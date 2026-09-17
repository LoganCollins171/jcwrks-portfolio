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

const MAX_STATS = 100_000_000;
const blobCache = new Map(); // sha -> Promise<Buffer>; blobs are immutable

export function createContentEngine({
  gh,
  draftBranch = "staging",
  prodBranch = "main",
  rawBase,          // e.g. https://raw.githubusercontent.com/<owner>/<repo>
  liveBase = "",    // e.g. https://jcwrks.com (photos already live load from the CDN)
  maxAttempts = 8,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const treeCache = new Map();

  function tree(commitSha) {
    if (!treeCache.has(commitSha)) {
      const p = gh.getCommit(commitSha).then(async (c) => ({ treeSha: c.tree, entries: await gh.getTree(c.tree) }));
      p.catch(() => treeCache.delete(commitSha));
      treeCache.set(commitSha, p);
    }
    return treeCache.get(commitSha);
  }

  function blob(sha) {
    if (!blobCache.has(sha)) {
      const p = gh.getBlob(sha);
      p.catch(() => blobCache.delete(sha));
      blobCache.set(sha, p);
      if (blobCache.size > 500) blobCache.delete(blobCache.keys().next().value);
    }
    return blobCache.get(sha);
  }

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

  const photoUrl = (commitSha, src) =>
    rawBase ? `${rawBase}/${commitSha}/public${src.split("/").map(encodeURIComponent).join("/")}` : `/public${src}`;

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
      if (!added.length && !removed.length && !replaced.length && !captions.length && !moved) {
        // Only the list file changed without changing what the site shows
        // (e.g. photos written into the list for the first time).
        galleries.push({ slug, title: GALLERY_TITLES[slug], added: 0, removed: 0, replaced: 0, moved: 0, captions: 0, housekeeping: true, removedPhotos: [] });
        continue;
      }
      galleries.push({
        slug,
        title: GALLERY_TITLES[slug],
        added: added.length,
        removed: removed.length,
        replaced: replaced.length,
        moved,
        captions: captions.length,
        housekeeping: false,
        removedPhotos: removed.map((i) => ({
          src: i.src,
          url: liveBase ? liveBase + i.src.split("/").map(encodeURIComponent).join("/") : photoUrl(ctx.mainHead, i.src),
          fallbackUrl: photoUrl(ctx.mainHead, i.src),
        })),
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
      if (same) return { ...result, changed: false, draftSha: ctx.stagingHead };

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
        return { ...result, changed: true, draftSha: commit };
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
    let name = `${stem}.${ext}`;
    let n = 2;
    const taken = (p) => [...work.keys()].some((k) => k.toLowerCase() === p.toLowerCase());
    while (taken(folder + name)) name = `${stem}-${n++}.${ext}`;
    return folder + name;
  }

  return {
    loadContext,
    summarize,

    async state(hints) {
      const ctx = await loadContext(hints);
      const galleries = await Promise.all(
        GALLERY_SLUGS.map(async (slug) => ({ slug, title: GALLERY_TITLES[slug], count: (await galleryView(ctx.draftContent, slug)).images.length }))
      );
      const changes = await summarize(ctx);
      return { draftSha: ctx.stagingHead, productionSha: ctx.mainHead, galleries, stats: changes.stats, changes };
    },

    async gallery(slug, hints) {
      assertGallery(slug);
      const ctx = await loadContext(hints);
      const view = await galleryView(ctx.draftContent, slug);
      return {
        draftSha: ctx.stagingHead,
        gallery: slug,
        title: GALLERY_TITLES[slug],
        photos: view.images.map((i) => ({
          src: i.src,
          name: i.src.split("/").pop(),
          alt: i.alt || "",
          sha: i.sha,
          url: liveBase && ctx.mainContent.get("public" + i.src) === i.sha
            ? liveBase + i.src.split("/").map(encodeURIComponent).join("/")
            : photoUrl(ctx.stagingHead, i.src),
          fallbackUrl: photoUrl(ctx.stagingHead, i.src),
          isNew: !ctx.mainContent.has("public" + i.src) || ctx.mainContent.get("public" + i.src) !== i.sha,
        })),
      };
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
        const images = view.images.map(({ src, alt }) => ({ src, alt }));
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

    async removePhoto(slug, src, hints) {
      assertGallery(slug);
      return change(`Remove a photo from ${slug}`, async (ctx, work, newBlobs) => {
        const view = await galleryView(work, slug);
        const img = findImage(view, src);
        if (!img) return { removed: false, alreadyGone: true };
        work.delete("public" + img.src);
        const images = view.images.filter((i) => i !== img).map(({ src: s, alt }) => ({ src: s, alt }));
        await writeJson(work, newBlobs, view.jsonPath, { ...view.data, images });
        return { removed: true, src: img.src };
      }, hints);
    },

    async restorePhoto(slug, src, hints) {
      assertGallery(slug);
      return change(`Restore a photo in ${slug}`, async (ctx, work, newBlobs) => {
        const live = await galleryView(ctx.mainContent, slug);
        const liveImg = findImage(live, src);
        if (!liveImg) throw new ContentError("not_live", "That photo isn't on the live site, so it can't be restored.", 404);
        const view = await galleryView(work, slug);
        if (findImage(view, liveImg.src)) return { restored: false, alreadyThere: true };
        work.set("public" + liveImg.src, liveImg.sha);
        const images = view.images.map(({ src: s, alt }) => ({ src: s, alt }));
        // Put it back before the first photo that followed it on the live site.
        const liveIdx = live.images.indexOf(liveImg);
        const draftKeys = images.map((i) => srcKey(i.src));
        let insertAt = images.length;
        for (const next of live.images.slice(liveIdx + 1)) {
          const at = draftKeys.indexOf(srcKey(next.src));
          if (at !== -1) { insertAt = at; break; }
        }
        images.splice(insertAt, 0, { src: liveImg.src, alt: liveImg.alt || "" });
        await writeJson(work, newBlobs, view.jsonPath, { ...view.data, images });
        return { restored: true, src: liveImg.src };
      }, hints);
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
        await writeJson(work, newBlobs, view.jsonPath, { ...view.data, images: images.map(({ src: s, alt }) => ({ src: s, alt })) });
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
        if (!entries.length) return { published: false, nothingToPublish: true, productionSha: ctx.mainHead };
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
        try { await gh.updateRef(draftBranch, commit); } catch { /* keep newer draft */ }
        return { published: true, productionSha: commit, summary };
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
