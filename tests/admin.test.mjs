// Tests for the /admin content pipeline, run against a fake in-memory repo.
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestSite, makeImage, uploadAndAdd, PASSWORD } from "./helpers/site.mjs";
import { MAX_FAILS } from "../src/lib/admin/auth.mjs";

const order = (site, branch, slug) => site.json(branch, `src/data/galleries/${slug}.json`).images.map((i) => i.src);

async function state(site, token) {
  const r = await site.call("state", {}, { token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

// ---------------- auth ----------------

test("wrong password is refused and nothing else works without a session", async () => {
  const site = await createTestSite();
  const r = await site.call("login", { password: "nope" });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, "wrong_password");
  const s = await site.call("state", {});
  assert.equal(s.status, 401);
  const forged = await site.call("state", {}, { token: "eyJ2IjoxLCJleHAiOjk5OTk5OTk5OTk5OTl9.forged" });
  assert.equal(forged.status, 401);
});

test("repeated wrong passwords lock that IP out, even for the right password, then recover", async () => {
  const site = await createTestSite();
  for (let i = 0; i < MAX_FAILS - 1; i++) assert.equal((await site.call("login", { password: "x" + i })).status, 401);
  const locked = await site.call("login", { password: "last" });
  assert.equal(locked.status, 429);
  assert.equal((await site.call("login", { password: PASSWORD })).status, 429, "locked even with right password");
  assert.equal((await site.call("login", { password: PASSWORD }, { ip: "2.2.2.2" })).status, 200, "other IPs unaffected");
  site.advance(16 * 60 * 1000);
  assert.equal((await site.call("login", { password: PASSWORD })).status, 200, "unlocks after the window");
});

test("sessions expire", async () => {
  const site = await createTestSite();
  const token = await site.login();
  assert.equal((await site.call("state", {}, { token })).status, 200);
  site.advance(31 * 24 * 60 * 60 * 1000);
  assert.equal((await site.call("state", {}, { token })).status, 401);
});

test("malformed requests get clear errors, not crashes", async () => {
  const site = await createTestSite();
  const token = await site.login();
  assert.equal((await site.call("reorder", "{not json", { token })).status, 400);
  assert.equal((await site.call("reorder", { gallery: "baseball", order: "nope" }, { token })).status, 400);
  assert.equal((await site.call("gallery", { gallery: "../../etc" }, { token })).body.error.code, "bad_gallery");
  assert.equal((await site.call("nonsense", {}, { token })).status, 404);
  assert.equal((await site.call("state", undefined, { token, method: "GET" })).status, 405);
  assert.equal((await site.call("publish", { draftSha: "zzz" }, { token })).status, 400);
  assert.equal((await site.call("moments-add", { amount: "1000" }, { token })).body.error.code, "bad_amount");
  assert.equal((await site.call("moments-add", { amount: -5 }, { token })).body.error.code, "bad_amount");
});

// ---------------- reading ----------------

test("gallery view: explicit order, unlisted files appended, missing files skipped, empty gallery ok", async () => {
  const site = await createTestSite();
  const token = await site.login();
  const g = (slug) => site.call("gallery", { gallery: slug }, { token }).then((r) => r.body);
  assert.deepEqual((await g("baseball")).photos.map((p) => p.name), ["c.webp", "a.webp", "b.webp"]);
  assert.deepEqual((await g("soccer")).photos.map((p) => p.name), ["IMG_2.webp", "IMG_10.webp"], "natural sort for unlisted");
  assert.deepEqual((await g("portraits")).photos.map((p) => p.name), ["p1.jpg"], "missing file skipped");
  assert.deepEqual((await g("track")).photos, []);
  const s = await state(site, token);
  assert.equal(s.changes.hasChanges, false);
  assert.equal(s.stats.draft, 68527);
});

// ---------------- upload ----------------

test("adding one photo: validated, stored with a collision-safe name, listed last, pending", async () => {
  const site = await createTestSite();
  const token = await site.login();
  const r = await uploadAndAdd(site, token, "baseball", [{ buf: await makeImage({ format: "webp" }), name: "5N1A4806.webp" }]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.added.length, 1);
  assert.match(r.body.added[0].src, /^\/galleries\/baseball\/5N1A4806-[0-9a-f]{8}\.webp$/);
  assert.equal(order(site, "staging", "baseball").at(-1), r.body.added[0].src);
  assert.equal(site.paths("main").length, site.paths("staging").length - 1, "production untouched");
  const s = await state(site, token);
  assert.deepEqual(s.changes.lines, ["Baseball: 1 photo added"]);
});

test("a batch of photos is one change; JPEG from Safari and WebP from Chrome both accepted", async () => {
  const site = await createTestSite();
  const token = await site.login();
  const before = site.fake.commits.size;
  const r = await uploadAndAdd(site, token, "track", [
    { buf: await makeImage({ format: "jpeg" }), name: "IMG_0001.HEIC" },
    { buf: await makeImage({ format: "webp" }), name: "IMG_0002.JPG" },
    { buf: await makeImage({ format: "jpeg", width: 800, height: 2000 }), name: "tall one (1).jpg" },
  ]);
  assert.equal(r.body.added.length, 3);
  assert.equal(site.fake.commits.size, before + 1, "exactly one commit for the batch");
  const names = order(site, "staging", "track").map((s) => s.split("/").pop());
  assert.match(names[0], /^IMG_0001-[0-9a-f]{8}\.jpg$/, "extension comes from real bytes, not the filename");
  assert.match(names[1], /^IMG_0002-[0-9a-f]{8}\.webp$/);
  assert.match(names[2], /^tall-one-1-[0-9a-f]{8}\.jpg$/);
});

test("same camera filename, different photo: both kept, nothing overwritten", async () => {
  const site = await createTestSite();
  const token = await site.login();
  await uploadAndAdd(site, token, "baseball", [{ buf: await makeImage({ color: { r: 255, g: 0, b: 0 } }), name: "IMG_0001.jpg" }]);
  await uploadAndAdd(site, token, "baseball", [{ buf: await makeImage({ color: { r: 0, g: 0, b: 255 } }), name: "IMG_0001.jpg" }]);
  const list = order(site, "staging", "baseball");
  assert.equal(list.length, 5);
  assert.notEqual(list[3], list[4]);
});

test("exact same photo uploaded twice is skipped, not duplicated or overwritten", async () => {
  const site = await createTestSite();
  const token = await site.login();
  const buf = await makeImage();
  await uploadAndAdd(site, token, "baseball", [{ buf, name: "x.jpg" }]);
  const r = await uploadAndAdd(site, token, "baseball", [{ buf, name: "x.jpg" }, { buf, name: "x-copy.jpg" }]);
  assert.equal(r.body.added.length, 0);
  assert.equal(r.body.skipped.length, 2);
  assert.equal(order(site, "staging", "baseball").length, 4);
});

test("unsupported and oversized images are rejected with useful messages and never stored", async () => {
  const site = await createTestSite();
  const token = await site.login();
  const blobsBefore = site.fake.blobs.size;
  const png = await site.call("upload", undefined, { token, raw: await makeImage({ format: "png" }), headers: { "x-file-name": "a.webp" } });
  assert.equal(png.status, 422);
  assert.equal(png.body.error.code, "unsupported");
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(40)]);
  const h = await site.call("upload", undefined, { token, raw: heic });
  assert.match(h.body.error.message, /HEIC/);
  const text = await site.call("upload", undefined, { token, raw: Buffer.from("hello world, not an image at all") });
  assert.equal(text.body.error.code, "unsupported");
  const huge = await site.call("upload", undefined, { token, raw: await makeImage({ width: 4000, height: 3000 }) });
  assert.equal(huge.body.error.code, "too_big_dimensions");
  const tooManyBytes = await site.call("upload", undefined, { token, raw: Buffer.alloc(3 * 1024 * 1024 + 1, 0xff) });
  assert.equal(tooManyBytes.status, 413);
  assert.equal(site.fake.blobs.size, blobsBefore, "nothing written to the repo");
});

