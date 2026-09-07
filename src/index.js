const KEY = 'count';          // global running total (all plates)
const PLATES_KEY = 'plates';   // JSON map of { "<plate>": <count> }
const COMMENTS_PREFIX = 'comments:'; // comments:<plate> → JSON array of comments
const MAX_COMMENTS = 200;      // per-plate comment cap; oldest are dropped past this
const MAX_TEXT = 500;          // comment body length cap
const MAX_NAME = 40;           // commenter name length cap
const RL_WINDOW = 60;          // rate-limit window (seconds); KV TTL minimum is 60
const RL_MAX = 10;             // max comments per IP per window

// Wedding takeover: live now through 2026-09-23 in US Eastern (the window sits in EDT,
// so the fixed -04:00 offset is exact). Turned on early — it was originally scoped to
// the 16th. During it "/" serves the wedding page instead of photo-of-the-day;
// "/?daily=1" opts back into the daily edition, and /wedding is reachable year-round.
const WEDDING_START = Date.parse('2026-09-07T00:00:00-04:00');
const WEDDING_END = Date.parse('2026-09-24T00:00:00-04:00');

function inWeddingWeek(now) {
  return now >= WEDDING_START && now < WEDDING_END;
}

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

    if (url.pathname === '/api/pets') return handlePets(request, env);
    if (url.pathname === '/api/comments') return handleComments(request, env);

    // "/?wedding=1" previews the takeover before it goes live; "/?daily=1" opts out of it
    // while it is. Neither is needed to reach the page itself — /wedding always works.
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const forced = url.searchParams.has('wedding');
      const optedOut = url.searchParams.has('daily');
      if (forced || (inWeddingWeek(Date.now()) && !optedOut)) {
        // Clean URL, not "/wedding.html" — the .html form 307-redirects, which would
        // bounce the visitor off "/" and show the redirect in the address bar.
        const target = new URL(url);
        target.pathname = '/wedding';
        return env.ASSETS.fetch(new Request(target, request));
      }
    }

    return env.ASSETS.fetch(request);
  },
};
