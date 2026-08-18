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
async function rateLimited(env, ip) {
  const key = `rl:${ip}`;
  const n = parseInt((await env.PETS.get(key)) || '0', 10) + 1;
  await env.PETS.put(key, String(n), { expirationTtl: RL_WINDOW });
  return n > RL_MAX;
}

function adminAuthorized(request, env) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  return Boolean(env.ADMIN_TOKEN) && token === env.ADMIN_TOKEN;
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
    return Response.json({ comment });
  }

  if (request.method === 'DELETE') {
    if (!adminAuthorized(request, env)) return new Response('Unauthorized', { status: 401 });
    const body = await safeJson(request);
    const plate = toPlate(body.plate);
    if (plate === null) return new Response('Bad plate', { status: 400 });
    const list = await readComments(env, plate);
    const next = list.filter((c) => c.id !== body.id);
    await env.PETS.put(COMMENTS_PREFIX + plate, JSON.stringify(next));
    return Response.json({ ok: true, removed: list.length - next.length });
  }

  return new Response('Method not allowed', { status: 405 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/captions.js') return handleCaptions(request, env);
    if (url.pathname.startsWith('/photos/')) return handlePhoto(request, env);
    if (url.pathname === '/api/pets') return handlePets(request, env);
    if (url.pathname === '/api/comments') return handleComments(request, env);

    return env.ASSETS.fetch(request);
  },
};
