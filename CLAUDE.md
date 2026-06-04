# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Static-first site deployed to Cloudflare Workers via Wrangler. No build step, no framework. `src/index.js` is a Worker that handles `/api/pets` (a KV-backed pet counter against the `PETS` binding) and falls through to `env.ASSETS.fetch(request)` for everything else. `wrangler.jsonc` sets `assets.directory` to `./public`, so everything under `public/` is publicly served and everything outside it (this file, `src/`, `wrangler.jsonc`, `README.md`) is project-only.

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
  index.js          # Worker entry: /api/pets + asset passthrough
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

1. Drop the file as `public/images/dog-<N>.jpeg` (next sequential number).
2. Commit — the pre-commit hook runs `scripts/caption-new-images.js`, which calls Claude vision to generate a caption and stages the updated `captions.js` automatically. Requires `ANTHROPIC_API_KEY` in the environment.
3. To generate or preview captions without committing: `node scripts/caption-new-images.js`
4. To override a generated caption, edit `public/captions.js` before the commit lands.

Captions must read standalone — each one is shown solo on the homepage on its assigned day, so avoid "again", "also", "same", etc. Style: 2–5 words, no articles, wry and observational.

The homepage picks the plate via `(year*10000 + month*100 + day) % TOTAL + 1`, where `TOTAL = captions.length`. Adding photos without captions will shift the deterministic daily rotation.

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
  composited onto the brand red (`#c43d1f`) by `scripts/make-app-icon.swift`. These are
  opaque app icons (iOS/Android mask transparency to black/circle, so app icons fill the
  square). The 192/512 are the maskable PWA icons referenced by the manifest.

To regenerate from a different source photo or crop:
```
# 1. transparent head cutout (x y w h = crop rect, top-left origin; omit to keep full subject)
swift scripts/make-favicon.swift public/images/dog-29.jpeg /tmp/head.png 900 800 1250 1250
sips -z 48 48 /tmp/head.png --out public/favicon.png
# 2. opaque app icons on brand red (last arg = safe-zone inset fraction)
swift scripts/make-app-icon.swift /tmp/head.png public/icon-512.png 512 c43d1f 0.14
sips -z 192 192 public/icon-512.png --out public/icon-192.png
swift scripts/make-app-icon.swift /tmp/head.png public/apple-touch-icon.png 180 c43d1f 0.10
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

## Commands

- Local dev server: `npx wrangler dev`
- Deploy to Cloudflare: `npx wrangler deploy`

There are no tests, no linter, and no `package.json` — Wrangler is invoked via `npx` on demand.
