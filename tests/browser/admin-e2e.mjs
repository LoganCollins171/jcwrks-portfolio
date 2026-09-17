// End-to-end test of the /admin page in real browser engines against the local
// fake-repo server (tests/browser/dev-server.mjs). Never touches real content.
//
//   PLAYWRIGHT=/path/to/node_modules/playwright FIXTURES=/path/to/fixtures SHOTS=/path/to/screens \
//     node tests/browser/admin-e2e.mjs chromium-desktop|webkit-iphone|chromium-android
//
// FIXTURES needs: CAMERA_0001.JPG (big camera JPG), ROTATED_6.jpg (EXIF orientation 6),
// IMG_0042.jpg, other/IMG_0042.jpg (different photo, same name), IPHONE_0099.HEIC, notes.jpg (not an image)

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT);
const FIX = process.env.FIXTURES;
const SHOTS = process.env.SHOTS;
const profile = process.argv[2] || "chromium-desktop";
mkdirSync(SHOTS, { recursive: true });

const PORTS = { "chromium-desktop": 4411, "webkit-iphone": 4412, "chromium-android": 4413, "webkit-desktop": 4414 };
const PORT = PORTS[profile];
const BASE = `http://localhost:${PORT}`;
const results = [];
const step = async (name, fn) => {
  try { const r = await fn(); results.push([r === "SKIP" ? "UNVERIFIED" : "PASS", name]); }
  catch (err) { results.push(["FAIL", name, err.message.split("\n")[0]]); }
};

const server = spawn(process.execPath, ["tests/browser/dev-server.mjs", String(PORT)], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, DEPLOY_DELAY_MS: "5000" } });
await new Promise((r) => server.stdout.on("data", (d) => { if (String(d).includes("admin test server")) r(); }));

const engine = profile.startsWith("webkit") ? webkit : chromium;
const browser = await engine.launch();
const ctxOpts =
  profile === "webkit-iphone" ? { ...devices["iPhone 13"] } :
  profile === "chromium-android" ? { ...devices["Pixel 7"] } :
  { viewport: { width: 1280, height: 900 } };
const context = await browser.newContext(ctxOpts);
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));
const shot = (n) => page.screenshot({ path: `${SHOTS}/${profile}-${n}.png`, fullPage: true });
const serverState = () => fetch(`${BASE}/__test/state`).then((r) => r.json());
const tileNames = () => page.$$eval("#grid .tile", (ts) => ts.map((t) => t.dataset.src.split("/").pop()));
const isTouch = profile !== "chromium-desktop" && profile !== "webkit-desktop";
const tap = (loc) => (isTouch ? loc.tap() : loc.click());

