// Pet counts live in ONE key. They used to live in two — `plates` for the per-plate map
// and `count` for the global total — which meant every pet cost two KV writes to record
// one fact, since the total is just the sum of the parts. The free tier allows 1,000
// writes a day and the wedding guestbook spends from that same budget, so the total is
// now derived on read and `count` is kept only as a pre-migration backup.
//
// `plates` holds { v: 2, base, plates: { "<plate>": n } }. `base` carries the pets that
// were never attributed to a plate: the legacy total minus the plate sum at migration
// time, plus anything a plate-less POST adds later. See readPetState for the migration.
const PLATES_KEY = 'plates';
const LEGACY_COUNT_KEY = 'count'; // pre-v2 global total; read once, then only for history
const MAX_PET_BATCH = 50;      // pets a single POST may carry; clients coalesce bursts
const PETS_CACHE_TTL = 60;     // seconds a GET /api/pets response may be reused

const COMMENTS_PREFIX = 'comments:'; // comments:<plate> → JSON array of comments
const MAX_COMMENTS = 200;      // per-plate comment cap; oldest are dropped past this
const MAX_TEXT = 500;          // comment body length cap
const MAX_NAME = 40;           // commenter name length cap
const RL_WINDOW = 60;          // rate-limit window (seconds); KV TTL minimum is 60
const RL_MAX = 10;             // max comments per IP per window

// The wedding guestbook is a keepsake, so it plays by different rules than photo
// comments. Two things would otherwise go wrong:
//   1. MAX_COMMENTS drops the OLDEST entries to make room — backwards for a guestbook,
//      where the first signatures matter most. Here the cap is far above any plausible
//      guest count, and a full book refuses new writes rather than silently discarding.
//   2. Guests on venue wifi all share one NAT'd IP, so RL_MAX would throttle the whole
//      room after ten signatures. The guestbook gets its own, roomier budget under a
//      separate key prefix so it never competes with ordinary comment traffic.
const GUESTBOOK_PLATE = 919;
const GUESTBOOK_MAX = 5000;    // ~3 MB of JSON worst case, well under KV's 25 MiB value limit
const RL_GUESTBOOK_MAX = 60;   // signatures per shared IP per window

// Signing is open only for the wedding weekend: 2026-09-19 and 2026-09-20 Eastern.
// Reading stays open always, so guests can browse the book before and after. Holders of
// ADMIN_TOKEN can sign any time, which is how you test the form outside the window.
const GUESTBOOK_OPENS = Date.parse('2026-09-19T00:00:00-04:00');
const GUESTBOOK_CLOSES = Date.parse('2026-09-21T00:00:00-04:00'); // exclusive: end of 9/20

function guestbookOpen(now) {
  return now >= GUESTBOOK_OPENS && now < GUESTBOOK_CLOSES;
}

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

// Pets a single POST may credit at once. Absent/garbage means one pet.
function toBatch(value) {
  if (value == null) return 1;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return 1;
  return Math.min(n, MAX_PET_BATCH);
}

function sumPlates(plates) {
  let total = 0;
  for (const v of Object.values(plates)) total += Number(v) || 0;
  return total;
}

// Returns { base, plates }. Costs one KV read once migrated, two before then.
async function readPetState(env) {
  let raw = null;
  try {
    raw = JSON.parse((await env.PETS.get(PLATES_KEY)) || 'null');
  } catch {
    raw = null;
  }

  if (raw && raw.v === 2) {
    return { base: Number(raw.base) || 0, plates: raw.plates || {} };
  }

  // Pre-v2: `plates` was a bare map and `count` held the total. The total could exceed
  // the plate sum because plate-less POSTs bumped only `count`, so the difference is
  // what `base` preserves. Migration is lazy and happens on the first write, not here —
  // a GET that writes would burn the write budget it is meant to protect.
  const plates = raw && typeof raw === 'object' ? raw : {};
  const legacyTotal = parseInt((await env.PETS.get(LEGACY_COUNT_KEY)) || '0', 10) || 0;
  return { base: Math.max(0, legacyTotal - sumPlates(plates)), plates };
}

