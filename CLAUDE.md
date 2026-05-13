# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Single-page static site deployed to Cloudflare Workers via Wrangler. No build step, no framework, no server-side code. `wrangler.jsonc` sets `assets.directory` to `./public`, so everything under `public/` is publicly served and everything outside it (this file, `wrangler.jsonc`, `README.md`) is project-only.

## Layout

```
public/
  index.html        # single self-contained page; inline CSS, loads Google Fonts
  images/           # dog-N.jpeg, referenced as images/dog-N.jpeg
wrangler.jsonc
```

Add new images as `public/images/<name>.jpeg` and reference them with a relative path from `index.html` (`images/<name>.jpeg`).

## Commands

- Local dev server: `npx wrangler dev`
- Deploy to Cloudflare: `npx wrangler deploy`

There are no tests, no linter, and no `package.json` — Wrangler is invoked via `npx` on demand.
