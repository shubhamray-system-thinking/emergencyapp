// Emergency — service worker. Precache the app shell so the app runs fully
// offline. Bump CACHE_VERSION whenever a shell file changes.

var CACHE_VERSION = 'emergency-shell-v10';

var APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './db.js',
  './security.js',
  './auth.js',
  './app.js',
  './family.js',
  './contacts.js',
  './insurer.js',
  './hospitals.js',
  './backup.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

// Install: precache the shell, then activate immediately.
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(APP_SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

// Activate: drop old caches and take control of open pages.
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) {
          return key !== CACHE_VERSION;
        }).map(function (key) {
          return caches.delete(key);
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// Fetch: NETWORK-FIRST for same-origin GET requests. When online we always
// fetch the latest file and refresh the cache — so app updates land on the
// next load and can never get stuck on a stale cached shell. When the network
// is unavailable we fall back to the cache (and to index.html for navigations),
// which is what makes the app work fully offline.
self.addEventListener('fetch', function (event) {
  var request = event.request;

  if (request.method !== 'GET') return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request).then(function (response) {
      // Cache successful basic responses so they're available offline.
      if (response && response.status === 200 && response.type === 'basic') {
        var copy = response.clone();
        caches.open(CACHE_VERSION).then(function (cache) {
          cache.put(request, copy);
        });
      }
      return response;
    }).catch(function () {
      // Offline: serve from cache; fall back to the app shell for navigations.
      return caches.match(request).then(function (cached) {
        if (cached) return cached;
        if (request.mode === 'navigate') return caches.match('./index.html');
        return undefined;
      });
    })
  );
});
