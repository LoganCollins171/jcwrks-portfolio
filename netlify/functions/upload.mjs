// Password-protected photo uploader for Jacob.
//
// Jacob never touches GitHub. The /admin page shrinks each photo to a ~2000px
// webp in his browser, then talks to this function, which commits the files to
// the repo on his behalf using a token stored in Netlify (GH_UPLOAD_TOKEN).
// Astro's src/lib/galleries.ts renders any image sitting in
// public/galleries/<slug>/, so committing the files there is all it takes.
//
// Two-step protocol so a whole session is ONE commit == ONE Netlify deploy
// (the old Sveltia CMS made one deploy per file and burned the monthly credits):
//   op "blob"   -> upload one photo, get back its git blob sha  (called N times)
//   op "commit" -> assemble all the shas into a single commit on `main`
//
// Env vars (set in Netlify -> Site settings -> Environment variables):
//   ADMIN_PASSWORD   the password Jacob types at /admin
//   GH_UPLOAD_TOKEN  a GitHub token with Contents: read/write on this repo

const OWNER = "BARRELLABS";
const REPO = "jcwrks-portfolio";
// Netlify builds `main`, so uploads go straight live. Overridable for testing.
const BRANCH = process.env.UPLOAD_BRANCH || "main";

// The galleries Jacob can upload into (must match src/data/galleries/*.json).
const GALLERIES = new Set([
  "baseball", "basketball", "cars", "football", "graphics", "hockey",
  "landscape", "portraits", "soccer", "softball", "track",
]);

const json = (status, body) => ({
  statusCode: status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function gh(token, path, method = "GET", body) {
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "jcwrks-uploader",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function ghJson(token, path, method, body) {
  const res = await gh(token, path, method, body);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.message || `GitHub ${res.status}`;
    throw new Error(`${msg} (${method} ${path})`);
  }
  return data;
}

// Keep only a safe filename, force a .webp extension.
function safeName(name) {
  const base = String(name || "photo").split(/[\\/]/).pop();
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const stem = cleaned.replace(/\.[^.]*$/, "") || "photo";
  return `${stem}.webp`;
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const token = process.env.GH_UPLOAD_TOKEN;
  const password = process.env.ADMIN_PASSWORD;
  if (!token || !password) {
    return json(500, { error: "Uploader not configured. Set ADMIN_PASSWORD and GH_UPLOAD_TOKEN in Netlify." });
  }

  let payload;
  try { payload = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Bad request." }); }

  if (payload.password !== password) return json(401, { error: "Wrong password." });

  try {
    if (payload.op === "blob") {
      if (!payload.dataBase64) return json(400, { error: "No image data." });
      const { sha } = await ghJson(token, `/repos/${OWNER}/${REPO}/git/blobs`, "POST", {
        content: payload.dataBase64,
        encoding: "base64",
      });
      return json(200, { sha });
    }

    if (payload.op === "commit") {
      const gallery = String(payload.gallery || "");
      if (!GALLERIES.has(gallery)) return json(400, { error: "Unknown gallery." });

      const files = Array.isArray(payload.files) ? payload.files : [];
      if (!files.length) return json(400, { error: "No photos to save." });

      // Build the tree entries, de-duping filenames within this batch.
      const used = new Set();
      const tree = files.map((f) => {
        let name = safeName(f.name);
        if (used.has(name.toLowerCase())) {
          const stem = name.replace(/\.webp$/, "");
          let i = 2;
          while (used.has(`${stem}-${i}.webp`.toLowerCase())) i++;
          name = `${stem}-${i}.webp`;
        }
        used.add(name.toLowerCase());
        return { path: `public/galleries/${gallery}/${name}`, mode: "100644", type: "blob", sha: f.sha };
      });

      const ref = await ghJson(token, `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
      const latestSha = ref.object.sha;
      const latestCommit = await ghJson(token, `/repos/${OWNER}/${REPO}/git/commits/${latestSha}`);

      const newTree = await ghJson(token, `/repos/${OWNER}/${REPO}/git/trees`, "POST", {
        base_tree: latestCommit.tree.sha,
        tree,
      });

      const count = tree.length;
      const message = `Add ${count} photo${count === 1 ? "" : "s"} to ${gallery} (via /admin)`;
      const commit = await ghJson(token, `/repos/${OWNER}/${REPO}/git/commits`, "POST", {
        message,
        tree: newTree.sha,
        parents: [latestSha],
      });

      await ghJson(token, `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, "PATCH", {
        sha: commit.sha,
        force: false,
      });

      return json(200, { committed: count, gallery, sha: commit.sha });
    }

    return json(400, { error: "Unknown action." });
  } catch (err) {
    return json(502, { error: err.message || "Upload failed." });
  }
};
