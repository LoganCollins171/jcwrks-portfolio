# Photo uploader — how Jacob manages galleries

Jacob adds photos himself at **/admin** (e.g. `jcwrks.com/admin`) with a simple
**password** — no GitHub account, no login accounts at all.

## How it works
- He goes to `/admin`, types the password, picks a gallery, drags in photos,
  and hits **Upload photos**.
- Each photo is shrunk to a ~2000px webp **in his browser** first (Canon files
  are ~8MB; this makes them ~300KB so uploads are fast and never choke).
- A Netlify function (`netlify/functions/upload.mjs`) commits the whole batch to
  the repo's `main` branch in one commit, using a server-side GitHub token.
- Netlify rebuilds once and the photos are live in a minute or two.

The site renders **any image file** sitting in `public/galleries/<slug>/`
(see `src/lib/galleries.ts`), so committing the files there is all it takes.
The per-gallery JSON in `src/data/galleries/<slug>.json` is only used to pin
ORDER and CAPTIONS for curated photos; uploaded photos are appended after those.

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
- Uploads go straight to `main`, so each upload session is exactly one Netlify
  deploy. (The old Sveltia CMS committed every file separately and burned deploy
  credits; that's why it was replaced.)
- Removing a photo isn't in the `/admin` UI yet — delete the file from
  `public/galleries/<slug>/` in GitHub, or ask.
- Retired: the old Sveltia CMS (`public/admin/config.yml`) and the
  `staging` branch + `publish.yml` / `shrink-photos.yml` / `sync-staging.yml`
  workflows. They're unused now and can be deleted whenever.

## Test the uploader locally
```
npm run dev
# open http://localhost:4321/admin/  (the function only runs on Netlify, so
# real uploads need the deployed site; use `netlify dev` to run the function locally)
```
