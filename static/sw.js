const CACHE = "presence-v10";
const PRECACHE = [
  "/",
  "/static/index.html",
  "/static/styles.css",
  "/static/app.js",
  "/static/app_plus.js",
  "/static/graph3d.js",
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

  // ---- PWA Share Target ----
  // When another app shares content to "presence", the browser POSTs to /share.
  // We extract the files/text, stash them in the SW cache, then redirect to the app.
  if (url.pathname === "/share" && e.request.method === "POST") {
    e.respondWith((async () => {
      try {
        const formData = await e.request.formData();
        const sharedFiles = formData.getAll("files");
        const sharedText = formData.get("text") || formData.get("title") || "";
        // Store shared items in a dedicated cache for the frontend to pick up
        const shareCache = await caches.open("presence-shared");
        // We can't store File objects in Cache API directly, so we use a
        // simpler approach: store the text and file metadata, let SW post them
        // to the backend on the next page load.
        const manifest = {
          text: sharedText,
          files: [],
          timestamp: Date.now(),
        };
        // Store each file as a separate cache entry
        for (let i = 0; i < sharedFiles.length; i++) {
          const file = sharedFiles[i];
          const response = new Response(file, {
            headers: { "Content-Type": file.type || "application/octet-stream" }
          });
          await shareCache.put("/__shared_file_" + i, response);
          manifest.files.push({
            name: file.name || ("shared_" + i),
            type: file.type || "application/octet-stream",
            cacheKey: "/__shared_file_" + i,
          });
        }
        await shareCache.put("/__shared_manifest", new Response(
          JSON.stringify(manifest), { headers: { "Content-Type": "application/json" } }
        ));
      } catch (err) {
        console.warn("[SW] share target failed:", err);
      }
      return Response.redirect("/?shared=1", 303);
    })());
    return;
  }

  // JS/CSS: network first (so code updates take effect immediately)
  if (url.pathname.match(/\.(js|css)$/)) {
    e.respondWith(
      fetch(e.request).then((r) => {
        caches.open(CACHE).then((c) => c.put(e.request, r.clone()));
        return r;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  // Other static: cache first, network fallback
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).then((r) => {
      const cc = caches.open(CACHE);
      cc.then((c) => c.put(e.request, r.clone()));
      return r;
    }))
  );
});