test("path traversal and forged receipts can't write outside the gallery", async () => {
  const site = await createTestSite();
  const token = await site.login();
  const up = await site.call("upload", undefined, { token, raw: await makeImage(), headers: { "x-file-name": encodeURIComponent("../../../src/pages/index.astro") } });
  assert.equal(up.status, 200);
  assert.equal(up.body.receipt.stem, "index");
  const r = await site.call("add", { gallery: "baseball", files: [up.body.receipt] }, { token });
  assert.match(r.body.added[0].src, /^\/galleries\/baseball\/index-[0-9a-f]{8}\.jpg$/);
  assert.equal(site.fake.files("staging")["src/pages/index.astro"].toString(), "<h1>code</h1>");

  const forged = { ...up.body.receipt, stem: "../../evil" };
  assert.equal((await site.call("add", { gallery: "baseball", files: [forged] }, { token })).body.error.code, "bad_receipt");
  const tampered = { ...up.body.receipt, ext: "webp" };
  assert.equal((await site.call("add", { gallery: "baseball", files: [tampered] }, { token })).body.error.code, "bad_receipt");
  assert.equal((await site.call("add", { gallery: "../pages", files: [up.body.receipt] }, { token })).body.error.code, "bad_gallery");
  assert.equal((await site.call("remove", { gallery: "baseball", src: "/../../src/pages/index.astro" }, { token })).body.alreadyGone, true);
  assert.ok(site.fake.files("staging")["src/pages/index.astro"]);
});

