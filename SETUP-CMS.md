# Photo uploader — how Jacob manages galleries

Jacob adds photos himself at **/admin** (e.g. `jcwrks.com/admin`) with a simple
**password** — no GitHub account, no login accounts at all.

## How it works
- He goes to `/admin`, types the password, picks a gallery, drags in photos,
  and hits **Upload photos**. Then, when ready, he hits **Publish to site**.
- Each photo is shrunk to a ~2000px webp **in his browser** first (Canon files
  are ~8MB; this makes them ~300KB so uploads are fast and never choke).
- A Netlify function (`netlify/functions/upload.mjs`) commits the batch to the
  **`staging`** branch, which Netlify never builds — so uploading costs no
  deploys. **Publish** fast-forwards `main` to `staging` (or merges if code has
  landed on main), which is the one and only deploy.
- After Publish, Netlify rebuilds once and the photos are live in a minute or two.

This staging-then-publish flow is deliberate: Jacob can upload as many times as
he wants for free, and one Publish puts everything live in a single deploy. (The
old Sveltia CMS made one deploy per photo and burned the monthly credits.)

The site renders **any image file** sitting in `public/galleries/<slug>/`
(see `src/lib/galleries.ts`), so committing the files there is all it takes.
The per-gallery JSON in `src/data/galleries/<slug>.json` is only used to pin
ORDER and CAPTIONS for curated photos; uploaded photos are appended after those.

The function ops (all password-gated): `blob` (upload one photo), `commit`
(save the batch to staging), `pending` (how many photos are waiting), `publish`
(move main up to staging). Branch names are overridable via `UPLOAD_BRANCH` /
`PROD_BRANCH` env vars (used only for testing).

## Configuration (Netlify → Site settings → Environment variables)
- `ADMIN_PASSWORD` — the password Jacob types at `/admin`.
- `GH_UPLOAD_TOKEN` — a GitHub fine-grained PAT with **Contents: Read and write**
  on `LoganCollins171/jcwrks-portfolio` only (no expiration). Created for the
  `jcwrks uploader` token. To rotate: make a new PAT with the same scope, update
  this env var, and redeploy.

Both must be present or the uploader returns "Uploader not configured".
Changing either takes effect on the next deploy.

## Notes
- **No GitHub account needed for Jacob** — the token does the committing for him.
- Uploads queue on `staging` (no deploy); **Publish** is the single deploy that
  puts a whole batch live. `sync-staging.yml` still keeps `staging` level with
  `main` after code changes, so the publish stays a clean fast-forward.
- Removing a photo isn't in the `/admin` UI yet — delete the file from
  `public/galleries/<slug>/` in GitHub, or ask.
- Retired: the old Sveltia CMS (`public/admin/config.yml`) and the manual
  `publish.yml` / `shrink-photos.yml` GitHub Actions. `sync-staging.yml` is still
  useful (keeps staging current). They can be cleaned up whenever.

## Test the uploader locally
```
npm run dev
# open http://localhost:4321/admin/  (the function only runs on Netlify, so
# real uploads need the deployed site; use `netlify dev` to run the function locally)
```
