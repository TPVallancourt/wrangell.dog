import { captionRequestBody, parseCaption } from './caption.mjs';

const KEY = 'count';          // global running total (all plates)
const PLATES_KEY = 'plates';   // JSON map of { "<plate>": <count> }
const COMMENTS_PREFIX = 'comments:'; // comments:<plate> → JSON array of comments
const MAX_COMMENTS = 200;      // per-plate comment cap; oldest are dropped past this
const MAX_TEXT = 500;          // comment body length cap
const MAX_NAME = 40;           // commenter name length cap
const RL_WINDOW = 60;          // rate-limit window (seconds); KV TTL minimum is 60
const RL_MAX = 10;             // max comments per IP per window
const PHOTOS_KEY = 'photos';   // JSON array of { n, caption, src, ts }; append-only
const BULLETINS_KEY = 'bulletins'; // JSON array of { id, text, href, startsAt, endsAt }
const CAPTIONS_TTL = 60;       // seconds browsers/edge may reuse the generated captions.js
const SESSION_COOKIE = 'wrangell_admin';
const SESSION_TTL = 60 * 60 * 12; // admin session lifetime (seconds)
const LOGIN_RL_MAX = 8;        // login attempts per IP per window
const LOGIN_RL_WINDOW = 300;   // login rate-limit window (seconds)
const MAX_CAPTION = 80;        // caption length cap
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // generous: the console downscales before sending
const MAX_BULLETIN_TEXT = 200; // bulletin body cap
const MAX_BULLETINS = 20;      // keep the bulletin list bounded
const RECENT_KEY = 'comments:recent'; // rolling cross-plate feed for moderation
const MAX_RECENT = 200;

