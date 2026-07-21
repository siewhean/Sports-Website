# Asset delivery and CDN contract

The web build is the origin of truth for immutable static assets. Next.js emits content-addressed chunks below `/_next/static/`; the deployment adapter must preserve their filenames and cache them as `public, max-age=31536000, immutable`. HTML, API responses, service-worker scripts, consent state, and error pages must not receive that immutable policy.

## Required edge policy

- Negotiate Brotli first and gzip second without varying application semantics.
- Preserve strong `ETag` values and `Vary: Accept-Encoding`.
- Optimise images into responsive modern formats with an explicit fallback and dimensions.
- Do not cache authenticated or private responses at a shared edge.
- Public competition projections cache by publication version. Publishing a result or schedule revision issues an idempotent purge for the old projection key and never exposes an unpublished schedule draft.
- Failed purge requests enter the durable job queue. After retry exhaustion and a successful dead-letter write, the worker increments `worker.jobs.dead_lettered`, emits one payload-free structured terminal event for alert routing, and exposes degraded health. Clients still use publication versions/ETags to detect stale data.
- CSP, HSTS, frame, content-type, referrer, and permissions headers must survive the CDN unchanged.

The ownership and release-verification boundary for these headers is documented in [WEB_SECURITY_HEADERS.md](./WEB_SECURITY_HEADERS.md).

## Release verification

For the exact staging build, record:

1. build manifest and static chunk filenames;
2. origin and edge `Content-Encoding`, `Cache-Control`, `ETag`, `Vary`, and security headers;
3. a cache miss followed by a cache hit for one immutable asset;
4. an image-format negotiation check with a fallback client;
5. a publish action whose old public projection is purged while the new version becomes visible;
6. a negative check proving organiser, session, and draft responses are not shared-cacheable.

Local builds can prove content hashing, offline fallback, and origin compression. Edge cache hits and purge-on-publish remain deployment-provider evidence and must be rechecked after the hosting/CDN decision.

## Repository controls

- `infra/deploy/asset-delivery.contract.json` separates origin-verifiable controls from required edge evidence.
- `pnpm deploy:manifest` records the build ID, byte size, and SHA-256 digest for every emitted static asset.
- `pnpm asset-delivery:verify:origin` binds the running origin's `X-Matchday-Build-Id` to the manifest, verifies every served immutable asset's byte size and SHA-256 digest, and rejects regressions in caching, gzip negotiation, ETags, conditional requests, private HTML, or service-worker caching.
- `@matchday/edge-cache` validates published monotonic versions and exposes a credential-free purge request. The worker derives the durable job idempotency key; an environment adapter owns the CDN endpoint and secret.

The repository does not treat the origin verifier as CDN proof. Brotli, edge HIT/MISS headers, provider receipts, and purge propagation must be captured from the selected staging deployment.
