const FOUNDATION_CACHE_NAME = "matchday-foundation-v3";
const SCORING_CACHE_PREFIX = "matchday-scoring-shell-";
const SCORING_CACHE_NAME = `${SCORING_CACHE_PREFIX}v5`;
const SCORING_FALLBACK_DB_NAME = "matchday-scoring-shell-fallback";
const SCORING_FALLBACK_STORE = "active-resources";
const SCORING_FALLBACK_MANIFEST_KEY = "manifest";
const SCORING_FALLBACK_MAX_RESOURCES = 128;
const SCORING_FALLBACK_MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
const SCORING_FALLBACK_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const SCORING_SHELL_PATH = "/score";
const SCORING_SHELL_MARKER = 'data-offline-scoring-shell="v1"';
const WORKER_VERSION = "gate-c-c3-v5";
const UPDATE_PROTOCOL_VERSION = 1;
const PREPARATION_PROTOCOL_VERSION = 1;
const PREPARATION_CAPABILITIES = Object.freeze(["offline-scoring-shell-cache-v1"]);
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
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    ["style", "script", "font"].includes(destination) &&
    url.pathname.startsWith("/_next/static/")
  );
}

function requiredScoringAssetRequests(candidates) {
  if (!Array.isArray(candidates)) throw new Error("The offline scoring asset manifest is invalid.");
  if (candidates.length > SCORING_FALLBACK_MAX_RESOURCES - 1) {
    throw new Error("The offline scoring asset manifest exceeds the resource limit.");
  }
  const requests = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (typeof candidate !== "string") throw new Error("The offline scoring asset manifest is invalid.");
    const url = new URL(candidate, self.location.origin);
    if (
      url.origin !== self.location.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith("/_next/static/")
    ) {
      throw new Error("The offline scoring asset manifest is invalid.");
    }
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    requests.push(new Request(url.href, { credentials: "same-origin" }));
  }
  return requests;
}

function scoringStorageError() {
  const error = new Error("The offline scoring shell could not be retained.");
  error.code = "OFFLINE_SHELL_STORAGE_UNAVAILABLE";
  return error;
}

function scoringResourceUrl(input) {
  const url = new URL(input instanceof Request ? input.url : input, self.location.origin);
  if (
    url.origin !== self.location.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== SCORING_SHELL_PATH && !url.pathname.startsWith("/_next/static/"))
  ) {
    throw new Error("The offline scoring fallback accepts only the scoring shell and immutable build assets.");
  }
  return url.href;
}

function openScoringFallbackDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SCORING_FALLBACK_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SCORING_FALLBACK_STORE)) {
        request.result.createObjectStore(SCORING_FALLBACK_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? scoringStorageError());
    request.onblocked = () => reject(scoringStorageError());
  });
}

function awaitScoringFallbackTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? scoringStorageError());
    transaction.onabort = () => reject(transaction.error ?? scoringStorageError());
  });
}

async function serialiseScoringFallbackResponse(request, response, generation) {
  const url = scoringResourceUrl(request);
  const body = await response.arrayBuffer();
  if (body.byteLength > SCORING_FALLBACK_MAX_RESOURCE_BYTES) {
    throw new Error("An offline scoring resource exceeds the durable storage limit.");
  }
  const headers = {};
  for (const name of [
    "cache-control",
    "content-language",
    "content-type",
    "x-content-type-options",
    "x-matchday-offline-shell",
  ]) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const digest = await crypto.subtle.digest("SHA-256", body);
  const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    key: `resource:${url}`,
    url,
    body,
    headers,
    generation,
    sha256,
    status: response.status,
    statusText: response.statusText,
  };
}

function scoringFallbackRequest(store, url) {
  return new Promise((resolve, reject) => {
    const request = store.get(url);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? scoringStorageError());
  });
}

async function retainScoringFallbackResponses(entries, generation) {
  if (entries.length < 1 || entries.length > SCORING_FALLBACK_MAX_RESOURCES) {
    throw new Error("The offline scoring resource count exceeds the durable storage limit.");
  }
  const records = await Promise.all(
    entries.map(({ request, response }) => serialiseScoringFallbackResponse(request, response.clone(), generation)),
  );
  const totalBytes = records.reduce((sum, record) => sum + record.body.byteLength, 0);
  if (totalBytes > SCORING_FALLBACK_MAX_TOTAL_BYTES) {
    throw new Error("The offline scoring resources exceed the total durable storage limit.");
  }
  const manifest = {
    key: SCORING_FALLBACK_MANIFEST_KEY,
    generation,
    worker_version: WORKER_VERSION,
    total_bytes: totalBytes,
    resources: records.map(({ url, sha256 }) => ({ url, sha256 })),
  };
  const database = await openScoringFallbackDatabase();
  try {
    const transaction = database.transaction(SCORING_FALLBACK_STORE, "readwrite");
    const store = transaction.objectStore(SCORING_FALLBACK_STORE);
    store.clear();
    for (const record of records) store.put(record);
    store.put(manifest);
    await awaitScoringFallbackTransaction(transaction);
  } finally {
    database.close();
  }
}

