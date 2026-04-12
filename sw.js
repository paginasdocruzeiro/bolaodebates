const CACHE_VERSION = 'bolao-v4';
const CACHE_EXTERNAL = 'bolao-external-v1';

const EXTERNAL_ASSETS = [
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'
];

function isCacheable(url) {
  return url.startsWith('http://') || url.startsWith('https://');
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_EXTERNAL)
      .then(cache => cache.addAll(EXTERNAL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_VERSION && k !== CACHE_EXTERNAL)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Ignorar tudo que não seja http/https
  if (!isCacheable(url)) return;

  const parsedUrl = new URL(url);

  // Nunca interceptar Firebase, APIs, Workers
  const bypassDomains = [
    'firebasedatabase.app',
    'firebaseio.com',
    'firebaseapp.com',
    'googleapis.com',
    'identitytoolkit',
    'football-proxy',
    'workers.dev'
  ];
  if (bypassDomains.some(d => url.includes(d))) return;

  // Ficheiros do próprio site → network-first
  const isOwnFile = parsedUrl.origin === self.location.origin;

  if (isOwnFile && e.request.method === 'GET') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then(cache => cache.put(e.request, clone));
          }
          return res;
        })
        .catch(() => {
          return caches.match(e.request).then(cached => {
            if (cached) return cached;
            // Fallback para navegação
            if (e.request.mode === 'navigate') return caches.match('./index.html');
            // Para imagens/assets em falta — retorna resposta vazia válida
            return new Response('', { status: 404, statusText: 'Not Found' });
          });
        })
    );
    return;
  }

  // Bibliotecas externas → cache-first
  if (e.request.method === 'GET') {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request)
          .then(res => {
            if (res.ok) {
              const clone = res.clone();
              caches.open(CACHE_EXTERNAL).then(cache => cache.put(e.request, clone));
            }
            return res;
          })
          .catch(() => new Response('', { status: 404, statusText: 'Not Found' }));
      })
    );
  }
});
