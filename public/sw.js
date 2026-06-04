// Service worker for wrangell.dog — makes the site installable and usable offline.
// Strategy:
//   - /api/*        → never touched (network only; the pet counter must stay live)
//   - /images/*     → cache-first (photos are immutable; serve instantly, cache on first view)
//   - everything    → network-first, falling back to cache (fresh HTML when online, works offline)
// Bump CACHE when the app shell changes to evict the old cache on activate.
//
// Note: Cloudflare assets serve pages at clean URLs (/gallery), and 307-redirect the
// .html form (/gallery.html → /gallery). We precache the clean URLs because Cache.put()
// rejects redirected responses, and normalize trailing ".html" on offline navigations.

const CACHE = 'wrangell-v1';

const APP_SHELL = [
  '/',
  '/gallery',
  '/classic',
  '/captions.js',
  '/manifest.webmanifest',
  '/favicon.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // let cross-origin (fonts) pass through
  if (url.pathname.startsWith('/api/')) return;     // never cache the pet counter

  // Photos never change — cache-first.
  if (url.pathname.startsWith('/images/')) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      })
    );
    return;
  }

  // App shell & docs — network-first so updates show, cache as offline fallback.
  event.respondWith(
    fetch(request)
      .then((res) => {
        // Don't cache redirects (Cache.put rejects them) or errors.
        if (res.ok && !res.redirected) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(request);
        if (hit) return hit;
        // Offline navigation to a .html link → fall back to its clean URL, then home.
        if (request.mode === 'navigate') {
          const clean = url.pathname.replace(/\.html$/, '') || '/';
          const alt = await caches.match(clean);
          if (alt) return alt;
          return caches.match('/');
        }
        return Response.error();
      })
  );
});
