const CACHE_NAME = "matchday-foundation-v3";
const PUBLIC_DOCUMENT_PATHS = new Set(["/", "/competitions/singapore-open"]);
const OFFLINE_DOCUMENT = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>MATCHDAY is offline</title>
  </head>
  <body>
    <main>
      <h1>MATCHDAY is offline</h1>
      <p>Reconnect, then refresh this page to continue.</p>
    </main>
  </body>
</html>`;

function isPublicCacheable(response) {
  const policy = response.headers.get("cache-control")?.toLowerCase() ?? "";
  return response.ok && policy.includes("public") && !policy.includes("private") && !policy.includes("no-store");
}

function isImmutableBuildAsset(url, destination) {
  return (
    url.origin === self.location.origin &&
    ["style", "script", "font"].includes(destination) &&
    url.pathname.startsWith("/_next/static/")
  );
}

function offlineResponse() {
  return new Response(OFFLINE_DOCUMENT, {
    status: 503,
    statusText: "Service Unavailable",
    headers: {
      "Cache-Control": "no-store, private",
      "Content-Language": "en",
      "Content-Type": "text/html; charset=utf-8",
      "Retry-After": "30",
    },
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(Promise.resolve());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (
    request.method !== "GET" ||
    (request.destination === "document" && new URL(request.url).origin !== self.location.origin)
  ) {
    return;
  }

  if (request.destination === "document") {
    const url = new URL(request.url);
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (PUBLIC_DOCUMENT_PATHS.has(url.pathname) && isPublicCacheable(response)) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => {
          if (PUBLIC_DOCUMENT_PATHS.has(url.pathname)) {
            const cached = await caches.match(request);
            if (cached) return cached;
          }
          return offlineResponse();
        }),
    );
    return;
  }

  const url = new URL(request.url);
  if (isImmutableBuildAsset(url, request.destination)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request).then((response) => {
          if (isPublicCacheable(response)) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        });
        return cached || network;
      }),
    );
  }
});