// ---------------- delete / restore / reorder ----------------

test("delete: removed from the draft list and folder, production untouched, stats untouched, restorable", async () => {
  const site = await createTestSite();
  const token = await site.login();
  const r = await site.call("remove", { gallery: "baseball", src: "/galleries/baseball/a.webp" }, { token });
  assert.equal(r.body.removed, true);
  assert.deepEqual(order(site, "staging", "baseball"), ["/galleries/baseball/c.webp", "/galleries/baseball/b.webp"]);
  assert.equal(site.fake.files("staging")["public/galleries/baseball/a.webp"], undefined);
  assert.ok(site.fake.files("main")["public/galleries/baseball/a.webp"], "live copy kept until publish");
  let s = await state(site, token);
  assert.deepEqual(s.changes.lines, ["Baseball: 1 photo removed"]);
  assert.equal(s.stats.draft, 68527, "deleting never changes Moments Captured");
  assert.equal(s.changes.galleries[0].removedPhotos[0].src, "/galleries/baseball/a.webp");

  const back = await site.call("restore", { gallery: "baseball", src: "/galleries/baseball/a.webp" }, { token });
  assert.equal(back.body.restored, true);
  assert.deepEqual(order(site, "staging", "baseball"), ["/galleries/baseball/c.webp", "/galleries/baseball/a.webp", "/galleries/baseball/b.webp"], "back in its original spot");
  s = await state(site, token);
  assert.equal(s.changes.hasChanges, false);
});

test("deleting a photo twice is harmless", async () => {
  const site = await createTestSite();
  const token = await site.login();
  await site.call("remove", { gallery: "baseball", src: "/galleries/baseball/a.webp" }, { token });
  const again = await site.call("remove", { gallery: "baseball", src: "/galleries/baseball/a.webp" }, { token });
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyGone, true);
});

test("reorder: saved explicitly, reload shows it, publish keeps it, stats untouched", async () => {
  const site = await createTestSite();
  const token = await site.login();
  const want = ["/galleries/baseball/b.webp", "/galleries/baseball/c.webp", "/galleries/baseball/a.webp"];
  await site.call("reorder", { gallery: "baseball", order: want }, { token });
  const g = await site.call("gallery", { gallery: "baseball" }, { token });
  assert.deepEqual(g.body.photos.map((p) => p.src), want);
  assert.equal(g.body.photos.find((p) => p.name === "a.webp").alt, "slide", "captions travel with photos");
  const s = await state(site, token);
  assert.deepEqual(s.changes.lines, ["Baseball: 1 photo moved"]);
  assert.equal(s.stats.draft, 68527);
  const p = await site.call("publish", { draftSha: s.draftSha }, { token });
  assert.equal(p.body.published, true);
  assert.deepEqual(order(site, "main", "baseball"), want);
});

test("reordering an unlisted gallery writes an explicit order (no more filename sorting)", async () => {
  const site = await createTestSite();
  const token = await site.login();
  await site.call("reorder", { gallery: "soccer", order: ["/galleries/soccer/IMG_10.webp", "/galleries/soccer/IMG_2.webp"] }, { token });
  assert.deepEqual(order(site, "staging", "soccer"), ["/galleries/soccer/IMG_10.webp", "/galleries/soccer/IMG_2.webp"]);
});

