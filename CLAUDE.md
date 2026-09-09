# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Static-first site deployed to Cloudflare Workers via Wrangler. No build step, no framework. `src/index.js` is a Worker that handles `/api/pets` and `/api/comments` (both KV-backed against the `PETS` binding — see "Gallery API") and falls through to `env.ASSETS.fetch(request)` for everything else. `wrangler.jsonc` sets `assets.directory` to `./public`, so everything under `public/` is publicly served and everything outside it (this file, `src/`, `wrangler.jsonc`, `README.md`) is project-only.

## Layout

```
public/
  index.html        # photo-of-the-day homepage; picks plate from date seed, links to gallery + classic
  gallery.html      # full gallery view
  classic.html      # original minimal view (single dog-1.jpeg)
  captions.js       # window.WRANGELL_CAPTIONS array; index 0 = dog-1.jpeg
  wedding.html      # wedding special edition; served at "/" during wedding week
  images/
    raw/            # dog-N.jpeg originals (archive; never referenced by a page)
    resized/        # dog-N.jpeg at <=1600px — what every page actually loads
  og-default.jpg    # 1200x630 share card for the everyday pages
  og-wedding.jpg    # 1200x630 share card for wedding.html
  favicon.png       # tab icon: transparent cutout of Wrangell's face (48x48)
  apple-touch-icon.png  # 180x180 app icon (head on brand red) for iOS home screen
  icon-192.png      # PWA maskable app icon (192x192)
  icon-512.png      # PWA maskable app icon (512x512)
  manifest.webmanifest  # PWA manifest (installable app metadata)
  sw.js             # service worker: offline cache + installability (see "Installable app")
src/
  index.js          # Worker entry: /api/pets + /api/comments + asset passthrough
scripts/
  resize-images.js       # syncs images/raw → images/resized at <=1600px; run by pre-commit hook
  caption-new-images.js  # generates missing captions via Claude vision; run by pre-commit hook
  check-captions.js      # asserts every raw/dog-N.jpeg has a caption
  crop-image.swift       # crop + downscale a pixel rect (used for the hero and OG cards)
  make-favicon.swift     # Vision-based background cutout for the favicon (see "Favicon")
  make-app-icon.swift    # composite a cutout onto a solid-color square app icon
.githooks/
  pre-commit        # resize-images.js, then caption-new-images.js, before every commit
wrangler.jsonc      # PETS KV binding, ASSETS binding, main = src/index.js
```

Each HTML page is self-contained (inline CSS, loads Google Fonts directly). `index.html` and `gallery.html` share a Fraunces + JetBrains Mono editorial design system; `classic.html` is deliberately plain.

## Adding photos

Use the `/add-photos` skill — it handles the full workflow automatically:
rename → caption (via Claude vision, no API key needed) → update `captions.js` → stage.

### How it works

1. Drop any number of image files into `public/images/raw/` (any filename is fine).
2. Run `/add-photos`. The skill will:
   - Rename files to `dog-N.jpeg` sequentially from the next available number
   - Run `scripts/resize-images.js` to derive `images/resized/dog-N.jpeg`
   - View each image and write a caption in the established style
   - Present captions for your review before writing them
   - Append entries to `captions.js` and update the header comment
   - Stage images + `captions.js` for commit
3. Review the proposed captions, tweak any you want changed, then commit.

### Caption style

Captions must read standalone — each is shown solo on the homepage on its assigned day.
- 2–5 words, no articles, wry and observational
- Avoid "again", "also", "same", or anything implying context from another photo
- One strong specific detail beats a generic description

### How photos are wired in

- **Two image sets**: `public/images/raw/` holds the originals as an archive; `public/images/resized/`
  holds the `<=1600px` copies that every page loads (534 MB → 78 MB across 160 photos). Pages must
  reference `images/resized/dog-N.jpeg` — never `raw/`. `scripts/resize-images.js` regenerates only
  what is missing or stale, so it is cheap to re-run; `--force` redoes everything. Note that 36 of
  the photos are stored sideways with an EXIF orientation tag of 6; `sips` preserves that tag, so
  they render upright in a browser even though most image viewers show them rotated.
