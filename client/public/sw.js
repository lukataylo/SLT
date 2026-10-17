// App-shell service worker: the UI opens instantly and offline; live data
// (WebSocket) and splat files always come from the network.
const CACHE = 'slt-v1';
const SHELL = ['./', './manifest.webmanifest', './icons/icon-192.png', './maps/default.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) (await caches.open(CACHE)).put(request, res.clone());
  return res;
}

async function networkFirst(request, fallback) {
  try {
    const res = await fetch(request);
    if (res.ok) (await caches.open(CACHE)).put(fallback ?? request, res.clone());
    return res;
  } catch {
    return (await caches.match(fallback ?? request)) ?? Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin && (url.pathname.startsWith('/ws') || url.pathname.startsWith('/splats/'))) return;

  if (request.mode === 'navigate') return event.respondWith(networkFirst(request, './'));
  // Hashed build assets and font files never change under the same URL.
  if ((sameOrigin && url.pathname.startsWith('/assets/')) || url.hostname === 'fonts.gstatic.com') {
    return event.respondWith(cacheFirst(request));
  }
  if (sameOrigin || url.hostname === 'fonts.googleapis.com') event.respondWith(networkFirst(request));
});