test("same order again is a no-op (no commit, nothing pending)", async () => {
  const site = await createTestSite();
  const token = await site.login();
  const before = site.fake.commits.size;
  const r = await site.call("reorder", { gallery: "baseball", order: ["/galleries/baseball/c.webp", "/galleries/baseball/a.webp", "/galleries/baseball/b.webp"] }, { token });
  assert.equal(r.body.changed, false);
  assert.equal(site.fake.commits.size, before);
});

test("delete + reorder together, then publish", async () => {
  const site = await createTestSite();
  const token = await site.login();
  await site.call("remove", { gallery: "baseball", src: "/galleries/baseball/c.webp" }, { token });
  await site.call("reorder", { gallery: "baseball", order: ["/galleries/baseball/b.webp", "/galleries/baseball/a.webp"] }, { token });
  const s = await state(site, token);
  assert.deepEqual(s.changes.lines, ["Baseball: 1 photo removed, 1 photo moved"]);
  await site.call("publish", { draftSha: s.draftSha }, { token });
  assert.deepEqual(order(site, "main", "baseball"), ["/galleries/baseball/b.webp", "/galleries/baseball/a.webp"]);
  assert.equal(site.fake.files("main")["public/galleries/baseball/c.webp"], undefined);
  assert.equal((await state(site, token)).changes.hasChanges, false);
});

// ---------------- Moments Captured ----------------

test("Moments Captured: add to total", async () => {
  const site = await createTestSite();
  const token = await site.login();
  const r = await site.call("moments-add", { amount: 1250 }, { token });
  assert.deepEqual([r.body.before, r.body.after], [68527, 69777]);
  const s = await state(site, token);
  assert.equal(s.stats.live, 68527);
  assert.equal(s.stats.draft, 69777);
  assert.deepEqual(s.changes.lines, ["Moments Captured: 68,527 → 69,777 (+1,250)"]);
  assert.equal(site.json("main", "src/data/stats.json").photosTaken, 68527, "live unchanged until publish");
});

test("Moments Captured: set exact total requires the current value (no stale overwrite)", async () => {
  const site = await createTestSite();
  const token = await site.login();
  const stale = await site.call("moments-set", { value: 72000, expected: 60000 }, { token });
  assert.equal(stale.status, 409);
  assert.equal(site.json("staging", "src/data/stats.json").photosTaken, 68527);
  const r = await site.call("moments-set", { value: 72000, expected: 68527 }, { token });
  assert.equal(r.body.after, 72000);
  assert.equal(site.json("staging", "src/data/stats.json").photosTaken, 72000);
  assert.equal((await site.call("moments-set", { value: 72000 }, { token })).body.error.code, "bad_expected");
});

test("upload then add the uploaded count to Moments Captured (explicit second step)", async () => {
  const site = await createTestSite();
  const token = await site.login();
  const imgs = [];
  for (let i = 0; i < 4; i++) imgs.push({ buf: await makeImage(), name: `s${i}.jpg` });
  const r = await uploadAndAdd(site, token, "hockey", imgs);
  assert.equal(site.json("staging", "src/data/stats.json").photosTaken, 68527, "uploading alone never changes the total");
  await site.call("moments-add", { amount: r.body.added.length }, { token });
  const s = await state(site, token);
  assert.deepEqual(s.changes.lines, ["Hockey: 4 photos added", "Moments Captured: 68,527 → 68,531 (+4)"]);
});

// ---------------- pending detection ----------------

test("pending: stats-only change is detected", async () => {
  const site = await createTestSite();
  const token = await site.login();
  await site.call("moments-add", { amount: 1 }, { token });
  assert.equal((await state(site, token)).changes.hasChanges, true);
});

test("pending: deleted-only change is detected", async () => {
  const site = await createTestSite();
  const token = await site.login();
  await site.call("remove", { gallery: "portraits", src: "/galleries/portraits/p1.jpg" }, { token });
  const s = await state(site, token);
  assert.equal(s.changes.hasChanges, true);
  assert.deepEqual(s.changes.lines, ["Portraits: 1 photo removed"]);
});

