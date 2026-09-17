// Server-side check of an uploaded photo's ACTUAL bytes.
//
// The browser prepares every photo (resize to <=2000px, JPEG or WebP) before
// sending it. We never trust the filename or the Content-Type: we sniff the
// real format from the bytes, read the real pixel size from the header, and
// refuse anything that isn't a web-ready JPEG/WebP of sensible size. That way
// nothing oversized or mislabelled can reach the repo (the Sept 16 uploads
// were 4MB PNGs named .webp).

export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024; // browser targets <=2.5MB
export const MAX_EDGE = 2048;                    // browser targets 2000px
export const MIN_EDGE = 16;

export class ImageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) return "webp";
  if (buf.length >= 8 && buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return "png";
  if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp") {
    const brand = buf.toString("ascii", 8, 12);
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return "heic";
    if (/^avi[fs]$/.test(brand)) return "avif";
  }
  if (buf.length >= 4 && (buf.toString("ascii", 0, 4) === "II*\0" || buf.toString("ascii", 0, 4) === "MM\0*")) return "tiff";
  if (buf.length >= 6 && buf.toString("ascii", 0, 3) === "GIF") return "gif";
  return "unknown";
}

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd9 || marker === 0xda) return null; // hit image data without a size
    i += 2 + len;
  }
  return null;
}

function webpSize(buf) {
  let off = 12;
  while (off + 8 <= buf.length) {
    const type = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const data = off + 8;
    if (type === "VP8X" && data + 10 <= buf.length) {
      return { width: 1 + buf.readUIntLE(data + 4, 3), height: 1 + buf.readUIntLE(data + 7, 3) };
    }
    if (type === "VP8 " && data + 10 <= buf.length) {
      if (buf[data + 3] !== 0x9d || buf[data + 4] !== 0x01 || buf[data + 5] !== 0x2a) return null;
      return { width: buf.readUInt16LE(data + 6) & 0x3fff, height: buf.readUInt16LE(data + 8) & 0x3fff };
    }
    if (type === "VP8L" && data + 5 <= buf.length) {
      if (buf[data] !== 0x2f) return null;
      const b = buf.readUInt32LE(data + 1);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    off = data + size + (size % 2);
  }
  return null;
}

const FRIENDLY = {
  heic: "This is an iPhone HEIC photo that wasn't converted. Try again in Safari on your iPhone, or export it as a JPG first.",
  png: "PNG files aren't accepted here. Please refresh the page and try again.",
  unknown: "That file isn't a photo we can use. Please use JPG photos.",
};

/**
 * Validate prepared image bytes.
 * @param {Buffer} buf
 * @returns {{ format: "jpeg"|"webp", ext: "jpg"|"webp", width: number, height: number, bytes: number }}
 */
export function validateImage(buf) {
  if (!buf || !buf.length) throw new ImageError("empty", "The photo was empty. Please try again.");
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new ImageError("too_large", "This photo is too large after shrinking. Please refresh the page and try again.");
  }
  const format = sniff(buf);
  if (format !== "jpeg" && format !== "webp") {
    throw new ImageError("unsupported", FRIENDLY[format] || FRIENDLY.unknown);
  }
  const dims = format === "jpeg" ? jpegSize(buf) : webpSize(buf);
  if (!dims || !dims.width || !dims.height) {
    throw new ImageError("corrupt", "This photo looks damaged and couldn't be read. Try exporting it again.");
  }
  if (Math.max(dims.width, dims.height) > MAX_EDGE) {
    throw new ImageError("too_big_dimensions", "This photo wasn't shrunk properly. Please refresh the page and try again.");
  }
  if (Math.min(dims.width, dims.height) < MIN_EDGE) {
    throw new ImageError("too_small", "This image is too small to be a portfolio photo.");
  }
  return { format, ext: format === "jpeg" ? "jpg" : "webp", width: dims.width, height: dims.height, bytes: buf.length };
}

/** Safe, readable stem from the camera filename: "IMG 0042 (1).HEIC" -> "IMG-0042-1". */
export function safeStem(name) {
  const base = String(name || "").split(/[\\/]/).pop() || "";
  const stem = base.replace(/\.[^.]*$/, "");
  const cleaned = stem.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
  return (cleaned || "photo").slice(0, 60);
}
