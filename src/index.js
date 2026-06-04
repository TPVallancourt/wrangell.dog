const KEY = 'count';       // global running total (all plates)
const PLATES_KEY = 'plates'; // JSON map of { "<plate>": <count> }
const MAX_PLATE = 200;       // sanity bound on plate numbers

async function readPlates(env) {
  try {
    return JSON.parse((await env.PETS.get(PLATES_KEY)) || '{}') || {};
  } catch {
    return {};
  }
}

// Accepts a plate from a request body; returns an integer in [1, MAX_PLATE] or null.
async function plateFromBody(request) {
  try {
    const body = await request.json();
    const n = Number(body && body.plate);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_PLATE) return n;
  } catch {}
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/pets') {
      if (request.method === 'GET') {
        const count = parseInt((await env.PETS.get(KEY)) || '0', 10);
        const plates = await readPlates(env);
        return Response.json({ count, plates });
      }
      if (request.method === 'POST') {
        const plate = await plateFromBody(request);
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

    return env.ASSETS.fetch(request);
  },
};