test("pending: modified-only change (the stranded Sept 16 shrink commit) is detected and publishable", async () => {
  const site = await createTestSite();
  const token = await site.login();
  // Simulate the old bot: same filenames, smaller bytes, committed on staging.
  site.fake.commitTo("staging", {
    "public/galleries/soccer/IMG_2.webp": await makeImage({ format: "webp", width: 600, height: 400 }),
    "src/data/galleries/soccer.json": JSON.stringify({ images: [{ src: "/galleries/soccer/IMG_2.webp", alt: "" }, { src: "/galleries/soccer/IMG_10.webp", alt: "" }] }, null, 2) + "\n",
  });
  const s = await state(site, token);
  assert.equal(s.changes.hasChanges, true);
  assert.deepEqual(s.changes.lines, ["Soccer: 1 photo updated"]);
  const p = await site.call("publish", { draftSha: s.draftSha }, { token });
  assert.equal(p.body.published, true);
  assert.equal((await state(site, token)).changes.hasChanges, false);
});

test("pending: reorder-only change is detected", async () => {
  const site = await createTestSite();
  const token = await site.login();
  await site.call("reorder", { gallery: "baseball", order: ["/galleries/baseball/a.webp"] }, { token });
  const s = await state(site, token);
  assert.equal(s.changes.hasChanges, true);
  assert.match(s.changes.lines[0], /moved/);
});

test("discard all unpublished changes puts the draft back to what's live", async () => {
  const site = await createTestSite();
  const token = await site.login();
  await site.call("remove", { gallery: "baseball", src: "/galleries/baseball/a.webp" }, { token });
  await site.call("moments-add", { amount: 99 }, { token });
  await uploadAndAdd(site, token, "cars", [{ buf: await makeImage(), name: "car.jpg" }]);
  await site.call("discard", {}, { token });
  const s = await state(site, token);
  assert.equal(s.changes.hasChanges, false);
  assert.deepEqual(site.paths("staging"), site.paths("main"));
});

// ---------------- publishing ----------------

test("publish applies every content difference in ONE production commit and levels the draft", async () => {
  const site = await createTestSite();
  const token = await site.login();
  await uploadAndAdd(site, token, "baseball", [{ buf: await makeImage(), name: "new.jpg" }]);
  await site.call("remove", { gallery: "portraits", src: "/galleries/portraits/p1.jpg" }, { token });
  await site.call("moments-add", { amount: 10 }, { token });
  const s = await state(site, token);
  const mainBefore = site.fake.ref("main");
  const p = await site.call("publish", { draftSha: s.draftSha }, { token });
  assert.equal(p.body.published, true);
  assert.deepEqual(site.fake.commits.get(site.fake.ref("main")).parents, [mainBefore, s.draftSha]);
  assert.equal(site.fake.ref("staging"), site.fake.ref("main"));
  assert.equal(site.json("main", "src/data/stats.json").photosTaken, 68537);
  assert.equal(order(site, "main", "baseball").length, 4);
  assert.equal(site.fake.files("main")["public/galleries/portraits/p1.jpg"], undefined);
  assert.equal((await state(site, token)).changes.hasChanges, false);
});

test("nothing to publish says so and creates no deploy", async () => {
  const site = await createTestSite();
  const token = await site.login();
  const s = await state(site, token);
  const before = site.fake.ref("main");
  const p = await site.call("publish", { draftSha: s.draftSha }, { token });
  assert.equal(p.body.nothingToPublish, true);
  assert.equal(site.fake.ref("main"), before);
});

test("publish refuses a draft that changed after it was reviewed (e.g. another device)", async () => {
  const site = await createTestSite();
  const token = await site.login();
  await site.call("moments-add", { amount: 5 }, { token });
  const reviewed = (await state(site, token)).draftSha;
  await site.call("remove", { gallery: "baseball", src: "/galleries/baseball/b.webp" }, { token }); // other device
  const mainBefore = site.fake.ref("main");
  const p = await site.call("publish", { draftSha: reviewed }, { token });
  assert.equal(p.status, 409);
  assert.equal(p.body.error.code, "stale_draft");
  assert.equal(site.fake.ref("main"), mainBefore, "production untouched");
});

test("publish while an upload batch is mid-flight: only saved changes publish, the batch is not lost", async () => {
  const site = await createTestSite();
  const token = await site.login();
  await site.call("moments-add", { amount: 1 }, { token });
  // Batch step 1 done (photo sent), step 2 (save to gallery) not yet.
  const up = await site.call("upload", undefined, { token, raw: await makeImage(), headers: { "x-file-name": "mid.jpg" } });
  const s = await state(site, token);
  const p = await site.call("publish", { draftSha: s.draftSha }, { token });
  assert.equal(p.body.published, true);
  assert.equal(order(site, "main", "baseball").length, 3, "unsaved photo not published");
  const add = await site.call("add", { gallery: "baseball", files: [up.body.receipt] }, { token });
  assert.equal(add.body.added.length, 1, "the batch still saves afterwards");
  assert.equal((await state(site, token)).changes.lines[0], "Baseball: 1 photo added");
});

