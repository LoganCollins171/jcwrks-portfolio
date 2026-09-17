// Measures GitHub API calls per owner action (what the browser actually triggers),
// against the fake repo. Run: node tests/perf/api-calls.mjs
import { createTestSite, makeImage } from "../helpers/site.mjs";

const site = await createTestSite();
const token = await site.login();
// Every request starts cold, like a fresh Netlify Function instance (worst case).
const rawCall = site.call;
site.call = (...a) => { site.engine.clearCaches(); return rawCall(...a); };
const count = async (label, fn) => {
  site.engine.clearCaches?.();
  const before = site.fake.calls.length;
  await fn();
  const calls = site.fake.calls.slice(before);
  const by = {};
  for (const c of calls) { const k = `${c.method} ${c.path.replace(/[0-9a-f]{40}/g, ":sha").replace(/\?.*/, "")}`; by[k] = (by[k] || 0) + 1; }
  console.log(`${label.padEnd(44)} ${String(calls.length).padStart(4)} calls`);
  return by;
};
const flow = globalThis.FLOW || "old";
await count("open dashboard (state + gallery)", async () => {
  await site.call("state", {}, { token });
  await site.call("gallery", { gallery: "baseball" }, { token });
});
const imgs = [];
for (let i = 0; i < 10; i++) imgs.push(await makeImage());
await count("upload 10 photos + save + refresh", async () => {
  const receipts = [];
  for (const buf of imgs) receipts.push((await site.call("upload", undefined, { token, raw: buf, headers: { "x-file-name": "a.jpg" } })).body.receipt);
  const r = await site.call("add", { gallery: "baseball", files: receipts }, { token });
  if (!r.body.snapshot) { await site.call("gallery", { gallery: "baseball" }, { token }); await site.call("state", {}, { token }); }
});
await count("remove 1 photo + refresh", async () => {
  const r = await site.call("remove", { gallery: "baseball", src: "/galleries/baseball/a.webp" }, { token });
  if (!r.body.snapshot) { await site.call("gallery", { gallery: "baseball" }, { token }); await site.call("state", {}, { token }); }
});
await count("reorder + refresh", async () => {
  const r = await site.call("reorder", { gallery: "baseball", order: ["/galleries/baseball/b.webp"] }, { token });
  if (!r.body.snapshot) { await site.call("gallery", { gallery: "baseball" }, { token }); await site.call("state", {}, { token }); }
});
await count("moments add + refresh", async () => {
  const r = await site.call("moments-add", { amount: 5 }, { token });
  if (!r.body.snapshot) await site.call("state", {}, { token });
});
await count("publish + refresh", async () => {
  const s = await site.call("state", {}, { token });
  const r = await site.call("publish", { draftSha: s.body.draftSha }, { token });
  if (!r.body.snapshot) await site.call("state", {}, { token });
});
