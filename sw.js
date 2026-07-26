const CACHE = 'bolao-v24-sw-clone-fix';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './hotfix-rodadas.js',
  './enhancements.js',
  './enhancements.css',
  './fundo-estrelas.png',
  './firebase-config.js',
  './Bolao1.png',
  './manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  if (!['http:', 'https:'].includes(url.protocol)) return;
  if (request.method !== 'GET') return;

  const alwaysNetwork = [
    'firebasedatabase.app',
    'googleapis.com',
    'football-proxy',
    'firebaseio.com',
    'identitytoolkit',
    'jsdelivr.net',
    'cdn.jsdelivr.net'
  ];

  // Firebase, autenticação e APIs seguem diretamente para a rede.
  if (alwaysNetwork.some(domain =>
    url.hostname.includes(domain) || url.href.includes(domain)
  )) {
    return;
  }

  const logicFiles = [
    '/app.js',
    '/firebase-config.js',
    '/hotfix-rodadas.js',
    '/sw.js'
  ];

  // Arquivos de lógica: rede primeiro, cache como fallback.
  if (
    url.origin === self.location.origin &&
    logicFiles.some(path => url.pathname.endsWith(path))
  ) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);

        if (response.ok) {
          // A cópia precisa ser criada antes de o corpo da resposta ser consumido.
          const responseForCache = response.clone();
          const cache = await caches.open(CACHE);
          await cache.put(request, responseForCache);
        }

        return response;
      } catch (error) {
        const cached = await caches.match(request);
        if (cached) return cached;

        return new Response('', {
          status: 503,
          statusText: 'Offline'
        });
      }
    })());

    return;
  }

  // Demais arquivos: cache primeiro, rede como fallback.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;

    try {
      const response = await fetch(request);

      if (
        response.ok &&
        url.origin === self.location.origin
      ) {
        // Clona imediatamente, antes de devolver a resposta ao navegador.
        const responseForCache = response.clone();
        const cache = await caches.open(CACHE);
        await cache.put(request, responseForCache);
      }

      return response;
    } catch (error) {
      if (request.mode === 'navigate') {
        const fallback = await caches.match('./index.html');
        if (fallback) return fallback;
      }

      return new Response('', {
        status: 404,
        statusText: 'Not Found'
      });
    }
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
