/* CloudSeed service worker.
 * It only makes the app shell (the page and its static files) load fast and open offline. It NEVER touches /api/ requests, never
 * stores anything a user owns, and never answers a request that carries data: files, downloads, shares and sign-in always go to the server. */
const VERSION = 'cs-shell-v1';
const SHELL = ['/', '/favicon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // sign-in redirects, downloads, streams, uploads: always the network

  // Hashed build files never change under the same name: serve from the cache, fill it on first use.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // Pages: always try the network first so a new version shows up at once; offline, fall back to the cached app shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.open(VERSION).then((c) => c.match('/')).then((r) => r || new Response('You are offline.', { status: 503, headers: { 'content-type': 'text/plain' } }))),
    );
  }
});
