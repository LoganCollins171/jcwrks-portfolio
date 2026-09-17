# Portfolio Manager (/admin): how it works

Jacob manages his portfolio at **jcwrks.com/admin**: add, remove and reorder
photos, update Moments Captured, then **Publish changes**. No GitHub, no JSON.

## What Jacob sees
- **Dashboard** (`/admin`): Moments Captured with progress to the next milestone
  (75k, 100k, 150k, 250k, 500k, 750k, 1M), portfolio photo count, galleries with photos,
  last publish (derived from git history), every gallery with its count, and the Publish card.
- **Gallery** (`/admin#/gallery/<slug>`): thumbnails in order with position numbers,
  Add photos (or drop files on desktop), drag or tap-menu reordering (Move earlier/later,
  start/end, or to a position number), Select mode for removing several photos at once,
  Undo after removing, and a "Removed, not published yet" strip to put photos back.
- **Status pill** (top right) always says one of: Uploading / Saving / Order not saved /
  Not published yet / Updating website / Verifying live site / Published ✓ /
  Website not updated yet / All changes live. Tapping it jumps to Publish.
- **Publish**: a review ("Ready to publish": per gallery +/− photos, order changed, Moments
  Captured before → after), then three steps: Preparing update, Updating website (waits for
  `/build.json` to show the new commit), Verifying live site (fetches each changed gallery page and
  the homepage and checks the photo counts and the Moments Captured number). Only then "Published ✓".
- A milestone crossed by a publish gets a one-time aperture animation after it's verified live.

## Architecture (one writer, one pipeline)

```
Browser (/admin)                     Netlify Function /api/admin              GitHub repo
-----------------                    ---------------------------              -----------
resize to <=2000px, JPEG/WebP  --->  check REAL bytes (format, size, px)  --> blob
                                     signed receipt
"Save to gallery" / remove /   --->  ONE atomic commit on `staging`       --> staging (Jacob's draft)
reorder / Moments Captured           (compare-and-swap, retried on races)
                                     answers with fresh state (1 round trip)
"Publish changes"              --->  ONE commit on `main` applying every  --> main --> Netlify build
                                     content difference (+ levels staging)
poll until live                --->  compares /build.json commit          <-- live site
```

- **Content** = `public/galleries/<gallery>/*`, `src/data/galleries/*.json`, `src/data/stats.json`.
  Everything else is code and always comes from `main`, so publishing never reverts a code deploy.
- **Draft** = `staging`. Every change is one commit there. The function is the ONLY
  thing that writes to it (the old shrink/sync/publish GitHub Actions are gone).
- **Pending** = every content difference between the draft and `main`: added, removed,
  replaced, reordered, captions, Moments Captured. Not just "new files".
- **Publish** refuses if the draft changed since Jacob reviewed it (`stale_draft`).
- **Published ✓** only shows once `jcwrks.com/build.json` reports the published commit
  (or a newer one that contains it). `build.json` is written at build time from Netlify's `COMMIT_REF`.
- **Order** lives in the gallery JSON. `src/lib/gallery-model.mjs` is the single rule set used by both
  the site build (`src/lib/galleries.ts`) and the admin, so what Jacob sees is what renders.
  A listed photo whose file is missing is skipped (never a broken image).
- **Uploads** prepare one photo at a time in the browser (big camera files use a lot of memory),
  send two at a time, and save to the gallery every 8 photos, so a closed tab loses little.
  The screen is kept awake during uploads where supported. Rate limits pause and continue by themselves.
- **Undo** of a removal works for any photo, including ones that were never published (restored by
  content hash after the bytes are re-validated).
- **File names** are `<camera-name>-<8 chars of content hash>.<jpg|webp>`, so two different photos
  called `IMG_0001.JPG` can never overwrite each other, and the exact same photo twice is skipped.

## Key files

