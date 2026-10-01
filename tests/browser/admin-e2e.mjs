// Full owner journey + deliberate failures, in real browser engines, against
// the local fake-repo server (tests/browser/dev-server.mjs). Never touches real content.
//
//   PLAYWRIGHT=/path/to/node_modules/playwright FIXTURES=/path/to/fixtures SHOTS=/path/to/screens \
//   AXE=/path/to/node_modules/axe-core/axe.min.js \
//     node tests/browser/admin-e2e.mjs chromium-desktop|webkit-iphone|chromium-android|webkit-tablet
//
// FIXTURES needs: CAMERA_0001.JPG (big camera JPG), ROTATED_6.jpg (EXIF orientation 6),
// IMG_0042.jpg, other/IMG_0042.jpg (different photo, same name), IPHONE_0099.HEIC, notes.jpg (not an image)

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT);
const FIX = process.env.FIXTURES;
const SHOTS = process.env.SHOTS;
const profile = process.argv[2] || "chromium-desktop";
mkdirSync(SHOTS, { recursive: true });

const PORTS = { "chromium-desktop": 4411, "webkit-iphone": 4412, "chromium-android": 4413, "webkit-tablet": 4414 };
const PORT = PORTS[profile];
const BASE = `http://localhost:${PORT}`;
const results = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const r = await fn(); results.push([r === "SKIP" ? "UNVERIFIED" : "PASS", `${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`]); }
  catch (err) { results.push(["FAIL", name, err.message.split("\n")[0]]); await shot(`FAIL-${name.slice(0, 30).replace(/\W+/g, "-")}`).catch(() => {}); }
};

const server = spawn(process.execPath, ["tests/browser/dev-server.mjs", String(PORT)], {
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, DEPLOY_DELAY_MS: "3000", CLOCK_SKEW_MS: String(10 * 60 * 1000) },
});
await new Promise((r) => server.stdout.on("data", (d) => { if (String(d).includes("admin test server")) r(); }));

const engine = profile.startsWith("webkit") ? webkit : chromium;
const browser = await engine.launch();
const ctxOpts =
  profile === "webkit-iphone" ? { ...devices["iPhone 13"] } :
  profile === "chromium-android" ? { ...devices["Pixel 7"] } :
  profile === "webkit-tablet" ? { viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true } :
  { viewport: { width: 1280, height: 900 } };
