# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Single-page static site (`index.html` + `dog.jpeg`) deployed to Cloudflare Workers via Wrangler. The whole repo root is served as static assets — there is no build step, no framework, and no server-side code. `wrangler.jsonc` sets `assets.directory` to `.`, so any file added to the root is publicly served.

## Commands

- Local dev server: `npx wrangler dev`
- Deploy to Cloudflare: `npx wrangler deploy`

There are no tests, no linter, and no `package.json` — Wrangler is invoked via `npx` on demand.
