// Integration test against the REAL GitHub API, on THROWAWAY branches only.
// Never touches main, staging, or any real photo file (only adds/removes test
// fixture images in the test branches), and deletes its branches at the end.
//
//   GH_TOKEN=... FIXTURES=/path/to/fixtures node tests/integration/real-github.mjs
//
// Netlify only builds `main` (branch deploys off), so these branches cost nothing.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createGitHub } from "../../src/lib/admin/github.mjs";
import { createContentEngine } from "../../src/lib/admin/content.mjs";
import { createAuth } from "../../src/lib/admin/auth.mjs";
import { createHandler } from "../../src/lib/admin/handler.mjs";

const OWNER = "LoganCollins171", REPO = "jcwrks-portfolio";
const stamp = Date.now().toString(36);
const PROD = `admin-it-prod-${stamp}`, DRAFT = `admin-it-draft-${stamp}`;
const token = process.env.GH_TOKEN;
const gh = createGitHub({ token, owner: OWNER, repo: REPO });
const results = [];
const created = [];
const step = async (name, fn) => {
  try { await fn(); results.push(["PASS", name]); }
  catch (err) { results.push(["FAIL", name, err.message.split("\n")[0]]); }
};

async function deleteBranch(b) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/git/refs/heads/${b}`, {
    method: "DELETE", headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  return res.status;
}

function makeSite(prod, draft) {
  const engine = createContentEngine({ gh, draftBranch: draft, prodBranch: prod, rawBase: `https://raw.githubusercontent.com/${OWNER}/${REPO}` });
  const auth = createAuth({ password: "it-pass", token, store: null });
  let live = null;
  const handle = createHandler({ auth, engine, gh, prodBranch: prod, fetchLiveCommit: async () => live, log: { error: (m) => console.error(m) } });
  let session;
  const call = async (op, body, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (op !== "login") headers.authorization = `Bearer ${session}`;
    const init = { method: "POST", headers, body: opts.raw ?? JSON.stringify(body || {}) };
    const r = await handle(new Request(`https://it.test/api/admin?op=${op}`, init));
    return { status: r.status, body: await r.json() };
  };
  return {
    engine, call, setLive: (c) => { live = c; },
    async login() { session = (await call("login", { password: "it-pass" })).body.token; },
  };
}

const readJson = async (ref, path) => {
  const t = await gh.getTree((await gh.getCommit(await gh.getRef(ref))).tree);
  const e = t.find((x) => x.path === path);
  return e ? JSON.parse((await gh.getBlob(e.sha)).toString()) : null;
};
const treeMap = async (ref) => new Map((await gh.getTree((await gh.getCommit(await gh.getRef(ref))).tree)).map((e) => [e.path, e.sha]));

