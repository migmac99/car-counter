/* Service worker: precache the app shell, runtime-cache the ML vendor files,
   and keep /api traffic network-first so stats stay fresh but survive offline. */

const VERSION = 'car-counter-v1';
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

  // Stats/config reads: network-first with cache fallback so the dashboard
  // still renders (with last-known data) when the server is unreachable.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(event.request, copy));
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
          return (
            cached ??
            new Response(JSON.stringify({ error: 'offline' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            })
          );
        })
    );
    return;
  }

  // Static assets (shell + vendored model): cache-first, fill the runtime
  // cache on first fetch so the multi-MB model downloads only once.
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
});
