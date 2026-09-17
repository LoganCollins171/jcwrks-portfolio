// The one set of rules for "what photos are in a gallery, in what order".
//
// Used by BOTH the live site (src/lib/galleries.ts, at build time) and the
// /admin backend (src/lib/admin/*), so the order Jacob sees in /admin is
// exactly the order the site renders. Keep this file dependency-free.
//
// Model:
//   - src/data/galleries/<slug>.json lists photos in order: { images: [{ src, alt }] }
//   - the files live in public/galleries/<slug>/
//   - a JSON entry whose file is missing is SKIPPED (never a broken image)
//   - a file with no JSON entry is appended after the listed ones, natural-sorted
//     (only happens for files added outside /admin; /admin always writes the list)

export const GALLERY_SLUGS = [
  "basketball", "football", "soccer", "baseball", "softball", "hockey", "track",
  "portraits", "landscape", "cars", "graphics",
];

export const GALLERY_TITLES = {
  basketball: "Basketball", football: "Football", soccer: "Soccer", baseball: "Baseball",
  softball: "Softball", hockey: "Hockey", track: "Track", portraits: "Portraits",
  landscape: "Landscape", cars: "Cars", graphics: "Graphics",
};

export const IMAGE_EXT = /\.(jpe?g|png|webp|avif)$/i;

export const GALLERIES_PREFIX = "public/galleries/";
export const GALLERY_DATA_PREFIX = "src/data/galleries/";
export const STATS_PATH = "src/data/stats.json";

// Paths that count as "content" (what Jacob manages). Everything else is code.
export function isContentPath(path) {
  return (
    (path.startsWith(GALLERIES_PREFIX) && IMAGE_EXT.test(path)) ||
    (path.startsWith(GALLERY_DATA_PREFIX) && path.endsWith(".json")) ||
    path === STATS_PATH
  );
}

// Loose comparison: URL-encoding and case differences are the same photo.
export function srcKey(src) {
  try {
    return decodeURIComponent(src).toLowerCase();
  } catch {
    return String(src).toLowerCase();
  }
}

export function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Merge a gallery's JSON list with the files that actually exist.
 * @param {Array<{src:string, alt?:string}>} listed  JSON images (any order)
 * @param {string[]} fileSrcs  "/galleries/<slug>/<file>" for every file on disk
 * @returns {{ images: Array<{src:string, alt:string}>, missing: string[], extras: string[] }}
 */
export function mergeGallery(listed, fileSrcs) {
  const onDisk = new Map();
  for (const src of fileSrcs) {
    if (IMAGE_EXT.test(src)) onDisk.set(srcKey(src), src);
  }

  const images = [];
  const missing = [];
  const seen = new Set();
  for (const item of Array.isArray(listed) ? listed : []) {
    if (!item || typeof item.src !== "string" || !item.src) continue;
    const k = srcKey(item.src);
    if (seen.has(k)) continue; // duplicate entry: first position wins
    if (!onDisk.has(k)) {
      missing.push(item.src);
      continue;
    }
    seen.add(k);
    images.push({ src: onDisk.get(k), alt: typeof item.alt === "string" ? item.alt : "" });
  }

  const extras = [...onDisk.entries()]
    .filter(([k]) => !seen.has(k))
    .map(([, src]) => src)
    .sort((a, b) => naturalCompare(a, b));
  for (const src of extras) images.push({ src, alt: "" });

  return { images, missing, extras };
}

/** Number of photos that changed position, given two orders of the same photos. */
export function movedCount(beforeSrcs, afterSrcs) {
  const afterKeys = new Set(afterSrcs.map(srcKey));
  const beforeKeys = new Set(beforeSrcs.map(srcKey));
  const common = beforeSrcs.map(srcKey).filter((k) => afterKeys.has(k));
  const position = new Map(afterSrcs.map(srcKey).filter((k) => beforeKeys.has(k)).map((k, i) => [k, i]));
  // Longest increasing subsequence of positions = photos that stayed in order.
  const seq = common.map((k) => position.get(k));
  const tails = [];
  for (const v of seq) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < v) lo = mid + 1; else hi = mid;
    }
    tails[lo] = v;
  }
  return seq.length - tails.length;
}