try {
  const mainSha = await gh.getRef("main");
  const stagingSha = await gh.getRef("staging");
  await gh.createRef(PROD, mainSha);
  created.push(PROD);
  const site = makeSite(PROD, DRAFT);
  await site.login();

  await step("draft branch auto-created; nothing pending; real gallery counts", async () => {
    const r = await site.call("state");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    created.push(DRAFT);
    assert.equal(r.body.changes.hasChanges, false, r.body.changes.lines.join("|"));
    const counts = Object.fromEntries(r.body.galleries.map((g) => [g.slug, g.count]));
    assert.deepEqual([counts.basketball, counts.portraits, counts.baseball, counts.soccer, counts.hockey, counts.track], [54, 46, 22, 12, 9, 0]);
    assert.equal(r.body.stats.draft, 68527);
  });

  let added = [];
  await step("upload two real JPEGs + add to Track (real blob + tree + CAS ref update)", async () => {
    const receipts = [];
    for (const f of ["IMG_0042.jpg", "other/IMG_0042.jpg"]) {
      const raw = await readFile(`${process.env.FIXTURES}/${f}`);
      const u = await site.call("upload", null, { raw, headers: { "x-file-name": "IMG_0042.jpg", "content-length": String(raw.length) } });
      assert.equal(u.status, 200, JSON.stringify(u.body));
      receipts.push(u.body.receipt);
    }
    const a = await site.call("add", { gallery: "track", files: receipts });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    added = a.body.added.map((x) => x.src);
    assert.equal(added.length, 2);
    const s = await site.call("state");
    assert.deepEqual(s.body.changes.lines, ["Track: 2 photos added"]);
  });

  await step("thumbnail URL for a draft photo loads from raw.githubusercontent.com", async () => {
    const g = await site.call("gallery", { gallery: "track" });
    const res = await fetch(g.body.photos[0].url);
    assert.equal(res.status, 200);
    assert.ok(Number(res.headers.get("content-length") || (await res.arrayBuffer()).byteLength) > 1000);
  });

  await step("reorder + remove one test photo + Moments +10 = accurate summary", async () => {
    assert.equal((await site.call("reorder", { gallery: "track", order: [added[1], added[0]] })).status, 200);
    assert.equal((await site.call("remove", { gallery: "track", src: added[0] })).body.removed, true);
    assert.equal((await site.call("moments-add", { amount: 10 })).body.after, 68537);
    const s = await site.call("state");
    assert.deepEqual(s.body.changes.lines, ["Track: 1 photo added", "Moments Captured: 68,527 → 68,537 (+10)"]);
  });

  await step("code pushed to production meanwhile is kept, not reverted", async () => {
    const head = await gh.getRef(PROD);
    const c = await gh.getCommit(head);
    const blob = await gh.createBlob(Buffer.from("integration test marker\n"));
    const tree = await gh.createTree(c.tree, [{ path: "tests/integration/.it-marker", sha: blob }]);
    await gh.updateRef(PROD, await gh.createCommit("IT: simulated code push", tree, [head]));
    const s = await site.call("state");
    assert.deepEqual(s.body.changes.lines, ["Track: 1 photo added", "Moments Captured: 68,527 → 68,537 (+10)"]);
  });

  let publishedSha;
  await step("publish: one commit, all content applied, code kept, other galleries byte-identical", async () => {
    const s = await site.call("state");
    const p = await site.call("publish", { draftSha: s.body.draftSha });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    publishedSha = p.body.productionSha;
    assert.equal(await gh.getRef(PROD), publishedSha);
    assert.equal(await gh.getRef(DRAFT), publishedSha, "draft levelled");
    const prod = await treeMap(PROD);
    const main = await treeMap("main");
    assert.ok(prod.has("tests/integration/.it-marker"));
    assert.ok(prod.has("public" + added[1]));
    assert.ok(!prod.has("public" + added[0]));
    assert.equal((await readJson(PROD, "src/data/stats.json")).photosTaken, 68537);
    for (const [path, sha] of main) {
      if (path.startsWith("public/galleries/") || (path.startsWith("src/data/galleries/") && !path.endsWith("track.json"))) {
        assert.equal(prod.get(path), sha, `unchanged: ${path}`);
      }
    }
    const after = await site.call("state");
    assert.equal(after.body.changes.hasChanges, false);
  });

  await step("live detection via real compare API", async () => {
    assert.equal(await site.engine.isLive(publishedSha, mainSha), false);
    assert.equal(await site.engine.isLive(publishedSha, publishedSha), true);
  });

  await step("stale draft publish is refused on real GitHub", async () => {
    await site.call("moments-add", { amount: 1 });
    const s1 = await site.call("state");
    await site.call("moments-add", { amount: 1 });
    const p = await site.call("publish", { draftSha: s1.body.draftSha });
    assert.equal(p.status, 409);
    assert.equal(await gh.getRef(PROD), publishedSha);
  });

  await step("discard returns draft to production", async () => {
    const d = await site.call("discard");
    const s = await site.call("state");
    if (s.body.changes.hasChanges) {
      results.push(["INFO", `discard wrote ${d.body.draftSha?.slice(0, 7)}; immediate state read draft ${s.body.draftSha.slice(0, 7)}: ${s.body.changes.lines.join(" | ")}`]);
    }
    assert.equal(s.body.changes.hasChanges, false);
  });

  // Scenario B: today's real staging (stranded shrink commit 2969db0) as the draft.
  const PROD_B = `admin-it-prodB-${stamp}`, DRAFT_B = `admin-it-draftB-${stamp}`;
  await gh.createRef(PROD_B, mainSha); created.push(PROD_B);
  await gh.createRef(DRAFT_B, stagingSha); created.push(DRAFT_B);
  const siteB = makeSite(PROD_B, DRAFT_B);
  await siteB.login();
  await step("real stranded staging (2969db0) is detected as pending, not 'nothing waiting'", async () => {
    const s = await siteB.call("state");
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.changes.hasChanges, true);
    results.push(["INFO", `stranded staging summary: ${s.body.changes.lines.join(" | ")}`]);
    assert.ok(s.body.changes.lines.some((l) => /Soccer: 12 photos updated/.test(l)));
  });
} finally {
  for (const b of created.reverse()) {
    const st = await deleteBranch(b);
    results.push(["CLEANUP", `delete ${b}: ${st}`]);
  }
  console.log("=== real GitHub integration ===");
  for (const r of results) console.log(r.join("  "));
  process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
}
