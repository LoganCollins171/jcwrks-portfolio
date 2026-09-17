// Login, sessions, brute-force protection and signed upload receipts.
//
// - The password is checked once at login (constant-time) and exchanged for a
//   signed session token, so it isn't resent or stored in the browser.
// - Changing ADMIN_PASSWORD (or the GitHub token) invalidates every session.
// - Wrong passwords are counted per IP in a small store (Netlify Blobs in
//   production). Too many in a window locks that IP out for a while.
// - An upload returns a signed receipt for the exact validated blob, and only
//   receipts we signed can be added to a gallery.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_FAILS = 8;
export const FAIL_WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_MS = 15 * 60 * 1000;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function createAuth({ password, token, store, now = () => Date.now(), log = () => {} }) {
  const key = createHash("sha256").update(`jcwrks-admin|${password}|${token}`).digest();
  const sign = (s) => createHmac("sha256", key).update(s).digest("base64url");

  function safeEqual(a, b) {
    const ha = createHash("sha256").update(String(a)).digest();
    const hb = createHash("sha256").update(String(b)).digest();
    return timingSafeEqual(ha, hb);
  }

  async function readFails(ip) {
    if (!store) return null;
    try {
      return (await store.get(`fails/${ip}`, { type: "json" })) || null;
    } catch (err) {
      log(`auth store read failed: ${err.message}`);
      return null; // fail open: never lock Jacob out because the store is down
    }
  }

  async function writeFails(ip, value) {
    if (!store) return;
    try {
      if (value) await store.setJSON(`fails/${ip}`, value);
      else await store.delete(`fails/${ip}`);
    } catch (err) {
      log(`auth store write failed: ${err.message}`);
    }
  }

  function issue() {
    const expires = now() + SESSION_TTL_MS;
    const payload = b64url(JSON.stringify({ v: 1, exp: expires }));
    return { token: `${payload}.${sign(payload)}`, expires };
  }

  return {
    /** @returns {{ ok: true, token, expires } | { ok: false, reason: "locked"|"wrong", retryAfterSec? }} */
    async login(attempt, ip = "unknown") {
      const t = now();
      let fails = await readFails(ip);
      if (fails && fails.lockedUntil && fails.lockedUntil > t) {
        return { ok: false, reason: "locked", retryAfterSec: Math.ceil((fails.lockedUntil - t) / 1000) };
      }
      if (typeof attempt === "string" && attempt.length <= 200 && safeEqual(attempt, password)) {
        if (fails) await writeFails(ip, null);
        return { ok: true, ...issue() };
      }
      if (!fails || t - fails.first > FAIL_WINDOW_MS) fails = { count: 0, first: t };
      fails.count += 1;
      if (fails.count >= MAX_FAILS) fails.lockedUntil = t + LOCKOUT_MS;
      await writeFails(ip, fails);
      if (fails.lockedUntil) return { ok: false, reason: "locked", retryAfterSec: Math.ceil(LOCKOUT_MS / 1000) };
      return { ok: false, reason: "wrong" };
    },

    /** A fresh session (used at login, and to quietly extend an active one). */
    issueSession: () => issue(),

    /** @returns {{ expires: number } | null} */
    readSession(sessionToken) {
      if (typeof sessionToken !== "string" || sessionToken.length > 1000) return null;
      const [payload, sig] = sessionToken.split(".");
      if (!payload || !sig) return null;
      if (!safeEqual(sig, sign(payload))) return null;
      try {
        const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        return data.v === 1 && typeof data.exp === "number" && data.exp > now() ? { expires: data.exp } : null;
      } catch {
        return null;
      }
    },

    verifySession(sessionToken) {
      return !!this.readSession(sessionToken);
    },

    signReceipt({ sha, ext, stem, width, height }) {
      const body = `${sha}|${ext}|${stem}|${width}|${height}`;
      return sign(`receipt|${body}`);
    },

    verifyReceipt(r) {
      if (!r || typeof r !== "object") return false;
      if (!/^[0-9a-f]{40}$/.test(String(r.sha)) || !/^(jpg|webp)$/.test(String(r.ext))) return false;
      if (typeof r.stem !== "string" || !/^[A-Za-z0-9_-]{1,60}$/.test(r.stem)) return false;
      const expected = sign(`receipt|${r.sha}|${r.ext}|${r.stem}|${r.width}|${r.height}`);
      return typeof r.receipt === "string" && safeEqual(r.receipt, expected);
    },
  };
}
