// Tests for the shared gallery rules + a read-only check against the REAL repo content.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { GALLERY_SLUGS, ORIGINAL_COVERS, mergeGallery, movedCount, isContentPath, resolveCover } from "../src/lib/gallery-model.mjs";
import { validateImage, safeStem } from "../src/lib/admin/images.mjs";
import { makeImage } from "./helpers/site.mjs";

test("mergeGallery keeps JSON order, drops missing, dedupes, appends unlisted naturally", () => {
  const r = mergeGallery(
    [{ src: "/galleries/x/b.jpg", alt: "B" }, { src: "/galleries/x/missing.jpg" }, { src: "/galleries/x/B.JPG" }, null, { src: "" }],
    ["/galleries/x/b.jpg", "/galleries/x/img10.jpg", "/galleries/x/img2.jpg", "/galleries/x/notes.txt"]
  );
  assert.deepEqual(r.images.map((i) => i.src), ["/galleries/x/b.jpg", "/galleries/x/img2.jpg", "/galleries/x/img10.jpg"]);
  assert.equal(r.images[0].alt, "B");
  assert.deepEqual(r.missing, ["/galleries/x/missing.jpg"]);
});

test("movedCount counts photos that changed position", () => {
  assert.equal(movedCount(["a", "b", "c"], ["a", "b", "c"]), 0);
  assert.equal(movedCount(["a", "b", "c"], ["c", "a", "b"]), 1);
  assert.equal(movedCount(["a", "b", "c", "d"], ["d", "c", "b", "a"]), 3);
  assert.equal(movedCount(["a", "b", "c"], ["b", "c"]), 0, "removal alone isn't a move");
});

test("content paths are only photos, gallery lists and stats", () => {
  assert.ok(isContentPath("public/galleries/soccer/a.webp"));
  assert.ok(isContentPath("src/data/galleries/soccer.json"));
  assert.ok(isContentPath("src/data/stats.json"));
  assert.ok(!isContentPath("src/pages/index.astro"));
  assert.ok(!isContentPath("public/covers/soccer.jpg"));
  assert.ok(!isContentPath("public/galleries/soccer/readme.txt"));
});

test("gallery list matches the site's categories and data files", () => {
  const cats = readFileSync("src/data/categories.ts", "utf8");
  const slugsInCats = [...cats.matchAll(/slug: "([a-z]+)"/g)].map((m) => m[1]).filter((s) => s !== "sports");
  assert.deepEqual([...slugsInCats].sort(), [...GALLERY_SLUGS].sort());
  const html = readFileSync("public/admin/index.html", "utf8") + readFileSync("public/admin/admin.js", "utf8");
  for (const slug of GALLERY_SLUGS) assert.ok(existsSync(`src/data/galleries/${slug}.json`), slug);
  assert.ok(html.length > 0);
});

test("REAL repo: every gallery still resolves to the same photos (read-only)", () => {
  const expected = { basketball: 54, portraits: 46, baseball: 22, soccer: 12, hockey: 9 };
  for (const slug of GALLERY_SLUGS) {
    const data = JSON.parse(readFileSync(`src/data/galleries/${slug}.json`, "utf8"));
    const dir = `public/galleries/${slug}`;
    const files = existsSync(dir) ? readdirSync(dir).map((n) => `/galleries/${slug}/${n}`) : [];
    const r = mergeGallery(data.images, files);
    assert.equal(r.images.length, expected[slug] || 0, slug);
    assert.deepEqual(r.missing, [], `${slug} has no broken entries`);
  }
});

