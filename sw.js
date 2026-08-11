/* Pick 'Em — service worker.
   Bump VERSION whenever you change index.html so installed apps update. */
const VERSION = 'v1.0.0';
const SHELL   = 'pickem-shell-'   + VERSION;
const RUNTIME = 'pickem-runtime-' + VERSION;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // add individually so one 404 can't fail the whole install
    await Promise.all(ASSETS.map(u => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SHELL && k !== RUNTIME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // page loads: network first, fall back to the cached shell when offline
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        (await caches.open(SHELL)).put('./index.html', fresh.clone());
        return fresh;
      } catch (err) {
        return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }

  // our own files: cache first
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const fresh = await fetch(req);
        if (fresh.ok) (await caches.open(SHELL)).put(req, fresh.clone());
        return fresh;
      } catch (err) {
        return hit || Response.error();
      }
    })());
    return;
  }

  // Google Fonts and anything else: serve cached, refresh in the background.
  // If it never arrives, the page falls back to system fonts on its own.
  e.respondWith((async () => {
    const cache = await caches.open(RUNTIME);
    const hit = await cache.match(req);
    const net = fetch(req).then(res => { cache.put(req, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || Response.error();
  })());
});