const context = await browser.newContext(ctxOpts);
await context.addInitScript(() => { try { sessionStorage.setItem("jcwrks_admin_test_fast", "1"); } catch {} });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));
async function shot(n) { await page.screenshot({ path: `${SHOTS}/${profile}-${n}.png`, fullPage: false }); }
const srv = () => fetch(`${BASE}/__test/state`).then((r) => r.json());
const fault = (f) => fetch(`${BASE}/__test/fault`, { method: "POST", body: JSON.stringify(f) });
const deployMode = (mode) => fetch(`${BASE}/__test/deploy-mode`, { method: "POST", body: JSON.stringify({ mode }) });
const tiles = () => page.$$eval("#grid .tile", (ts) => ts.map((t) => t.dataset.src));
const isTouch = profile !== "chromium-desktop";
const tap = (sel) => (isTouch ? page.locator(sel).first().tap() : page.locator(sel).first().click());
const tapTile = (i) => (isTouch ? page.locator("#grid .tile").nth(i).tap() : page.locator("#grid .tile").nth(i).click());
const text = (sel) => page.locator(sel).first().textContent();
const waitText = (sel, re, timeout = 30000) => page.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s)?.textContent || ""), [sel, re.source], { timeout });
const waitIdle = () => page.waitForFunction(() => !/Saving|Uploading/.test(document.getElementById("statusText").textContent), null, { timeout: 60000 });
async function openGallery(slug) {
  await tap(`a[href="#/gallery/${slug}"]`);
  await page.waitForSelector("#galleryView:not([hidden])");
  await page.waitForFunction(() => !document.getElementById("emptyGallery").hidden || document.querySelectorAll("#grid .tile").length > 0);
}
async function goHome() {
  await tap("#backLink");
  await page.waitForSelector("#homeView:not([hidden])");
}
async function uploadFiles(paths) {
  await page.setInputFiles("#fileInput", paths);
  await page.waitForSelector("#uploadPanel:not([hidden])");
  await page.waitForSelector("#uploadActions:not([hidden])", { timeout: 120000 });
  await page.waitForTimeout(200);
  return Object.fromEntries(await page.$$eval("#uploadList li", (lis) => lis.map((li) => [li.querySelector(".nm").textContent, li.querySelector(".st").textContent])));
}
async function closeUpload() { await tap("#closeUpload"); await page.waitForSelector("#uploadPanel", { state: "hidden" }); }
async function axe(label) {
  if (!process.env.AXE) return "SKIP";
  await page.addScriptTag({ content: readFileSync(process.env.AXE, "utf8") });
  const r = await page.evaluate(async () => (await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa"] })).violations.map((v) => `${v.id}(${v.nodes.length}: ${v.nodes[0].target.join(" ")})`));
  if (r.length) throw new Error(`axe ${label}: ${r.join(", ")}`);
}

let offerN = 0;
let momentsNow = 68527;

await step("sign in: wrong password is explained, right password opens the dashboard", async () => {
  await page.goto(`${BASE}/admin/`);
  await page.fill("#pw", "wrong");
  await tap("#loginBtn");
  await waitText("#loginMsg", /isn't right/);
  await page.fill("#pw", "test-password-not-real");
  await tap("#loginBtn");
  await page.waitForSelector("#homeView:not([hidden])");
  assert.equal(await text("#mcValue"), "68,527");
  assert.equal(await text("#factPhotos"), "71");
  assert.equal(await text("#factGalleries"), "3 of 11");
  assert.match(await text("#statusText"), /All changes live/);
  assert.match(await text("#msText"), /6,473 more until 75,000/);
  await page.waitForTimeout(500);
  await shot("01-home");
});

await step("accessibility: dashboard has no WCAG A/AA violations", async () => axe("home"));

await step("open Baseball from the dashboard", async () => {
  await openGallery("baseball");
  assert.equal((await tiles()).length, 8);
  assert.equal(await text("#gTitle"), "Baseball");
  await shot("02-gallery");
});

await step("accessibility: gallery has no WCAG A/AA violations", async () => axe("gallery"));

await step("upload a batch: camera JPG, EXIF-rotated, normal, HEIC, not-a-photo", async () => {
  const st = await uploadFiles([`${FIX}/CAMERA_0001.JPG`, `${FIX}/ROTATED_6.jpg`, `${FIX}/IMG_0042.jpg`, `${FIX}/IPHONE_0099.HEIC`, `${FIX}/notes.jpg`]);
  assert.match(st["CAMERA_0001.JPG"], /Saved ✓/);
  assert.match(st["ROTATED_6.jpg"], /Saved ✓/);
  assert.match(st["IMG_0042.jpg"], /Saved ✓/);
  assert.match(st["notes.jpg"], /couldn't be opened as a photo/);
  results.push(["INFO", `HEIC: ${st["IPHONE_0099.HEIC"]}`]);
  assert.ok(/Saved ✓|HEIC/.test(st["IPHONE_0099.HEIC"]));
  offerN = Object.values(st).filter((s) => /Saved ✓/.test(s)).length;
  assert.match(await text("#uploadCounts"), new RegExp(`${offerN} saved.*${5 - offerN} failed`));
  assert.ok(await page.isHidden("#retryFailed"), "no retry offered for files that can never work");
  assert.equal((await tiles()).length, 8 + offerN, "grid updated from the save response");
  assert.match(await text("#statusText"), /Not published yet/);
  const badges = await page.$$eval("#grid .tile .badge", (b) => b.filter((x) => !x.hidden).length);
  assert.equal(badges, offerN, "new photos marked Not live yet");
  await shot("03-uploaded");
});

await step("uploaded bytes are real JPEG/WebP, <=2.5MB, <=2000px, upright", async () => {
  const s = await srv();
  for (const u of s.uploads) {
    assert.ok(u.bytes <= 2.5 * 1024 * 1024, `upload ${u.bytes}`);
    assert.ok(/^ffd8ff/.test(u.head) || /^52494646.{8}57454250/.test(u.head), u.head);
  }
  results.push(["INFO", `formats: ${[...new Set(s.uploads.map((u) => u.type))].join(",")}; sizes: ${s.uploads.map((u) => Math.round(u.bytes / 1024) + "KB").join(", ")}`]);
  const get = async (p) => Buffer.from(await (await fetch(`${BASE}/raw/${s.staging}/${p}`)).arrayBuffer());
  const rb = await get(s.stagingFiles.find((p) => /ROTATED_6-/.test(p)));
  const { data, info } = await sharp(rb).raw().toBuffer({ resolveWithObject: true });
  assert.ok(info.height > info.width, "portrait");
  const i = (5 * info.width + info.width - 5) * info.channels;
  assert.ok(data[i] > 150 && data[i + 2] < 100, "red corner top-right");
  const cm = await sharp(await get(s.stagingFiles.find((p) => /CAMERA_0001-/.test(p)))).metadata();
  assert.equal(Math.max(cm.width, cm.height), 2000);
});

await step("offer: add uploaded count to Moments Captured only when ticked", async () => {
  await page.waitForSelector("#momentsOffer:not([hidden])");
  assert.equal(await text("#offerCount"), String(offerN));
  assert.equal(await page.isDisabled("#offerBtn"), true);
  await tap("#offerCheck");
  await tap("#offerBtn");
  momentsNow += offerN;
  await page.waitForTimeout(300);
  await waitIdle();
  const s = await srv();
  assert.equal(s.stagingStats.photosTaken, momentsNow);
  assert.equal(s.mainStats.photosTaken, 68527);
});

await step("duplicate photo is skipped; different photo with the same name is kept", async () => {
  await closeUpload();
  let st = await uploadFiles([`${FIX}/IMG_0042.jpg`]);
  const dup = Object.values(st)[0];
  if (profile.startsWith("webkit")) assert.match(dup, /Already in this gallery/);
  else assert.match(dup, /Already in this gallery|Saved ✓/); // Chrome may re-encode identically either way
  await closeUpload();
  st = await uploadFiles([`${FIX}/other/IMG_0042.jpg`]);
  assert.match(Object.values(st)[0], /Saved ✓/);
  await closeUpload();
  const s = await srv();
  assert.ok(s.stagingFiles.filter((p) => p.includes("/IMG_0042-")).length >= 2);
});

await step("reorder with Move to position; leaving asks Save / Don't save / Keep editing", async () => {
  const before = await tiles();
  await tapTile(0);
  await page.waitForSelector("#photoSheet[open]");
  await page.fill("#moveToInput", "5");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#orderBar:not([hidden])");
  const after = await tiles();
  assert.equal(after[4], before[0]);
  assert.match(await text("#statusText"), /Order not saved/);
  await shot("04-order-unsaved");
  await tap("#backLink");
  await page.waitForSelector("#confirmDialog[open]");
  const buttons = await page.$$eval("#confirmDialog .modal-actions button", (bs) => bs.filter((b) => !b.hidden).map((b) => b.textContent));
  assert.deepEqual(buttons, ["Keep editing", "Don't save", "Save order"]);
  await tap("#confirmCancel");
  await page.waitForTimeout(400);
  assert.ok(!(await page.isHidden("#galleryView")), "still in the gallery");
  assert.deepEqual(await tiles(), after, "unsaved order kept");
  await tap("#saveOrder");
  await page.waitForSelector("#orderBar", { state: "hidden" });
  await waitIdle();
  const s = await srv();
  assert.deepEqual(s.stagingBaseball.images.map((i) => i.src), after);
});

await step("reorder by dragging", async () => {
  if (profile.startsWith("webkit")) {
    results.push(["INFO", "WebKit touch drag can't be injected by Playwright; tap-menu reordering verified instead"]);
    return "SKIP";
  }
  await page.evaluate(() => document.getElementById("grid").scrollIntoView({ block: "start" }));
  await page.waitForTimeout(300);
  const before = await tiles();
  const fb = await page.locator("#grid .tile").nth(0).boundingBox();
  const tb = await page.locator("#grid .tile").nth(3).boundingBox();
  if (isTouch) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: fb.x + fb.width / 2, y: fb.y + fb.height / 2 }] });
    await page.waitForTimeout(500);
    for (let i = 1; i <= 14; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: fb.x + fb.width / 2 + ((tb.x - fb.x) * i) / 14 + 8, y: fb.y + fb.height / 2 + ((tb.y - fb.y) * i) / 14 }] });
      await page.waitForTimeout(30);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 15; i++) await page.mouse.move(fb.x + fb.width / 2 + ((tb.x - fb.x) * i) / 15 + 10, fb.y + fb.height / 2 + ((tb.y - fb.y) * i) / 15, { steps: 2 });
    await page.mouse.up();
  }
  await page.waitForTimeout(500);
  const after = await tiles();
  assert.notDeepEqual(after, before, "drag changed order");
  await tap("#saveOrder");
  await page.waitForSelector("#orderBar", { state: "hidden" });
  await waitIdle();
  assert.deepEqual((await srv()).stagingBaseball.images.map((i) => i.src), after);
});

