// Service Worker - Mi Control PKU
// Estrategia: Network First (siempre intenta traer la versión más reciente del servidor;
// solo usa el caché como respaldo si no hay conexión a internet).
// Esto evita que la app quede "atascada" mostrando una versión vieja después de actualizar.

const CACHE_NAME = 'pku-control-cache-v4'; // subir este número cada vez que se publique una actualización importante

// NOTA: NO llamar self.skipWaiting() en install.
// El nuevo SW queda en estado "waiting" hasta que el usuario confirme
// la actualización tocando el banner "🆕 Hay una nueva versión disponible".
// Así el usuario nunca pierde datos que esté escribiendo en ese momento.

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
  // NO llamar self.skipWaiting() aquí — el SW queda en "waiting"
  // y el banner del index.html lo detectará para avisar al usuario.
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

  // No interceptar llamadas a APIs externas (Google Drive, Open Food Facts, Firebase, etc.)
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

// El index.html llama postMessage({type: 'SKIP_WAITING'}) cuando el usuario
// toca el botón "Actualizar ahora" del banner de nueva versión.
// Recién ahí el nuevo SW toma control y la página se recarga.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
