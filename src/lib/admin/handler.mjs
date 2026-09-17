// HTTP layer for the /admin API. Framework-agnostic: Request in, Response out,
// every dependency injected so the whole thing runs in tests without Netlify.
//
// POST /api/admin?op=<op>
//   login            { password }                    -> { token, expires }
//   state                                            -> galleries, Moments Captured, unpublished changes, live status
//   gallery          { gallery }                     -> photos in draft order
//   upload           raw JPEG/WebP bytes, header x-file-name -> signed receipt
//   add              { gallery, files: [receipt] }   -> added / skipped
//   remove           { gallery, src }
//   restore          { gallery, src }
//   reorder          { gallery, order: [src] }
//   moments-add      { amount }
//   moments-set      { value, expected }
//   discard          {}
//   publish          { draftSha }
//   publish-status   { productionSha }
//   retry-publish    {}
// Every op except login needs `authorization: Bearer <token>`.

import { ContentError } from "./content.mjs";
import { ImageError, MAX_UPLOAD_BYTES, safeStem, validateImage } from "./images.mjs";
import { GitHubError } from "./github.mjs";

const RETRY_PUBLISH_MIN_AGE_MS = 4 * 60 * 1000;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
const fail = (status, code, message, extra = {}) => json(status, { ok: false, error: { code, message, ...extra } });
const ok = (body) => json(200, { ok: true, ...body });

