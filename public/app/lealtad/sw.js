const RELEASE_TAG = '2026-03-26-b3';
const CACHE_PREFIX = 'haruja-lealtad';
const CACHE_NAME = `${CACHE_PREFIX}-${RELEASE_TAG}`;

const APP_SHELL = [
  '/lealtad',
  '/lealtad/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

function isHtmlRequest(request) {
  return request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => {
          console.log('[SW lealtad] deleting old cache', key);
          return caches.delete(key);
        })
    );
    await self.clients.claim();
    console.log('[SW lealtad] version active', RELEASE_TAG);
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isApiRequest = url.pathname.startsWith('/api/');

  if (!isSameOrigin || isApiRequest) {
    event.respondWith(fetch(request));
    return;
  }

  if (isHtmlRequest(request)) {
    event.respondWith((async () => {
      try {
        const networkResponse = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, networkResponse.clone());
        return networkResponse;
      } catch {
        return (await caches.match(request)) || (await caches.match('/lealtad')) || Response.error();
      }
    })());
    return;
  }

  const isStaticAsset = /\.(?:js|css|png|jpg|jpeg|svg|webp|ico|woff2?|ttf|json)$/i.test(url.pathname);
  if (!isStaticAsset) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    const networkFetch = fetch(request)
      .then(async (response) => {
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, response.clone());
        }
        return response;
      })
      .catch(() => cached);

    return cached || networkFetch;
  })());
});