async function clearScoringFallbackResponses() {
  const database = await openScoringFallbackDatabase();
  try {
    const transaction = database.transaction(SCORING_FALLBACK_STORE, "readwrite");
    transaction.objectStore(SCORING_FALLBACK_STORE).clear();
    await awaitScoringFallbackTransaction(transaction);
  } finally {
    database.close();
  }
}

async function matchScoringFallbackResponse(request) {
  const url = scoringResourceUrl(request);
  const database = await openScoringFallbackDatabase();
  try {
    const transaction = database.transaction(SCORING_FALLBACK_STORE, "readonly");
    const store = transaction.objectStore(SCORING_FALLBACK_STORE);
    const [manifest, record] = await Promise.all([
      scoringFallbackRequest(store, SCORING_FALLBACK_MANIFEST_KEY),
      scoringFallbackRequest(store, `resource:${url}`),
    ]);
    await awaitScoringFallbackTransaction(transaction);
    const manifestIsAuthoritative =
      manifest?.worker_version === WORKER_VERSION &&
      typeof manifest.generation === "string" &&
      /^[a-f0-9-]{36}$/u.test(manifest.generation) &&
      Array.isArray(manifest.resources) &&
      manifest.resources.length > 0 &&
      manifest.resources.length <= SCORING_FALLBACK_MAX_RESOURCES &&
      Number.isSafeInteger(manifest.total_bytes) &&
      manifest.total_bytes > 0 &&
      manifest.total_bytes <= SCORING_FALLBACK_MAX_TOTAL_BYTES;
    if (!manifestIsAuthoritative) return { authoritative: false, response: undefined };
    const expected = manifest.resources.find((resource) => resource.url === url);
    if (
      !expected ||
      expected.sha256 !== record?.sha256 ||
      record.generation !== manifest.generation ||
      !record.body ||
      !Number.isSafeInteger(record.body.byteLength) ||
      record.body.byteLength > SCORING_FALLBACK_MAX_RESOURCE_BYTES
    ) {
      return { authoritative: true, response: undefined };
    }
    const digest = await crypto.subtle.digest("SHA-256", record.body);
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (sha256 !== expected.sha256) return { authoritative: true, response: undefined };
    const response = new Response(record.body, {
      headers: record.headers,
      status: record.status,
      statusText: record.statusText,
    });
    return { authoritative: true, response: await verifiedRetainedScoringResponse(request, response) };
  } finally {
    database.close();
  }
}

async function matchScoringResource(request, options) {
  try {
    const fallback = await matchScoringFallbackResponse(request);
    if (fallback.authoritative) return fallback.response;
  } catch {
    // IndexedDB is unavailable. A fully verified Cache Storage generation may
    // still provide the retained scoring resource.
  }
  try {
    const cache = await caches.open(SCORING_CACHE_NAME);
    const cached = await cache.match(request, options);
    const verified = await verifiedRetainedScoringResponse(request, cached);
    if (verified) return verified;
  } catch {
    // Some otherwise durable WebKit stores expose Cache Storage but do not
    // retain entries. The bounded IndexedDB fallback below uses the same
    // participant-free resource allowlist.
  }
  return undefined;
}

async function retainScoringResources(entries) {
  if (entries.length < 1 || entries.length > SCORING_FALLBACK_MAX_RESOURCES) {
    throw new Error("The offline scoring resource count exceeds the durable storage limit.");
  }
  const sizes = await Promise.all(entries.map(({ response }) => response.clone().arrayBuffer()));
  if (
    sizes.some(({ byteLength }) => byteLength > SCORING_FALLBACK_MAX_RESOURCE_BYTES) ||
    sizes.reduce((sum, { byteLength }) => sum + byteLength, 0) > SCORING_FALLBACK_MAX_TOTAL_BYTES
  ) {
    throw new Error("The offline scoring resources exceed the durable storage limit.");
  }
  const generation = crypto.randomUUID();
  let fallbackCreated = false;
  let fallbackRetained = false;
  let fallbackInvalidated = false;
  try {
    await retainScoringFallbackResponses(entries, generation);
    fallbackCreated = true;
    const retained = await Promise.all(entries.map(({ request }) => matchScoringFallbackResponse(request)));
    fallbackRetained = retained.every(({ authoritative, response }) => authoritative && response?.ok);
  } catch {
    // Cache Storage remains a supported durable backend when IndexedDB is
    // unavailable.
  }
  if (fallbackCreated && !fallbackRetained) {
    try {
      await clearScoringFallbackResponses();
      fallbackInvalidated = true;
    } catch {
      // A failed IndexedDB generation is authoritative until it is removed.
      // Cache Storage must not be accepted while that generation can suppress
      // otherwise valid cache entries.
    }
  }
  let cacheRetained = false;
  try {
    await caches.delete(SCORING_CACHE_NAME);
    const cache = await caches.open(SCORING_CACHE_NAME);
    await Promise.all(
      entries.map(async ({ request, response }) => {
        const headers = new Headers(response.headers);
        headers.set("x-matchday-offline-generation", generation);
        await cache.put(
          request,
          new Response(await response.clone().arrayBuffer(), {
            headers,
            status: response.status,
            statusText: response.statusText,
          }),
        );
      }),
    );
    const retained = await Promise.all(
      entries.map(async ({ request }) =>
        verifiedRetainedScoringResponse(request, await cache.match(request, { ignoreVary: true })),
      ),
    );
    cacheRetained = retained.every(
      (response) => response?.ok && response.headers.get("x-matchday-offline-generation") === generation,
    );
  } catch {
    await caches.delete(SCORING_CACHE_NAME).catch(() => false);
  }
  if (!cacheRetained) await caches.delete(SCORING_CACHE_NAME).catch(() => false);
  if (fallbackCreated && !fallbackRetained && !fallbackInvalidated) {
    await caches.delete(SCORING_CACHE_NAME).catch(() => false);
    throw scoringStorageError();
  }
  if (!fallbackRetained && !cacheRetained) throw scoringStorageError();
}