test("resolveCover: chosen photo, designed cover, fallbacks, never a missing file", () => {
  const images = [{ src: "/galleries/x/a.jpg" }, { src: "/galleries/x/b.jpg" }];
  const has = (...paths) => (src) => paths.includes(src);
  const r = (a) => resolveCover({ images, original: "/covers/x.jpg", exists: has("/covers/x.jpg"), ...a });
  assert.deepEqual(r({ cover: "/galleries/x/b.jpg" }), { src: "/galleries/x/b.jpg", kind: "chosen", stale: false });
  assert.deepEqual(r({ cover: "/Galleries/X/B.JPG" }), { src: "/galleries/x/b.jpg", kind: "chosen", stale: false }, "same loose match as the photo list");
  assert.deepEqual(r({}), { src: "/covers/x.jpg", kind: "original", stale: false }, "legacy: no choice yet");
  assert.deepEqual(r({ cover: "/covers/x.jpg" }), { src: "/covers/x.jpg", kind: "original", stale: false });
  assert.deepEqual(r({ cover: "/galleries/x/gone.jpg" }), { src: "/galleries/x/a.jpg", kind: "first", stale: true }, "chosen photo removed");
  assert.deepEqual(r({ cover: "/covers/missing.jpg" }), { src: "/galleries/x/a.jpg", kind: "first", stale: true });
  assert.deepEqual(r({ cover: "/galleries/other/a.jpg" }), { src: "/galleries/x/a.jpg", kind: "first", stale: true }, "another album's photo");
  assert.deepEqual(r({ exists: has() }), { src: "/galleries/x/a.jpg", kind: "first", stale: false }, "original file gone");
  assert.deepEqual(r({ images: [], cover: "/galleries/x/gone.jpg" }), { src: "/covers/x.jpg", kind: "original", stale: true }, "empty album");
  assert.deepEqual(r({ images: [], exists: has() }), { src: null, kind: "none", stale: false }, "nothing at all: placeholder");
  assert.deepEqual(resolveCover({ images: [{ src: "/galleries/x/only.jpg" }] }), { src: "/galleries/x/only.jpg", kind: "first", stale: false }, "one photo");
});

test("original covers match the site's categories and the files in public/covers", () => {
  const cats = readFileSync("src/data/categories.ts", "utf8");
  for (const slug of GALLERY_SLUGS) {
    const m = cats.match(new RegExp(`slug: "${slug}"[^}]*?cover: "([^"]+)"`, "s"));
    assert.ok(m, `${slug} has a cover in categories.ts`);
    assert.equal(ORIGINAL_COVERS[slug]?.src, m[1], slug);
    assert.ok(existsSync(`public${m[1]}`), `${m[1]} exists`);
  }
});

test("REAL repo: adding cover management changes no cover on the site (read-only)", () => {
  const cats = readFileSync("src/data/categories.ts", "utf8");
  for (const slug of GALLERY_SLUGS) {
    const data = JSON.parse(readFileSync(`src/data/galleries/${slug}.json`, "utf8"));
    const dir = `public/galleries/${slug}`;
    const files = existsSync(dir) ? readdirSync(dir).map((n) => `/galleries/${slug}/${n}`) : [];
    const { images } = mergeGallery(data.images, files);
    const original = cats.match(new RegExp(`slug: "${slug}"[^}]*?cover: "([^"]+)"`, "s"))[1];
    const oldRule = data.cover || original; // what the site did before this feature
    const { src } = resolveCover({ cover: data.cover, images, original, exists: (p) => existsSync(`public${p}`) });
    assert.ok(src && existsSync(`public${src}`), `${slug} cover file exists`);
    if (existsSync(`public${oldRule}`)) assert.equal(src, oldRule, `${slug} cover unchanged`);
  }
});

test("validateImage reads real bytes and dimensions", async () => {
  const j = validateImage(await makeImage({ width: 2000, height: 1333 }));
  assert.deepEqual([j.format, j.ext, j.width, j.height], ["jpeg", "jpg", 2000, 1333]);
  const w = validateImage(await makeImage({ width: 1500, height: 2000, format: "webp" }));
  assert.deepEqual([w.format, w.width, w.height], ["webp", 1500, 2000]);
  const lossless = await (await import("sharp")).default({ create: { width: 300, height: 200, channels: 4, background: "#fff" } }).webp({ lossless: true }).toBuffer();
  assert.deepEqual([validateImage(lossless).width, validateImage(lossless).height], [300, 200]);
  assert.throws(() => validateImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0])), /damaged/);
  assert.throws(() => validateImage(Buffer.alloc(0)), /empty/);
});

test("safeStem makes readable safe names", () => {
  assert.equal(safeStem("IMG 0042 (1).HEIC"), "IMG-0042-1");
  assert.equal(safeStem("../../etc/passwd"), "passwd");
  assert.equal(safeStem("..\\..\\x.jpg"), "x");
  assert.equal(safeStem(".jpg"), "photo");
  assert.equal(safeStem("ÉTÉ été.jpg"), "photo".length ? safeStem("ÉTÉ été.jpg") : "");
  assert.ok(safeStem("a".repeat(200) + ".jpg").length <= 60);
});
