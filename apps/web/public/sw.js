const FOUNDATION_CACHE_NAME = "matchday-foundation-v3";
const SCORING_CACHE_PREFIX = "matchday-scoring-shell-";
const SCORING_CACHE_NAME = `${SCORING_CACHE_PREFIX}v4`;
const SCORING_SHELL_PATH = "/score";
const SCORING_SHELL_MARKER = 'data-offline-scoring-shell="v1"';
const WORKER_VERSION = "gate-c-c3-v4";
const UPDATE_PROTOCOL_VERSION = 1;
const CLIENT_SAFETY_TIMEOUT_MS = 5_000;
const PUBLIC_DOCUMENT_PATHS = new Set(["/", "/competitions/singapore-open"]);
const pendingActivationChecks = new Map();
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

async function verifiedScoringShellResponse(response) {
  if (!response.ok || response.headers.has("set-cookie")) return null;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/html")) return null;
  const document = await response.text();
  if (!document.includes(SCORING_SHELL_MARKER)) return null;
  if (
    /#access=|__Secure-matchday-offline-grant|__Secure-matchday-scoring|x-scoring-session-token|authorization\s*[:=]/iu.test(
      document,
    )
  ) {
    return null;
  }
  return new Response(document, {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Language": response.headers.get("content-language") ?? "en",
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Matchday-Offline-Shell": "v1",
    },
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(Promise.resolve());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(SCORING_CACHE_PREFIX) && key !== SCORING_CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function sendActivationResult(client, requestId, status, unsafeClientCount = 0) {
  client?.postMessage({
    type: "MATCHDAY_SCORING_WORKER_ACTIVATION_RESULT",
    requestId,
    status,
    unsafeClientCount,
    version: WORKER_VERSION,
    protocolVersion: UPDATE_PROTOCOL_VERSION,
  });
}

function finishActivationCheck(requestId, status) {
  const check = pendingActivationChecks.get(requestId);
  if (!check) return;
  clearTimeout(check.timeout);
  pendingActivationChecks.delete(requestId);
  const unsafeClientCount = [...check.responses.values()].filter((response) => response.safe !== true).length;
  const notifyClients = (resultStatus) => {
    for (const client of check.clients.values()) {
      sendActivationResult(client, requestId, resultStatus, unsafeClientCount);
    }
    if (!check.clients.has(check.requester?.id)) {
      sendActivationResult(check.requester, requestId, resultStatus, unsafeClientCount);
    }
  };

  if (status !== "ready") {
    notifyClients(status);
    return;
  }

  const waiting = self.registration.waiting;
  if (!waiting) {
    notifyClients("no-update");
    return;
  }
  waiting.postMessage({
    type: "MATCHDAY_SCORING_WORKER_ACTIVATION_APPROVED",
    requestId,
    checkedClientIds: [...check.expectedClientIds],
    protocolVersion: UPDATE_PROTOCOL_VERSION,
  });
  notifyClients("committing");
}

function sameClientSet(left, right) {
  return left.size === right.size && [...left].every((clientId) => right.has(clientId));
}

function requestClientSafetyRound(check, clients) {
  for (const client of clients) {
    client.postMessage({
      type: "MATCHDAY_SCORING_WORKER_SAFE_STATE_QUERY",
      requestId: check.requestId,
      protocolVersion: UPDATE_PROTOCOL_VERSION,
      round: check.round,
      expectedEpoch: check.expectedEpochs.get(client.id) ?? null,
    });
  }
}

async function evaluateActivationRound(requestId) {
  const check = pendingActivationChecks.get(requestId);
  if (!check || check.evaluating || check.responses.size !== check.expectedClientIds.size) return;
  check.evaluating = true;
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (!pendingActivationChecks.has(requestId)) return;
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: false });
  const currentClientIds = new Set(clients.map((client) => client.id));
  if (!sameClientSet(check.expectedClientIds, currentClientIds)) {
    check.expectedClientIds = currentClientIds;
    check.clients = new Map(clients.map((client) => [client.id, client]));
    check.expectedEpochs.clear();
    check.responses.clear();
    check.round = 1;
    check.evaluating = false;
    if (clients.length === 0) finishActivationCheck(requestId, "blocked");
    else requestClientSafetyRound(check, clients);
    return;
  }

  const everyClientSafe = [...check.responses.values()].every(
    (response) =>
      response.safe === true &&
      response.activeScoring === false &&
      response.transitionInFlight === false &&
      response.unresolvedQueue === false &&
      (check.round === 1 || (response.stable === true && response.frozen === true)),
  );
  if (!everyClientSafe) {
    finishActivationCheck(requestId, "blocked");
    return;
  }
  if (check.round === 1) {
    check.expectedEpochs = new Map(
      [...check.responses.entries()].map(([clientId, response]) => [clientId, response.epoch]),
    );
    check.responses.clear();
    check.round = 2;
    check.evaluating = false;
    requestClientSafetyRound(check, clients);
    return;
  }
  finishActivationCheck(requestId, "ready");
}

async function beginActivationCheck(event, requestId) {
  if (pendingActivationChecks.has(requestId)) return;
  if (!self.registration.waiting) {
    sendActivationResult(event.source, requestId, "no-update");
    return;
  }
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: false });
  if (clients.length === 0) {
    sendActivationResult(event.source, requestId, "blocked");
    return;
  }
  const check = {
    requestId,
    expectedClientIds: new Set(clients.map((client) => client.id)),
    clients: new Map(clients.map((client) => [client.id, client])),
    expectedEpochs: new Map(),
    responses: new Map(),
    round: 1,
    evaluating: false,
    requester: event.source,
    timeout: setTimeout(() => finishActivationCheck(requestId, "blocked"), CLIENT_SAFETY_TIMEOUT_MS),
  };
  pendingActivationChecks.set(requestId, check);
  requestClientSafetyRound(check, clients);
}

