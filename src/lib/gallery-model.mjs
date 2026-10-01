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
export const COPY_PATH = "src/data/copy.json"; // site text (see site-text.mjs)

// Paths that count as "content" (what Jacob manages). Everything else is code.
export function isContentPath(path) {
  return (
    (path.startsWith(GALLERIES_PREFIX) && IMAGE_EXT.test(path)) ||
    (path.startsWith(GALLERY_DATA_PREFIX) && path.endsWith(".json")) ||
    path === STATS_PATH ||
    path === COPY_PATH
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

// Each album's original designed cover (public/covers/), used until Jacob picks one.
// `src` mirrors the `cover` values in src/data/categories.ts (a test keeps them in step).
// `photo` is the album photo that cover was cut from, when there is one, so /admin can
// point at the right photo. Basketball's original isn't in its album.
export const ORIGINAL_COVERS = {
  basketball: { src: "/covers/basketball.jpg", photo: null },
  football: { src: "/covers/football.jpg", photo: "/galleries/football/5N1A7535-89bc3a38.jpg" },
  soccer: { src: "/covers/soccer.jpg", photo: "/galleries/soccer/5N1A9465.webp" },
  baseball: { src: "/covers/baseball.jpg", photo: "/galleries/baseball/IMG_0674.webp" },
  softball: { src: "/covers/softball.jpg", photo: "/galleries/softball/IMG_8643-997a05cf.jpg" },
  hockey: { src: "/covers/hockey.jpg", photo: "/galleries/hockey/_MG_7769.webp" },
  track: { src: "/covers/track.jpg", photo: "/galleries/track/5N1A1830-18caf2ee.jpg" },
  portraits: { src: "/covers/portraits.jpg", photo: "/galleries/portraits/5N1A9007.jpeg" },
  landscape: { src: "/covers/landscape.jpg", photo: "/galleries/landscape/5N1A3643-60ff6572.jpg" },
  cars: { src: "/covers/cars.jpg", photo: "/galleries/cars/5N1A7848-f03bda09.jpg" },
  graphics: { src: "/covers/graphics.jpg", photo: "/galleries/graphics/JB1-copy-3f20499c.jpg" },
};

const isDesignedCover = (src) => typeof src === "string" && src.startsWith("/covers/") && IMAGE_EXT.test(src);

/**
 * Which image represents an album on the site (its cover). One rule for the site
 * build and /admin, so the cover Jacob sees in /admin is the one that renders.
 *
 *   1. `cover` (the album JSON's field) names a photo that is in the album now -> that photo.
 *   2. `cover` names a designed cover in /covers/ that exists              -> that image.
 *   3. no `cover` at all -> the album's original designed cover, if it exists.
 *   4. otherwise (the chosen photo was removed, or nothing above exists)   -> the first
 *      photo in the album's current order.
 *   5. no photos either -> the original designed cover if it exists, else none
 *      (the site shows its placeholder tile).
 *
 * @param {{ cover?: string, images: Array<{src:string}>, original?: string|null, exists?: (src:string)=>boolean }} a
 *   `images` must be the album's resolved photos (mergeGallery().images).
 * @returns {{ src: string|null, kind: "chosen"|"original"|"first"|"none", stale: boolean }}
 *   `stale` = the album names a cover photo that is no longer in it.
 */
export function resolveCover({ cover, images, original = null, exists = () => true }) {
  const list = Array.isArray(images) ? images : [];
  let stale = false;
  if (typeof cover === "string" && cover) {
    const k = srcKey(cover);
    const hit = list.find((i) => srcKey(i.src) === k);
    if (hit) return { src: hit.src, kind: "chosen", stale };
    if (isDesignedCover(cover) && exists(cover)) return { src: cover, kind: "original", stale };
    stale = true;
  } else if (isDesignedCover(original) && exists(original)) {
    return { src: original, kind: "original", stale };
  }
  if (list.length) return { src: list[0].src, kind: "first", stale };
  if (isDesignedCover(original) && exists(original)) return { src: original, kind: "original", stale };
  return { src: null, kind: "none", stale };
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