function isVerifiedImmutableScoringAssetResponse(request, response) {
  const url = new URL(scoringResourceUrl(request));
  const policy = response?.headers.get("cache-control")?.toLowerCase() ?? "";
  const contentType = response?.headers.get("content-type")?.toLowerCase() ?? "";
  return (
    url.pathname.startsWith("/_next/static/") &&
    response?.ok === true &&
    !response.headers.has("set-cookie") &&
    policy.includes("public") &&
    policy.includes("immutable") &&
    !policy.includes("private") &&
    !policy.includes("no-store") &&
    /(?:javascript|text\/css|font|woff|octet-stream)/u.test(contentType)
  );
}

async function verifiedRetainedScoringResponse(request, response) {
  if (!response) return null;
  const url = new URL(scoringResourceUrl(request));
  if (url.pathname === SCORING_SHELL_PATH) return verifiedScoringShellResponse(response);
  return isVerifiedImmutableScoringAssetResponse(request, response) ? response : null;
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
      ...(response.headers.get("x-matchday-offline-generation")
        ? { "X-Matchday-Offline-Generation": response.headers.get("x-matchday-offline-generation") }
        : {}),
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
  const requiredCapabilities = Array.isArray(message.requiredCapabilities)
    ? message.requiredCapabilities.filter((capability) => typeof capability === "string")
    : [];
  if (
    message.protocolVersion !== PREPARATION_PROTOCOL_VERSION ||
    requiredCapabilities.length !== message.requiredCapabilities?.length ||
    requiredCapabilities.some((capability) => !PREPARATION_CAPABILITIES.includes(capability))
  ) {
    event.ports[0]?.postMessage({
      ok: false,
      version: WORKER_VERSION,
      protocolVersion: PREPARATION_PROTOCOL_VERSION,
      capabilities: PREPARATION_CAPABILITIES,
      code: "INCOMPATIBLE_PREPARATION_PROTOCOL",
    });
    return;
  }
  event.waitUntil(
    Promise.resolve()
      .then(async () => {
        const assetRequests = requiredScoringAssetRequests(message.assets);
        const shellResponse = await fetch(SCORING_SHELL_PATH, { credentials: "same-origin", cache: "no-store" });
        const shell = await verifiedScoringShellResponse(shellResponse);
        if (!shell) throw new Error("The offline scoring shell failed its privacy verification.");
        const shellRequest = new Request(new URL(SCORING_SHELL_PATH, self.location.origin).href, {
          credentials: "same-origin",
        });
        const assetResponses = await Promise.all(
          assetRequests.map(async (assetRequest) => {
            const response = await fetch(assetRequest, { credentials: "same-origin", cache: "no-store" });
            if (!isVerifiedImmutableScoringAssetResponse(assetRequest, response)) {
              throw new Error("A required offline scoring asset failed its immutable-response verification.");
            }
            return response;
          }),
        );
        await retainScoringResources([
          { request: shellRequest, response: shell },
          ...assetRequests.map((request, index) => ({ request, response: assetResponses[index] })),
        ]);
        event.ports[0]?.postMessage({
          ok: true,
          version: WORKER_VERSION,
          protocolVersion: PREPARATION_PROTOCOL_VERSION,
          capabilities: PREPARATION_CAPABILITIES,
        });
      })
      .catch((error) => {
        const code =
          error && typeof error === "object" && error.code === "OFFLINE_SHELL_STORAGE_UNAVAILABLE"
            ? error.code
            : "OFFLINE_SHELL_PREPARATION_FAILED";
        event.ports[0]?.postMessage({
          ok: false,
          version: WORKER_VERSION,
          protocolVersion: PREPARATION_PROTOCOL_VERSION,
          capabilities: PREPARATION_CAPABILITIES,
          code,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
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
          const shellRequest = new Request(new URL(SCORING_SHELL_PATH, self.location.origin).href, {
            credentials: "same-origin",
          });
          const cached = await matchScoringResource(shellRequest, { ignoreVary: true });
          if (cached) return cached;
          return offlineResponse();
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
      Promise.resolve().then(async () => {
        const cached = (await matchScoringResource(request)) || (await caches.match(request));
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (isPublicCacheable(response)) {
            const copy = response.clone();
            void caches.open(FOUNDATION_CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      }),
    );
  }
});
