/* Service worker strategy:
   - app shell + /api: network-first, cached fallback → always fresh online,
     still works offline
   - /vendor/ (ML runtime + model, ~16 MB): cache-first → downloaded once */

const VERSION = 'car-counter-v4';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/main.js',
  '/js/camera.js',
  '/js/detector.js',
  '/js/tracker.js',
  '/js/counter.js',
  '/js/geometry.js',
  '/js/overlay.js',
  '/js/zones.js',
  '/js/charts.js',
  '/js/stats-ui.js',
  '/js/api.js',
  '/js/speed.js',
  '/js/yolox.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;

  // Vendored ML runtime + model: effectively immutable, cache-first.
  if (url.pathname.startsWith('/vendor/')) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ??
          fetch(event.request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(RUNTIME_CACHE).then((cache) => cache.put(event.request, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  // Everything else (app shell and /api reads): network-first so updates and
  // fresh stats always win online; fall back to cache when offline. Preview
  // frames are ephemeral — never cache them.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && !url.pathname.startsWith('/api/preview')) {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (url.pathname.startsWith('/api/')) {
          return new Response(JSON.stringify({ error: 'offline' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return Response.error();
      })
  );
});