await step("wrong password shows a friendly error", async () => {
  await page.goto(`${BASE}/admin/`);
  await page.fill("#pw", "wrong");
  await tap(page.locator("#loginBtn"));
  await page.waitForFunction(() => document.getElementById("loginMsg").textContent.length > 0);
  assert.match(await page.textContent("#loginMsg"), /isn't right/);
});

await step("sign in and load dashboard", async () => {
  await page.fill("#pw", "test-password-not-real");
  await tap(page.locator("#loginBtn"));
  await page.waitForSelector("#appView:not([hidden])");
  await page.selectOption("#gallery", "baseball");
  await page.waitForFunction(() => document.querySelectorAll("#grid .tile").length === 8);
  assert.equal(await page.textContent("#momentsValue"), "68,527");
  assert.match(await page.textContent("#changesNone"), /Everything is up to date/);
  await page.waitForTimeout(400);
  await shot("01-dashboard");
});

await step("thumbnails render", async () => {
  const loaded = await page.$$eval("#grid .tile img", (imgs) => imgs.filter((i) => i.complete && i.naturalWidth > 0).length);
  assert.equal(loaded, 8);
});

let offerN = 0;
await step("upload batch: camera JPG, EXIF-rotated, normal, HEIC, fake file", async () => {
  await page.setInputFiles("#fileInput", [`${FIX}/CAMERA_0001.JPG`, `${FIX}/ROTATED_6.jpg`, `${FIX}/IMG_0042.jpg`, `${FIX}/IPHONE_0099.HEIC`, `${FIX}/notes.jpg`]);
  await page.waitForSelector("#uploadPanel:not([hidden])");
  await shot("02-uploading");
  await page.waitForSelector("#uploadActions:not([hidden])", { timeout: 90000 });
  await page.waitForTimeout(300);
  const statuses = await page.$$eval("#uploadList li", (lis) => lis.map((li) => [li.querySelector(".nm").textContent, li.querySelector(".st").textContent]));
  const st = Object.fromEntries(statuses);
  assert.match(st["CAMERA_0001.JPG"], /Added ✓/);
  assert.match(st["ROTATED_6.jpg"], /Added ✓/);
  assert.match(st["IMG_0042.jpg"], /Added ✓/);
  assert.match(st["notes.jpg"], /couldn't be opened as a photo/);
  results.push(["INFO", `HEIC in ${profile}: ${st["IPHONE_0099.HEIC"]}`]);
  assert.ok(/Added ✓|HEIC/.test(st["IPHONE_0099.HEIC"]), "HEIC either works or explains itself");
  offerN = statuses.filter(([, s]) => /Added ✓/.test(s)).length;
  await shot("03-upload-done");
});

await step("uploaded bytes are real JPEG/WebP, <=2.5MB, <=2000px, orientation baked in", async () => {
  const s = await serverState();
  for (const u of s.uploads) {
    assert.ok(u.bytes <= 2.5 * 1024 * 1024, `upload ${u.bytes} bytes`);
    assert.ok(/^ffd8ff/.test(u.head) || /^52494646.{8}57454250/.test(u.head), `real format, got ${u.head}`);
  }
  results.push(["INFO", `upload formats in ${profile}: ${[...new Set(s.uploads.map((u) => u.type))].join(", ")}; sizes ${s.uploads.map((u) => Math.round(u.bytes / 1024) + "KB").join(", ")}`]);
  const rotated = s.stagingFiles.find((p) => /ROTATED_6-/.test(p));
  const cam = s.stagingFiles.find((p) => /CAMERA_0001-/.test(p));
  const commit = s.staging;
  const get = (p) => fetch(`${BASE}/raw/${commit}/${p}`).then((r) => r.arrayBuffer()).then((b) => Buffer.from(b));
  const rb = await get(rotated);
  const rm = await sharp(rb).metadata();
  assert.ok(rm.height > rm.width, `rotated photo should be portrait, got ${rm.width}x${rm.height}`);
  const { data, info } = await sharp(rb).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => { const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]]; };
  const tr = px(info.width - 5, 5);
  assert.ok(tr[0] > 150 && tr[2] < 100, `red corner should be top-right after rotation, got ${tr}`);
  const cm = await sharp(await get(cam)).metadata();
  assert.equal(Math.max(cm.width, cm.height), 2000);
});

await step("offer to add uploaded count to Moments Captured (explicit checkbox)", async () => {
  await page.waitForSelector("#momentsOffer:not([hidden])");
  assert.equal(await page.textContent("#offerCount"), String(offerN));
  assert.equal(await page.isDisabled("#offerBtn"), true, "button disabled until ticked");
  await tap(page.locator("#offerCheck"));
  await tap(page.locator("#offerBtn"));
  await page.waitForFunction((v) => document.getElementById("momentsValue").textContent === v, (68527 + offerN).toLocaleString("en-US"));
  assert.match(await page.textContent("#momentsLive"), /On your site now: 68,527/);
});

await step("same camera filename, different photo: both kept; identical photo skipped", async () => {
  await tap(page.locator("#closeUpload"));
  await page.setInputFiles("#fileInput", [`${FIX}/other/IMG_0042.jpg`]);
  await page.waitForSelector("#uploadActions:not([hidden])", { timeout: 60000 });
  await page.waitForFunction(() => /Added ✓/.test(document.querySelector("#uploadList .st").textContent));
  await tap(page.locator("#closeUpload"));
  await page.setInputFiles("#fileInput", [`${FIX}/IMG_0042.jpg`]);
  await page.waitForSelector("#uploadActions:not([hidden])", { timeout: 60000 });
  const st = await page.textContent("#uploadList .st");
  const s = await serverState();
  const named = s.stagingFiles.filter((p) => p.includes("/IMG_0042-"));
  if (profile.startsWith("webkit") || /Already/.test(st)) {
    assert.match(st, /Already in this gallery/);
  } else {
    // Chrome may re-encode to identical bytes; either way no overwrite
    assert.ok(/Already|Added/.test(st));
  }
  assert.equal(named.length, 2, `two different IMG_0042 photos kept, got ${named}`);
  await tap(page.locator("#closeUpload"));
});

await step("reorder with the tap menu, Save order, persisted", async () => {
  const before = await tileNames();
  await tap(page.locator("#grid .tile").first());
  await page.waitForSelector("#photoSheet[open]");
  await shot("04-photo-sheet");
  await tap(page.locator('[data-move="last"]'));
  await page.waitForSelector("#orderBar:not([hidden])");
  assert.equal(await page.isDisabled("#publishBtn"), true, "can't publish with unsaved order");
  await shot("05-order-unsaved");
  await tap(page.locator("#saveOrder"));
  await page.waitForSelector("#orderBar", { state: "hidden" });
  const after = await tileNames();
  assert.equal(after.at(-1), before[0]);
  const s = await serverState();
  assert.equal(s.stagingBaseball.images.at(-1).src.split("/").pop(), before[0]);
});

