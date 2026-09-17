// The /admin content engine.
//
// ONE writer, ONE pipeline:
//   - Every change Jacob makes (add, remove, restore, reorder, Moments Captured,
//     discard) is ONE atomic commit on the `staging` branch (his draft).
//   - Commits are compare-and-swap: the branch only moves if nobody else moved
//     it first. If it did, we re-read and re-apply the change (it is stored as
//     an intent, e.g. "remove photo X", not as a stale snapshot), so two
//     devices/tabs can never overwrite each other.
//   - The draft is always "production + Jacob's content changes". Code comes
//     from main, so a code deploy can never be reverted by a publish.
//   - Publish = ONE commit on main that applies every content difference
//     (added, removed, replaced, reordered, stats). Nothing else writes content.
//
// "Content" = public/galleries/**/<image>, src/data/galleries/*.json,
// src/data/stats.json (see gallery-model.mjs isContentPath).

import { createHash } from "node:crypto";
import { RefConflictError } from "./github.mjs";
import { validateImage } from "./images.mjs";
import {
  GALLERY_SLUGS, GALLERY_TITLES, GALLERIES_PREFIX, GALLERY_DATA_PREFIX, STATS_PATH,
  IMAGE_EXT, isContentPath, mergeGallery, movedCount, srcKey,
} from "../gallery-model.mjs";

