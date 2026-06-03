#!/usr/bin/env node
'use strict';

// Verifies every dog-N.jpeg in public/images/ has a non-empty caption in captions.js.
// Exits 1 if any are missing; suitable for CI and local preflight checks.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IMAGES_DIR = path.join(ROOT, 'public', 'images');
const CAPTIONS_FILE = path.join(ROOT, 'public', 'captions.js');

const src = fs.readFileSync(CAPTIONS_FILE, 'utf8');
const match = src.match(/window\.WRANGELL_CAPTIONS\s*=\s*(\[[\s\S]*?\]);/);
if (!match) { process.stderr.write('Could not parse captions.js\n'); process.exit(1); }
const captions = JSON.parse(match[1]);

const indices = fs.readdirSync(IMAGES_DIR)
  .map(f => { const m = f.match(/^dog-(\d+)\.jpeg$/); return m ? parseInt(m[1], 10) : null; })
  .filter(Boolean)
  .sort((a, b) => a - b);

const missing = indices.filter(n => !captions[n - 1]);

if (missing.length === 0) {
  process.stdout.write(`OK: all ${indices.length} images have captions\n`);
} else {
  process.stderr.write(`FAIL: ${missing.length} image(s) missing captions: ${missing.map(n => `dog-${n}.jpeg`).join(', ')}\n`);
  process.stderr.write(`Run: node scripts/caption-new-images.js\n`);
  process.exit(1);
}
