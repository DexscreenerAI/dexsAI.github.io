// ByeBoss service worker — network-first, conservative.
// Rationale: this is a live trading view, so staleness is harmful. We always
// hit the network first; the cache is only an offline fallback. Cross-origin
// requests (Railway API, Supabase, DexScreener) and non-GET requests pass
// through untouched so live data and control calls are never intercepted.
const CACHE = 'byeboss-v1';
const SHELL = ['/sniper_terminal.html', '/theme.css'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // never touch POST/PUT (control calls)
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // never touch cross-origin APIs

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/sniper_terminal.html')))
  );
});
