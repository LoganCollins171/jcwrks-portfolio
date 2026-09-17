// The admin must stay visually part of jcwrks.com: same tokens, same fonts, same logo.
// If someone changes the site's palette in src/styles/global.css, this fails until
// public/admin/admin.css follows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const site = readFileSync("src/styles/global.css", "utf8");
const admin = readFileSync("public/admin/admin.css", "utf8");
const html = readFileSync("public/admin/index.html", "utf8");

const siteToken = (name) => site.match(new RegExp(`--color-${name}:\\s*([^;]+);`))[1].trim();
const adminToken = (name) => admin.match(new RegExp(`--${name}:\\s*([^;]+);`))[1].trim();

test("admin colour tokens are the portfolio's exact values", () => {
  for (const name of ["ink", "charcoal", "panel", "line", "bone", "fog", "accent", "accent-bright"]) {
    assert.equal(adminToken(name), siteToken(name), `--${name}`);
  }
});

test("admin type stack is the portfolio's", () => {
  assert.equal(adminToken("display"), site.match(/--font-display:\s*([^;]+);/)[1].trim());
  assert.equal(adminToken("body"), site.match(/--font-body:\s*([^;]+);/)[1].trim());
  assert.match(html, /fonts\.googleapis\.com\/css2\?family=Inter\+Tight[^"]*family=Inter:/);
});

test("admin uses the real logo file, not a redrawn one", () => {
  assert.match(html, /<img src="\/logo\.png"/);
  assert.ok(existsSync("public/logo.png"));
  assert.match(html, /<span class="logo">jc_wrks<\/span>/);
});

test("the body wash matches the portfolio's", () => {
  const grab = (css) => [...css.matchAll(/radial-gradient\(([^)]*rgba\(124, 58, 237[^)]*\)[^)]*)\)/g)].map((m) => m[1].replace(/\s+/g, " "));
  const siteWash = grab(site);
  assert.ok(siteWash.length >= 2);
  for (const w of siteWash) assert.ok(grab(admin).includes(w), `missing wash: ${w}`);
});

test("no off-brand surfaces or effects crept in", () => {
  assert.doesNotMatch(admin, /linear-gradient\(90deg, var\(--accent\)/, "no gradient fills");
  assert.doesNotMatch(admin, /drop-shadow\(0 0/, "no glows");
  assert.doesNotMatch(html, /<svg class="aperture"/, "no stock camera iconography");
});
