const CACHE = 'bolao-v12';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './firebase-config.js',
  './Bolao1.png',
  './manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  if (!['http:', 'https:'].includes(url.protocol)) return;

  const alwaysNetwork = [
    'firebasedatabase.app',
    'googleapis.com',
    'football-proxy',
    'firebaseio.com',
    'identitytoolkit',
    'jsdelivr.net',
    'cdn.jsdelivr.net'
  ];

  if (alwaysNetwork.some(d => url.hostname.includes(d) || url.href.includes(d))) return;

  if (url.origin === self.location.origin && url.pathname.endsWith('/app.js')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            caches.open(CACHE).then(cache => cache.put(e.request, res.clone()));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;

      return fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET' && url.origin === self.location.origin) {
          caches.open(CACHE).then(cache => cache.put(e.request, res.clone()));
        }
        return res;
      }).catch(() => {
        if (e.request.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 404, statusText: 'Not Found' });
      });
    })
  );
});