| Path | Purpose |
| --- | --- |
| `public/admin/index.html`, `admin.js`, `admin.css` | The dashboard (plain JS, no build step) |
| `public/admin/vendor/Sortable.min.js` | Drag-to-reorder (SortableJS 1.15.7, MIT) |
| `netlify/functions/admin.mjs` | Netlify Function wiring (env vars, Blobs store) at `/api/admin` |
| `src/lib/admin/handler.mjs` | HTTP API: ops, auth checks, friendly errors |
| `src/lib/admin/content.mjs` | Draft/publish engine (atomic commits, pending summary) |
| `src/lib/admin/images.mjs` | Server-side image validation (real bytes, dimensions) |
| `src/lib/admin/auth.mjs` | Login, signed sessions, lockout, signed upload receipts |
| `src/lib/admin/github.mjs` | Minimal GitHub Git Data API client |
| `src/lib/gallery-model.mjs` | Shared gallery ordering rules |
| `src/pages/build.json.ts` | Live-commit marker used to confirm publishes |

## Configuration (Netlify → Site configuration → Environment variables)

- `ADMIN_PASSWORD`: the password Jacob types. Changing it signs everyone out.
- `GH_UPLOAD_TOKEN`: GitHub fine-grained token, repository `LoganCollins171/jcwrks-portfolio` only,
  permission **Contents: Read and write** (Metadata: read is automatic). Nothing else.
- Optional, testing only: `UPLOAD_BRANCH` (default `staging`), `PROD_BRANCH` (default `main`).

Env var changes take effect on the next deploy (Deploys → Trigger deploy).

### Rotating the GitHub token
1. GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token:
   resource owner LoganCollins171, only `jcwrks-portfolio`, Contents: Read and write.
2. Netlify: replace `GH_UPLOAD_TOKEN`, then trigger a deploy.
3. Sign in at /admin and confirm the dashboard loads.
4. Delete the old token in GitHub.

### Changing the password
Netlify: replace `ADMIN_PASSWORD`, trigger a deploy, tell Jacob the new one.

## Security notes
- Password is checked once at login (constant time) and exchanged for a 30-day signed session.
- 8 wrong passwords from one IP in 15 minutes locks that IP for 15 minutes (Netlify Blobs store
  `admin-auth`; if the store is unavailable it fails open rather than locking Jacob out).
- Only receipts the server signed after validating an image can be added to a gallery.
- Draft thumbnails load from `raw.githubusercontent.com`, which works because the repo is public.
  If the repo is ever made private, not-yet-published thumbnails will show "Preview unavailable".

## Recovering / rolling back
- Instant site rollback: Netlify → Deploys → pick an earlier deploy → Publish deploy.
- Content history: every draft change and publish is a commit (`git log main`, `git log staging`).
- Throw away the draft: /admin → "Throw away all unpublished changes".
- Pre-upgrade backup tags: `backup/pre-admin-upgrade-main`, `backup/pre-admin-upgrade-staging`.
- Don't edit gallery files or JSON directly on `main` while Jacob has unpublished changes to the
  same gallery; the draft's version of that gallery wins on publish.

## Tests
```
npm test                                   # engine, API, auth, races, model (fake in-memory GitHub)
node tests/perf/api-calls.mjs              # GitHub API calls per action on a cold function
node tests/browser/dev-server.mjs          # local /admin on a fake repo: http://localhost:4400/admin/
PLAYWRIGHT=.../node_modules/playwright AXE=.../axe-core/axe.min.js FIXTURES=... SHOTS=... \
  node tests/browser/admin-e2e.mjs webkit-iphone     # also chromium-desktop, chromium-android, webkit-tablet
GH_TOKEN=... FIXTURES=... node tests/integration/real-github.mjs   # real GitHub, throwaway branches
```
The browser test covers the whole owner journey plus deliberate failures (storage errors on upload,
save and publish, rate limits, offline, a website build that never finishes, two tabs).
The dev server accepts `POST /__test/fault` and `POST /__test/deploy-mode` to simulate those.
Never run `npm run build` in the real checkout and commit the result: the build shrinks images in place.