function writePetState(env, state) {
  return env.PETS.put(
    PLATES_KEY,
    JSON.stringify({ v: 2, base: state.base, plates: state.plates }),
  );
}

async function readComments(env, plate) {
  try {
    return JSON.parse((await env.PETS.get(COMMENTS_PREFIX + plate)) || '[]') || [];
  } catch {
    return [];
  }
}

// Fixed-window per-IP limiter; returns true when the caller is over the limit.
// `prefix` keeps separate budgets from sharing a counter.
async function rateLimited(env, ip, { prefix = 'rl', max = RL_MAX } = {}) {
  const key = `${prefix}:${ip}`;
  const n = parseInt((await env.PETS.get(key)) || '0', 10) + 1;
  await env.PETS.put(key, String(n), { expirationTtl: RL_WINDOW });
  return n > max;
}

function adminAuthorized(request, env) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  return Boolean(env.ADMIN_TOKEN) && token === env.ADMIN_TOKEN;
}

// Normalized so a stray query string still hits the one cached entry, and so POST can
// address the same entry the GET stored.
function petsCacheKey(request) {
  const url = new URL(request.url);
  url.search = '';
  return new Request(url.toString(), { method: 'GET' });
}

async function handlePets(request, env, ctx) {
  const cache = caches.default;

  if (request.method === 'GET') {
    // Many visitors read these counts and few change them, so caching collapses a
    // traffic spike into one KV read per TTL per colo. Purging on write (below) is
    // free in KV terms, which keeps a reload after petting honest.
    const key = petsCacheKey(request);
    const hit = await cache.match(key);
    if (hit) return hit;

    const { base, plates } = await readPetState(env);
    const response = Response.json(
      { count: base + sumPlates(plates), plates },
      { headers: { 'Cache-Control': `public, max-age=${PETS_CACHE_TTL}` } },
    );
    ctx.waitUntil(cache.put(key, response.clone()));
    return response;
  }

  if (request.method === 'POST') {
    const body = await safeJson(request);
    const plate = toPlate(body.plate);
    const n = toBatch(body.n);
    const state = await readPetState(env);

    // No valid plate (legacy/defensive) → credit the unattributed pool only.
    if (plate === null) {
      state.base += n;
    } else {
      state.plates[plate] = (state.plates[plate] || 0) + n;
    }
    await writePetState(env, state);
    ctx.waitUntil(cache.delete(petsCacheKey(request)));

    const count = state.base + sumPlates(state.plates);
    if (plate === null) return Response.json({ count });
    return Response.json({ count, plate, plateCount: state.plates[plate] });
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

    const isGuestbook = plate === GUESTBOOK_PLATE;

    if (isGuestbook && !guestbookOpen(Date.now()) && !adminAuthorized(request, env)) {
      return new Response('Guestbook closed', { status: 403 });
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'anon';
    const limited = isGuestbook
      ? await rateLimited(env, ip, { prefix: 'rlgb', max: RL_GUESTBOOK_MAX })
      : await rateLimited(env, ip);
    if (limited) return new Response('Too many comments', { status: 429 });

    const comment = {
      id: crypto.randomUUID(),
      name: clean(body.name, MAX_NAME),
      text,
      ts: Date.now(),
    };
    const list = await readComments(env, plate);

    if (isGuestbook) {
      // Refuse rather than evict — losing someone's signature silently is worse than
      // telling them the book is full.
      if (list.length >= GUESTBOOK_MAX) {
        return new Response('Guestbook is full', { status: 409 });
      }
      list.push(comment);
    } else {
      list.push(comment);
      if (list.length > MAX_COMMENTS) list.splice(0, list.length - MAX_COMMENTS);
    }

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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/pets') return handlePets(request, env, ctx);
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
