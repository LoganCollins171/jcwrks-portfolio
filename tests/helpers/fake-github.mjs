// In-memory stand-in for the parts of the GitHub REST API the admin uses.
// Speaks HTTP-shaped fetch so tests exercise src/lib/admin/github.mjs too.
// Enforces fast-forward-only ref updates exactly like GitHub (force:false).

import { createHash } from "node:crypto";

const sha1 = (s) => createHash("sha1").update(s).digest("hex");
export const blobSha = (buf) => createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");

export function createFakeGitHub({ owner = "o", repo = "r" } = {}) {
  const blobs = new Map();   // sha -> Buffer
  const trees = new Map();   // sha -> Map(path -> {sha, mode})
  const commits = new Map(); // sha -> {sha, tree, parents, message, date}
  const refs = new Map();    // branch -> sha
  const hooks = { beforeRefUpdate: null, faults: [] };
  const calls = [];
  let clock = Date.parse("2026-09-17T12:00:00Z");

  function putBlob(buf) {
    const sha = blobSha(buf);
    blobs.set(sha, Buffer.from(buf));
    return sha;
  }
  function putTree(map) {
    const sorted = [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const sha = sha1("tree" + JSON.stringify(sorted));
    trees.set(sha, new Map(sorted));
    return sha;
  }
  function putCommit(tree, parents, message, date) {
    const d = date || new Date((clock += 1000)).toISOString();
    const sha = sha1(`commit|${tree}|${parents.join(",")}|${message}|${d}|${Math.random()}`);
    commits.set(sha, { sha, tree, parents, message, date: d });
    return sha;
  }
  function ancestors(sha) {
    const seen = new Set();
    const stack = [sha];
    while (stack.length) {
      const s = stack.pop();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      for (const p of commits.get(s)?.parents || []) stack.push(p);
    }
    return seen;
  }
  function mergeBase(a, b) {
    const anc = ancestors(a);
    const queue = [b];
    const seen = new Set();
    while (queue.length) {
      const s = queue.shift();
      if (seen.has(s)) continue;
      seen.add(s);
      if (anc.has(s)) return s;
      for (const p of commits.get(s)?.parents || []) queue.push(p);
    }
    return null;
  }

  /** Seed a branch from { path: Buffer|string }. */
  function seed(branch, files, message = "seed") {
    const map = new Map();
    for (const [path, content] of Object.entries(files)) {
      map.set(path, { sha: putBlob(Buffer.isBuffer(content) ? content : Buffer.from(content)), mode: "100644" });
    }
    const commit = putCommit(putTree(map), [], message);
    refs.set(branch, commit);
    return commit;
  }

  /** Test helper: commit directly to a branch (like Logan pushing code). */
  function commitTo(branch, changes, message = "direct") {
    const head = refs.get(branch);
    const map = new Map(trees.get(commits.get(head).tree));
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) map.delete(path);
      else map.set(path, { sha: putBlob(Buffer.isBuffer(content) ? content : Buffer.from(content)), mode: "100644" });
    }
    const commit = putCommit(putTree(map), [head], message);
    refs.set(branch, commit);
    return commit;
  }

  function files(branchOrCommit) {
    const c = commits.get(refs.get(branchOrCommit) || branchOrCommit);
    const out = {};
    for (const [path, { sha }] of trees.get(c.tree)) out[path] = blobs.get(sha);
    return out;
  }

  const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  async function fetchImpl(url, init = {}) {
    const method = (init.method || "GET").toUpperCase();
    const u = new URL(url);
    const path = u.pathname.replace(`/repos/${owner}/${repo}`, "");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path });

    for (const f of hooks.faults) {
      if (f.remaining > 0 && f.method === method && f.path.test(path)) {
        f.remaining--;
        if (f.status === 0) throw new TypeError("fetch failed");
        return new Response(JSON.stringify({ message: f.message || "injected fault" }), { status: f.status, headers: { "content-type": "application/json", ...(f.headers || {}) } });
      }
    }
    await new Promise((r) => setImmediate(r)); // let concurrent requests interleave

    let m;
    if (method === "GET" && (m = path.match(/^\/git\/ref\/heads\/(.+)$/))) {
      const sha = refs.get(m[1]);
      return sha ? res(200, { object: { sha } }) : res(404, { message: "Not Found" });
    }
    if (method === "POST" && path === "/git/refs") {
      const branch = body.ref.replace("refs/heads/", "");
      if (refs.has(branch)) return res(422, { message: "Reference already exists" });
      refs.set(branch, body.sha);
      return res(201, { ref: body.ref });
    }
    if (method === "PATCH" && (m = path.match(/^\/git\/refs\/heads\/(.+)$/))) {
      const branch = m[1];
      if (hooks.beforeRefUpdate) await hooks.beforeRefUpdate(branch, body.sha);
      const current = refs.get(branch);
      if (!commits.has(body.sha)) return res(422, { message: "Object does not exist" });
      if (!body.force && current && !ancestors(body.sha).has(current)) {
        return res(422, { message: "Update is not a fast forward" });
      }
      refs.set(branch, body.sha);
      return res(200, { object: { sha: body.sha } });
    }
    if (method === "GET" && (m = path.match(/^\/git\/commits\/([0-9a-f]+)$/))) {
      const c = commits.get(m[1]);
      if (!c) return res(404, { message: "Not Found" });
      return res(200, { sha: c.sha, tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })), message: c.message, committer: { date: c.date } });
    }
    if (method === "GET" && (m = path.match(/^\/git\/trees\/([0-9a-f]+)$/))) {
      const t = trees.get(m[1]);
      if (!t) return res(404, { message: "Not Found" });
      return res(200, { sha: m[1], truncated: false, tree: [...t].map(([p, e]) => ({ path: p, mode: e.mode, type: "blob", sha: e.sha })) });
    }
    if (method === "GET" && (m = path.match(/^\/git\/blobs\/([0-9a-f]+)$/))) {
      const b = blobs.get(m[1]);
      if (!b) return res(404, { message: "Not Found" });
      return res(200, { sha: m[1], encoding: "base64", content: b.toString("base64") });
    }
    if (method === "POST" && path === "/git/blobs") {
      return res(201, { sha: putBlob(Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8")) });
    }
    if (method === "POST" && path === "/git/trees") {
      const base = body.base_tree ? trees.get(body.base_tree) : new Map();
      if (!base) return res(422, { message: "base_tree not found" });
      const map = new Map(base);
      for (const e of body.tree) {
        if (e.sha === null) {
          if (!map.has(e.path)) return res(422, { message: `path ${e.path} not in base tree` });
          map.delete(e.path);
        } else {
          if (!blobs.has(e.sha)) return res(422, { message: `blob ${e.sha} does not exist` });
          map.set(e.path, { sha: e.sha, mode: e.mode });
        }
      }
      return res(201, { sha: putTree(map) });
    }
    if (method === "POST" && path === "/git/commits") {
      if (!trees.has(body.tree)) return res(422, { message: "tree does not exist" });
      for (const p of body.parents) if (!commits.has(p)) return res(422, { message: "parent does not exist" });
      return res(201, { sha: putCommit(body.tree, body.parents, body.message) });
    }
    if (method === "GET" && (m = path.match(/^\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/))) {
      const [, base, head] = m;
      if (!commits.has(base) || !commits.has(head)) return res(404, { message: "Not Found" });
      let status = "diverged";
      if (base === head) status = "identical";
      else if (ancestors(head).has(base)) status = "ahead";
      else if (ancestors(base).has(head)) status = "behind";
      return res(200, { status, merge_base_commit: { sha: mergeBase(base, head) } });
    }
    if (method === "GET" && path === "/commits") {
      const start = refs.get(u.searchParams.get("sha")) || u.searchParams.get("sha");
      const per = Number(u.searchParams.get("per_page") || 30);
      const out = [];
      const seen = new Set();
      let frontier = [start];
      while (frontier.length && out.length < per) {
        frontier.sort((a, b) => (commits.get(b)?.date || "").localeCompare(commits.get(a)?.date || ""));
        const sha = frontier.shift();
        if (!sha || seen.has(sha) || !commits.has(sha)) continue;
        seen.add(sha);
        const c = commits.get(sha);
        out.push({ sha, commit: { message: c.message, committer: { date: c.date } } });
        frontier.push(...c.parents);
      }
      return res(200, out);
    }
    if (method === "GET" && (m = path.match(/^\/commits\/([0-9a-f]+)$/))) {
      const c = commits.get(m[1]);
      if (!c) return res(404, { message: "Not Found" });
      const now = trees.get(c.tree);
      const prev = c.parents[0] ? trees.get(commits.get(c.parents[0]).tree) : new Map();
      const files = [];
      for (const [p, e] of now) if (prev.get(p)?.sha !== e.sha) files.push({ filename: p });
      for (const p of prev.keys()) if (!now.has(p)) files.push({ filename: p });
      return res(200, { sha: c.sha, files });
    }
    return res(404, { message: `fake: no route for ${method} ${path}` });
  }

  return {
    fetchImpl, seed, commitTo, files, refs, commits, blobs, hooks, calls,
    fault(method, path, status, times = 1, message, headers) {
      hooks.faults.push({ method, path, status, remaining: times, message, headers });
    },
    ref: (b) => refs.get(b),
    setClock: (ms) => { clock = ms; },
  };
}
