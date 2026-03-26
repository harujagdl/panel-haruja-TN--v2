const RELEASE_TAG = '2026-03-26-b3';
const CACHE_PREFIX = 'tarjeta-lealtad-shell';
const CACHE_NAME = `${CACHE_PREFIX}-${RELEASE_TAG}`;
const APP_SHELL_ASSETS = [
  '/tarjeta-lealtad.html',
  '/tarjeta-lealtad.html?pwa=1',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/app/assets/haruja-logo.png',
  '/shared/loyaltyService.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => {
          console.log('[SW tarjeta] deleting old cache', key);
          return caches.delete(key);
        })
    );
    await self.clients.claim();
    console.log('[SW tarjeta] version active', RELEASE_TAG);
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(request.url);
  const isSameOrigin = requestUrl.origin === self.location.origin;
  const isApiRequest = requestUrl.pathname.startsWith('/api/');
  const isNavigationRequest = request.mode === 'navigate';
  const isLoyaltyPage = requestUrl.pathname === '/tarjeta-lealtad.html';

  if (!isSameOrigin || isApiRequest) {
    event.respondWith(fetch(request));
    return;
  }

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

  const isStaticAsset = /\.(?:js|css|png|jpg|jpeg|svg|webp|ico|woff2?|ttf|json)$/i.test(requestUrl.pathname);
  if (!isStaticAsset) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(request).then((response) => {
        if (response.ok && isSameOrigin) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