await step("select 3 (2 live + 1 new), one confirmation, remove, Undo restores exact order", async () => {
  const before = await tiles();
  const s0 = await srv();
  const newIdx = before.findIndex((src) => !s0.mainFiles.includes("public" + src));
  const liveIdx = before.map((src, i) => [src, i]).filter(([src]) => s0.mainFiles.includes("public" + src)).map(([, i]) => i).slice(0, 2);
  await tap("#selectBtn");
  for (const i of [...liveIdx, newIdx]) await tapTile(i);
  await waitText("#selectCount", /3 selected/);
  await shot("05-selected");
  await tap("#selectRemove");
  await page.waitForSelector("#confirmDialog[open]");
  assert.equal(await text("#confirmTitle"), "Remove 3 photos from Baseball?");
  assert.equal(await page.$$eval("#confirmBody .confirm-thumbs img", (i) => i.length), 3);
  await shot("06-remove-confirm");
  await tap("#confirmOk");
  await page.waitForFunction((n) => document.querySelectorAll("#grid .tile").length === n, before.length - 3);
  await page.waitForSelector("#toast:not([hidden])");
  assert.match(await text("#toastText"), /3 photos removed/);
  let s = await srv();
  for (const i of liveIdx) assert.ok(s.mainFiles.includes("public" + before[i]), "live copies untouched");
  await tap("#toastAction");
  await page.waitForFunction((n) => document.querySelectorAll("#grid .tile").length === n, before.length);
  await waitIdle();
  assert.deepEqual(await tiles(), before, "exact order restored, including the never-published photo");
  s = await srv();
  assert.deepEqual(s.stagingBaseball.images.map((i) => i.src), before);
});

await step("remove one; 'Removed, not published yet' panel; Put back; remove again", async () => {
  const before = await tiles();
  const s0 = await srv();
  const idx = before.findIndex((src) => s0.mainFiles.includes("public" + src));
  const target = before[idx];
  await tapTile(idx);
  await page.waitForSelector("#photoSheet[open]");
  await tap("#sheetRemove");
  await page.waitForSelector("#confirmDialog[open]");
  assert.match(await text("#confirmTitle"), /Remove this photo from Baseball\?/);
  await tap("#confirmCancel");
  await page.waitForTimeout(200);
  assert.deepEqual(await tiles(), before, "cancel keeps it");
  await tapTile(idx);
  await page.waitForSelector("#photoSheet[open]");
  await tap("#sheetRemove");
  await page.waitForSelector("#confirmDialog[open]");
  await tap("#confirmOk");
  await page.waitForSelector("#removedPanel:not([hidden])");
  await waitIdle();
  await shot("07-removed-panel");
  await tap("#removedStrip .btn");
  await page.waitForSelector("#removedPanel", { state: "hidden" });
  await waitIdle();
  assert.deepEqual(await tiles(), before);
  await tapTile(idx);
  await page.waitForSelector("#photoSheet[open]");
  await tap("#sheetRemove");
  await page.waitForSelector("#confirmDialog[open]");
  await tap("#confirmOk");
  await page.waitForSelector("#removedPanel:not([hidden])");
  await waitIdle();
  assert.ok(!(await tiles()).includes(target));
  const s = await srv();
  assert.equal(s.stagingStats.photosTaken, momentsNow, "removing never changes Moments Captured");
});

