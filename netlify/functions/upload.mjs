// Password-protected photo uploader for Jacob.
//
// Jacob never touches GitHub. The /admin page shrinks each photo to a ~2000px
// webp in his browser, then talks to this function, which commits the files to
// the repo on his behalf using a token stored in Netlify (GH_UPLOAD_TOKEN).
// Astro's src/lib/galleries.ts renders any image sitting in
// public/galleries/<slug>/, so committing the files there is all it takes.
//
// Deploy control: uploads land on the `staging` branch, which Netlify NEVER
// builds, so Jacob can upload as much as he likes for free. Nothing goes live
// until he hits "Publish", which fast-forwards `main` to `staging` — one deploy
// for the whole batch (the old CMS made one deploy per photo and burned credits).
//
// Ops (JSON body, all password-gated):
//   op "blob"    -> upload one photo, get back its git blob sha
//   op "commit"  -> assemble the shas into one commit on `staging` (no deploy)
//   op "pending" -> how many photos are queued on staging but not yet live
//   op "publish" -> move `main` up to `staging` (ONE deploy, everything goes live)
//
// Env vars (Netlify -> Site settings -> Environment variables):
//   ADMIN_PASSWORD   the password Jacob types at /admin
//   GH_UPLOAD_TOKEN  a GitHub token with Contents: read/write on this repo

const OWNER = "LoganCollins171";
const REPO = "jcwrks-portfolio";
const CONTENT_BRANCH = process.env.UPLOAD_BRANCH || "staging"; // uploads queue here
const PROD_BRANCH = process.env.PROD_BRANCH || "main";         // Netlify builds this

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

// Count queued photos: image files added on staging that aren't on main yet.
async function countPending(token) {
  const cmp = await ghJson(token, `/repos/${OWNER}/${REPO}/compare/${PROD_BRANCH}...${CONTENT_BRANCH}`);
  if (cmp.status === "identical" || cmp.status === "behind") return 0;
  const files = cmp.files || [];
  return files.filter(
    (f) => f.status === "added" && /^public\/galleries\/.+\.(webp|jpe?g|png|avif)$/i.test(f.filename)
  ).length;
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

      const ref = await ghJson(token, `/repos/${OWNER}/${REPO}/git/ref/heads/${CONTENT_BRANCH}`);
      const latestSha = ref.object.sha;
      const latestCommit = await ghJson(token, `/repos/${OWNER}/${REPO}/git/commits/${latestSha}`);

      const newTree = await ghJson(token, `/repos/${OWNER}/${REPO}/git/trees`, "POST", {
        base_tree: latestCommit.tree.sha,
        tree,
      });

      const count = tree.length;
      const message = `Add ${count} photo${count === 1 ? "" : "s"} to ${gallery} (queued via /admin)`;
      const commit = await ghJson(token, `/repos/${OWNER}/${REPO}/git/commits`, "POST", {
        message,
        tree: newTree.sha,
        parents: [latestSha],
      });

      await ghJson(token, `/repos/${OWNER}/${REPO}/git/refs/heads/${CONTENT_BRANCH}`, "PATCH", {
        sha: commit.sha,
        force: false,
      });

      const pending = await countPending(token).catch(() => null);
      return json(200, { committed: count, gallery, pending });
    }

    if (payload.op === "pending") {
      const pending = await countPending(token);
      return json(200, { pending });
    }

    if (payload.op === "publish") {
      const cmp = await ghJson(token, `/repos/${OWNER}/${REPO}/compare/${PROD_BRANCH}...${CONTENT_BRANCH}`);
      if (cmp.status === "identical" || cmp.status === "behind") {
        return json(200, { published: 0, message: "Nothing new to publish." });
      }

      const stagingRef = await ghJson(token, `/repos/${OWNER}/${REPO}/git/ref/heads/${CONTENT_BRANCH}`);
      const stagingSha = stagingRef.object.sha;
      const pending = await countPending(token).catch(() => null);

      if (cmp.status === "ahead") {
        // Clean fast-forward: main just moves up to staging.
        await ghJson(token, `/repos/${OWNER}/${REPO}/git/refs/heads/${PROD_BRANCH}`, "PATCH", {
          sha: stagingSha,
          force: false,
        });
      } else {
        // Diverged (code landed on main). Merge staging into main, then level staging.
        const merge = await ghJson(token, `/repos/${OWNER}/${REPO}/merges`, "POST", {
          base: PROD_BRANCH,
          head: CONTENT_BRANCH,
          commit_message: "Publish queued photos",
        });
        const newMainSha = merge.sha || stagingSha;
        await ghJson(token, `/repos/${OWNER}/${REPO}/git/refs/heads/${CONTENT_BRANCH}`, "PATCH", {
          sha: newMainSha,
          force: true,
        });
      }

      return json(200, { published: pending ?? 1 });
    }

    return json(400, { error: "Unknown action." });
  } catch (err) {
    return json(502, { error: err.message || "Upload failed." });
  }
};