await step("reorder by dragging", async () => {
  if (profile === "webkit-iphone") {
    results.push(["INFO", "WebKit touch-drag: Playwright cannot inject touch drags into WebKit, so this is UNVERIFIED here (tap-menu reorder verified above)"]);
    return "SKIP";
  }
  const before = await tileNames();
  await page.locator("#photosTitle").scrollIntoViewIfNeeded();
  await page.evaluate(() => document.getElementById("grid").scrollIntoView({ block: "start" }));
  await page.waitForTimeout(300);
  const from = page.locator("#grid .tile").nth(0);
  const to = page.locator("#grid .tile").nth(3);
  const fb = await from.boundingBox();
  const tb = await to.boundingBox();
  if (isTouch && profile.startsWith("chromium")) {
    const cdp = await context.newCDPSession(page);
    const pt = (b, dx = 0) => ({ x: b.x + b.width / 2 + dx, y: b.y + b.height / 2 });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pt(fb)] });
    await page.waitForTimeout(450); // press and hold
    for (let i = 1; i <= 12; i++) {
      const x = fb.x + fb.width / 2 + ((tb.x - fb.x) * i) / 12 + 10;
      const y = fb.y + fb.height / 2 + ((tb.y - fb.y) * i) / 12;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
      await page.waitForTimeout(30);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else if (isTouch) {
    // WebKit: no touch-drag injection available in Playwright; fall back to mouse on the same page.
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(300);
    for (let i = 1; i <= 12; i++) await page.mouse.move(fb.x + fb.width / 2 + ((tb.x - fb.x) * i) / 12 + 10, fb.y + fb.height / 2 + ((tb.y - fb.y) * i) / 12);
    await page.mouse.up();
  } else {
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 15; i++) await page.mouse.move(fb.x + fb.width / 2 + ((tb.x - fb.x) * i) / 15 + 10, fb.y + fb.height / 2 + ((tb.y - fb.y) * i) / 15, { steps: 2 });
    await page.mouse.up();
  }
  await page.waitForTimeout(500);
  const after = await tileNames();
  const moved = JSON.stringify(after) !== JSON.stringify(before);
  if (!moved) throw new Error("drag did not change the order in this engine/input mode");
  await page.waitForSelector("#orderBar:not([hidden])");
  await tap(page.locator("#saveOrder"));
  await page.waitForSelector("#orderBar", { state: "hidden" });
  const s = await serverState();
  assert.deepEqual(s.stagingBaseball.images.map((i) => i.src.split("/").pop()), after);
});

await step("delete needs confirmation; cancel keeps it; remove; undo from publish card; remove again", async () => {
  const names = await tileNames();
  const target = names.find((n) => n.startsWith("TEST-"));
  const idx = names.indexOf(target);
  await tap(page.locator("#grid .tile").nth(idx));
  await page.waitForSelector("#photoSheet[open]");
  await tap(page.locator("#sheetRemove"));
  await page.waitForSelector("#confirmDialog[open]");
  assert.match(await page.textContent("#confirmTitle"), /Remove this photo from Baseball\?/);
  assert.match(await page.textContent("#confirmText"), /stays on your live site until you publish/);
  await shot("06-delete-confirm");
  await tap(page.locator("#confirmCancel"));
  assert.ok((await tileNames()).includes(target));
  await tap(page.locator("#grid .tile").nth(idx));
  await page.waitForSelector("#photoSheet[open]");
  await tap(page.locator("#sheetRemove"));
  await page.waitForSelector("#confirmDialog[open]");
  await tap(page.locator("#confirmOk"));
  await page.waitForFunction((t) => ![...document.querySelectorAll("#grid .tile")].some((x) => x.dataset.src.endsWith(t)), target);
  await page.waitForSelector("#removedList .removed-row");
  let s = await serverState();
  assert.ok(s.mainFiles.some((p) => p.endsWith(target)), "live copy untouched");
  assert.ok(!s.stagingFiles.some((p) => p.endsWith(target)));
  assert.equal(s.stagingStats.photosTaken, 68527 + offerN, "delete doesn't change Moments Captured");
  await tap(page.locator("#removedList .removed-row button"));
  await page.waitForFunction((t) => [...document.querySelectorAll("#grid .tile")].some((x) => x.dataset.src.endsWith(t)), target);
  await tap(page.locator("#grid .tile").nth((await tileNames()).indexOf(target)));
  await page.waitForSelector("#photoSheet[open]");
  await tap(page.locator("#sheetRemove"));
  await page.waitForSelector("#confirmDialog[open]");
  await tap(page.locator("#confirmOk"));
  await page.waitForSelector("#removedList .removed-row");
  s = await serverState();
  assert.ok(!s.stagingFiles.some((p) => p.endsWith(target)));
});

