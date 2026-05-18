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
src/
  index.js          # Worker entry: /api/pets + asset passthrough
wrangler.jsonc      # PETS KV binding, ASSETS binding, main = src/index.js
```

Each HTML page is self-contained (inline CSS, loads Google Fonts directly). `index.html` and `gallery.html` share a Fraunces + JetBrains Mono editorial design system; `classic.html` is deliberately plain.

## Adding photos

1. Drop the file as `public/images/dog-<N>.jpeg` (next sequential number).
2. Add a caption at the matching index in `public/captions.js` (entry `N-1` corresponds to `dog-N.jpeg`).
3. Captions must read standalone — each one is shown solo on the homepage on its assigned day, so avoid "again", "also", "same", etc.

The homepage picks the plate via `(year*10000 + month*100 + day) % TOTAL + 1`, where `TOTAL = captions.length`. Adding photos without captions will shift the deterministic daily rotation.

## Commands

- Local dev server: `npx wrangler dev`
- Deploy to Cloudflare: `npx wrangler deploy`

There are no tests, no linter, and no `package.json` — Wrangler is invoked via `npx` on demand.
