/* Pick 'Em — service worker.
   Bump VERSION whenever you change index.html so installed apps update. */
const VERSION = 'v1.4.0';
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
  './icons/favicon-32.png',
  './data/results.json',
  ...['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC',
      'LAC','LAR','LV','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS']
      .map(t => `./logos/${t}.png`)
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

  // live results: always try the network, fall back to the last copy offline
  if (url.origin === location.origin && url.pathname.endsWith('/data/results.json')) {
    e.respondWith((async () => {
      const cache = await caches.open(RUNTIME);
      try {
        const fresh = await fetch(req, { cache: 'no-store' });
        if (fresh.ok) cache.put(req.url.split('?')[0], fresh.clone());
        return fresh;
      } catch (err) {
        return (await cache.match(req.url.split('?')[0])) || (await caches.match('./data/results.json')) || Response.error();
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

  // Google Fonts: serve cached, refresh in the background.
  // If it never arrives, the page falls back to system fonts on its own.
  // Anything else cross-origin (ads, analytics) goes straight to the network.
  if (!/^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) return;
  e.respondWith((async () => {
    const cache = await caches.open(RUNTIME);
    const hit = await cache.match(req);
    const net = fetch(req).then(res => { cache.put(req, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || Response.error();
  })());
});
