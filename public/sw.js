/* ==========================================================================
   Smart Home Dashboard — Offline-First Kiosk Service Worker
   Caches the Kiosk shell, CDN assets, and the latest /api/dashboard snapshot
   so a wall-mounted tablet stays functional during Wi-Fi / ISP outages.
   ========================================================================== */

const CACHE_NAME = 'smart-home-kiosk-shell-v2';
const SHELL_CACHE = CACHE_NAME;
const DATA_CACHE = 'smart-home-kiosk-data-v2';

const CORE_SHELL_URLS = [
  '/',
  '/index.html',
  '/js/kiosk-enhancements.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(CORE_SHELL_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== DATA_CACHE)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Network-first with offline fallback for /api/dashboard
  if (url.pathname === '/api/dashboard') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(DATA_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Skip other API or Socket.IO polling routes
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) {
    return;
  }

  // Stale-while-revalidate for CDN scripts, fonts, photos, and Kiosk shell
  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && (response.ok || response.type === 'opaque')) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});
