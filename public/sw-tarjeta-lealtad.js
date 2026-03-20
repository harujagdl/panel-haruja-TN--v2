const CACHE_NAME = 'tarjeta-lealtad-shell-v1';
const APP_SHELL_ASSETS = [
  '/tarjeta-lealtad.html',
  '/tarjeta-lealtad.html?pwa=1',
  '/manifest-tarjeta-lealtad.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/app/assets/haruja-logo.png',
  '/shared/loyaltyService.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(request.url);
  const isNavigationRequest = request.mode === 'navigate';
  const isLoyaltyPage = requestUrl.pathname === '/tarjeta-lealtad.html';

  if (isNavigationRequest && isLoyaltyPage) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/tarjeta-lealtad.html', copy));
          return response;
        })
        .catch(async () => (await caches.match('/tarjeta-lealtad.html')) || Response.error())
    );
    return;
  }

  if (isNavigationRequest) {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match('/tarjeta-lealtad.html')) || Response.error())
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(request).then((response) => {
        const isSameOrigin = requestUrl.origin === self.location.origin;
        if (response.ok && isSameOrigin) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