await step("switch galleries and come back: everything still there", async () => {
  const before = await tiles();
  await goHome();
  const baseballRow = await page.locator('a[href="#/gallery/baseball"]').getAttribute("aria-label");
  assert.match(baseballRow, /unpublished changes/);
  await openGallery("soccer");
  assert.equal((await tiles()).length, 3);
  await goHome();
  await openGallery("baseball");
  await page.waitForFunction((n) => document.querySelectorAll("#grid .tile").length === n, before.length);
  assert.deepEqual(await tiles(), before);
  await page.waitForSelector("#removedPanel:not([hidden])");
  await goHome();
});

await step("Moments Captured: add 1,250 (Enter key works) and set exact total (needs tick)", async () => {
  await tap("#mcAddBtn");
  await page.waitForSelector("#numberDialog[open]");
  await page.fill("#numberInput", "1,250");
  assert.equal(await text("#numberPreview"), `${momentsNow.toLocaleString("en-US")} → ${(momentsNow + 1250).toLocaleString("en-US")}`);
  await shot("08-moments-add");
  await page.keyboard.press("Enter");
  momentsNow += 1250;
  await waitText("#mcValue", new RegExp(`^${momentsNow.toLocaleString("en-US")}$`));
  await waitIdle();
  await tap("#mcSetBtn");
  await page.waitForSelector("#numberDialog[open]");
  await page.fill("#numberInput", "72000");
  assert.equal(await page.isDisabled("#numberOk"), true);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  assert.ok(await page.$("#numberDialog[open]"), "Enter can't skip the confirmation tick");
  await tap("#numberCheck");
  await tap("#numberOk");
  await waitText("#mcValue", /^72,000$/);
  await waitIdle();
  momentsNow = 72000;
  assert.match(await text("#mcLive"), /jcwrks\.com shows 68,527/);
  assert.match(await text("#msText"), /3,000 more until 75,000/);
});

