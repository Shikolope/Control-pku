const CACHE_NAME = 'pku-control-v1';
const assets = [
  'app.html',
  'manifest.json'
];

// Instalar el Service Worker y guardar archivos esenciales en la memoria del fono
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(assets);
    })
  );
});

// Hacer que la app funcione sin internet (Offline)
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(response => {
      return response || fetch(e.request);
    })
  );
});