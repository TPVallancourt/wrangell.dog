#!/usr/bin/env node
// Builds the KV photo manifest from the committed public/captions.js + public/images/,
// and prints it to stdout. This is the one-time bridge from "captions live in git" to
// "captions live in KV"; after seeding, KV is the source of truth and public/captions.js
// is the seed and offline fallback.
//
//   node scripts/seed-manifest.js > /tmp/photos.json
//   npx wrangler kv key put --remote photos --path /tmp/photos.json --binding PETS
//
// Re-running is safe: it always derives from the committed files, so it produces the same
// manifest. It will NOT preserve edits made through the admin console — seed once.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const captionsPath = path.join(root, 'public', 'captions.js');
const imagesDir = path.join(root, 'public', 'images');

// Same extraction the other scripts use, so all three stay in agreement.
const src = fs.readFileSync(captionsPath, 'utf8');
const match = src.match(/window\.WRANGELL_CAPTIONS\s*=\s*(\[[\s\S]*?\]);/);
if (!match) {
  console.error('Could not parse window.WRANGELL_CAPTIONS from public/captions.js');
  process.exit(1);
}
const captions = JSON.parse(match[1]);

const present = new Set(
  fs
    .readdirSync(imagesDir)
    .map((f) => /^dog-(\d+)\.jpeg$/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]))
);

const photos = [];
const missing = [];
for (let n = 1; n <= captions.length; n++) {
  if (!present.has(n)) {
    missing.push(n);
    continue;
  }
  photos.push({
    n,
    caption: captions[n - 1] || '',
    src: `images/dog-${n}.jpeg`, // static asset; uploads use "/photos/dog-N.jpeg"
    ts: 0, // backfilled entries predate upload timestamps
  });
}

if (missing.length) {
  console.error(`warning: ${missing.length} caption(s) have no image and were skipped: ${missing.join(', ')}`);
}
const orphans = [...present].filter((n) => n > captions.length).sort((a, b) => a - b);
if (orphans.length) {
  console.error(`warning: ${orphans.length} image(s) have no caption and were skipped: ${orphans.join(', ')}`);
}

console.error(`seeded ${photos.length} photos`);
process.stdout.write(JSON.stringify(photos));