await step("Moments Captured: add 1,250 with preview", async () => {
  const cur = 68527 + offerN;
  await tap(page.locator("#momentsAddBtn"));
  await page.waitForSelector("#numberDialog[open]");
  await page.fill("#numberInput", "1,250");
  assert.equal(await page.textContent("#numberPreview"), `${cur.toLocaleString("en-US")} → ${(cur + 1250).toLocaleString("en-US")}`);
  await shot("07-moments-add");
  await tap(page.locator("#numberOk"));
  await page.waitForFunction((v) => document.getElementById("momentsValue").textContent === v, (cur + 1250).toLocaleString("en-US"));
});

await step("Moments Captured: set exact total needs a confirmation tick", async () => {
  const cur = 68527 + offerN + 1250;
  await tap(page.locator("#momentsSetBtn"));
  await page.waitForSelector("#numberDialog[open]");
  await page.fill("#numberInput", "72000");
  assert.equal(await page.isDisabled("#numberOk"), true);
  assert.match(await page.textContent("#numberCheckText"), /set my total to 72,000/);
  await tap(page.locator("#numberCheck"));
  assert.equal(await page.isDisabled("#numberOk"), false);
  await shot("08-moments-set");
  await tap(page.locator("#numberOk"));
  await page.waitForFunction(() => document.getElementById("momentsValue").textContent === "72,000");
  assert.ok(cur > 0);
});

await step("unpublished summary lists everything", async () => {
  await page.waitForSelector("#changesSome:not([hidden])");
  const lines = await page.$$eval("#changesList li", (l) => l.map((x) => x.textContent));
  results.push(["INFO", `summary: ${lines.join(" | ")}`]);
  assert.ok(lines.some((l) => /^Baseball: .*added.*removed.*moved/.test(l)), lines.join(" | "));
  assert.ok(lines.some((l) => /^Moments Captured: 68,527 → 72,000 \(\+3,473\)$/.test(l)), lines.join(" | "));
  await page.locator("#publishCard").scrollIntoViewIfNeeded();
  await shot("09-review");
});

await step("session survives reload; order and changes still there", async () => {
  const names = await tileNames();
  await page.reload();
  await page.waitForSelector("#appView:not([hidden])");
  await page.selectOption("#gallery", "baseball");
  await page.waitForFunction((n) => document.querySelectorAll("#grid .tile").length === n, names.length);
  assert.deepEqual(await tileNames(), names);
  assert.equal(await page.textContent("#momentsValue"), "72,000");
});

await step("publish: confirm, updating, only then Published ✓; production matches draft", async () => {
  await tap(page.locator("#publishBtn"));
  await page.waitForSelector("#confirmDialog[open]");
  assert.match(await page.textContent("#confirmText"), /Moments Captured/);
  await tap(page.locator("#confirmOk"));
  await page.waitForFunction(() => /Updating your live site|Publishing/.test(document.getElementById("pubTitle").textContent));
  await shot("10-publishing");
  const early = await page.textContent("#pubTitle");
  assert.ok(!/Published ✓/.test(early), "must not claim success before the site updates");
  await page.waitForFunction(() => document.getElementById("pubTitle").textContent === "Published ✓", null, { timeout: 45000 });
  await shot("11-published");
  const s = await serverState();
  assert.equal(s.live, s.main);
  assert.equal(s.mainStats.photosTaken, 72000);
  assert.deepEqual(s.mainBaseball, s.stagingBaseball);
  assert.deepEqual([...s.mainFiles].sort(), [...s.stagingFiles].sort());
  await page.waitForSelector("#changesNone:not([hidden])");
});

await step("stuck deploy never shows Published ✓", async () => {
  await fetch(`${BASE}/__test/deploy-mode`, { method: "POST", body: JSON.stringify({ mode: "stuck" }) });
  await tap(page.locator("#pubDismiss"));
  await tap(page.locator("#momentsAddBtn"));
  await page.waitForSelector("#numberDialog[open]");
  await page.fill("#numberInput", "5");
  await tap(page.locator("#numberOk"));
  await page.waitForFunction(() => document.getElementById("momentsValue").textContent === "72,005");
  await tap(page.locator("#publishBtn"));
  await page.waitForSelector("#confirmDialog[open]");
  await tap(page.locator("#confirmOk"));
  await page.waitForTimeout(12000);
  assert.match(await page.textContent("#pubTitle"), /Updating your live site/);
});

await step("no JavaScript errors", async () => {
  const real = consoleErrors.filter((e) => !/Failed to load resource.*(fonts|404)|status of 4(0[14]|22|29)/i.test(e));
  assert.deepEqual(real, []);
});

await browser.close();
server.kill();
console.log(`\n=== ${profile} ===`);
for (const r of results) console.log(r.join("  "));
process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