// Returns a positive integer plate, or null.
function toPlate(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

async function safeJson(request) {
  try {
    return (await request.json()) || {};
  } catch {
    return {};
  }
}

// Trim, drop control characters (keep tab/newline), and cap length.
function clean(value, max) {
  let out = '';
  for (const ch of String(value == null ? '' : value)) {
    const c = ch.codePointAt(0);
    if (c === 0x7f || (c < 0x20 && c !== 0x09 && c !== 0x0a)) continue;
    out += ch;
  }
  return out.trim().slice(0, max);
}

async function readPlates(env) {
  try {
    return JSON.parse((await env.PETS.get(PLATES_KEY)) || '{}') || {};
  } catch {
    return {};
  }
}

async function readComments(env, plate) {
  try {
    return JSON.parse((await env.PETS.get(COMMENTS_PREFIX + plate)) || '[]') || [];
  } catch {
    return [];
  }
}

async function readPhotos(env) {
  try {
    const raw = await env.PETS.get(PHOTOS_KEY);
    if (!raw) return null; // distinct from []: null means "not seeded, fall back to the asset"
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

async function readBulletins(env) {
  try {
    return JSON.parse((await env.PETS.get(BULLETINS_KEY)) || '[]') || [];
  } catch {
    return [];
  }
}

// The bulletin whose window covers now, most recently started first. Null when none.
function activeBulletin(list, now) {
  const live = list.filter((b) => {
    const from = Number(b.startsAt) || 0;
    const until = Number(b.endsAt) || Infinity;
    return now >= from && now < until;
  });
  live.sort((a, b) => (Number(b.startsAt) || 0) - (Number(a.startsAt) || 0));
  return live[0] || null;
}

// Fixed-window per-IP limiter; returns true when the caller is over the limit.
async function rateLimited(env, ip, prefix = 'rl', max = RL_MAX, windowSeconds = RL_WINDOW) {
  const key = `${prefix}:${ip}`;
  const n = parseInt((await env.PETS.get(key)) || '0', 10) + 1;
  await env.PETS.put(key, String(n), { expirationTtl: windowSeconds });
  return n > max;
}

// Compares two secrets without leaking their contents or lengths through timing: digest both
// and compare the fixed-width digests byte by byte.
async function secretEqual(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

async function hmacHex(env, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(env.ADMIN_TOKEN),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Session value is "<expiry ms>.<HMAC of the expiry>" — self-contained, so there is no
// session store to keep and revocation is a matter of rotating ADMIN_TOKEN.
async function makeSession(env) {
  const expires = Date.now() + SESSION_TTL * 1000;
  return `${expires}.${await hmacHex(env, String(expires))}`;
}

async function sessionValid(env, value) {
  const [expires, signature] = String(value || '').split('.');
  if (!/^\d+$/.test(expires || '') || Date.now() > Number(expires)) return false;
  return secretEqual(signature || '', await hmacHex(env, expires));
}

function readCookie(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// Either a session cookie (admin console) or a bearer token (the ?admin=<token> flow the
// gallery and homepage already use for comment deletion).
async function adminAuthorized(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (bearer && (await secretEqual(bearer, env.ADMIN_TOKEN))) return true;
  const cookie = readCookie(request, SESSION_COOKIE);
  return Boolean(cookie) && (await sessionValid(env, cookie));
}

// Serializes a value as a JS literal. U+2028/2029 are legal in JSON but were illegal in
// JS string literals before ES2019, so escape them defensively.
function jsLiteral(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// GET /captions.js — generated from the KV manifest so uploads take effect without a deploy.
// Emits WRANGELL_CAPTIONS (index 0 = plate 1) for back-compat alongside the authoritative
// WRANGELL_PHOTOS. Falls back to the committed asset when KV is unseeded.
//
// The manifest is append-only: photos are never deleted, so plate numbers are contiguous and
// permanently stable. That is what lets comments and pet counts key off the plate number.
async function handleCaptions(request, env) {
  const photos = await readPhotos(env);
  if (!photos) return env.ASSETS.fetch(request);

  const valid = photos.filter((p) => p && Number.isInteger(p.n) && p.n >= 1);
  const maxN = valid.reduce((max, p) => (p.n > max ? p.n : max), 0);

  // Indexed by plate number rather than array position, so a manifest that somehow has a
  // hole degrades to a blank caption instead of silently shifting every later plate.
  const captions = new Array(maxN).fill('');
  for (const p of valid) captions[p.n - 1] = String(p.caption || '');

  const manifest = valid
    .map((p) => ({ n: p.n, caption: String(p.caption || ''), src: p.src || `images/dog-${p.n}.jpeg` }))
    .sort((a, b) => a.n - b.n);

  const bulletin = activeBulletin(await readBulletins(env), Date.now());

  const body =
    `// Generated from KV by the Worker. public/captions.js is the seed and offline fallback.\n` +
    `window.WRANGELL_CAPTIONS = ${jsLiteral(captions)};\n` +
    `window.WRANGELL_PHOTOS = ${jsLiteral(manifest)};\n` +
    `window.WRANGELL_BULLETIN = ${jsLiteral(bulletin)};\n`;

  return new Response(body, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': `public, max-age=${CAPTIONS_TTL}`,
    },
  });
}

// GET /photos/<key> — uploaded photos, served from R2. Distinct from /images/, which is
// static assets in the repo and is deliberately never routed through the Worker.
async function handlePhoto(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }
  if (!env.PHOTOS) return new Response('Not found', { status: 404 });

  const key = decodeURIComponent(new URL(request.url).pathname.slice('/photos/'.length));
  if (!key || key.includes('..')) return new Response('Not found', { status: 404 });

  // onlyIf lets R2 evaluate If-None-Match / If-Modified-Since; a failed precondition comes
  // back as an object with no body, which is the 304.
  const object = await env.PHOTOS.get(key, { onlyIf: request.headers });
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  // Keys are never reused, so this can be immutable — which keeps repeat views on the edge
  // cache instead of spending a Worker invocation each time.
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  if (!('body' in object)) return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}

async function handlePets(request, env) {
  if (request.method === 'GET') {
    const count = parseInt((await env.PETS.get(KEY)) || '0', 10);
    const plates = await readPlates(env);
    return Response.json({ count, plates });
  }
  if (request.method === 'POST') {
    const body = await safeJson(request);
    const plate = toPlate(body.plate);
    const next = parseInt((await env.PETS.get(KEY)) || '0', 10) + 1;
    await env.PETS.put(KEY, String(next));

    // No valid plate (legacy/defensive) → bump only the global total.
    if (plate === null) return Response.json({ count: next });

    const plates = await readPlates(env);
    const plateCount = (plates[plate] || 0) + 1;
    plates[plate] = plateCount;
    await env.PETS.put(PLATES_KEY, JSON.stringify(plates));
    return Response.json({ count: next, plate, plateCount });
  }
  return new Response('Method not allowed', { status: 405 });
}

async function handleComments(request, env) {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const plate = toPlate(url.searchParams.get('plate'));
    if (plate === null) return new Response('Bad plate', { status: 400 });
    return Response.json({ comments: await readComments(env, plate) });
  }

  if (request.method === 'POST') {
    const body = await safeJson(request);
    // Honeypot: real users never fill this hidden field. Accept silently, store nothing.
    if (body.website) return Response.json({ ok: true });

    const plate = toPlate(body.plate);
    if (plate === null) return new Response('Bad plate', { status: 400 });

    const text = clean(body.text, MAX_TEXT);
    if (!text) return new Response('Empty comment', { status: 400 });

    const ip = request.headers.get('CF-Connecting-IP') || 'anon';
    if (await rateLimited(env, ip)) return new Response('Too many comments', { status: 429 });

    const comment = {
      id: crypto.randomUUID(),
      name: clean(body.name, MAX_NAME),
      text,
      ts: Date.now(),
    };
    const list = await readComments(env, plate);
    list.push(comment);
    if (list.length > MAX_COMMENTS) list.splice(0, list.length - MAX_COMMENTS);
    await env.PETS.put(COMMENTS_PREFIX + plate, JSON.stringify(list));

    // Mirror into a rolling cross-plate feed so the admin console can list everything in one
    // read rather than fetching comments:<plate> for every plate.
    try {
      const recent = JSON.parse((await env.PETS.get(RECENT_KEY)) || '[]') || [];
      recent.push({ ...comment, plate });
      if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
      await env.PETS.put(RECENT_KEY, JSON.stringify(recent));
    } catch {
      // The feed is a convenience; never fail the visitor's comment over it.
    }

    return Response.json({ comment });
  }

  if (request.method === 'DELETE') {
    if (!(await adminAuthorized(request, env))) return new Response('Unauthorized', { status: 401 });
    const body = await safeJson(request);
    const plate = toPlate(body.plate);
    if (plate === null) return new Response('Bad plate', { status: 400 });
    const list = await readComments(env, plate);
    const next = list.filter((c) => c.id !== body.id);
    await env.PETS.put(COMMENTS_PREFIX + plate, JSON.stringify(next));

    try {
      const recent = JSON.parse((await env.PETS.get(RECENT_KEY)) || '[]') || [];
      await env.PETS.put(RECENT_KEY, JSON.stringify(recent.filter((c) => c.id !== body.id)));
    } catch {
      // Feed is best-effort; the per-plate list is the source of truth.
    }

    return Response.json({ ok: true, removed: list.length - next.length });
  }

  return new Response('Method not allowed', { status: 405 });
}

// Chunked so a large image doesn't blow the argument limit on String.fromCharCode.
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Photos live in two places: R2 for uploads, the asset bundle for everything committed.
async function readPhotoBytes(request, env, photo) {
  const src = String(photo.src || '');
  if (src.startsWith('/photos/')) {
    if (!env.PHOTOS) return null;
    const object = await env.PHOTOS.get(decodeURIComponent(src.slice('/photos/'.length)));
    return object ? object.arrayBuffer() : null;
  }
  const res = await env.ASSETS.fetch(new Request(new URL(src, request.url)));
  return res.ok ? res.arrayBuffer() : null;
}

// The admin endpoints must never see an empty manifest: an upload would then assign plate 1
// and replace the committed set. So bootstrap from public/captions.js on first use — same
// derivation as scripts/seed-manifest.js, just done lazily so deploying needs no seed step.
// Read straight from ASSETS: fetching /captions.js would re-enter handleCaptions.
async function ensurePhotos(request, env) {
  const existing = await readPhotos(env);
  if (existing && existing.length) return existing;

  const res = await env.ASSETS.fetch(new Request(new URL('/captions.js', request.url)));
  if (!res.ok) return existing || [];

  const match = (await res.text()).match(/window\.WRANGELL_CAPTIONS\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) return existing || [];

  let captions;
  try {
    captions = JSON.parse(match[1]);
  } catch {
    return existing || [];
  }

  const photos = captions.map((caption, i) => ({
    n: i + 1,
    caption: String(caption || ''),
    src: `images/dog-${i + 1}.jpeg`,
    ts: 0,
  }));
  await env.PETS.put(PHOTOS_KEY, JSON.stringify(photos));
  return photos;
}

function sessionCookie(value, maxAge) {
  // Secure is honored on http://localhost too, so this works in `wrangler dev`.
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

// /api/admin/* — everything here is gated on adminAuthorized except the login endpoint.
async function handleAdmin(request, env, url) {
  const route = url.pathname.slice('/api/admin/'.length);

  if (route === 'login') {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!env.ADMIN_TOKEN) return new Response('Admin not configured', { status: 503 });

    const ip = request.headers.get('CF-Connecting-IP') || 'anon';
    if (await rateLimited(env, ip, 'rl:login', LOGIN_RL_MAX, LOGIN_RL_WINDOW)) {
      return new Response('Too many attempts', { status: 429 });
    }

    const body = await safeJson(request);
    if (!(await secretEqual(body.password || '', env.ADMIN_TOKEN))) {
      return new Response('Unauthorized', { status: 401 });
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': sessionCookie(await makeSession(env), SESSION_TTL),
      },
    });
  }

  if (route === 'logout') {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie('', 0) },
    });
  }

  // Cheap probe so the console can decide between the login form and the dashboard.
  if (route === 'session') {
    return Response.json({ admin: await adminAuthorized(request, env) });
  }

  if (!(await adminAuthorized(request, env))) return new Response('Unauthorized', { status: 401 });

  if (route === 'photos') {
    const photos = await ensurePhotos(request, env);

    if (request.method === 'GET') return Response.json({ photos });

    // Upload. The console downscales client-side first, so these are normally ~400KB.
    if (request.method === 'POST') {
      if (!env.PHOTOS) return new Response('R2 bucket not configured', { status: 503 });

      const form = await request.formData();
      const file = form.get('file');
      if (!file || typeof file.arrayBuffer !== 'function') {
        return new Response('Missing file', { status: 400 });
      }
      if (file.type !== 'image/jpeg') return new Response('JPEG only', { status: 415 });
      if (file.size > MAX_UPLOAD_BYTES) return new Response('Too large', { status: 413 });

      // Append-only: the next plate is always one past the highest, never a reused number.
      const n = photos.reduce((max, p) => (p.n > max ? p.n : max), 0) + 1;
      const key = `dog-${n}.jpeg`;
      await env.PHOTOS.put(key, await file.arrayBuffer(), {
        httpMetadata: { contentType: 'image/jpeg' },
      });

      const photo = {
        n,
        caption: clean(form.get('caption'), MAX_CAPTION),
        src: `/photos/${key}`,
        ts: Date.now(),
      };
      photos.push(photo);
      await env.PETS.put(PHOTOS_KEY, JSON.stringify(photos));
      return Response.json({ photo });
    }

    // Caption edit. Captions are the only mutable field — photos are never deleted.
    if (request.method === 'PATCH') {
      const body = await safeJson(request);
      const n = toPlate(body.n);
      const photo = photos.find((p) => p.n === n);
      if (!photo) return new Response('No such plate', { status: 404 });
      photo.caption = clean(body.caption, MAX_CAPTION);
      await env.PETS.put(PHOTOS_KEY, JSON.stringify(photos));
      return Response.json({ photo });
    }

    return new Response('Method not allowed', { status: 405 });
  }

  // Suggests a caption for an existing plate; the console shows it in an editable field.
  if (route === 'caption') {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!env.ANTHROPIC_API_KEY) return new Response('ANTHROPIC_API_KEY not set', { status: 503 });

    const body = await safeJson(request);
    const n = toPlate(body.n);
    const photos = await ensurePhotos(request, env);
    const photo = photos.find((p) => p.n === n);
    if (!photo) return new Response('No such plate', { status: 404 });

    const bytes = await readPhotoBytes(request, env, photo);
    if (!bytes) return new Response('Image not found', { status: 404 });

    const samples = photos.filter((p) => p.caption).map((p) => p.caption);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(captionRequestBody(toBase64(bytes), samples)),
    });
    if (!res.ok) {
      return new Response(`Caption API ${res.status}: ${await res.text()}`, { status: 502 });
    }
    return Response.json({ caption: parseCaption(await res.json()) });
  }

  if (route === 'bulletins') {
    if (request.method === 'GET') return Response.json({ bulletins: await readBulletins(env) });

    // Whole-list replace: there is one admin, so this is simpler than per-item CRUD.
    if (request.method === 'PUT') {
      const body = await safeJson(request);
      const incoming = Array.isArray(body.bulletins) ? body.bulletins : [];
      const bulletins = incoming.slice(0, MAX_BULLETINS).map((b) => ({
        id: String(b.id || crypto.randomUUID()),
        text: clean(b.text, MAX_BULLETIN_TEXT),
        href: clean(b.href, 200),
        startsAt: Number(b.startsAt) || 0,
        endsAt: Number(b.endsAt) || 0,
      })).filter((b) => b.text);
      await env.PETS.put(BULLETINS_KEY, JSON.stringify(bulletins));
      return Response.json({ bulletins });
    }

    return new Response('Method not allowed', { status: 405 });
  }

  // One read instead of one per plate — see the rolling list maintained in handleComments.
  if (route === 'comments') {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    let recent = [];
    try {
      recent = JSON.parse((await env.PETS.get(RECENT_KEY)) || '[]') || [];
    } catch {
      recent = [];
    }
    return Response.json({ comments: recent.slice().reverse() });
  }

  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/captions.js') return handleCaptions(request, env);
    if (url.pathname.startsWith('/photos/')) return handlePhoto(request, env);
    if (url.pathname.startsWith('/api/admin/')) return handleAdmin(request, env, url);
    if (url.pathname === '/api/pets') return handlePets(request, env);
    if (url.pathname === '/api/comments') return handleComments(request, env);

    return env.ASSETS.fetch(request);
  },
};
