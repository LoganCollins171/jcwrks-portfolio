// Builds a throwaway fake repo + the real admin handler wired to it.
// NOTHING here touches GitHub, Netlify, or Jacob's real photos.

import sharp from "sharp";
import { createFakeGitHub } from "./fake-github.mjs";
import { createGitHub } from "../../src/lib/admin/github.mjs";
import { createContentEngine } from "../../src/lib/admin/content.mjs";
import { createAuth } from "../../src/lib/admin/auth.mjs";
import { createHandler } from "../../src/lib/admin/handler.mjs";
import { GALLERY_SLUGS } from "../../src/lib/gallery-model.mjs";

export const PASSWORD = "test-password-not-real";

let colorSeed = 0;
export async function makeImage({ width = 1200, height = 800, format = "jpeg", color } = {}) {
  const c = color || { r: (colorSeed * 53) % 255, g: (colorSeed * 97) % 255, b: (colorSeed++ * 31) % 255 };
  const img = sharp({ create: { width, height, channels: 3, background: c } });
  if (format === "webp") return img.webp({ quality: 80 }).toBuffer();
  if (format === "png") return img.png().toBuffer();
  return img.jpeg({ quality: 80 }).toBuffer();
}

export function memoryStore() {
  const m = new Map();
  return {
    data: m,
    async get(key) { return m.has(key) ? structuredClone(m.get(key)) : null; },
    async setJSON(key, v) { m.set(key, structuredClone(v)); },
    async delete(key) { m.delete(key); },
  };
}

export async function createTestSite({ now } = {}) {
  const fake = createFakeGitHub();
  const files = {
    "src/pages/index.astro": "<h1>code</h1>",
    "src/data/stats.json": JSON.stringify({ photosTaken: 68527 }, null, 2) + "\n",
  };
  for (const slug of GALLERY_SLUGS) files[`src/data/galleries/${slug}.json`] = JSON.stringify({ images: [] }, null, 2) + "\n";

  const b = [await makeImage(), await makeImage(), await makeImage()];
  files["public/galleries/baseball/a.webp"] = b[0];
  files["public/galleries/baseball/b.webp"] = b[1];
  files["public/galleries/baseball/c.webp"] = b[2];
  files["src/data/galleries/baseball.json"] = JSON.stringify({
    images: [
      { src: "/galleries/baseball/c.webp", alt: "" },
      { src: "/galleries/baseball/a.webp", alt: "slide" },
      { src: "/galleries/baseball/b.webp", alt: "" },
    ],
  }, null, 2) + "\n";
  // soccer: files on disk, not listed (the Sept 16 state)
  files["public/galleries/soccer/IMG_2.webp"] = await makeImage();
  files["public/galleries/soccer/IMG_10.webp"] = await makeImage();
  // portraits: a listed entry whose file is missing
  files["public/galleries/portraits/p1.jpg"] = await makeImage();
  files["src/data/galleries/portraits.json"] = JSON.stringify({
    images: [{ src: "/galleries/portraits/gone.jpg", alt: "" }, { src: "/galleries/portraits/p1.jpg", alt: "" }],
  }, null, 2) + "\n";

  const initial = fake.seed("main", files);
  fake.refs.set("staging", initial);

  const gh = createGitHub({ token: "fake-token", owner: "o", repo: "r", fetchImpl: fake.fetchImpl, apiBase: "https://api.test" });
  const engine = createContentEngine({ gh, rawBase: "https://raw.test/o/r", sleep: (ms) => new Promise((r) => setTimeout(r, Math.ceil(ms / 10))) });
  const store = memoryStore();
  let clock = now ?? Date.parse("2026-09-17T12:00:00Z");
  const auth = createAuth({ password: PASSWORD, token: "fake-token", store, now: () => clock });
  const live = { commit: initial, fail: false };
  const handle = createHandler({
    auth, engine, gh,
    now: () => clock,
    log: { error() {} },
    fetchLiveCommit: async () => {
      if (live.fail) throw new Error("site down");
      return live.commit;
    },
  });

  async function call(op, body, { token, raw, headers = {}, ip = "1.1.1.1", method = "POST" } = {}) {
    const init = { method, headers: { ...headers } };
    if (token) init.headers.authorization = `Bearer ${token}`;
    if (raw !== undefined) {
      init.body = raw;
      init.headers["content-length"] = String(raw.length);
    } else if (body !== undefined) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
      init.headers["content-type"] = "application/json";
    }
    const res = await handle(new Request(`https://jcwrks.test/api/admin?op=${op}`, init), { ip });
    return { status: res.status, body: await res.json() };
  }

  async function login() {
    const r = await call("login", { password: PASSWORD });
    if (r.status !== 200) throw new Error("login failed in test setup");
    return r.body.token;
  }

  return {
    fake, gh, engine, auth, store, live, call, login, initial,
    advance(ms) { clock += ms; },
    json(branch, path) { return JSON.parse(fake.files(branch)[path].toString("utf8")); },
    paths(branch, prefix = "public/galleries/") { return Object.keys(fake.files(branch)).filter((p) => p.startsWith(prefix)).sort(); },
  };
}

/** Upload + add in one go, the way the browser does it. */
export async function uploadAndAdd(site, token, gallery, images) {
  const receipts = [];
  for (const { buf, name } of images) {
    const r = await site.call("upload", undefined, { token, raw: buf, headers: { "x-file-name": encodeURIComponent(name) } });
    if (r.status !== 200) return { failedUpload: r };
    receipts.push(r.body.receipt);
  }
  return site.call("add", { gallery, files: receipts }, { token });
}
