const CACHE = 'home-library-v2';
const BASE  = self.location.href.replace('sw.js', '');

// These always fetch fresh from network (fall back to cache offline)
const NETWORK_FIRST = ['', 'index.html', 'app.js', 'style.css']
  .map(f => BASE + f);

// These are stable — serve from cache, update in background
const CACHE_ONLY = ['manifest.json', 'icon.svg', 'html5-qrcode.min.js']
  .map(f => BASE + f);

const ALL_ASSETS = [...NETWORK_FIRST, ...CACHE_ONLY];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ALL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(clients => clients.forEach(c => c.postMessage({ type: 'SW_UPDATED' })))
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // External services: network only, no caching
  if (url.includes('googleapis.com') || url.includes('gstatic.com') || url.includes('openlibrary.org') || url.includes('firestore')) {
    e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // Core app files: network-first so updates are always picked up automatically
  if (NETWORK_FIRST.some(u => url === u || url === u.replace(/\/$/, ''))) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Everything else: cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
