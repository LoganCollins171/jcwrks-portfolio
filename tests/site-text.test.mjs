// Site text: the editable wording on the public site (src/lib/site-text.mjs + src/data/copy.json).
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FIELDS, FIELD_BY_KEY, cleanText, effectiveText, problemWith } from "../src/lib/site-text.mjs";
import { COPY_PATH, isContentPath } from "../src/lib/gallery-model.mjs";
import { createTestSite, makeImage, uploadAndAdd } from "./helpers/site.mjs";

const F = (key) => FIELD_BY_KEY.get(key);

// ---------------- rules ----------------

test("one-line fields: whitespace collapses, control and direction-override characters are stripped", () => {
  assert.equal(cleanText("  Freelance \n\t Photographer  ", F("home.hero.kicker")), "Freelance Photographer");
  assert.equal(cleanText("a\u0000b\u0007c\u202Ed\u2066e\u007F", F("home.hero.kicker")), "abcde");
  assert.equal(cleanText("Café 📸 — “quotes” & <b>tags</b>", F("home.hero.intro")), "Café 📸 — “quotes” & <b>tags</b>", "plain text kept as typed");
  assert.equal(cleanText(42, F("home.hero.kicker")), null);
});

test("paragraph fields keep paragraph breaks and tidy everything else", () => {
  const bio = F("about.bio.body");
  assert.equal(cleanText("One\r\nline.\r\n\r\n\r\n  Two  \n \n\nThree ", bio), "One line.\n\nTwo\n\nThree");
  assert.equal(cleanText("\n\n  Only \u2029\u2029 two  ", bio), "Only\n\ntwo");
});

test("limits count characters the way people do and reject empty wording", () => {
  const kicker = F("home.hero.kicker");
  assert.equal(problemWith("x".repeat(28), kicker), null);
  assert.match(problemWith("x".repeat(29), kicker), /too long \(29 of 28/);
  assert.equal(problemWith("📸".repeat(28), kicker), null, "an emoji is one character");
  assert.equal(problemWith("", kicker), "can't be empty");
  const bio = F("about.bio.body");
  assert.match(problemWith(Array(7).fill("p").join("\n\n"), bio), /7 paragraphs \(at most 6\)/);
  assert.match(problemWith(`ok\n\n${"x".repeat(601)}`, bio), /paragraph 2 is too long/);
});

test("the site falls back to the original wording for anything missing or invalid", () => {
  const def = F("footer.cta.label").default;
  assert.equal(effectiveText({}, "footer.cta.label"), def);
  assert.equal(effectiveText(null, "footer.cta.label"), def);
  assert.equal(effectiveText({ text: { "footer.cta.label": "   " } }, "footer.cta.label"), def);
  assert.equal(effectiveText({ text: { "footer.cta.label": "x".repeat(31) } }, "footer.cta.label"), def);
  assert.equal(effectiveText({ text: { "footer.cta.label": ["no"] } }, "footer.cta.label"), def);
  assert.equal(effectiveText({ text: { "footer.cta.label": " Booking  now " } }, "footer.cta.label"), "Booking now");
  assert.throws(() => effectiveText({}, "nope"), /Unknown/);
});

test("copy.json is content (drafted, reviewed, published) and ships empty", () => {
  assert.ok(isContentPath(COPY_PATH));
  assert.deepEqual(JSON.parse(readFileSync(COPY_PATH, "utf8")), { text: {} });
});

test("every field is used by the site and every text() call names a real field", () => {
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(astro|ts)$/.test(n)) files.push(p); } };
  walk("src");
  const src = files.map((f) => readFileSync(f, "utf8")).join("\n");
  const used = new Set([...src.matchAll(/\b(?:text|paragraphs)\("([^"]+)"\)/g)].map((m) => m[1]));
  for (const k of used) assert.ok(FIELD_BY_KEY.has(k), `unknown field used: ${k}`);
  for (const f of FIELDS) assert.ok(used.has(f.key), `field never shown on the site: ${f.key}`);
  assert.equal(FIELDS.length, 36);
});

// ---------------- API ----------------