export class ContentError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function gitBlobSha(buf) {
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

export const MILESTONES = [75_000, 100_000, 150_000, 250_000, 500_000, 750_000, 1_000_000];
const MAX_STATS = 100_000_000;
const MAX_BATCH_REMOVE = 500;

// Immutable data, safe to reuse across requests while the function instance is warm.
const blobCache = new Map();   // blob sha -> Promise<Buffer>
const treeCache = new Map();   // commit sha -> Promise<{ treeSha, entries }>
const publishCache = new Map(); // main sha -> Promise<lastPublished>

function remember(map, key, make, limit) {
  if (!map.has(key)) {
    const p = make();
    p.catch(() => map.delete(key));
    map.set(key, p);
    if (map.size > limit) map.delete(map.keys().next().value);
  }
  return map.get(key);
}

export function createContentEngine({
  gh,
  draftBranch = "staging",
  prodBranch = "main",
  rawBase,          // e.g. https://raw.githubusercontent.com/<owner>/<repo>
  liveBase = "",    // e.g. https://jcwrks.com (photos already live load from the CDN)
  maxAttempts = 8,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const tree = (commitSha) =>
    remember(treeCache, commitSha, () => gh.getCommit(commitSha).then(async (c) => ({ treeSha: c.tree, entries: await gh.getTree(c.tree) })), 60);
  const blob = (sha) => remember(blobCache, sha, () => gh.getBlob(sha), 500);
  const contentOf = (entries) => new Map(entries.filter((e) => isContentPath(e.path)).map((e) => [e.path, e.sha]));

  // ---------- reading ----------

  // GitHub reads can lag a moment behind a write. If the browser already knows
  // a newer commit (from a write it just made), trust it when it's a descendant.
  async function freshest(readSha, hint) {
    if (!hint || !readSha || hint === readSha || !/^[0-9a-f]{40}$/.test(hint)) return readSha;
    try {
      const cmp = await gh.compare(readSha, hint);
      return cmp.status === "ahead" ? hint : readSha;
    } catch {
      return readSha;
    }
  }

  async function loadContext(hints = {}) {
    const [mainRef, stagingRef] = await Promise.all([gh.getRef(prodBranch), gh.getRef(draftBranch)]);
    if (!mainRef) throw new ContentError("no_main", "The site's main branch is missing.", 500);
    const [mainHead, stagingFresh] = await Promise.all([freshest(mainRef, hints.prod), freshest(stagingRef, hints.draft)]);
    let stagingHead = stagingFresh;
    if (!stagingHead) {
      try { await gh.createRef(draftBranch, mainHead); } catch { /* someone else created it */ }
      stagingHead = await gh.getRef(draftBranch);
      if (!stagingHead) throw new ContentError("no_draft", "Couldn't create the draft branch.", 500);
    }

    let mergeBase = mainHead;
    if (stagingHead !== mainHead) {
      mergeBase = (await gh.compare(mainHead, stagingHead)).mergeBase || mainHead;
    }

    const [mainT, stagingT, baseT] = await Promise.all([tree(mainHead), tree(stagingHead), tree(mergeBase)]);
    const mainContent = contentOf(mainT.entries);
    const stagingContent = contentOf(stagingT.entries);
    const baseContent = contentOf(baseT.entries);

    // Jacob's changes = what staging changed since it last included main.
    // Applied on top of the CURRENT main, so later code/content on main is kept.
    const draftContent = new Map(mainContent);
    for (const path of new Set([...baseContent.keys(), ...stagingContent.keys()])) {
      const before = baseContent.get(path);
      const after = stagingContent.get(path);
      if (before === after) continue;
      if (after === undefined) draftContent.delete(path);
      else draftContent.set(path, after);
    }

    return { mainHead, stagingHead, mergeBase, mainTreeSha: mainT.treeSha, mainContent, draftContent };
  }

  function diffEntries(from, to) {
    const entries = [];
    for (const [path, sha] of to) if (from.get(path) !== sha) entries.push({ path, sha });
    for (const path of from.keys()) if (!to.has(path)) entries.push({ path, sha: null });
    return entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  async function readJson(content, path, fallback) {
    const sha = content.get(path);
    if (!sha) return structuredClone(fallback);
    try {
      const parsed = JSON.parse((await blob(sha)).toString("utf8"));
      return parsed && typeof parsed === "object" ? parsed : structuredClone(fallback);
    } catch {
      return structuredClone(fallback);
    }
  }

  function assertGallery(slug) {
    if (!GALLERY_SLUGS.includes(slug)) throw new ContentError("bad_gallery", "Unknown gallery.");
  }

  async function galleryView(content, slug) {
    const jsonPath = `${GALLERY_DATA_PREFIX}${slug}.json`;
    const data = await readJson(content, jsonPath, { images: [] });
    const folder = `${GALLERIES_PREFIX}${slug}/`;
    const files = [];
    for (const path of content.keys()) {
      if (path.startsWith(folder) && !path.slice(folder.length).includes("/") && IMAGE_EXT.test(path)) {
        files.push("/" + path.slice("public/".length));
      }
    }
    const merged = mergeGallery(data.images, files);
    const images = merged.images.map((img) => ({ ...img, sha: content.get("public" + img.src) }));
    return { jsonPath, data, images, missing: merged.missing, extras: merged.extras };
  }

  const encodePath = (src) => src.split("/").map(encodeURIComponent).join("/");
  const rawUrl = (commitSha, src) => (rawBase ? `${rawBase}/${commitSha}/public${encodePath(src)}` : `/public${src}`);

  /** Thumbnail URL: the live CDN copy when production has these exact bytes, else the draft commit. */
  function photoUrls(ctx, commitSha, img) {
    const fallbackUrl = rawUrl(commitSha, img.src);
    const url = liveBase && ctx.mainContent.get("public" + img.src) === img.sha ? liveBase + encodePath(img.src) : fallbackUrl;
    return { url, fallbackUrl };
  }

  async function readStats(content) {
    const stats = await readJson(content, STATS_PATH, { photosTaken: 0 });
    const n = Number(stats.photosTaken);
    return { stats, value: Number.isFinite(n) && n > 0 ? Math.round(n) : 0 };
  }

  async function summarize(ctx) {
    const entries = diffEntries(ctx.mainContent, ctx.draftContent);
    const explained = new Set();
    const galleries = [];

    for (const slug of GALLERY_SLUGS) {
      const folder = `${GALLERIES_PREFIX}${slug}/`;
      const jsonPath = `${GALLERY_DATA_PREFIX}${slug}.json`;
      if (!entries.some((e) => e.path.startsWith(folder) || e.path === jsonPath)) continue;

      const [live, draft] = await Promise.all([galleryView(ctx.mainContent, slug), galleryView(ctx.draftContent, slug)]);
      const liveKeys = new Map(live.images.map((i) => [srcKey(i.src), i]));
      const draftKeys = new Map(draft.images.map((i) => [srcKey(i.src), i]));

      const added = draft.images.filter((i) => !liveKeys.has(srcKey(i.src)));
      const removed = live.images.filter((i) => !draftKeys.has(srcKey(i.src)));
      const replaced = draft.images.filter((i) => liveKeys.has(srcKey(i.src)) && liveKeys.get(srcKey(i.src)).sha !== i.sha);
      const captions = draft.images.filter((i) => liveKeys.has(srcKey(i.src)) && (liveKeys.get(srcKey(i.src)).alt || "") !== (i.alt || ""));
      const moved = movedCount(live.images.map((i) => i.src), draft.images.map((i) => i.src));

      for (const e of entries) if (e.path.startsWith(folder) || e.path === jsonPath) explained.add(e.path);
      const housekeeping = !added.length && !removed.length && !replaced.length && !captions.length && !moved;
      galleries.push({
        slug,
        title: GALLERY_TITLES[slug],
        added: added.length,
        removed: removed.length,
        replaced: replaced.length,
        moved,
        captions: captions.length,
        housekeeping,
        liveCount: live.images.length,
        draftCount: draft.images.length,
        removedPhotos: removed.map((i) => ({ src: i.src, sha: i.sha, ...photoUrls(ctx, ctx.mainHead, i) })),
      });
    }

    const [liveStats, draftStats] = await Promise.all([readStats(ctx.mainContent), readStats(ctx.draftContent)]);
    if (entries.some((e) => e.path === STATS_PATH)) explained.add(STATS_PATH);
    const other = entries.filter((e) => !explained.has(e.path)).length;

    const plural = (n, word) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
    const lines = [];
    for (const g of galleries) {
      if (g.housekeeping) continue;
      const bits = [];
      if (g.added) bits.push(`${plural(g.added, "photo")} added`);
      if (g.removed) bits.push(`${plural(g.removed, "photo")} removed`);
      if (g.replaced) bits.push(`${plural(g.replaced, "photo")} updated`);
      if (g.moved) bits.push(`${plural(g.moved, "photo")} moved`);
      if (g.captions) bits.push(`${plural(g.captions, "caption")} changed`);
      lines.push(`${g.title}: ${bits.join(", ")}`);
    }
    if (draftStats.value !== liveStats.value) {
      const d = draftStats.value - liveStats.value;
      lines.push(`Moments Captured: ${liveStats.value.toLocaleString("en-US")} → ${draftStats.value.toLocaleString("en-US")} (${d > 0 ? "+" : "−"}${Math.abs(d).toLocaleString("en-US")})`);
    }
    if (galleries.some((g) => g.housekeeping) || other) lines.push("Behind-the-scenes gallery tidy-up");

    return {
      hasChanges: entries.length > 0,
      changedFiles: entries.length,
      galleries,
      stats: { live: liveStats.value, draft: draftStats.value },
      lines,
    };
  }

  /** The most recent publish that reached main through /admin, derived from git history. */
  function lastPublished(mainHead) {
    return remember(publishCache, mainHead, async () => {
      if (!gh.listCommits) return null;
      const commits = await gh.listCommits(prodBranch, 40);
      const hit = commits.find((c) => /\(\s*(queued\s+)?via \/admin\)/.test(c.message) && !/^Retry publishing/.test(c.message));
      if (!hit) return null;
      let galleries = [];
      let moments = false;
      try {
        const files = await gh.getCommitFiles(hit.sha);
        const slugs = new Set();
        for (const f of files) {
          const m = f.match(/^public\/galleries\/([^/]+)\//) || f.match(/^src\/data\/galleries\/([^/]+)\.json$/);
          if (m && GALLERY_SLUGS.includes(m[1])) slugs.add(m[1]);
          if (f === STATS_PATH) moments = true;
        }
        galleries = GALLERY_SLUGS.filter((s) => slugs.has(s)).map((s) => GALLERY_TITLES[s]);
      } catch { /* date alone is still useful */ }
      return { date: hit.date, galleries, moments };
    }, 20);
  }

  async function stateFrom(ctx) {
    const views = await Promise.all(GALLERY_SLUGS.map((slug) => galleryView(ctx.draftContent, slug)));
    const changes = await summarize(ctx);
    const changedSlugs = new Set(changes.galleries.filter((g) => !g.housekeeping).map((g) => g.slug));
    const galleries = GALLERY_SLUGS.map((slug, i) => {
      const first = views[i].images[0];
      return {
        slug,
        title: GALLERY_TITLES[slug],
        count: views[i].images.length,
        changed: changedSlugs.has(slug),
        cover: first ? { sha: first.sha, ...photoUrls(ctx, ctx.stagingHead, first) } : null,
      };
    });
    let published = null;
    try { published = await lastPublished(ctx.mainHead); } catch { published = null; }
    return {
      draftSha: ctx.stagingHead,
      productionSha: ctx.mainHead,
      galleries,
      totalPhotos: galleries.reduce((n, g) => n + g.count, 0),
      stats: changes.stats,
      milestones: MILESTONES,
      changes,
      lastPublished: published,
    };
  }

  async function galleryFrom(ctx, slug) {
    const view = await galleryView(ctx.draftContent, slug);
    return {
      draftSha: ctx.stagingHead,
      gallery: slug,
      title: GALLERY_TITLES[slug],
      photos: view.images.map((i) => ({
        src: i.src,
        sha: i.sha,
        name: i.src.split("/").pop(),
        alt: i.alt || "",
        ...photoUrls(ctx, ctx.stagingHead, i),
        isNew: ctx.mainContent.get("public" + i.src) !== i.sha,
      })),
    };
  }

  // ---------- writing ----------

  function jsonBuffer(obj) {
    return Buffer.from(JSON.stringify(obj, null, 2) + "\n", "utf8");
  }

  async function writeJson(work, pending, path, obj) {
    const buf = jsonBuffer(obj);
    const sha = gitBlobSha(buf);
    if (work.get(path) === sha) return;
    pending.push(buf);
    work.set(path, sha);
  }

  /**
   * Apply one intent atomically to the draft, retrying on conflicts.
   * intent(ctx, work, newBlobs) mutates `work` (path -> sha) and returns a result.
   * Returns the result plus `ctx`: the exact context AFTER the change, so callers
   * can answer with fresh state without reading GitHub again.
   */
  async function change(message, intent, hints = {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const ctx = await loadContext(hints);
      const work = new Map(ctx.draftContent);
      const newBlobs = [];
      const result = (await intent(ctx, work, newBlobs)) || {};

      const before = diffEntries(ctx.mainContent, ctx.draftContent);
      const after = diffEntries(ctx.mainContent, work);
      const same = before.length === after.length && before.every((e, i) => e.path === after[i].path && e.sha === after[i].sha);
      if (same) return { ...result, changed: false, draftSha: ctx.stagingHead, ctx };

      for (const buf of newBlobs) {
        const sha = await gh.createBlob(buf);
        blobCache.set(sha, Promise.resolve(buf));
      }
      const treeSha = after.length ? await gh.createTree(ctx.mainTreeSha, after) : ctx.mainTreeSha;
      const parents = [ctx.stagingHead];
      if (ctx.mergeBase !== ctx.mainHead) parents.push(ctx.mainHead);
      const commit = await gh.createCommit(`${message} (via /admin)`, treeSha, parents);
      try {
        await gh.updateRef(draftBranch, commit);
        // main is now an ancestor of the new draft commit, so it is the merge base.
        const nextCtx = { ...ctx, stagingHead: commit, mergeBase: ctx.mainHead, draftContent: work };
        return { ...result, changed: true, draftSha: commit, ctx: nextCtx };
      } catch (err) {
        if (!(err instanceof RefConflictError) || attempt === maxAttempts) {
          if (err instanceof RefConflictError) {
            throw new ContentError("busy", "Another change was saving at the same time. Please try again.", 409);
          }
          throw err;
        }
        await sleep(Math.floor(Math.random() * 120 * attempt)); // jitter so racing writers spread out
      }
    }
    throw new ContentError("busy", "Another change was saving at the same time. Please try again.", 409);
  }

  function findImage(view, src) {
    const k = srcKey(String(src || ""));
    return view.images.find((i) => srcKey(i.src) === k);
  }

  function uniquePath(work, folder, stem, ext) {
    const lower = new Set([...work.keys()].map((k) => k.toLowerCase()));
    let name = `${stem}.${ext}`;
    let n = 2;
    while (lower.has((folder + name).toLowerCase())) name = `${stem}-${n++}.${ext}`;
    return folder + name;
  }

  const plain = (images) => images.map(({ src, alt }) => ({ src, alt: alt || "" }));

  return {
    /** Test/measurement hook: forget cached trees and blobs (simulates a cold function). */
    clearCaches() { treeCache.clear(); blobCache.clear(); publishCache.clear(); },
    loadContext,
    summarize,
    stateFrom,
    galleryFrom,

    async state(hints) {
      return stateFrom(await loadContext(hints));
    },

    async gallery(slug, hints) {
      assertGallery(slug);
      return galleryFrom(await loadContext(hints), slug);
    },

    /** files: [{ sha, ext: "jpg"|"webp", stem }] (already validated + signed by the handler) */
    async addPhotos(slug, files, hints) {
      assertGallery(slug);
      if (!Array.isArray(files) || !files.length) throw new ContentError("no_files", "No photos to add.");
      if (files.length > 200) throw new ContentError("too_many", "Please add at most 200 photos at a time.");
      return change(`Add photos to ${slug}`, async (ctx, work, newBlobs) => {
        const view = await galleryView(work, slug);
        const folder = `${GALLERIES_PREFIX}${slug}/`;
        const shasInGallery = new Set(view.images.map((i) => i.sha));
        const images = plain(view.images);
        const added = [];
        const skipped = [];
        for (const f of files) {
          if (shasInGallery.has(f.sha)) {
            skipped.push({ sha: f.sha, reason: "duplicate" });
            continue;
          }
          const path = uniquePath(work, folder, `${f.stem}-${f.sha.slice(0, 8)}`, f.ext);
          work.set(path, f.sha);
          shasInGallery.add(f.sha);
          const src = "/" + path.slice("public/".length);
          images.push({ src, alt: "" });
          added.push({ sha: f.sha, src });
        }
        if (added.length) await writeJson(work, newBlobs, view.jsonPath, { ...view.data, images });
        return { added, skipped };
      }, hints);
    },

    /** Remove one or many photos in a single change. Returns what was removed (with sha + position for undo). */
    async removePhotos(slug, srcs, hints) {
      assertGallery(slug);
      if (!Array.isArray(srcs) || !srcs.length) throw new ContentError("no_photos", "No photos selected.");
      if (srcs.length > MAX_BATCH_REMOVE) throw new ContentError("too_many", "Too many photos at once.");
      return change(`Remove ${srcs.length === 1 ? "a photo" : `${srcs.length} photos`} from ${slug}`, async (ctx, work, newBlobs) => {
        const view = await galleryView(work, slug);
        const wanted = new Set(srcs.map((s) => srcKey(String(s || ""))));
        const removed = [];
        const images = [];
        view.images.forEach((img, index) => {
          if (wanted.has(srcKey(img.src))) {
            work.delete("public" + img.src);
            removed.push({ src: img.src, sha: img.sha, alt: img.alt || "", index, wasLive: ctx.mainContent.get("public" + img.src) === img.sha });
          } else {
            images.push({ src: img.src, alt: img.alt || "" });
          }
        });
        if (removed.length) await writeJson(work, newBlobs, view.jsonPath, { ...view.data, images });
        return { removed, alreadyGone: srcs.length - removed.length };
      }, hints);
    },

    async removePhoto(slug, src, hints) {
      const r = await this.removePhotos(slug, [src], hints);
      return { ...r, removed: r.removed.length === 1, src: r.removed[0]?.src, alreadyGone: r.removed.length === 0 };
    },

    /**
     * Put photos back. A photo still on the live site comes back from there, in its live
     * position. A photo that was never published can be restored by its blob sha (the
     * browser keeps it for Undo); its bytes are re-validated first.
     * items: [{ src, sha?, index? }]
     */
    async restorePhotos(slug, items, hints) {
      assertGallery(slug);
      if (!Array.isArray(items) || !items.length) throw new ContentError("no_photos", "Nothing to restore.");
      const folder = `${GALLERIES_PREFIX}${slug}/`;
      // Validate never-published photos up front (outside the retry loop).
      const verified = new Map();
      for (const it of items) {
        if (typeof it?.sha === "string" && /^[0-9a-f]{40}$/.test(it.sha)) {
          try {
            validateImage(await blob(it.sha));
            verified.set(it.sha, true);
          } catch { /* not restorable by sha */ }
        }
      }
      return change(`Restore photos in ${slug}`, async (ctx, work, newBlobs) => {
        const live = await galleryView(ctx.mainContent, slug);
        const view = await galleryView(work, slug);
        const images = plain(view.images);
        const restored = [];
        const failed = [];
        // Restore in original position order so indexes stay meaningful.
        const ordered = [...items].sort((a, b) => (a.index ?? 1e9) - (b.index ?? 1e9));
        for (const it of ordered) {
          const src = String(it?.src || "");
          if (images.some((i) => srcKey(i.src) === srcKey(src))) continue; // already there
          const liveImg = findImage(live, src);
          if (liveImg) {
            work.set("public" + liveImg.src, liveImg.sha);
            let insertAt = images.length;
            if (Number.isInteger(it.index)) {
              // Undo: back to exactly where it was in the draft.
              insertAt = Math.max(0, Math.min(it.index, images.length));
            } else {
              // "Put back": before the first photo that followed it on the live site.
              const liveIdx = live.images.indexOf(liveImg);
              const keys = images.map((i) => srcKey(i.src));
              for (const next of live.images.slice(liveIdx + 1)) {
                const at = keys.indexOf(srcKey(next.src));
                if (at !== -1) { insertAt = at; break; }
              }
            }
            images.splice(insertAt, 0, { src: liveImg.src, alt: liveImg.alt || "" });
            restored.push(liveImg.src);
            continue;
          }
          const name = src.startsWith(`/galleries/${slug}/`) ? src.slice(`/galleries/${slug}/`.length) : "";
          const m = name.match(/^([A-Za-z0-9._-]{1,120})\.(jpg|webp)$/);
          if (!m || !verified.has(it.sha)) { failed.push(src); continue; }
          const path = work.get(folder + name) ? uniquePath(work, folder, m[1], m[2]) : folder + name;
          work.set(path, it.sha);
          const at = Number.isInteger(it.index) ? Math.max(0, Math.min(it.index, images.length)) : images.length;
          images.splice(at, 0, { src: "/" + path.slice("public/".length), alt: typeof it.alt === "string" ? it.alt : "" });
          restored.push("/" + path.slice("public/".length));
        }
        if (restored.length) await writeJson(work, newBlobs, view.jsonPath, { ...view.data, images });
        return { restored, failed };
      }, hints);
    },

    async restorePhoto(slug, src, hints) {
      const r = await this.restorePhotos(slug, [{ src }], hints);
      if (r.failed.length) throw new ContentError("not_live", "That photo isn't on the live site, so it can't be restored.", 404);
      return { ...r, restored: r.restored.length === 1, alreadyThere: r.restored.length === 0, src: r.restored[0] };
    },

    async reorder(slug, order, hints) {
      assertGallery(slug);
      if (!Array.isArray(order)) throw new ContentError("bad_order", "Missing photo order.");
      return change(`Reorder ${slug}`, async (ctx, work, newBlobs) => {
        const view = await galleryView(work, slug);
        const byKey = new Map(view.images.map((i) => [srcKey(i.src), i]));
        const used = new Set();
        const images = [];
        for (const s of order) {
          const k = srcKey(String(s || ""));
          if (byKey.has(k) && !used.has(k)) { used.add(k); images.push(byKey.get(k)); }
        }
        // Anything the request didn't mention (e.g. added from another device) keeps its place at the end.
        for (const i of view.images) if (!used.has(srcKey(i.src))) images.push(i);
        await writeJson(work, newBlobs, view.jsonPath, { ...view.data, images: plain(images) });
        return { order: images.map((i) => i.src) };
      }, hints);
    },

    async addToMoments(amount, hints) {
      if (!Number.isInteger(amount) || amount < 1 || amount > 1_000_000) {
        throw new ContentError("bad_amount", "Enter a whole number between 1 and 1,000,000.");
      }
      return change(`Add ${amount} to Moments Captured`, async (ctx, work, newBlobs) => {
        const { stats, value } = await readStats(work);
        const next = Math.min(value + amount, MAX_STATS);
        await writeJson(work, newBlobs, STATS_PATH, { ...stats, photosTaken: next });
        return { before: value, after: next };
      }, hints);
    },

    async setMoments(value, expected, hints) {
      if (!Number.isInteger(value) || value < 0 || value > MAX_STATS) {
        throw new ContentError("bad_amount", "Enter a whole number between 0 and 100,000,000.");
      }
      if (!Number.isInteger(expected)) throw new ContentError("bad_expected", "Missing the current total. Refresh and try again.");
      return change(`Set Moments Captured to ${value}`, async (ctx, work, newBlobs) => {
        const { stats, value: current } = await readStats(work);
        if (current !== expected) {
          throw new ContentError("stale_total", `The total changed to ${current.toLocaleString("en-US")} while you were editing. Please check it and try again.`, 409);
        }
        await writeJson(work, newBlobs, STATS_PATH, { ...stats, photosTaken: value });
        return { before: current, after: value };
      }, hints);
    },

    async discard(hints) {
      return change("Discard unpublished changes", async (ctx, work) => {
        work.clear();
        for (const [p, s] of ctx.mainContent) work.set(p, s);
        return { discarded: true };
      }, hints);
    },

    /** Publish exactly the draft Jacob reviewed (expectedDraftSha) to production. */
    async publish(expectedDraftSha, hints = {}) {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const ctx = await loadContext({ ...hints, draft: expectedDraftSha });
        if (expectedDraftSha && expectedDraftSha !== ctx.stagingHead) {
          throw new ContentError("stale_draft", "Your changes were updated since you last looked. Please review them and publish again.", 409);
        }
        const entries = diffEntries(ctx.mainContent, ctx.draftContent);
        if (!entries.length) return { published: false, nothingToPublish: true, productionSha: ctx.mainHead, ctx };
        const summary = await summarize(ctx);
        const treeSha = await gh.createTree(ctx.mainTreeSha, entries);
        const parents = ctx.stagingHead === ctx.mainHead ? [ctx.mainHead] : [ctx.mainHead, ctx.stagingHead];
        const commit = await gh.createCommit("Publish portfolio changes (via /admin)", treeSha, parents);
        try {
          await gh.updateRef(prodBranch, commit);
        } catch (err) {
          if (err instanceof RefConflictError && attempt < maxAttempts) { await sleep(60 * attempt); continue; }
          if (err instanceof RefConflictError) throw new ContentError("busy", "The site was being updated at the same time. Please try again.", 409);
          throw err;
        }
        // Level the draft with what just went live. If a new change landed
        // meanwhile this is refused, which is fine: that change stays pending.
        let levelled = true;
        try { await gh.updateRef(draftBranch, commit); } catch { levelled = false; }
        const nextCtx = levelled
          ? { ...ctx, mainHead: commit, stagingHead: commit, mergeBase: commit, mainTreeSha: treeSha, mainContent: ctx.draftContent }
          : null;
        return { published: true, productionSha: commit, summary, ctx: nextCtx };
      }
      throw new ContentError("busy", "The site was being updated at the same time. Please try again.", 409);
    },

    /** Re-run the live update for what's already published (no content change). */
    async retryPublish() {
      const ctx = await loadContext();
      const commit = await gh.createCommit("Retry publishing (via /admin)", ctx.mainTreeSha, [ctx.mainHead]);
      try {
        await gh.updateRef(prodBranch, commit);
      } catch (err) {
        if (err instanceof RefConflictError) throw new ContentError("busy", "The site is already updating. Please wait a minute.", 409);
        throw err;
      }
      return { productionSha: commit };
    },

    /** Is `targetSha` (or something newer that contains it) what the live site is serving? */
    async isLive(targetSha, liveCommit) {
      if (!liveCommit) return false;
      if (liveCommit === targetSha) return true;
      try {
        const cmp = await gh.compare(targetSha, liveCommit);
        return cmp.status === "ahead" || cmp.status === "identical";
      } catch {
        return false;
      }
    },
  };
}
