// Local test server for /admin: the real page + the real API handler, backed by
// a FAKE in-memory repo with generated test photos. Never touches GitHub,
// Netlify, or Jacob's photos.
//
//   node tests/browser/dev-server.mjs [port]
//   open http://localhost:4400/admin/   password: test-password-not-real
//
// Simulated deploys: ~6s after production changes, /build.json reports it live.
// POST /__test/deploy-mode {"mode":"normal"|"stuck"} to simulate a stuck build.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import sharp from "sharp";
import { createFakeGitHub } from "../helpers/fake-github.mjs";
import { createGitHub } from "../../src/lib/admin/github.mjs";
import { createContentEngine } from "../../src/lib/admin/content.mjs";
import { createAuth } from "../../src/lib/admin/auth.mjs";
import { createHandler } from "../../src/lib/admin/handler.mjs";
import { GALLERY_SLUGS, mergeGallery } from "../../src/lib/gallery-model.mjs";

const PORT = Number(process.argv[2] || 4400);
const ROOT = process.env.PUBLIC_ROOT || new URL("../../public/", import.meta.url).pathname;
const PASSWORD = "test-password-not-real";
const DEPLOY_DELAY_MS = Number(process.env.DEPLOY_DELAY_MS || 6000);

async function labeled(n, { width = 1200, height = 800, hue = n * 37 } = {}) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="hsl(${hue % 360},55%,55%)"/>
    <text x="50%" y="55%" font-size="${Math.round(Math.min(width, height) / 2.2)}" font-family="Helvetica" font-weight="bold" fill="white" text-anchor="middle">${n}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 80 }).toBuffer();
}

const fake = createFakeGitHub();
const files = {
  "src/pages/index.astro": "<h1>code</h1>",
  "src/data/stats.json": JSON.stringify({ photosTaken: 68527 }, null, 2) + "\n",
};
for (const slug of GALLERY_SLUGS) files[`src/data/galleries/${slug}.json`] = JSON.stringify({ images: [] }, null, 2) + "\n";
const baseball = [];
for (let i = 1; i <= (process.env.REAL_PHOTOS ? 0 : 8); i++) {
  const w = i % 3 === 0 ? 800 : 1200, h = i % 3 === 0 ? 1200 : 800;
  files[`public/galleries/baseball/TEST-${i}.webp`] = await labeled(i, { width: w, height: h });
  baseball.push({ src: `/galleries/baseball/TEST-${i}.webp`, alt: "" });
}
if (baseball.length) files["src/data/galleries/baseball.json"] = JSON.stringify({ images: baseball }, null, 2) + "\n";
for (let i = 1; i <= (process.env.REAL_PHOTOS ? 0 : 3); i++) files[`public/galleries/soccer/S-${i}.webp`] = await labeled(i + 20);
// A long gallery (like basketball's 54) for scrolling / performance checks.
const LONG = process.env.REAL_PHOTOS ? 0 : Number(process.env.LONG_GALLERY || 60);
const long = [];
for (let i = 1; i <= LONG; i++) {
  files[`public/galleries/basketball/B-${i}.webp`] = await labeled(i, { width: 1600, height: i % 4 ? 1067 : 2000, hue: i * 11 });
  long.push({ src: `/galleries/basketball/B-${i}.webp`, alt: "" });
}
if (LONG) files["src/data/galleries/basketball.json"] = JSON.stringify({ images: long }, null, 2) + "\n";
// REAL_PHOTOS=1 seeds the preview with Jacob's actual photos, read from the working
// tree (read-only) so design reviews show the real thing. Nothing is ever written back.
if (process.env.REAL_PHOTOS) {
  const { readdirSync, readFileSync, existsSync } = await import("node:fs");
  for (const slug of GALLERY_SLUGS) {
    const dir = `public/galleries/${slug}`;
    if (existsSync(dir)) for (const name of readdirSync(dir)) files[`${dir}/${name}`] = readFileSync(`${dir}/${name}`);
    const json = `src/data/galleries/${slug}.json`;
    if (existsSync(json)) files[json] = readFileSync(json, "utf8");
  }
  files["src/data/stats.json"] = readFileSync("src/data/stats.json", "utf8");
}
const initial = fake.seed("main", files);
fake.refs.set("staging", initial);

const gh = createGitHub({ token: "fake", owner: "o", repo: "r", fetchImpl: fake.fetchImpl, apiBase: "https://api.test" });
const engine = createContentEngine({ gh, rawBase: `http://localhost:${PORT}/raw` });
const store = new Map();
const auth = createAuth({
  password: PASSWORD, token: "fake",
  store: { get: async (k) => store.get(k) ?? null, setJSON: async (k, v) => store.set(k, v), delete: async (k) => store.delete(k) },
});

const deploy = { live: initial, mode: "normal", timer: null, lastMain: initial };
setInterval(() => {
  const main = fake.ref("main");
  if (main !== deploy.lastMain) {
    deploy.lastMain = main;
    clearTimeout(deploy.timer);
    if (deploy.mode === "normal") deploy.timer = setTimeout(() => { deploy.live = main; }, DEPLOY_DELAY_MS);
  }
}, 250);

