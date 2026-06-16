// Service Worker - Mi Control PKU
// Estrategia: Network First (siempre intenta traer la versión más reciente del servidor;
// solo usa el caché como respaldo si no hay conexión a internet).
// Esto evita que la app quede "atascada" mostrando una versión vieja después de actualizar.

const CACHE_NAME = 'pku-control-cache-v3'; // subir este número cada vez que se publique una actualización importante
const URLS_A_CACHEAR = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png'
];

// Instalación: precachear el shell básico de la app
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(URLS_A_CACHEAR))
  );
  self.skipWaiting(); // activa el nuevo SW inmediatamente, sin esperar a que se cierren todas las pestañas
});

// Activación: borrar cachés antiguos de versiones anteriores
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim(); // toma control de todas las pestañas abiertas inmediatamente
});

// Fetch: Network First con respaldo a caché
self.addEventListener('fetch', (event) => {
  // Solo manejar peticiones GET (evita interferir con llamadas a APIs externas tipo POST/PATCH de Drive)
  if (event.request.method !== 'GET') return;

  // No interceptar llamadas a APIs externas (Google Drive, Open Food Facts, etc.)
  // Solo gestionamos el caché de los archivos propios de la app.
  const url = new URL(event.request.url);
  const esRecursoPropio = url.origin === self.location.origin;
  if (!esRecursoPropio) return;

  event.respondWith(
    fetch(event.request)
      .then((respuestaRed) => {
        // Si la red responde bien, actualizamos el caché con la versión fresca
        if (respuestaRed && respuestaRed.status === 200) {
          const respuestaClonada = respuestaRed.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, respuestaClonada));
        }
        return respuestaRed;
      })
      .catch(() => {
        // Sin conexión: usar lo que haya en caché como respaldo
        return caches.match(event.request);
      })
  );
});

// Permite que la app fuerce la actualización del Service Worker desde el cliente
// (por ejemplo, llamando a navigator.serviceWorker.controller.postMessage({type: 'SKIP_WAITING'}))
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
