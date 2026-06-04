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
  apple-touch-icon.png  # 180x180 cutout for iOS home screen / high-DPI
src/
  index.js          # Worker entry: /api/pets + asset passthrough
scripts/
  caption-new-images.js  # generates missing captions via Claude vision; run by pre-commit hook
  make-favicon.swift     # Vision-based background cutout for the favicon (see "Favicon")
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

## Favicon

The tab icon (`public/favicon.png` + `public/apple-touch-icon.png`) is a transparent cutout
of Wrangell's face from `public/images/dog-29.jpeg` (a clean head-on portrait), referenced by `<link rel="icon">` /
`<link rel="apple-touch-icon">` in all three HTML pages. The cutout is produced by
`scripts/make-favicon.swift`, which uses the macOS Vision framework
(`VNGenerateForegroundInstanceMaskRequest`) to drop the background — no installs, macOS only.

To regenerate (e.g. from a different source photo or crop):
```
swift scripts/make-favicon.swift public/images/dog-29.jpeg /tmp/head.png 900 800 1250 1250
sips -z 48 48   /tmp/head.png --out public/favicon.png
sips -z 180 180 /tmp/head.png --out public/apple-touch-icon.png
```
The `x y w h` args are an optional crop rect (top-left origin, oriented-pixel space); omit
them to keep the full subject, then inspect to find the head box. A trailing `pad` centers
the crop on a transparent square canvas (side = the longer dimension) — useful for a tall
side-on head, though dog-29's front-on head is already roughly square so no pad is needed.

## Commands

- Local dev server: `npx wrangler dev`
- Deploy to Cloudflare: `npx wrangler deploy`

There are no tests, no linter, and no `package.json` — Wrangler is invoked via `npx` on demand.