const copyOn = (site, branch) => {
  const f = site.fake.files(branch)[COPY_PATH];
  return f ? JSON.parse(f.toString("utf8")) : null;
};
async function read(site, token) {
  const r = await site.call("site-text", {}, { token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
const field = (st, key) => st.fields.find((f) => f.key === key);
const save = (site, token, changes) => site.call("site-text-save", { changes }, { token });

test("reading: every field with its current wording, grouped by page, nothing pending", async () => {
  const site = await createTestSite();
  const token = await site.login();
  const st = await read(site, token);
  assert.deepEqual(st.pages.map((p) => p.label), ["Home", "Photo & Video", "Categories", "About", "Contact", "Call", "Thanks", "Footer"]);
  assert.equal(st.fields.length, 36);
  for (const f of st.fields) {
    assert.equal(f.value, FIELD_BY_KEY.get(f.key).default);
    assert.equal(f.live, f.value);
  }
  assert.equal(field(st, "about.bio.body").kind, "paragraphs");
});

test("saving one field writes only the site text file, shows in review with exact wording, and publishes", async () => {
  const site = await createTestSite();
  const token = await site.login();
  const before = { ...site.fake.files("staging") };
  const r = await save(site, token, [{ key: "about.bio.heading", value: "  Every  photo\nmatters. ", expected: F("about.bio.heading").default }]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.saved, [{ key: "about.bio.heading", before: F("about.bio.heading").default, after: "Every photo matters." }]);
  assert.equal(field(r.body.snapshot.siteText, "about.bio.heading").value, "Every photo matters.");
  assert.equal(field(r.body.snapshot.siteText, "about.bio.heading").live, F("about.bio.heading").default);

  const after = site.fake.files("staging");
  const touched = Object.keys({ ...before, ...after }).filter((p) => before[p] !== after[p] && String(before[p]) !== String(after[p]));
  assert.deepEqual(touched, [COPY_PATH], "photos, order, covers, Moments untouched");
  assert.deepEqual(copyOn(site, "staging"), { text: { "about.bio.heading": "Every photo matters." } });
  assert.deepEqual(copyOn(site, "main"), { text: {} }, "not live until publish");

  const s = r.body.snapshot.state;
  assert.equal(s.changes.hasChanges, true);
  assert.deepEqual(s.changes.lines, ["Site text, About: 1 change"]);
  assert.deepEqual(s.changes.text, [{ id: "about", label: "About", fields: [{ key: "about.bio.heading", label: "Bio heading", before: F("about.bio.heading").default, after: "Every photo matters.", paths: ["/about/"] }] }]);
  assert.equal(s.changes.galleries.length, 0);

  const p = await site.call("publish", { draftSha: s.draftSha }, { token });
  assert.equal(p.status, 200);
  assert.deepEqual(copyOn(site, "main"), { text: { "about.bio.heading": "Every photo matters." } });
  const st = await read(site, token);
  assert.equal(field(st, "about.bio.heading").live, "Every photo matters.");
});

test("paragraph wording is saved tidy and survives a fresh read (new session)", async () => {
  const site = await createTestSite();
  const token = await site.login();
  const r = await save(site, token, [{ key: "about.bio.body", value: "First para.\r\n\r\n\r\nSecond   para,\nsame paragraph.", expected: F("about.bio.body").default }]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const again = await read(site, await site.login());
  assert.equal(field(again, "about.bio.body").value, "First para.\n\nSecond para, same paragraph.");
});

test("server-side limits: too long, empty, not text, unknown field, missing expected; nothing is saved", async () => {
  const site = await createTestSite();
  const token = await site.login();
  const exp = (k) => F(k).default;
  const tooLong = await save(site, token, [{ key: "home.hero.kicker", value: "x".repeat(29), expected: exp("home.hero.kicker") }]);
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error.code, "invalid_text");
  assert.match(tooLong.body.error.message, /Home · Small heading above your name is too long \(29 of 28 characters\)/);
  const empty = await save(site, token, [{ key: "footer.cta.label", value: " \n\t ", expected: exp("footer.cta.label") }]);
  assert.match(empty.body.error.message, /can't be empty/);
  assert.equal((await save(site, token, [{ key: "footer.cta.label", value: 5, expected: exp("footer.cta.label") }])).body.error.code, "invalid_text");
  assert.equal((await save(site, token, [{ key: "nav.home", value: "x", expected: "" }])).body.error.code, "bad_text");
  assert.equal((await save(site, token, [{ key: "footer.cta.label", value: "x" }])).body.error.code, "bad_text");
  assert.equal((await save(site, token, [{ key: "footer.cta.label", value: "x", expected: "a" }, { key: "footer.cta.label", value: "y", expected: "a" }])).body.error.code, "bad_text");
  assert.equal((await site.call("site-text-save", { changes: "nope" }, { token })).body.error.code, "no_text");
  // one bad field blocks the whole save
  const mixed = await save(site, token, [
    { key: "footer.cta.muted", value: "Fine", expected: exp("footer.cta.muted") },
    { key: "footer.cta.strong", value: "x".repeat(25), expected: exp("footer.cta.strong") },
  ]);
  assert.equal(mixed.status, 400);
  assert.deepEqual(mixed.body.error.fields.map((f) => f.key), ["footer.cta.strong"]);
  assert.deepEqual(copyOn(site, "staging"), { text: {} }, "nothing written");
});

test("conflict: wording changed elsewhere is never overwritten, and nothing in the batch is saved", async () => {
  const site = await createTestSite();
  const token = await site.login();
  const orig = F("contact.call.lead").default;
  assert.equal((await save(site, token, [{ key: "contact.call.lead", value: "Rather talk?", expected: orig }])).status, 200);
  // A second tab that opened before that save still thinks the original is there.
  const r = await save(site, token, [
    { key: "contact.call.body", value: "New body", expected: F("contact.call.body").default },
    { key: "contact.call.lead", value: "Want to talk?", expected: orig },
  ]);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "text_conflict");
  assert.match(r.body.error.message, /Call box heading changed somewhere else/);
  assert.deepEqual(r.body.error.fields, [{ key: "contact.call.lead", current: "Rather talk?" }]);
  assert.deepEqual(copyOn(site, "staging").text, { "contact.call.lead": "Rather talk?" }, "the other field wasn't saved either");
});

test("undo: saving the earlier wording back leaves nothing to publish (original = no stored change)", async () => {
  const site = await createTestSite();
  const token = await site.login();
  const orig = F("home.statement.tail").default;
  const r = await save(site, token, [{ key: "home.statement.tail", value: "Shot sharp.", expected: orig }]);
  const undo = await save(site, token, r.body.saved.map((x) => ({ key: x.key, value: x.before, expected: x.after })));
  assert.equal(undo.status, 200);
  assert.deepEqual(copyOn(site, "staging"), { text: {} });
  assert.equal(undo.body.snapshot.state.changes.hasChanges, false, "no leftover 'tidy-up'");
  const noop = await save(site, token, [{ key: "home.statement.tail", value: orig, expected: orig }]);
  assert.equal(noop.body.changed, false);
});

test("throw away all unpublished changes also restores the wording", async () => {
  const site = await createTestSite();
  const token = await site.login();
  await save(site, token, [{ key: "site.coverage", value: "All of Michigan", expected: F("site.coverage").default }]);
  const d = await site.call("discard", {}, { token });
  assert.equal(d.status, 200);
  assert.equal(field(await read(site, token), "site.coverage").value, F("site.coverage").default);
  assert.equal(d.body.snapshot.state.changes.hasChanges, false);
});

test("text is stored as plain text: markup is kept as characters, never interpreted here", async () => {
  const site = await createTestSite();
  const token = await site.login();
  const evil = `<img src=x onerror="alert(1)"> & <script>alert(2)</script>`;
  const r = await save(site, token, [{ key: "home.hero.intro", value: evil, expected: F("home.hero.intro").default }]);
  assert.equal(r.status, 200);
  assert.equal(copyOn(site, "staging").text["home.hero.intro"], evil);
});

test("text changes sit alongside photos, covers and Moments without touching them", async () => {
  const site = await createTestSite();
  const token = await site.login();
  await uploadAndAdd(site, token, "hockey", [{ buf: await makeImage(), name: "h.jpg" }]);
  await site.call("cover", { gallery: "baseball", src: "/galleries/baseball/a.webp" }, { token });
  await site.call("moments-add", { amount: 5 }, { token });
  const stagingBefore = site.fake.files("staging");
  const r = await save(site, token, [{ key: "call.intro", value: "Grab a time.", expected: F("call.intro").default }]);
  const stagingAfter = site.fake.files("staging");
  for (const p of Object.keys(stagingBefore)) if (p !== COPY_PATH) assert.equal(String(stagingAfter[p]), String(stagingBefore[p]), p);
  const lines = r.body.snapshot.state.changes.lines;
  assert.ok(lines.includes("Hockey: 1 photo added, new cover"), lines.join(" | "));
  assert.ok(lines.some((l) => l.startsWith("Baseball: new cover")), lines.join(" | "));
  assert.ok(lines.includes("Moments Captured: 68,527 → 68,532 (+5)"), lines.join(" | "));
  assert.ok(lines.includes("Site text, Call: 1 change"), lines.join(" | "));
});
