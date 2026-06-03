#!/usr/bin/env node
'use strict';

// Finds dog-*.jpeg files in public/images that lack a caption in captions.js and
// generates one via Claude vision. Stages public/captions.js when done.
// Requires ANTHROPIC_API_KEY.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const IMAGES_DIR = path.join(ROOT, 'public', 'images');
const CAPTIONS_FILE = path.join(ROOT, 'public', 'captions.js');

function readCaptions() {
  const src = fs.readFileSync(CAPTIONS_FILE, 'utf8');
  const match = src.match(/window\.WRANGELL_CAPTIONS\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) throw new Error('Could not parse captions.js');
  return JSON.parse(match[1]);
}

function writeCaptions(captions) {
  const lines = captions.map(c => `  ${JSON.stringify(c)}`);
  const src = [
    `// Captions for dog-1.jpeg .. dog-${captions.length}.jpeg (index 0 = dog-1).`,
    `window.WRANGELL_CAPTIONS = [`,
    lines.join(',\n'),
    `];\n`,
  ].join('\n');
  fs.writeFileSync(CAPTIONS_FILE, src, 'utf8');
}

function getImageIndices() {
  return fs.readdirSync(IMAGES_DIR)
    .map(f => { const m = f.match(/^dog-(\d+)\.jpeg$/); return m ? parseInt(m[1], 10) : null; })
    .filter(Boolean)
    .sort((a, b) => a - b);
}

async function generateCaption(imagePath, existingSamples) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const imageData = fs.readFileSync(imagePath).toString('base64');
  const sampleList = existingSamples.slice(-12).map(s => `- ${s}`).join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 30,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageData } },
          {
            type: 'text',
            text: `Write a one-line caption for this dog photo in this exact style:\n${sampleList}\n\nRules: 2–5 words, no articles (a/an/the) unless essential, wry and observational, never sentimental, never mention the dog's name, no exclamation points. Reply with the caption only.`,
          },
        ],
      }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content[0].text.trim().replace(/^["']|["']$/g, '');
}

async function main() {
  const captions = readCaptions();
  const indices = getImageIndices();
  const missing = indices.filter(n => !captions[n - 1]);

  if (missing.length === 0) {
    process.stdout.write('captions: up to date\n');
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(
      `\nWarning: ${missing.length} image(s) need captions but ANTHROPIC_API_KEY is not set.\n` +
      `Missing: ${missing.map(n => `dog-${n}.jpeg`).join(', ')}\n` +
      `Run \`node scripts/caption-new-images.js\` with the key set before merging.\n\n`
    );
    return;
  }

  process.stdout.write(`Captioning ${missing.length} new image(s) via Claude...\n`);
  const samples = captions.filter(Boolean);

  for (const n of missing) {
    const imagePath = path.join(IMAGES_DIR, `dog-${n}.jpeg`);
    process.stdout.write(`  dog-${n}.jpeg → `);
    const caption = await generateCaption(imagePath, samples);
    process.stdout.write(`"${caption}"\n`);
    while (captions.length < n) captions.push('');
    captions[n - 1] = caption;
    samples.push(caption);
  }

  writeCaptions(captions);
  execSync('git add public/captions.js', { cwd: ROOT });
  process.stdout.write(`Updated captions.js (${captions.length} total)\n`);
}

main().catch(err => { process.stderr.write(`\n${err.message}\n`); process.exit(1); });
