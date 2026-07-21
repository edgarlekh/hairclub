const CACHE_NAME = "hairclub-admin-v1";
const ASSETS = ["/", "/index.html", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener("fetch", (event) => {
  // API-запросы всегда идут в сеть (не кэшируем живые данные)
  if (event.request.url.includes("/api/")) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
