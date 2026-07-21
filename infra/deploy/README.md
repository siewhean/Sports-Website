# Deployment infrastructure

Production deployment definitions will target containerised API and workers plus CDN-hosted web assets. Provider-specific resources remain blocked on the Phase 0 provider and regional-durability decisions.

The provider-neutral contract is checked into `asset-delivery.contract.json`. Every web build must run `pnpm deploy:manifest` and retain `artifacts/deployment-manifest.json` with its release evidence. `pnpm asset-delivery:verify:origin` starts the exact local production build, binds its public build-ID response header to that manifest, verifies every immutable asset's bytes, and checks compression, conditional requests, private HTML, service-worker caching, and security headers.

`@matchday/edge-cache` defines the outbound purge port. The worker registers `edge.public-projection.purge` with a deterministic key based on competition, projection, and the prior published version. `EDGE_CACHE_PURGE_ENDPOINT` and `EDGE_CACHE_PURGE_BEARER_TOKEN` configure its HTTPS adapter; staging and production worker startup fails closed if either is absent, and neither is allowed in job payloads or diagnostics. The API does not require or receive this worker-only credential. Real cache-hit and purge evidence remains a deployment gate after a CDN is selected.