- **Gallery** (`gallery.html`): uses `captions.length` as total plate count; generates `images/resized/dog-${n}.jpeg` for n = 1..total. Images and captions must always be in sync.
- **Homepage** (`index.html`): picks today's photo via `(year*10000 + month*100 + day) % captions.length + 1`. Rotation shifts when photos are added — expected.
- **Pre-commit hook** (`.githooks/pre-commit`): runs `scripts/caption-new-images.js` (requires `ANTHROPIC_API_KEY`). When captions are already written by the skill, the hook exits cleanly without the key.

**One-time hook setup** (already done on the main clone):
```
git config core.hooksPath .githooks
```

## Favicon & app icons

All icons derive from one transparent head cutout of Wrangell from
`public/images/raw/dog-29.jpeg` (a clean head-on portrait), produced by `scripts/make-favicon.swift`
via the macOS Vision framework (`VNGenerateForegroundInstanceMaskRequest`) — no installs, macOS only.

- **`favicon.png`** (48×48) — the bare transparent cutout; used as the browser tab icon.
- **`apple-touch-icon.png`** (180×180), **`icon-192.png`**, **`icon-512.png`** — the head
  composited onto a soft sage green (`#a3b18a`) by `scripts/make-app-icon.swift`. These are
  opaque app icons (iOS/Android mask transparency to black/circle, so app icons fill the
  square). The 192/512 are the maskable PWA icons referenced by the manifest.

To regenerate from a different source photo or crop:
```
# 1. transparent head cutout (x y w h = crop rect, top-left origin; omit to keep full subject)
swift scripts/make-favicon.swift public/images/raw/dog-29.jpeg /tmp/head.png 900 800 1250 1250
sips -z 48 48 /tmp/head.png --out public/favicon.png
# 2. opaque app icons on brand red (last arg = safe-zone inset fraction)
swift scripts/make-app-icon.swift /tmp/head.png public/icon-512.png 512 a3b18a 0.14
sips -z 192 192 public/icon-512.png --out public/icon-192.png
swift scripts/make-app-icon.swift /tmp/head.png public/apple-touch-icon.png 180 a3b18a 0.10
```
`make-favicon.swift` also accepts a trailing `pad` arg to center the crop on a transparent
square canvas (side = longer dimension) — useful for a tall side-on head; dog-29's front-on
head is already roughly square.

## Installable app (PWA)

The site is an installable Progressive Web App. `public/manifest.webmanifest` declares the
app name, icons, and `display: standalone` (launches fullscreen, no browser chrome).
`public/sw.js` is a service worker registered by every page; it makes the site installable
(Chrome/Android/desktop show an "Install" prompt; iOS uses Share → Add to Home Screen) and
adds offline support: photos are cached-first, the app shell is network-first with a cache
fallback, and `/api/*` (the pet counter) is never cached. Standalone meta tags
(`theme-color`, `apple-mobile-web-app-*`, `mobile-web-app-capable`) live in each page `<head>`.

Bump `CACHE` in `sw.js` when changing cached assets so old caches are evicted on activate.

## Gallery API (pets & comments)

The gallery (`gallery.html`) is the interactive surface: clicking a plate opens a **lightbox**
(full image, caption, prev/next, keyboard nav) that hosts both the pet button and comments.
The Worker exposes two KV-backed JSON endpoints; `/api/*` is excluded from the service-worker
cache (`sw.js`), so neither is ever cached there.

**`/api/pets`** — pet counts.
- `GET` → `{ count, plates }` where `count` is the global total and `plates` is a
  `{ "<plate>": <count> }` map. One KV read, and edge-cached for `PETS_CACHE_TTL` (60s)
  via the Cache API, keyed on a query-stripped URL. Many visitors read these counts and
  few change them, so this collapses a traffic spike into one KV read per TTL per colo.
  A POST purges the entry, which costs nothing in KV terms and keeps a reload after
  petting honest.
