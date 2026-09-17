// Netlify Function behind jcwrks.com/admin (Jacob's portfolio manager).
// All logic lives in src/lib/admin/ so it can be tested without Netlify.
//
// Env vars (Netlify -> Site configuration -> Environment variables):
//   ADMIN_PASSWORD   the password Jacob types at /admin
//   GH_UPLOAD_TOKEN  GitHub fine-grained token, Contents: read/write on this repo only
// Optional (testing only): UPLOAD_BRANCH (default "staging"), PROD_BRANCH (default "main")

import { getStore } from "@netlify/blobs";
import { createGitHub } from "../../src/lib/admin/github.mjs";
import { createContentEngine } from "../../src/lib/admin/content.mjs";
import { createAuth } from "../../src/lib/admin/auth.mjs";
import { createHandler } from "../../src/lib/admin/handler.mjs";

const OWNER = "LoganCollins171";
const REPO = "jcwrks-portfolio";

export default async (req, context) => {
  const password = process.env.ADMIN_PASSWORD;
  const token = process.env.GH_UPLOAD_TOKEN;
  if (!password || !token) {
    return new Response(
      JSON.stringify({ ok: false, error: { code: "not_configured", message: "The photo manager isn't set up yet. Tell Logan: missing settings." } }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  let store = null;
  try { store = getStore("admin-auth"); } catch (err) { console.error(`[admin] blobs unavailable: ${err.message}`); }

  const siteUrl = process.env.URL || "https://jcwrks.com";
  const prodBranch = process.env.PROD_BRANCH || "main";
  const gh = createGitHub({ token, owner: OWNER, repo: REPO });
  const engine = createContentEngine({
    gh,
    draftBranch: process.env.UPLOAD_BRANCH || "staging",
    prodBranch,
    rawBase: `https://raw.githubusercontent.com/${OWNER}/${REPO}`,
    liveBase: siteUrl,
  });
  const auth = createAuth({ password, token, store, log: (m) => console.error(`[admin] ${m}`) });
  const handle = createHandler({
    auth,
    engine,
    gh,
    prodBranch,
    fetchLiveCommit: async () => {
      const res = await fetch(`${siteUrl}/build.json?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return null;
      const data = await res.json();
      return typeof data.commit === "string" ? data.commit : null;
    },
  });
  return handle(req, { ip: context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown" });
};

export const config = { path: "/api/admin" };