export function createHandler({ auth, engine, gh, fetchLiveCommit, prodBranch = "main", now = () => Date.now(), log = console }) {
  async function liveStatus(productionSha) {
    let liveCommit = null;
    try { liveCommit = await fetchLiveCommit(); } catch { liveCommit = null; }
    const live = await engine.isLive(productionSha, liveCommit);
    return { productionSha, liveCommit, live };
  }

  // Newest commits the browser already knows about (see content.mjs freshest()).
  function hints(req) {
    const pick = (h) => { const v = req.headers.get(h) || ""; return /^[0-9a-f]{40}$/.test(v) ? v : undefined; };
    return { draft: pick("x-known-draft"), prod: pick("x-known-prod") };
  }

  async function readJsonBody(req) {
    const text = await req.text();
    if (text.length > 200_000) throw new ContentError("too_big", "Request too large.", 413);
    if (!text) return {};
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not an object");
      return data;
    } catch {
      throw new ContentError("bad_json", "The request was malformed. Please refresh the page.", 400);
    }
  }

  const ops = {
    async state(req) {
      const s = await engine.state(hints(req));
      return ok({ ...s, deploy: await liveStatus(s.productionSha) });
    },

    async gallery(req) {
      const { gallery } = await readJsonBody(req);
      return ok(await engine.gallery(String(gallery || ""), hints(req)));
    },

    async upload(req) {
      const declared = Number(req.headers.get("content-length") || 0);
      if (declared > MAX_UPLOAD_BYTES) {
        return fail(413, "too_large", "This photo is too large after shrinking. Please refresh the page and try again.");
      }
      const buf = Buffer.from(await req.arrayBuffer());
      const info = validateImage(buf);
      let name = "";
      try { name = decodeURIComponent(req.headers.get("x-file-name") || ""); } catch { name = ""; }
      const stem = safeStem(name);
      const sha = await gh.createBlob(buf);
      const receipt = { sha, ext: info.ext, stem, width: info.width, height: info.height, bytes: info.bytes };
      return ok({ receipt: { ...receipt, receipt: auth.signReceipt(receipt) } });
    },

    async add(req) {
      const { gallery, files } = await readJsonBody(req);
      if (!Array.isArray(files) || !files.length) throw new ContentError("no_files", "No photos to add.");
      for (const f of files) {
        if (!auth.verifyReceipt(f)) throw new ContentError("bad_receipt", "A photo's upload couldn't be verified. Please upload it again.", 400);
      }
      const result = await engine.addPhotos(String(gallery || ""), files.map((f) => ({ sha: f.sha, ext: f.ext, stem: f.stem })), hints(req));
      return ok(result);
    },

    async remove(req) {
      const { gallery, src } = await readJsonBody(req);
      return ok(await engine.removePhoto(String(gallery || ""), String(src || ""), hints(req)));
    },

    async restore(req) {
      const { gallery, src } = await readJsonBody(req);
      return ok(await engine.restorePhoto(String(gallery || ""), String(src || ""), hints(req)));
    },

    async reorder(req) {
      const { gallery, order } = await readJsonBody(req);
      if (!Array.isArray(order) || order.length > 2000 || order.some((s) => typeof s !== "string")) {
        throw new ContentError("bad_order", "The new order was malformed. Please refresh the page.");
      }
      return ok(await engine.reorder(String(gallery || ""), order, hints(req)));
    },

    async "moments-add"(req) {
      const { amount } = await readJsonBody(req);
      return ok(await engine.addToMoments(amount, hints(req)));
    },

    async "moments-set"(req) {
      const { value, expected } = await readJsonBody(req);
      return ok(await engine.setMoments(value, expected, hints(req)));
    },

    async discard(req) {
      return ok(await engine.discard(hints(req)));
    },

    async publish(req) {
      const { draftSha } = await readJsonBody(req);
      if (typeof draftSha !== "string" || !/^[0-9a-f]{40}$/.test(draftSha)) {
        throw new ContentError("bad_draft", "Please refresh the page and review your changes before publishing.");
      }
      return ok(await engine.publish(draftSha, hints(req)));
    },

    async "publish-status"(req) {
      const { productionSha } = await readJsonBody(req);
      if (typeof productionSha !== "string" || !/^[0-9a-f]{40}$/.test(productionSha)) {
        throw new ContentError("bad_sha", "Missing publish reference.");
      }
      return ok(await liveStatus(productionSha));
    },

    async "retry-publish"() {
      const mainHead = await gh.getRef(prodBranch);
      const status = await liveStatus(mainHead);
      if (status.live) return ok({ retried: false, alreadyLive: true, ...status });
      const commit = await gh.getCommit(mainHead);
      const age = commit.date ? now() - Date.parse(commit.date) : Infinity;
      if (age < RETRY_PUBLISH_MIN_AGE_MS) {
        return fail(409, "too_soon", "Your site is still updating. Please give it a couple more minutes.");
      }
      const r = await engine.retryPublish();
      return ok({ retried: true, ...r });
    },
  };

  return async function handle(req, { ip = "unknown" } = {}) {
    const url = new URL(req.url);
    const op = url.searchParams.get("op") || "";
    if (req.method !== "POST") return fail(405, "method", "POST only.");

    try {
      if (op === "login") {
        const { password } = await readJsonBody(req);
        const r = await auth.login(password, ip);
        if (r.ok) return ok({ token: r.token, expires: r.expires });
        if (r.reason === "locked") {
          const mins = Math.max(1, Math.ceil(r.retryAfterSec / 60));
          return fail(429, "locked", `Too many wrong passwords. Please wait ${mins} minute${mins === 1 ? "" : "s"} and try again.`);
        }
        return fail(401, "wrong_password", "That password isn't right.");
      }

      if (!Object.hasOwn(ops, op)) return fail(404, "unknown_op", "Unknown action.");

      const header = req.headers.get("authorization") || "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!auth.verifySession(token)) {
        return fail(401, "signed_out", "You've been signed out. Please enter your password again.");
      }

      return await ops[op](req);
    } catch (err) {
      if (err instanceof ImageError) return fail(422, err.code, err.message);
      if (err instanceof ContentError) return fail(err.status, err.code, err.message);
      if (err instanceof GitHubError) {
        log.error?.(`[admin] GitHub error ${err.status} on ${op}: ${err.message} (${err.path})`);
        if (err.status === 401 || err.status === 403) {
          return fail(502, "storage_denied", "The photo manager can't save right now (storage access was refused). Nothing was lost. Tell Logan: \"GitHub access refused\".");
        }
        return fail(502, "storage_error", "The photo manager couldn't reach storage. Nothing was lost. Please try again in a minute.");
      }
      log.error?.(`[admin] unexpected error on ${op}: ${err?.stack || err}`);
      return fail(500, "unexpected", "Something went wrong. Nothing was lost. Please try again.");
    }
  };
}