await step("review shows a clear summary", async () => {
  await page.locator("#publishCard").scrollIntoViewIfNeeded();
  const items = await page.$$eval("#reviewList .review-item", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  results.push(["INFO", `review: ${items.join(" | ")}`]);
  assert.ok(items.some((t) => /^Baseball ?\+ \d+ photos ?− 1 photo ?Order changed$/.test(t)), items.join(" | "));
  assert.ok(items.some((t) => /^Moments Captured ?68,527 → 72,000$/.test(t)), items.join(" | "));
  await shot("09-review");
});

await step("accessibility: dashboard with pending changes", async () => axe("review"));

await step("reload keeps session and unpublished work", async () => {
  await page.reload();
  await page.waitForSelector("#homeView:not([hidden])");
  assert.equal(await text("#mcValue"), "72,000");
  assert.match(await text("#statusText"), /Not published yet/);
});

await step("double-tapping Publish opens one review and makes one publish", async () => {
  const before = (await srv()).mainCommitMessages;
  await page.locator("#publishBtn").dblclick();
  await page.waitForSelector("#confirmDialog[open]");
  assert.equal(await text("#confirmTitle"), "Ready to publish");
  await shot("10-ready");
  await tap("#confirmOk");
  await page.waitForFunction(() => /Updating website|Verifying|Published/.test(document.getElementById("pubTitle").textContent));
  results.push(["INFO", `first status after confirm: ${await text("#pubTitle")}`]);
  assert.doesNotMatch(await text("#pubTitle"), /Published/, "no instant success");
  await shot("11-updating");
  await waitText("#pubTitle", /^Published ✓$/, 60000);
  await shot("12-published");
  const s = await srv();
  assert.equal(s.mainCommitMessages, before + 1, "exactly one publish");
  assert.equal(s.live, s.main);
  assert.equal(s.mainStats.photosTaken, 72000);
  assert.deepEqual(s.mainBaseball, s.stagingBaseball);
  assert.deepEqual([...s.mainFiles].sort(), [...s.stagingFiles].sort());
  const steps = await page.$$eval("#pubSteps li", (l) => l.map((x) => x.className));
  assert.deepEqual(steps, ["done", "done", "done"]);
  await page.waitForSelector("#changesNone:not([hidden])");
  assert.match(await text("#factPublished"), /Today/);
});

await step("after reload everything is live: no pending, no 'Not live yet' badges", async () => {
  await page.reload();
  await page.waitForSelector("#homeView:not([hidden])");
  await waitText("#statusText", /All changes live/);
  assert.ok(!(await page.isHidden("#changesNone")));
  await openGallery("baseball");
  const badges = await page.$$eval("#grid .tile .badge", (b) => b.filter((x) => !x.hidden).length);
  assert.equal(badges, 0);
  await goHome();
});

// ---------------- deliberate failures ----------------

await step("FAIL upload: storage error on one photo, then 'Try failed photos again' works", async () => {
  await openGallery("soccer");
  await fault({ method: "POST", path: "git/blobs$", status: 500, times: 2 });
  const st = await uploadFiles([`${FIX}/ROTATED_6.jpg`]);
  assert.match(Object.values(st)[0], /couldn't reach storage/);
  assert.match(await text("#uploadNote"), /Try them again/);
  await shot("13-upload-failed");
  await tap("#retryFailed");
  await page.waitForSelector("#uploadActions:not([hidden])", { timeout: 60000 });
  await waitText("#uploadList .st", /Saved ✓/);
  await closeUpload();
});

await step("FAIL save: photo sent but saving fails, retry saves it; nothing half-done", async () => {
  const s0 = await srv();
  await fault({ method: "POST", path: "git/commits$", status: 500, times: 6 });
  const st = await uploadFiles([`${FIX}/IMG_0042.jpg`]);
  assert.match(Object.values(st)[0], /Sent but not saved/);
  const s1 = await srv();
  assert.equal(s1.staging, s0.staging, "draft unchanged by the failed save");
  await page.waitForSelector("#alert:not([hidden])");
  await tap("#alertClose");
  await tap("#retryFailed");
  await page.waitForSelector("#uploadActions:not([hidden])", { timeout: 60000 });
  await waitText("#uploadList .st", /Saved ✓|Already/);
  await closeUpload();
});

await step("FAIL rate limit: upload pauses with a calm message and continues by itself", async () => {
  await fault({ method: "POST", path: "git/blobs$", status: 403, times: 1, message: "You have exceeded a secondary rate limit", headers: { "retry-after": "5" } });
  await page.setInputFiles("#fileInput", [`${FIX}/other/IMG_0042.jpg`]);
  await waitText("#uploadNote", /short break/, 30000);
  await shot("14-rate-limit");
  await page.waitForSelector("#uploadActions:not([hidden])", { timeout: 60000 });
  await waitText("#uploadList .st", /Saved ✓|Already/);
  await closeUpload();
  await goHome();
});

await step("FAIL offline: a change without internet says so and nothing changes", async () => {
  const s0 = await srv();
  await context.setOffline(true);
  await tap("#mcAddBtn");
  await page.waitForSelector("#numberDialog[open]");
  await page.fill("#numberInput", "5");
  await tap("#numberOk");
  await page.waitForSelector("#alert:not([hidden])");
  assert.match(await text("#alertText"), /Couldn't connect/);
  await context.setOffline(false);
  const s1 = await srv();
  assert.equal(s1.staging, s0.staging);
  await tap("#alertAction");
  await waitText("#mcValue", /72,005/);
  await waitIdle();
});

await step("FAIL publish: storage error, 'still saved', Try again publishes", async () => {
  await fault({ method: "PATCH", path: "git/refs/heads/main$", status: 500, times: 2 });
  await tap("#publishBtn");
  await page.waitForSelector("#confirmDialog[open]");
  await tap("#confirmOk");
  await waitText("#pubTitle", /Publish didn't go through/);
  assert.match(await text("#pubDetail"), /still saved\. Nothing was lost/);
  await shot("15-publish-failed");
  assert.notEqual((await srv()).mainStats.photosTaken, 72005);
  await tap("#pubRetry");
  await page.waitForSelector("#confirmDialog[open]");
  await tap("#confirmOk");
  await waitText("#pubTitle", /^Published ✓$/, 60000);
  assert.equal((await srv()).mainStats.photosTaken, 72005);
});

await step("FAIL deploy: website never updates, no false success, Try again recovers", async () => {
  await deployMode("stuck");
  await tap("#mcAddBtn");
  await page.waitForSelector("#numberDialog[open]");
  await page.fill("#numberInput", "1");
  await tap("#numberOk");
  await waitText("#mcValue", /72,006/);
  await waitIdle();
  await tap("#publishBtn");
  await page.waitForSelector("#confirmDialog[open]");
  await tap("#confirmOk");
  await waitText("#pubTitle", /Updating website/);
  await waitText("#pubTitle", /Still updating/, 30000);
  await waitText("#pubTitle", /hasn't updated yet/, 30000);
  assert.match(await text("#pubDetail"), /saved and nothing was lost/);
  assert.match(await text("#statusText"), /Website not updated yet/);
  await shot("16-stuck");
  await deployMode("normal");
  await tap("#pubRetry");
  await waitText("#pubTitle", /^Published ✓$/, 60000);
});

await step("two tabs: a change made elsewhere during review is caught before publishing", async () => {
  await tap("#pubDismiss");
  const tab2 = await context.newPage();
  await tab2.goto(`${BASE}/admin/`);
  await tab2.waitForSelector("#homeView:not([hidden])");
  await tap("#mcAddBtn");
  await page.waitForSelector("#numberDialog[open]");
  await page.fill("#numberInput", "10");
  await tap("#numberOk");
  await waitText("#mcValue", /72,016/);
  await waitIdle();
  await tap("#publishBtn");
  await page.waitForSelector("#confirmDialog[open]");
  await tab2.reload();
  await tab2.waitForSelector("#homeView:not([hidden])");
  await (isTouch ? tab2.locator("#mcAddBtn").tap() : tab2.click("#mcAddBtn"));
  await tab2.waitForSelector("#numberDialog[open]");
  await tab2.fill("#numberInput", "3");
  await (isTouch ? tab2.locator("#numberOk").tap() : tab2.click("#numberOk"));
  await tab2.waitForFunction(() => document.getElementById("mcValue").textContent === "72,019");
  await tab2.close();
  await tap("#confirmOk");
  await waitText("#pubTitle", /Your changes were updated/);
  await tap("#pubDismiss");
  await waitText("#mcValue", /72,019/);
  await tap("#publishBtn");
  await page.waitForSelector("#confirmDialog[open]");
  await tap("#confirmOk");
  await waitText("#pubTitle", /^Published ✓$/, 60000);
  assert.equal((await srv()).mainStats.photosTaken, 72019);
});

await step("milestone: crossing 75,000 celebrates once, only after it's live", async () => {
  await tap("#pubDismiss");
  await tap("#mcAddBtn");
  await page.waitForSelector("#numberDialog[open]");
  await page.fill("#numberInput", "3000");
  await tap("#numberOk");
  await waitText("#mcValue", /75,019/);
  await waitIdle();
  assert.ok(await page.isHidden("#celebrate"), "no celebration before publishing");
  await tap("#publishBtn");
  await page.waitForSelector("#confirmDialog[open]");
  await tap("#confirmOk");
  await waitText("#pubTitle", /^Published ✓$/, 60000);
  await page.waitForSelector("#celebrate:not([hidden])");
  assert.equal(await text("#celebrateTitle"), "75,000 moments captured.");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1200);
  await shot("17-milestone");
  await page.reload();
  await page.waitForSelector("#homeView:not([hidden])");
  await page.waitForTimeout(500);
  assert.ok(await page.isHidden("#celebrate"), "not repeated on the next visit");
  assert.match(await text("#msText"), /24,981 more until 100,000/);
});

const coverTile = () => page.$$eval("#grid .tile", (ts) => ts.filter((t) => !t.querySelector(".cover-tag").hidden).map((t) => t.dataset.src));

await step("cover: gallery shows its original cover; picker marks it; choosing a photo moves the Cover tag", async () => {
  await openGallery("baseball");
  await page.waitForSelector("#coverBlock:not([hidden])");
  await page.waitForSelector("#coverBtn:not([hidden])");
  const order = await tiles();
  assert.deepEqual(await coverTile(), [], "the original cover isn't one of these photos");
  assert.match(await text("#coverText"), /original cover/);
  await tap("#coverBtn");
  await page.waitForSelector("#coverDialog[open]");
  assert.equal(await page.locator("#coverPicker .pick").count(), order.length + 1, "original + every photo");
  assert.equal(await page.locator('#coverPicker .pick[aria-pressed="true"]').getAttribute("aria-label"), "Original cover, current cover");
  assert.ok(await page.isDisabled("#coverOk"), "nothing to save until a different one is picked");
  await page.waitForTimeout(400);
  await shot("18-cover-picker");
  await page.locator("#coverPicker .pick").nth(3).click();
  assert.equal(await page.locator('#coverPicker .pick[aria-pressed="true"]').getAttribute("data-key"), order[2]);
  assert.ok(!(await page.isDisabled("#coverOk")));
  await tap("#coverOk");
  await waitIdle();
  await waitText("#toastText", /Cover updated/);
  assert.deepEqual(await coverTile(), [order[2]]);
  assert.match(await text("#coverText"), /^Photo 3 is what people see for Baseball/);
  assert.match(await text("#coverNote"), /after you publish/);
  assert.ok(await page.$eval("#coverImg", (i, src) => decodeURIComponent(i.src).endsWith(src), order[2]), "preview shows the new cover");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await shot("19-cover-chosen");
});

await step("cover: Undo puts the original back; the photo menu can set a cover too", async () => {
  const order = await tiles();
  await tap("#toastAction");
  await waitIdle();
  await waitText("#toastText", /Cover change undone/);
  assert.deepEqual(await coverTile(), []);
  assert.match(await text("#coverText"), /original cover/);
  await tapTile(3);
  await page.waitForSelector("#photoSheet[open]");
  assert.equal(await text("#sheetCover"), "Use as cover");
  await tap("#sheetCover");
  await waitIdle();
  assert.deepEqual(await coverTile(), [order[3]]);
  await tapTile(3);
  await page.waitForSelector("#photoSheet[open]");
  assert.equal(await text("#sheetCover"), "This is the cover");
  assert.ok(await page.isDisabled("#sheetCover"));
  await tap("#sheetClose");
});

await step("accessibility: cover picker has no WCAG A/AA violations", async () => {
  await tap("#coverBtn");
  await page.waitForSelector("#coverDialog[open]");
  try { return await axe("cover picker"); } finally { await tap("#coverCancel"); }
});

await step("cover: removing the cover photo falls back to the first photo with a clear note; Undo restores it", async () => {
  const order = await tiles();
  const cover = (await coverTile())[0];
  await tapTile(order.indexOf(cover));
  await page.waitForSelector("#photoSheet[open]");
  await tap("#sheetRemove");
  await page.waitForSelector("#confirmDialog[open]");
  await tap("#confirmOk");
  await waitIdle();
  const after = await tiles();
  assert.deepEqual(await coverTile(), [after[0]], "first photo stands in");
  assert.match(await text("#coverNote"), /was removed/);
  await shot("20-cover-removed");
  await tap("#toastAction");
  await waitIdle();
  await waitText("#toastText", /put back/);
  assert.deepEqual(await coverTile(), [cover], "undo brings the chosen cover back");
});

await step("cover: review says New cover; publish verifies the live tile shows it", async () => {
  const cover = (await coverTile())[0];
  await goHome();
  await waitText("#reviewList", /New cover/);
  const tileSrc = await page.$eval('a[href="#/gallery/baseball"] img.cover', (i) => decodeURIComponent(i.src));
  assert.ok(tileSrc.endsWith(cover), "dashboard tile shows the new cover");
  await tap("#publishBtn");
  await page.waitForSelector("#confirmDialog[open]");
  assert.match(await text("#confirmBody"), /New cover/);
  await tap("#confirmOk");
  await waitText("#pubTitle", /^Published ✓$/, 60000);
  const live = await (await fetch(`${BASE}/work/sports/`)).text();
  assert.ok(live.includes(`src="${cover}"`), "live Sports page shows the chosen cover");
});

await step("cover: an empty gallery explains itself and offers no picker", async () => {
  await openGallery("track");
  await page.waitForSelector("#coverBlock:not([hidden])");
  assert.match(await text("#coverText"), /Add photos to choose a cover/);
  assert.ok(await page.isHidden("#coverBtn"));
  await goHome();
});

// ---------------- site text ----------------
const tf = (key) => `.tf[data-key="${key}"]`;
const fieldVal = (key) => page.$eval(`${tf(key)} .tf-input`, (i) => i.value);
const typeInto = async (key, value) => { await page.fill(`${tf(key)} .tf-input`, value); };
async function apiAs(op, body) {
  const login = await (await fetch(`${BASE}/api/admin?op=login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-password-not-real" }) })).json();
  return (await fetch(`${BASE}/api/admin?op=${op}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${login.token}` }, body: JSON.stringify(body) })).json();
}
async function openText() {
  if (await page.isVisible("#textView")) return;
  if (!(await page.isVisible("#homeView"))) { await page.goto(`${BASE}/admin/#/`); await page.waitForSelector("#homeView:not([hidden])"); }
  await tap("#textCardBtn");
  await page.waitForSelector("#textView:not([hidden])");
  await page.waitForFunction(() => document.querySelectorAll("#textForm .tf").length === 36, null, { timeout: 30000 });
}
const kickerOrig = "Freelance Photographer";

await step("site text: dashboard card opens the editor, grouped by page with plain labels and counters", async () => {
  await openText();
  assert.deepEqual(await page.$$eval("#textForm .text-page h2", (h) => h.map((x) => x.textContent)), ["Home", "Photo & Video", "Categories", "About", "Contact", "Call", "Thanks", "Footer"]);
  assert.equal(await fieldVal("home.hero.kicker"), kickerOrig);
  assert.equal(await page.textContent(`${tf("home.hero.kicker")} .tf-count`), "22 / 28");
  assert.match(await page.textContent(`${tf("about.bio.body")} .tf-count`), /4 paragraphs \(up to 6\) · longest 273 \/ 600/);
  assert.match(await page.textContent(`${tf("thanks.body.start")} .tf-preview`), /Thanks for reaching out — I'll get back to you within 24 hours\. Can't wait/);
  const html = await page.content();
  assert.doesNotMatch(await page.textContent("#textView"), /home\.hero|copy\.json|JSON|\{/, "no keys or developer terms on screen");
  assert.ok(html.length > 0);
  assert.ok(await page.isHidden("#textBar"));
  await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(300);
  await shot("21-site-text");
});

await step("accessibility: Site text page has no WCAG A/AA violations", async () => axe("site text"));

await step("site text: limits block saving; one-line and paragraph edits save; Undo puts the old wording back", async () => {
  await typeInto("home.hero.kicker", "Sports & Portrait Photographer!");
  assert.equal(await page.textContent(`${tf("home.hero.kicker")} .tf-count`), "31 / 28");
  assert.match(await page.textContent(`${tf("home.hero.kicker")} .tf-note`), /Too long \(31 of 28/);
  assert.match(await page.textContent("#textBarText"), /Fix the field/);
  assert.ok(await page.isDisabled("#textSave"));
  await typeInto("home.hero.kicker", "   Sports   Photographer ");
  assert.equal(await page.textContent(`${tf("home.hero.kicker")} .tf-flag`), "Not saved");
  const bio = await fieldVal("about.bio.body");
  await typeInto("about.bio.body", bio + "\n\nNew last paragraph.");
  assert.match(await page.textContent("#textBarText"), /2 changes not saved/);
  assert.match(await text("#statusText"), /Wording not saved/);
  await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(200);
  await shot("22-site-text-editing");
  await tap("#textSave");
  await waitText("#toastText", /2 wording changes saved/);
  assert.equal(await fieldVal("home.hero.kicker"), "Sports Photographer", "saved tidy");
  assert.equal(await page.textContent(`${tf("home.hero.kicker")} .tf-flag`), "Not published yet");
  assert.ok(await page.isVisible(`${tf("home.hero.kicker")} .tf-live`), "can go back to the live wording");
  const st = await srv();
  assert.deepEqual(Object.keys(st.stagingCopy.text).sort(), ["about.bio.body", "home.hero.kicker"]);
  await tap("#toastAction");
  await waitText("#toastText", /Wording change undone/);
  assert.equal(await fieldVal("home.hero.kicker"), kickerOrig);
  assert.deepEqual((await srv()).stagingCopy.text, {}, "back to exactly what's live");
  assert.ok(await page.isHidden(`${tf("home.hero.kicker")} .tf-flag`));
  await typeInto("home.hero.kicker", "Sports Photographer");
  await tap("#textSave");
  await waitText("#toastText", /Wording saved/);
});

await step("site text: wording survives a refresh and a fresh sign-in", async () => {
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("#textForm .tf").length === 36, null, { timeout: 30000 });
  assert.equal(await fieldVal("home.hero.kicker"), "Sports Photographer");
  await page.evaluate(() => localStorage.removeItem("jcwrks_admin_session"));
  await page.goto(`${BASE}/admin/#/text`); await page.reload();
  await page.fill("#pw", "test-password-not-real"); await tap("#loginBtn");
  await page.waitForFunction(() => document.querySelectorAll("#textForm .tf").length === 36, null, { timeout: 30000 });
  assert.equal(await fieldVal("home.hero.kicker"), "Sports Photographer");
});

await step("site text: a change made elsewhere is never overwritten; Jacob's wording stays on screen", async () => {
  const other = await apiAs("site-text-save", { changes: [{ key: "home.hero.kicker", value: "Photographer (other tab)", expected: "Sports Photographer" }] });
  assert.ok(other.ok, JSON.stringify(other));
  await typeInto("home.hero.kicker", "Mine wins?");
  await tap("#textSave");
  await page.waitForSelector("#alert:not([hidden])");
  assert.match(await text("#alertText"), /changed somewhere else/);
  assert.match(await page.textContent(`${tf("home.hero.kicker")} .tf-note`), /changed somewhere else to: “Photographer \(other tab\)”/);
  assert.equal(await fieldVal("home.hero.kicker"), "Mine wins?");
  assert.equal((await srv()).stagingCopy.text["home.hero.kicker"], "Photographer (other tab)", "nothing overwritten");
  await shot("23-site-text-conflict");
  await tap(`${tf("home.hero.kicker")} .tf-undo`);
  assert.equal(await fieldVal("home.hero.kicker"), "Photographer (other tab)");
  await tap("#alertClose");
});

await step("site text: markup is just characters, never HTML", async () => {
  await typeInto("contact.call.lead", "<b>Hi</b> & <img src=x>");
  await tap("#textSave");
  await waitText("#toastText", /Wording saved/);
  assert.equal(await fieldVal("contact.call.lead"), "<b>Hi</b> & <img src=x>");
  assert.equal(await page.$$eval("#textView b, #textView img", (n) => n.filter((x) => !x.closest(".tf-preview")).length), 0);
});

await step("site text: leaving with unsaved wording asks first", async () => {
  await typeInto("footer.cta.label", "Need photos?");
  await tap("#textView .back");
  await page.waitForSelector("#confirmDialog[open]");
  assert.equal(await text("#confirmTitle"), "Save your wording?");
  await tap("#confirmAlt");
  await page.waitForSelector("#homeView:not([hidden])");
  await openText();
  assert.equal(await fieldVal("footer.cta.label"), "Got a shoot in mind?");
});

await step("site text: review lists each page and the exact wording; publish verifies the live pages", async () => {
  await page.goto(`${BASE}/admin/#/`); await page.waitForSelector("#homeView:not([hidden])"); await page.waitForTimeout(500);
  assert.match(await text("#textCardStatus"), /2 wording changes not published yet/);
  const items = await page.$$eval("#reviewList .review-item", (els) => els.map((e) => e.querySelector("h4").textContent + " | " + e.querySelector("ul").textContent));
  assert.deepEqual(items, ["Home | Wording: 1 change", "Contact | Wording: 1 change"]);
  await page.locator("#reviewList details summary").first().click();
  assert.match(await page.textContent("#reviewList details"), /Small heading above your name.*Freelance Photographer.*Photographer \(other tab\)/s);
  await page.locator("#publishCard").scrollIntoViewIfNeeded(); await page.waitForTimeout(300);
  await shot("24-review-wording");
  await tap("#publishBtn");
  await page.waitForSelector("#confirmDialog[open]");
  assert.match(await text("#confirmBody"), /See exact wording/);
  await tap("#confirmOk");
  await waitText("#pubTitle", /^Published ✓$/, 60000);
  const live = await (await fetch(`${BASE}/`)).text();
  assert.ok(live.includes("Photographer (other tab)"));
  const contact = await (await fetch(`${BASE}/contact/`)).text();
  assert.ok(contact.includes("&lt;b&gt;Hi&lt;/b&gt; &amp; &lt;img src=x&gt;"), "escaped on the page");
});

await step("site text: Throw away all unpublished changes restores the wording", async () => {
  await openText();
  await typeInto("site.coverage", "All of Michigan");
  await tap("#textSave"); await waitText("#toastText", /Wording saved/);
  await page.goto(`${BASE}/admin/#/`); await page.waitForSelector("#homeView:not([hidden])");
  await tap("#discardBtn"); await page.waitForSelector("#confirmDialog[open]");
  await page.check("#confirmCheck"); await tap("#confirmOk");
  await waitText("#toastText", /thrown away/);
  await openText();
  assert.equal(await fieldVal("site.coverage"), "Metro Detroit & East Lansing, MI");
  await page.goto(`${BASE}/admin/#/`); await page.waitForSelector("#homeView:not([hidden])");
});

await step("keyboard: focus a photo, Enter opens options, Escape closes", async () => {
  if (isTouch) return "SKIP";
  await openGallery("baseball");
  await page.locator("#grid .tile").first().focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector("#photoSheet[open]");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert.ok(!(await page.$("#photoSheet[open]")));
  await goHome();
});

await step("no JavaScript errors", async () => {
  const real = consoleErrors.filter((e) => !/Failed to load resource|status of (4\d\d|5\d\d)|ERR_INTERNET_DISCONNECTED|ERR_NETWORK|Load failed|NetworkError|network connection was lost/i.test(e));
  assert.deepEqual(real, []);
});

await browser.close();
server.kill();
console.log(`\n=== ${profile} ===`);
for (const r of results) console.log(r.join("  "));
process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