- `POST` with body `{ plate, n }` (`plate` an integer ≥ 1; `n` optional pet count, default
  1, clamped to `MAX_PET_BATCH` = 50) → credits that plate and returns
  `{ count, plate, plateCount }`. A missing/invalid `plate` credits only the unattributed
  pool (`{ count }`) for back-compat. **One KV write**, whatever `n` is.
- KV key: `plates` alone, holding `{ v: 2, base, plates: { "<plate>": n } }`. `count` is
  derived as `base + sum(plates)`, never stored — see "Pet write budget" below.

### Pet write budget

The free tier allows **1,000 KV writes a day**, and the wedding guestbook spends from that
same budget, so pets are deliberately cheap:

- **One key, not two.** `plates` and a separate `count` key used to be written on every pet
  — two writes to record one fact, since the total is just the sum of the parts. `base`
  carries the pets never attributed to a plate (the legacy total minus the plate sum at
  migration, plus anything a later plate-less POST adds).
- **Migration is lazy** and happens on the first POST, not on GET: a GET that writes would
  burn the budget it exists to protect. Until that first pet lands, a GET costs two reads
  instead of one. The pre-v2 `count` key is left in place as a backup and is never written
  again. Note this is a one-way door — reverting the Worker would make the old code read the
  v2 wrapper keys (`v`, `base`, `plates`) as if they were plate numbers.
- **Clients coalesce bursts.** All three pages increment the UI optimistically and send one
  POST per burst — after `PET_IDLE` of quiet, at `PET_MAX` since the burst began, or at
  `PET_BATCH` (50) taps, whichever lands first — then reconcile against the server's number
  once nothing is queued behind the batch. `wedding.html` uses a longer `PET_IDLE` (3s vs
  2s) because its `PET_GOAL` progress bar invites sustained tapping, and a longer window
  packs more taps into each write. Pending taps flush on `pagehide`/`visibilitychange` via
  `navigator.sendBeacon`, since a fetch started as the page goes away gets cancelled.
- `PET_BATCH` in each page must stay in step with `MAX_PET_BATCH` in `src/index.js`, or taps
  past the cap are silently dropped.

Comment reads are cached per plate for the session in each page (`commentCache`, and
`entries` for the guestbook), and post/delete splice that copy rather than re-reading the
list. Holding an arrow key in the lightbox used to cost one KV read per plate stepped over.

**`/api/comments`** — per-plate visitor notes.
- `GET ?plate=N` → `{ comments: [{ id, name, text, ts }] }` (oldest first).
- `POST` body `{ plate, name, text, website }` → stores a comment, returns `{ comment }`.
  Guards: `text` 1–`MAX_TEXT` (required), `name` 0–`MAX_NAME` (optional → shows "Anonymous"),
  control chars stripped, a `website` honeypot (any value → accepted silently, stored nothing),
  and a per-IP fixed-window rate limit (`RL_MAX`/`RL_WINDOW`s via a `rl:<ip>` TTL key).
- `DELETE` body `{ plate, id }` → admin-only comment removal; requires
  `Authorization: Bearer <ADMIN_TOKEN>`. Returns 401 otherwise.
- KV keys: `comments:<plate>` (JSON array, capped at `MAX_COMMENTS`, oldest dropped).

Comments render oldest-first (chronological). Because they are keyed only by plate, the
**homepage photo-of-the-day** (`index.html`) has its own comments panel on the same endpoint:
a note left on the day's photo appears on that plate in the gallery lightbox, and vice versa.