self.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;
  if (message.type === "MATCHDAY_SCORING_WORKER_VERSION") {
    event.source?.postMessage({
      type: "MATCHDAY_SCORING_WORKER_VERSION",
      requestId: typeof message.requestId === "string" ? message.requestId : null,
      version: WORKER_VERSION,
    });
    return;
  }
  if (
    message.type === "MATCHDAY_SCORING_WORKER_ACTIVATION_APPROVED" &&
    event.source === self.registration.active &&
    typeof message.requestId === "string" &&
    Array.isArray(message.checkedClientIds) &&
    message.protocolVersion === UPDATE_PROTOCOL_VERSION
  ) {
    // The active worker already established a stable, frozen two-round quorum.
    // A waiting worker cannot enumerate clients controlled by the active worker,
    // so it must not attempt a third client round here.
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (
    message.type === "MATCHDAY_REQUEST_SCORING_WORKER_ACTIVATION" &&
    typeof message.requestId === "string" &&
    message.protocolVersion === UPDATE_PROTOCOL_VERSION
  ) {
    event.waitUntil(beginActivationCheck(event, message.requestId));
    return;
  }
  if (message.type === "MATCHDAY_SCORING_WORKER_SAFE_STATE") {
    const requestId = typeof message.requestId === "string" ? message.requestId : "";
    const check = pendingActivationChecks.get(requestId);
    const sourceId = event.source && "id" in event.source ? event.source.id : "";
    if (message.protocolVersion !== UPDATE_PROTOCOL_VERSION || !sourceId) return;
    if (!check || !check.expectedClientIds.has(sourceId) || check.responses.has(sourceId)) return;
    check.responses.set(sourceId, {
      safe: message.safe === true,
      activeScoring: message.activeScoring === true,
      transitionInFlight: message.transitionInFlight === true,
      unresolvedQueue: message.unresolvedQueue === true,
      epoch: Number.isSafeInteger(message.epoch) ? message.epoch : -1,
      stable:
        check.round === 1 ||
        (message.stable === true &&
          Number.isSafeInteger(message.epoch) &&
          message.epoch === check.expectedEpochs.get(sourceId)),
      frozen: message.frozen === true,
    });
    if (check.responses.size === check.expectedClientIds.size) {
      event.waitUntil(evaluateActivationRound(requestId));
    }
    return;
  }
  if (
    message.type === "MATCHDAY_SCORING_WORKER_SAFETY_INVALIDATED" &&
    message.protocolVersion === UPDATE_PROTOCOL_VERSION
  ) {
    const sourceId = event.source && "id" in event.source ? event.source.id : "";
    if (!sourceId) return;
    for (const [requestId, check] of pendingActivationChecks.entries()) {
      if (check.expectedClientIds.has(sourceId)) finishActivationCheck(requestId, "blocked");
    }
    return;
  }
  if (message.type !== "MATCHDAY_PREPARE_OFFLINE_SCORING") return;
  const assets = Array.isArray(message.assets)
    ? message.assets.filter((candidate) => {
        if (typeof candidate !== "string") return false;
        try {
          const url = new URL(candidate, self.location.origin);
          return url.origin === self.location.origin && url.pathname.startsWith("/_next/static/");
        } catch {
          return false;
        }
      })
    : [];
  event.waitUntil(
    caches
      .open(SCORING_CACHE_NAME)
      .then(async (cache) => {
        const networkShell = await fetch(SCORING_SHELL_PATH, { credentials: "same-origin", cache: "no-store" });
        const shell = await verifiedScoringShellResponse(networkShell);
        if (!shell) throw new Error("The offline scoring shell failed its privacy verification.");
        await cache.put(SCORING_SHELL_PATH, shell);
        await Promise.all(
          assets.map(async (asset) => {
            const response = await fetch(asset, { credentials: "same-origin" });
            if (response.ok) await cache.put(asset, response);
          }),
        );
        event.ports[0]?.postMessage({ ok: true, version: WORKER_VERSION });
      })
      .catch(() => {
        event.ports[0]?.postMessage({ ok: false, version: WORKER_VERSION });
      }),
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
    if (url.pathname === SCORING_SHELL_PATH) {
      event.respondWith(
        fetch(request).catch(async () => {
          const cached = await caches.open(SCORING_CACHE_NAME).then((cache) => cache.match(SCORING_SHELL_PATH));
          return cached || offlineResponse();
        }),
      );
      return;
    }
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (PUBLIC_DOCUMENT_PATHS.has(url.pathname) && isPublicCacheable(response)) {
            const copy = response.clone();
            void caches.open(FOUNDATION_CACHE_NAME).then((cache) => cache.put(request, copy));
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
      caches.open(SCORING_CACHE_NAME).then(async (scoringCache) => {
        const cached = (await scoringCache.match(request)) || (await caches.match(request));
        const network = fetch(request).then((response) => {
          if (isPublicCacheable(response)) {
            const copy = response.clone();
            void caches.open(FOUNDATION_CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        });
        return cached || network;
      }),
    );
  }
});