test("publish failure (GitHub error) leaves production and the draft intact, and retry works", async () => {
  const site = await createTestSite();
  const token = await site.login();
  await site.call("moments-add", { amount: 7 }, { token });
  const s = await state(site, token);
  const mainBefore = site.fake.ref("main");
  site.fake.fault("PATCH", /refs\/heads\/main$/, 500, 1);
  const p = await site.call("publish", { draftSha: s.draftSha }, { token });
  assert.equal(p.status, 502);
  assert.match(p.body.error.message, /Nothing was lost/);
  assert.equal(site.fake.ref("main"), mainBefore);
  assert.equal(site.fake.ref("staging"), s.draftSha);
  const again = await site.call("publish", { draftSha: s.draftSha }, { token });
  assert.equal(again.body.published, true);
  assert.equal(site.json("main", "src/data/stats.json").photosTaken, 68534);
});

test("expired/revoked GitHub token gives a clear message, no crash", async () => {
  const site = await createTestSite();
  const token = await site.login();
  site.fake.fault("GET", /git\/ref\/heads\/main$/, 401, 5);
  const r = await site.call("state", {}, { token });
  assert.equal(r.status, 502);
  assert.equal(r.body.error.code, "storage_denied");
});

test("a code push to main is never reverted by publishing older draft content", async () => {
  const site = await createTestSite();
  const token = await site.login();
  await site.call("moments-add", { amount: 3 }, { token });
  // Logan deploys code (and even tweaks a gallery Jacob didn't touch) on main.
  site.fake.commitTo("main", { "src/pages/index.astro": "<h1>new code</h1>", "src/data/galleries/cars.json": JSON.stringify({ cover: "/covers/cars.jpg", images: [] }) });
  const s = await state(site, token);
  assert.deepEqual(s.changes.lines, ["Moments Captured: 68,527 → 68,530 (+3)"]);
  await site.call("publish", { draftSha: s.draftSha }, { token });
  const main = site.fake.files("main");
  assert.equal(main["src/pages/index.astro"].toString(), "<h1>new code</h1>");
  assert.equal(JSON.parse(main["src/data/galleries/cars.json"]).cover, "/covers/cars.jpg");
  assert.equal(site.json("main", "src/data/stats.json").photosTaken, 68530);
});

test("main moving during publish (race) is retried safely", async () => {
  const site = await createTestSite();
  const token = await site.login();
  await site.call("moments-add", { amount: 2 }, { token });
  const s = await state(site, token);
  let once = true;
  site.fake.hooks.beforeRefUpdate = async (branch) => {
    if (branch === "main" && once) { once = false; site.fake.commitTo("main", { "src/pages/index.astro": "<h1>raced</h1>" }); }
  };
  const p = await site.call("publish", { draftSha: s.draftSha }, { token });
  assert.equal(p.body.published, true);
  assert.equal(site.fake.files("main")["src/pages/index.astro"].toString(), "<h1>raced</h1>");
  assert.equal(site.json("main", "src/data/stats.json").photosTaken, 68529);
});

// ---------------- concurrency ----------------

test("concurrent changes from two devices all land (no lost updates)", async () => {
  const site = await createTestSite();
  const token = await site.login();
  const ups = [];
  for (let i = 0; i < 3; i++) {
    const r = await site.call("upload", undefined, { token, raw: await makeImage(), headers: { "x-file-name": `c${i}.jpg` } });
    ups.push(r.body.receipt);
  }
  const results = await Promise.all([
    site.call("add", { gallery: "baseball", files: [ups[0]] }, { token }),
    site.call("add", { gallery: "baseball", files: [ups[1]] }, { token }),
    site.call("add", { gallery: "football", files: [ups[2]] }, { token }),
    site.call("moments-add", { amount: 100 }, { token }),
    site.call("moments-add", { amount: 1 }, { token }),
    site.call("remove", { gallery: "baseball", src: "/galleries/baseball/b.webp" }, { token }),
    site.call("reorder", { gallery: "baseball", order: ["/galleries/baseball/a.webp"] }, { token }),
  ]);
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));
  const baseball = order(site, "staging", "baseball");
  assert.equal(baseball.length, 4, "3 original - 1 removed + 2 added");
  assert.ok(!baseball.includes("/galleries/baseball/b.webp"));
  assert.equal(order(site, "staging", "football").length, 1);
  assert.equal(site.json("staging", "src/data/stats.json").photosTaken, 68628, "both increments counted");
  // every listed photo has its file and vice versa
  const files = site.paths("staging", "public/galleries/baseball/").map((p) => "/" + p.slice(7));
  assert.deepEqual([...baseball].sort(), files.sort());
});

