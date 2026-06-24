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
  images/           # dog-N.jpeg, referenced as images/dog-N.jpeg
  favicon.png       # tab icon: transparent cutout of Wrangell's face (48x48)
  apple-touch-icon.png  # 180x180 app icon (head on brand red) for iOS home screen
  icon-192.png      # PWA maskable app icon (192x192)
  icon-512.png      # PWA maskable app icon (512x512)
  manifest.webmanifest  # PWA manifest (installable app metadata)
  sw.js             # service worker: offline cache + installability (see "Installable app")
src/
  index.js          # Worker entry: /api/pets + /api/comments + asset passthrough
scripts/
  caption-new-images.js  # generates missing captions via Claude vision; run by pre-commit hook
  make-favicon.swift     # Vision-based background cutout for the favicon (see "Favicon")
  make-app-icon.swift    # composite a cutout onto a solid-color square app icon
.githooks/
  pre-commit        # invokes caption-new-images.js before every commit
wrangler.jsonc      # PETS KV binding, ASSETS binding, main = src/index.js
```

Each HTML page is self-contained (inline CSS, loads Google Fonts directly). `index.html` and `gallery.html` share a Fraunces + JetBrains Mono editorial design system; `classic.html` is deliberately plain.

## Adding photos

Use the `/add-photos` skill — it handles the full workflow automatically:
rename → caption (via Claude vision, no API key needed) → update `captions.js` → stage.

### How it works

1. Drop any number of image files into `public/images/` (any filename is fine).
2. Run `/add-photos`. The skill will:
   - Rename files to `dog-N.jpeg` sequentially from the next available number
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

- **Gallery** (`gallery.html`): uses `captions.length` as total plate count; generates `images/dog-${n}.jpeg` for n = 1..total. Images and captions must always be in sync.
- **Homepage** (`index.html`): picks today's photo via `(year*10000 + month*100 + day) % captions.length + 1`. Rotation shifts when photos are added — expected.
- **Pre-commit hook** (`.githooks/pre-commit`): runs `scripts/caption-new-images.js` (requires `ANTHROPIC_API_KEY`). When captions are already written by the skill, the hook exits cleanly without the key.

**One-time hook setup** (already done on the main clone):
```
git config core.hooksPath .githooks
```

## Favicon & app icons

All icons derive from one transparent head cutout of Wrangell from
`public/images/dog-29.jpeg` (a clean head-on portrait), produced by `scripts/make-favicon.swift`
via the macOS Vision framework (`VNGenerateForegroundInstanceMaskRequest`) — no installs, macOS only.

- **`favicon.png`** (48×48) — the bare transparent cutout; used as the browser tab icon.
- **`apple-touch-icon.png`** (180×180), **`icon-192.png`**, **`icon-512.png`** — the head
  composited onto a soft sage green (`#a3b18a`) by `scripts/make-app-icon.swift`. These are
  opaque app icons (iOS/Android mask transparency to black/circle, so app icons fill the
  square). The 192/512 are the maskable PWA icons referenced by the manifest.

To regenerate from a different source photo or crop:
```
# 1. transparent head cutout (x y w h = crop rect, top-left origin; omit to keep full subject)
swift scripts/make-favicon.swift public/images/dog-29.jpeg /tmp/head.png 900 800 1250 1250
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
cache (`sw.js`), so neither is ever cached.

**`/api/pets`** — pet counts.
- `GET` → `{ count, plates }` where `count` is the global total and `plates` is a
  `{ "<plate>": <count> }` map.
- `POST` with body `{ plate }` (integer 1–`MAX_PLATE`) → increments that plate and the total,
  returns `{ count, plate, plateCount }`. A missing/invalid `plate` bumps only the total
  (`{ count }`) for back-compat.
- KV keys: `count` (string total) and `plates` (one JSON map). The gallery shows a per-plate
  "🐾 N" badge, a "Most petted" sort, and a top-3 hall of fame.

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

## Commands

- Local dev server: `npx wrangler dev`
- Deploy to Cloudflare: `npx wrangler deploy`

There are no tests, no linter, and no `package.json` — Wrangler is invoked via `npx` on demand.
