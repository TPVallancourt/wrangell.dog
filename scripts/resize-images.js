#!/usr/bin/env node
'use strict';

// Syncs public/images/raw/ → public/images/resized/, downscaling each photo so its
// longer side is at most MAX_DIM. The site serves the resized set; raw is the archive.
//
//   node scripts/resize-images.js          # only photos missing or older than their raw
//   node scripts/resize-images.js --force  # redo everything
//
// Uses macOS `sips`, which resizes the stored pixels but preserves the EXIF orientation
// tag — important, because several photos (e.g. dog-151) are stored sideways and rely on
// that tag to render upright in the browser.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MAX_DIM = 1600;
const QUALITY = 82;

const ROOT = path.join(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'public', 'images', 'raw');
const OUT_DIR = path.join(ROOT, 'public', 'images', 'resized');

const force = process.argv.includes('--force');

function plates(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((f) => {
      const m = f.match(/^dog-(\d+)\.jpeg$/);
      return m ? { n: parseInt(m[1], 10), file: f } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n);
}

// True when the resized copy is missing or older than its raw source.
function stale(rawPath, outPath) {
  if (force || !fs.existsSync(outPath)) return true;
  return fs.statSync(rawPath).mtimeMs > fs.statSync(outPath).mtimeMs;
}

function main() {
  if (!fs.existsSync(RAW_DIR)) {
    process.stderr.write(`No raw directory at ${RAW_DIR}\n`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const all = plates(RAW_DIR);
  const todo = all.filter(({ file }) => stale(path.join(RAW_DIR, file), path.join(OUT_DIR, file)));

  if (todo.length === 0) {
    process.stdout.write(`resized: up to date (${all.length} photos)\n`);
    return;
  }

  process.stdout.write(`Resizing ${todo.length} of ${all.length} photo(s) to ${MAX_DIM}px...\n`);

  let before = 0;
  let after = 0;
  for (const { file } of todo) {
    const rawPath = path.join(RAW_DIR, file);
    const outPath = path.join(OUT_DIR, file);
    execFileSync('sips', [
      '-Z', String(MAX_DIM),
      '-s', 'format', 'jpeg',
      '-s', 'formatOptions', String(QUALITY),
      rawPath, '--out', outPath,
    ], { stdio: 'ignore' });
    before += fs.statSync(rawPath).size;
    after += fs.statSync(outPath).size;
  }

  const mb = (b) => (b / 1024 / 1024).toFixed(1);
  process.stdout.write(`Done — ${mb(before)} MB raw → ${mb(after)} MB resized\n`);
}

main();
