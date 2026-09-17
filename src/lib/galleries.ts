// Loads gallery photos + cover for the site at build time.
//
// The rules live in ./gallery-model.mjs, shared with the /admin backend, so
// the order Jacob sets in /admin is exactly what renders here:
//   - src/data/galleries/<slug>.json decides ORDER and captions
//   - a listed photo whose file is gone is skipped (no broken images)
//   - a file in public/galleries/<slug>/ that isn't listed is appended
//     (only happens for files added outside /admin)

import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mergeGallery } from "./gallery-model.mjs";

export interface GalleryImage {
  src: string;
  alt?: string;
}

const files = import.meta.glob<{ cover?: string; images?: GalleryImage[] }>(
  "../data/galleries/*.json",
  { eager: true }
);

// Astro bundles this module, so import.meta.url can point into a build chunk rather
// than src/lib — resolve against the real project root instead and fall back.
const CANDIDATE_ROOTS = [
  `${process.cwd()}/public/galleries`,
  fileURLToPath(new URL("../../public/galleries", import.meta.url)),
];
const GALLERIES_DIR = CANDIDATE_ROOTS.find((d) => existsSync(d)) ?? CANDIDATE_ROOTS[0];

function filesOnDisk(slug: string): string[] {
  const dir = `${GALLERIES_DIR}/${slug}`;
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).map((name) => `/galleries/${slug}/${name}`);
  } catch {
    return [];
  }
}

const imagesBySlug: Record<string, GalleryImage[]> = {};
const coverBySlug: Record<string, string> = {};
const notes: string[] = [];

for (const path in files) {
  const slug = path.split("/").pop()!.replace(".json", "");
  const data = files[path] as { cover?: string; images?: GalleryImage[] };

  const { images, missing, extras } = mergeGallery(data.images ?? [], filesOnDisk(slug));
  imagesBySlug[slug] = images;
  if (data.cover) coverBySlug[slug] = data.cover;
  if (extras.length) notes.push(`${slug} +${extras.length} unlisted`);
  if (missing.length) notes.push(`${slug} skipped ${missing.length} missing`);
}

// Shows up in the Netlify build log.
if (notes.length) {
  console.log(`[galleries] ${notes.join(", ")}`);
}

export function getGalleryImages(slug: string): GalleryImage[] {
  return imagesBySlug[slug] ?? [];
}

// JSON-set cover wins; fall back to the hardcoded `fallback` (from categories.ts)
export function getCover(slug: string, fallback?: string): string | undefined {
  return coverBySlug[slug] || fallback;
}

// Total real photos across every gallery.
export function getTotalPhotos(): number {
  return Object.values(imagesBySlug).reduce((sum, imgs) => sum + imgs.length, 0);
}