**Admin moderation.** `ADMIN_TOKEN` is a Worker secret. In the gallery (and on the homepage),
visiting
`?admin=<token>` once stores it in `localStorage` and reveals a delete "×" on each comment;
ordinary visitors never see it. Configure it per environment:
```
npx wrangler secret put ADMIN_TOKEN          # production
echo 'ADMIN_TOKEN="..."' > .dev.vars         # local dev (gitignored)
```

## Wedding week (`wedding.html`)

A special edition for Vaughn Taylor & Emily Ulrich's wedding on **September 19th, 2026**.
Wedding coasters link to the site, so this page is the landing experience for a wave of
first-time visitors: hero, formalwear strip, guestbook, and one big push into the gallery.
Tomatoes fall down the page because that is the wedding's theme — they are drawn in CSS (a
gradient body plus a clip-path calyx on `.tomato::before`), not images, and the whole layer
is skipped for `prefers-reduced-motion` visitors.

**Routing.** `src/index.js` serves `/wedding` at `/` for the window **now through
2026-09-23** (US Eastern; the whole window is EDT, so the fixed `-04:00` offset in
`WEDDING_START`/`WEDDING_END` is exact). The takeover was originally scoped to start on
the 16th and was turned on early. This requires `assets.run_worker_first` in
`wrangler.jsonc` — without it Cloudflare serves `public/index.html` directly and the Worker
never runs. `run_worker_first` is scoped to `["/", "/index.html"]` so every other path keeps
the fast direct-to-asset path.

| URL | Behaviour |
| --- | --- |
| `/` | Wedding page during the window, photo-of-the-day otherwise |
| `/?wedding=1` | Forces the wedding page **any time** — use this to preview before it goes live |
| `/?daily=1` | Forces photo-of-the-day, even during the window |
| `/wedding` | Always the wedding page, year-round |

`gallery.html` reveals a wedding banner and swaps its masthead to "Wedding Edition" on the
same window, and also honours `?wedding=1`. Keep the dates in the two files in sync.

**Tense flip.** The headline, countdown chip, and dek switch from "are getting married" to
"got married" at **midnight Eastern on 2026-09-20** (the `AFTER` constant in `wedding.html`).
The page re-checks hourly, so a tab left open overnight flips on its own.

**Guestbook.** Reuses `/api/comments` on reserved **plate 919**, since `toPlate` accepts any
integer ≥ 1 and the gallery only ever renders plates 1..161. Admin deletion works exactly as
elsewhere (`?admin=<token>`). The "pet the ring bearer" button increments **plate 161**, the
hero, so it also feeds the gallery's hall of fame.

It does *not* behave like ordinary photo comments, because a guestbook is a keepsake:

- **Signing is open only for the wedding weekend** — 2026-09-19 and 2026-09-20 Eastern
  (`GUESTBOOK_OPENS`/`GUESTBOOK_CLOSES`). Reading is always open. Enforced in the Worker
  and mirrored by `renderGuestbookState()` in `wedding.html`; keep the two windows in sync.
  **Holders of `ADMIN_TOKEN` can sign any time**, which is how you test the form off-window.
- **Entries are never silently evicted.** Ordinary plates cap at `MAX_COMMENTS` (200) and drop
  the oldest; the guestbook caps at `GUESTBOOK_MAX` (5000) and returns **409** when full, so a
  signature is never lost to make room.
- **Its own rate-limit budget.** Wedding guests share one NAT'd IP on venue wifi, so the normal
  `RL_MAX` of 10/minute would throttle the whole room. The guestbook gets `RL_GUESTBOOK_MAX`
  (60/minute) under a separate `rlgb:` key prefix.

**Back it up.** The entire book is one KV value, so run `node scripts/export-guestbook.js`
after the wedding. It writes a restorable `.json` and a readable `.txt` transcript into
`guestbook-exports/` (gitignored — `git add -f` the final one if you want it in the repo).

## Commands

- Local dev server: `npx wrangler dev`
- Deploy to Cloudflare: `npx wrangler deploy`

There are no tests, no linter, and no `package.json` — Wrangler is invoked via `npx` on demand.