// CLOCK_SKEW_MS lets tests reach "the last publish is old enough to retry" without waiting minutes.
const handle = createHandler({ auth, engine, gh, fetchLiveCommit: async () => deploy.live, now: () => Date.now() + Number(process.env.CLOCK_SKEW_MS || 0), log: { error() {} } });
const SPORTS = ["basketball", "football", "soccer", "baseball", "softball", "hockey", "track"];

// Minimal stand-ins for the real site's pages, rendered from the LIVE build,
// so the admin's "Verifying live site" step checks something real.
function livePage(pathname) {
  const content = fake.files(deploy.live);
  const m = pathname.match(/^\/work\/(?:sports\/)?([a-z]+)\/$/);
  if (m && GALLERY_SLUGS.includes(m[1]) && (SPORTS.includes(m[1]) === pathname.startsWith("/work/sports/"))) {
    const slug = m[1];
    const json = content[`src/data/galleries/${slug}.json`];
    const listed = json ? JSON.parse(json).images || [] : [];
    const disk = Object.keys(content).filter((p) => p.startsWith(`public/galleries/${slug}/`)).map((p) => p.slice(6));
    const { images } = mergeGallery(listed, disk);
    return `<!doctype html><title>${slug}</title>${images.map((i) => `<button data-lightbox data-src="${i.src}"></button>`).join("")}`;
  }
  if (pathname === "/") {
    const stats = JSON.parse(content["src/data/stats.json"]);
    return `<!doctype html><title>home</title><span data-photo-count data-to="${stats.photosTaken}">${Number(stats.photosTaken).toLocaleString("en-US")}</span>`;
  }
  return null;
}
export const uploads = [];
let rawHits = 0;

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".json": "application/json" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/api/admin") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      if (url.searchParams.get("op") === "upload") {
        uploads.push({ bytes: body.length, type: headers.get("content-type"), head: body.subarray(0, 16).toString("hex") });
      }
      const r = await handle(new Request(url, { method: req.method, headers, body: req.method === "POST" ? body : undefined }), { ip: "127.0.0.1" });
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    if (url.pathname === "/build.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ commit: deploy.live }));
      return;
    }
    if (url.pathname.startsWith("/raw/")) {
      rawHits++;
      const [, , commit, ...rest] = url.pathname.split("/");
      const path = decodeURIComponent(rest.join("/"));
      const f = fake.files(commit)[path];
      if (!f) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream", "cache-control": "max-age=3600" });
      res.end(f);
      return;
    }
    if (url.pathname === "/__test/state") {
      const main = fake.ref("main"), staging = fake.ref("staging");
      const read = (b, p) => { const f = fake.files(b)[p]; return f ? JSON.parse(f) : null; };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        main, staging, live: deploy.live, uploads, rawHits,
        mainStats: read("main", "src/data/stats.json"), stagingStats: read("staging", "src/data/stats.json"),
        mainBaseball: read("main", "src/data/galleries/baseball.json"), stagingBaseball: read("staging", "src/data/galleries/baseball.json"),
        stagingFiles: Object.keys(fake.files("staging")).filter((p) => p.startsWith("public/")),
        mainCommitMessages: [...fake.commits.values()].filter((c) => c.message.includes("Publish")).length,
        mainFiles: Object.keys(fake.files("main")).filter((p) => p.startsWith("public/")),
      }));
      return;
    }
    const page = req.method === "GET" ? livePage(url.pathname) : null;
    if (page) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      res.end(page);
      return;
    }
    if (url.pathname === "/__test/fault" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const f = JSON.parse(Buffer.concat(chunks).toString());
      fake.fault(f.method, new RegExp(f.path), f.status, f.times || 1, f.message, f.headers);
      res.writeHead(204); res.end();
      return;
    }
    if (url.pathname === "/__test/deploy-mode" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      deploy.mode = JSON.parse(Buffer.concat(chunks).toString()).mode;
      if (deploy.mode === "normal" && fake.ref("main") !== deploy.live) {
        clearTimeout(deploy.timer);
        deploy.timer = setTimeout(() => { deploy.live = fake.ref("main"); }, DEPLOY_DELAY_MS);
      }
      res.writeHead(204); res.end();
      return;
    }
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, "");
    if (p.endsWith("/") || p === "admin") p = join(p, "index.html");
    if (p.includes("..")) { res.writeHead(400); res.end(); return; }
    const data = await readFile(join(ROOT, p));
    res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream" });
    res.end(data);
  } catch (err) {
    res.writeHead(err.code === "ENOENT" ? 404 : 500);
    res.end(String(err.code === "ENOENT" ? "not found" : err.stack));
  }
});
server.listen(PORT, () => console.log(`admin test server: http://localhost:${PORT}/admin/  (password: ${PASSWORD})`));
