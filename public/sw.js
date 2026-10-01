const CACHE_NAME = 'jesherhead-v{{VERSION}}';
const IMAGE_CACHE_NAME = 'jesherhead-images-v{{VERSION}}';
// Asset paths are derived from the worker's own scope (registration scope
// ends with the base: '/' in dev, '/jesherhead/' in production) instead of a
// hardcoded prefix, so the precache list works in every environment.
function scopeBase() {
  try {
    const scope = (self.registration && self.registration.scope) || '/';
    return scope.endsWith('/') ? scope : scope + '/';
  } catch (err) {
    return '/';
  }
}
function staticAssets() {
  const base = scopeBase();
  return [
    './',
    'index.html',
    'offline.html',
    'urls.html',
    'terms_of_service.txt',
    'manifest.json',
    'icon.png',
    'data/games_merged.json',
    'icons/icon-72x72.png',
    'icons/icon-96x96.png',
    'icons/icon-128x128.png',
    'icons/icon-144x144.png',
    'icons/icon-152x152.png',
    'icons/icon-192x192.png',
    'icons/icon-384x384.png',
    'icons/icon-512x512.png',
    'icons/icon-192x192-maskable.png',
    'icons/icon-512x512-maskable.png',
  ].map((p) => base + p);
}

const MAX_CACHE_ENTRIES = 500;
const MAX_IMAGE_CACHE_ENTRIES = 1000;
const CACHE_MAX_AGE = 1000 * 60 * 60 * 24 * 30;

const GAME_IMAGE_ORIGINS = [
  'iili.io',
  'cdn.jsdelivr.net'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Caching static assets');
        // Per-asset add: one 404 must not fail the whole install (the old
        // cache.addAll rejected entirely when any single asset was missing).
        return Promise.allSettled(
          staticAssets().map((url) =>
            cache.add(url).catch((err) => console.warn('[SW] Precache skipped:', url))
          )
        );
      })
      .then(() => caches.open(IMAGE_CACHE_NAME))
    // NOTE: no skipWaiting() here on purpose. The page's update toast
    // (index.html) relies on the new worker sitting in `waiting` until the
    // user clicks Update, which posts SKIP_WAITING. Auto-skipping raced the
    // toast (waiting never existed) and claimed mixed versions without reload.
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME && name !== IMAGE_CACHE_NAME)
            .map((name) => {
              console.log('[SW] Deleting old cache:', name);
              return caches.delete(name);
            })
        );
      })
      .then(() => cleanupCache(CACHE_NAME, MAX_CACHE_ENTRIES))
      .then(() => cleanupCache(IMAGE_CACHE_NAME, MAX_IMAGE_CACHE_ENTRIES))
      .then(() => self.clients.claim())
  );
});

async function cleanupCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const now = Date.now();

  const entriesWithTime = await Promise.all(
    keys.map(async (request) => {
      const response = await cache.match(request);
      // Entry may have been deleted between keys() and match().
      if (!response) return null;
      const dateHeader = response.headers.get('sw-cache-date');
      const cachedTime = dateHeader ? parseInt(dateHeader) : now;
      return { request, cachedTime };
    })
  ).then(entries => entries.filter(Boolean));

  entriesWithTime.sort((a, b) => a.cachedTime - b.cachedTime);

  const expiredEntries = entriesWithTime.filter(
    (entry) => now - entry.cachedTime > CACHE_MAX_AGE
  );

  const excessEntries = entriesWithTime.slice(0, Math.max(0, entriesWithTime.length - maxEntries));

  const toDelete = [...new Set([...expiredEntries, ...excessEntries].map(e => e.request))];

  for (const request of toDelete) {
    await cache.delete(request);
    console.log('[SW] Removed from cache:', request.url);
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') {
    return;
  }

  const isGameImage = GAME_IMAGE_ORIGINS.some(origin => url.hostname === origin || url.hostname.endsWith('.' + origin)) && 
    (url.pathname.match(/\.(jpg|jpeg|png|webp|gif|avif)(\?.*)?$/i) || url.pathname.includes('/media/'));

  if (isGameImage) {
    event.respondWith(imageCacheFirst(request));
    return;
  }

  if (url.origin !== location.origin) {
    if (url.pathname.endsWith('.html') || url.pathname === '/' || url.pathname.endsWith('/')) {
      event.respondWith(networkFirstWithOfflineFallback(request));
    }
    return;
  }

  const assets = staticAssets();
  // Mutable content must be network-first: serving index.html / the app shell
  // / games data from cache is how stale versions (and removed features)
  // kept running on returning visitors until they cleared site data.
  // Immutable icons stay cache-first below; everything else falls through to
  // network-first with offline fallback so offline mode keeps working.
  const basePath = new URL(scopeBase(), location.origin).pathname;
  const mutableSuffixes = [
    'index.html',
    'offline.html',
    'urls.html',
    'terms_of_service.txt',
    'manifest.json',
    'data/games_merged.json',
  ];
  const isMutable =
    url.pathname === basePath ||
    mutableSuffixes.some((suffix) => url.pathname.endsWith('/' + suffix) || url.pathname === basePath + suffix);
  if (isMutable || request.destination === 'document') {
    event.respondWith(networkFirstWithOfflineFallback(request));
    return;
  }

  if (assets.some(asset => url.pathname === new URL(asset, location.origin).pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(networkFirstWithOfflineFallback(request));
});

async function imageCacheFirst(request) {
  const cache = await caches.open(IMAGE_CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response.ok && (response.type === 'basic' || response.type === 'cors')) {
      const responseToCache = new Response(response.clone().body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers)
      });
      responseToCache.headers.set('sw-cache-date', Date.now().toString());
      // Await the put so worker shutdown can't silently drop the write.
      await cache.put(request, responseToCache).catch(() => {});
    }
    return response;
  } catch (error) {
    return new Response('', { status: 503, statusText: 'Service Unavailable' });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response.ok) {
      const responseToCache = new Response(response.clone().body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers)
      });
      responseToCache.headers.set('sw-cache-date', Date.now().toString());
      await cache.put(request, responseToCache).catch(() => {});
    }
    return response;
  } catch (error) {
    const offline = await cache.match(new URL('offline.html', scopeBase()).href).catch(() => null);
    if (offline) return offline;
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

async function networkFirstWithOfflineFallback(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) {
      const responseToCache = new Response(response.clone().body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers)
      });
      responseToCache.headers.set('sw-cache-date', Date.now().toString());
      await cache.put(request, responseToCache).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    // Cross-origin document fallback: serve the cached offline shell instead
    // of a blank plain-text body.
    const offline = await cache.match(new URL('offline.html', scopeBase()).href).catch(() => null);
    if (offline) return offline;
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data === 'skipWaiting' || (data && data.type === 'SKIP_WAITING')) {
    self.skipWaiting();
  }
  if (data === 'getVersion' || (data && data.type === 'getVersion')) {
    // Guard: messages without a MessagePort (e.g. plain postMessage from the
    // offline page's "Check for Updates" button) used to throw on ports[0].
    const port = event.ports && event.ports[0];
    if (port) {
      port.postMessage({ version: CACHE_NAME });
    }
  }
});