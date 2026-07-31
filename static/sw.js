const CACHE = "presence-v3";
const PRECACHE = [
  "/",
  "/static/index.html",
  "/static/styles.css",
  "/static/app.js",
  "/static/app_plus.js",
  "/static/manifest.json",
  "/static/assets/icon-192.png",
  "/static/assets/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Only cache same-origin requests
  if (url.origin !== location.origin) return;
  // API calls: network first, fallback to cache
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }
  // Navigations: network first, fall back to the cached app shell
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request).catch(() => caches.match("/"))
    );
    return;
  }
  // Static: cache first, network fallback
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).then((r) => {
      const cc = caches.open(CACHE);
      cc.then((c) => c.put(e.request, r.clone()));
      return r;
    }))
  );
});
