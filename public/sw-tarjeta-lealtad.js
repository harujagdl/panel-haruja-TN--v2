const RELEASE_TAG = '2026-05-02-b3.3';
const CACHE_PREFIX = 'tarjeta-lealtad-shell';
const CACHE_NAME = `${CACHE_PREFIX}-${RELEASE_TAG}`;
const SW_LABEL = '[SW tarjeta]';
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
const STATIC_CACHE_PATTERNS = [
  /^\/icons\//,
  /^\/app\/assets\//,
  /^\/shared\/loyaltyService\.js$/,
  /^\/manifest\.webmanifest$/,
  /^\/favicon\.svg$/,
  /^\/apple-touch-icon\.png$/
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL_ASSETS);
    self.skipWaiting();
    console.log(`${SW_LABEL} version installed`, RELEASE_TAG);
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => {
          console.log(`${SW_LABEL} deleting old cache`, key);
          return caches.delete(key);
        })
    );
    await self.clients.claim();
    console.log(`${SW_LABEL} version active`, RELEASE_TAG);
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
  const isLoyaltyPage = requestUrl.pathname === '/tarjeta-lealtad.html' || requestUrl.pathname === '/tarjeta-lealtad';
  const isPanelNavigation = isNavigationRequest && (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html');

  if (!isSameOrigin || isApiRequest) {
    return;
  }

  if (isPanelNavigation) return;

  if (isNavigationRequest && isLoyaltyPage) {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('/tarjeta-lealtad.html', copy));
          }
          return response;
        })
        .catch(async () => (await caches.match('/tarjeta-lealtad.html')) || Response.error())
    );
    return;
  }

  if (isNavigationRequest) {
    event.respondWith(fetch(request).catch(() => Response.error()));
    return;
  }

  const isStaticAsset = STATIC_CACHE_PATTERNS.some((pattern) => pattern.test(requestUrl.pathname));
  if (!isStaticAsset) {
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    const networkFetch = fetch(request)
      .then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => cached || fetch(request).catch(() => Response.error()));

    return cached || networkFetch || Response.error();
  })());
});
