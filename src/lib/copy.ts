// Site text for the public pages: Jacob's wording from /admin (src/data/copy.json),
// else the original wording. Rules and defaults live in ./site-text.mjs.
//
// Read with import.meta.glob so a missing copy.json can never break the build.

import { effectiveText } from "./site-text.mjs";

const files = import.meta.glob<{ default: unknown }>("../data/copy.json", { eager: true });
const data = Object.values(files)[0]?.default ?? {};

/** The wording for one field. Output is always plain text (Astro escapes it). */
export function text(key: string): string {
  return effectiveText(data, key);
}

/** A paragraphs field, one string per paragraph. */
export function paragraphs(key: string): string[] {
  return text(key).split("\n\n");
}
