#!/usr/bin/env node
'use strict';

// Exports the wedding guestbook (KV key comments:919) to a timestamped JSON backup and a
// readable transcript. The whole book lives in a single KV value, so this is the only
// copy that survives the namespace being cleared — run it after the wedding.
//
//   node scripts/export-guestbook.js [outDir]     # default: ./guestbook-exports
//
// Requires wrangler to be authenticated (npx wrangler login).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PLATE = 919;
const KEY = `comments:${PLATE}`;
const ROOT = path.join(__dirname, '..');
const OUT_DIR = process.argv[2] || path.join(ROOT, 'guestbook-exports');

function readKV() {
  let out;
  try {
    out = execFileSync(
      'npx',
      ['--yes', 'wrangler', 'kv', 'key', 'get', KEY, '--binding', 'PETS', '--remote'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (err) {
    process.stderr.write(
      'Could not read the guestbook from KV.\n' +
      'Check that wrangler is authenticated: npx wrangler login\n\n' +
      String(err.stderr || err.message) + '\n'
    );
    process.exit(1);
  }

  // wrangler prints the raw value, sometimes alongside log chatter — take the JSON array.
  const start = out.indexOf('[');
  const end = out.lastIndexOf(']');
  if (start === -1 || end === -1) {
    process.stderr.write(`No guestbook found at key "${KEY}" — nobody has signed yet.\n`);
    process.exit(1);
  }
  try {
    return JSON.parse(out.slice(start, end + 1));
  } catch {
    process.stderr.write(`Value at "${KEY}" is not valid JSON.\n`);
    process.exit(1);
  }
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function transcript(entries) {
  const lines = [
    'The Wrangell.dog Wedding Guestbook',
    'Vaughn Taylor & Emily Ulrich — September 19th, 2026',
    '',
    `${entries.length} ${entries.length === 1 ? 'signature' : 'signatures'}`,
    '='.repeat(52),
    '',
  ];
  for (const c of entries) {
    const when = new Date(c.ts).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });
    lines.push(`${c.name || 'Anonymous'} — ${when}`);
    lines.push(c.text);
    lines.push('');
  }
  return lines.join('\n');
}

const entries = readKV().sort((a, b) => a.ts - b.ts);
fs.mkdirSync(OUT_DIR, { recursive: true });
const base = path.join(OUT_DIR, `guestbook-${stamp(new Date())}`);
fs.writeFileSync(`${base}.json`, JSON.stringify(entries, null, 2));
fs.writeFileSync(`${base}.txt`, transcript(entries));

process.stdout.write(`Exported ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}\n`);
process.stdout.write(`  ${base}.json  (backup — restorable)\n`);
process.stdout.write(`  ${base}.txt   (readable transcript)\n`);
