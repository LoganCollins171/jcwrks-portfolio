// Minimal GitHub Git Data API client used by the /admin backend.
// fetch is injectable so tests can run against an in-memory fake.

export class GitHubError extends Error {
  constructor(status, message, path) {
    super(message);
    this.status = status;
    this.path = path;
  }
}

/** A ref update was rejected because the branch moved (compare-and-swap lost). */
export class RefConflictError extends Error {
  constructor(branch) {
    super(`Branch ${branch} moved during the update`);
    this.branch = branch;
  }
}

export function createGitHub({ token, owner, repo, fetchImpl = fetch, apiBase = "https://api.github.com" }) {
  const base = `/repos/${owner}/${repo}`;

  async function call(path, method = "GET", body) {
    const attempts = method === "GET" ? 2 : 1;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      let res;
      try {
        res = await fetchImpl(`${apiBase}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "jcwrks-admin",
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } catch (err) {
        lastErr = new GitHubError(0, `Network error talking to GitHub: ${err.message}`, path);
        continue;
      }
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (res.ok) return data;
      lastErr = new GitHubError(res.status, data?.message || `GitHub ${res.status}`, path);
      if (res.status < 500) break;
    }
    throw lastErr;
  }

  return {
    async getRef(branch) {
      try {
        const r = await call(`${base}/git/ref/heads/${branch}`);
        return r.object.sha;
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    },
    async createRef(branch, sha) {
      await call(`${base}/git/refs`, "POST", { ref: `refs/heads/${branch}`, sha });
    },
    /** Fast-forward only. Throws RefConflictError if the branch moved. */
    async updateRef(branch, sha) {
      try {
        await call(`${base}/git/refs/heads/${branch}`, "PATCH", { sha, force: false });
      } catch (err) {
        if (err.status === 422 || err.status === 409) throw new RefConflictError(branch);
        throw err;
      }
    },
    async getCommit(sha) {
      const c = await call(`${base}/git/commits/${sha}`);
      return { sha: c.sha, tree: c.tree.sha, parents: (c.parents || []).map((p) => p.sha), date: c.committer?.date || null, message: c.message || "" };
    },
    async getTree(sha) {
      const t = await call(`${base}/git/trees/${sha}?recursive=1`);
      if (t.truncated) throw new GitHubError(500, "Repository tree too large to read", "tree");
      return t.tree.filter((e) => e.type === "blob").map((e) => ({ path: e.path, mode: e.mode, sha: e.sha }));
    },
    async getBlob(sha) {
      const b = await call(`${base}/git/blobs/${sha}`);
      return Buffer.from(b.content || "", b.encoding === "base64" ? "base64" : "utf8");
    },
    async createBlob(buf) {
      const b = await call(`${base}/git/blobs`, "POST", { content: buf.toString("base64"), encoding: "base64" });
      return b.sha;
    },
    /** entries: [{ path, sha|null }] applied on top of baseTree. */
    async createTree(baseTree, entries) {
      const t = await call(`${base}/git/trees`, "POST", {
        base_tree: baseTree,
        tree: entries.map((e) => ({ path: e.path, mode: e.mode || "100644", type: "blob", sha: e.sha })),
      });
      return t.sha;
    },
    async createCommit(message, tree, parents) {
      const c = await call(`${base}/git/commits`, "POST", { message, tree, parents });
      return c.sha;
    },
    /** { status: "identical"|"ahead"|"behind"|"diverged", mergeBase } for base...head */
    async compare(baseSha, headSha) {
      const c = await call(`${base}/compare/${baseSha}...${headSha}?per_page=1`);
      return { status: c.status, mergeBase: c.merge_base_commit?.sha || null };
    },
  };
}