test("persistent conflicts give up with a friendly retry message instead of corrupting", async () => {
  const site = await createTestSite();
  const token = await site.login();
  site.fake.hooks.beforeRefUpdate = async (branch) => {
    if (branch === "staging") site.fake.commitTo("staging", { "src/pages/noise.txt": String(Math.random()) });
  };
  const r = await site.call("moments-add", { amount: 1 }, { token });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "busy");
  site.fake.hooks.beforeRefUpdate = null;
  assert.equal(site.json("staging", "src/data/stats.json").photosTaken, 68527);
});

// ---------------- live status ----------------

test("publish status only reports live once the site serves the published commit (or newer)", async () => {
  const site = await createTestSite();
  const token = await site.login();
  await site.call("moments-add", { amount: 1 }, { token });
  const s = await state(site, token);
  const p = await site.call("publish", { draftSha: s.draftSha }, { token });
  const productionSha = p.body.productionSha;
  let st = await site.call("publish-status", { productionSha }, { token });
  assert.equal(st.body.live, false, "old build still live");
  site.live.fail = true;
  st = await site.call("publish-status", { productionSha }, { token });
  assert.equal(st.body.live, false, "site unreachable is not success");
  site.live.fail = false;
  site.live.commit = productionSha;
  st = await site.call("publish-status", { productionSha }, { token });
  assert.equal(st.body.live, true);
  site.live.commit = site.fake.commitTo("main", { "src/pages/index.astro": "later code" });
  st = await site.call("publish-status", { productionSha }, { token });
  assert.equal(st.body.live, true, "a newer build that contains it also counts");
});

test("retry publish: refused while recent or already live, allowed after a stuck build", async () => {
  const site = await createTestSite();
  const token = await site.login();
  site.live.commit = site.fake.ref("main");
  assert.equal((await site.call("retry-publish", {}, { token })).body.alreadyLive, true);
  await site.call("moments-add", { amount: 1 }, { token });
  const s = await state(site, token);
  await site.call("publish", { draftSha: s.draftSha }, { token });
  const commitDate = Date.parse(site.fake.commits.get(site.fake.ref("main")).date);
  site.advance(commitDate - Date.parse("2026-09-17T12:00:00Z") + 60_000);
  assert.equal((await site.call("retry-publish", {}, { token })).body.error.code, "too_soon");
  site.advance(5 * 60_000);
  const before = site.fake.ref("main");
  const r = await site.call("retry-publish", {}, { token });
  assert.equal(r.body.retried, true);
  assert.notEqual(site.fake.ref("main"), before);
  assert.deepEqual(site.paths("main"), site.paths(before), "retry changes no content");
});

test("a lagging GitHub read never shows older state when the browser knows a newer commit", async () => {
  const site = await createTestSite();
  const token = await site.login();
  const r = await site.call("moments-add", { amount: 9 }, { token });
  const newer = r.body.draftSha;
  const older = site.fake.commits.get(newer).parents[0];
  site.fake.refs.set("staging", older); // simulate a replica that hasn't seen the write
  const lagging = await site.call("state", {}, { token });
  assert.equal(lagging.body.stats.draft, 68527, "without a hint the stale read shows");
  const hinted = await site.call("state", {}, { token, headers: { "x-known-draft": newer } });
  assert.equal(hinted.body.stats.draft, 68536);
  assert.equal(hinted.body.draftSha, newer);
  const bogus = await site.call("state", {}, { token, headers: { "x-known-draft": "f".repeat(40) } });
  assert.equal(bogus.status, 200, "unknown hints are ignored safely");
  site.fake.refs.set("staging", newer);
});
