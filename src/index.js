const KEY = 'count';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/pets') {
      if (request.method === 'GET') {
        const count = parseInt((await env.PETS.get(KEY)) || '0', 10);
        return Response.json({ count });
      }
      if (request.method === 'POST') {
        const current = parseInt((await env.PETS.get(KEY)) || '0', 10);
        const next = current + 1;
        await env.PETS.put(KEY, String(next));
        return Response.json({ count: next });
      }
      return new Response('Method not allowed', { status: 405 });
    }

    return env.ASSETS.fetch(request);
  },
};
