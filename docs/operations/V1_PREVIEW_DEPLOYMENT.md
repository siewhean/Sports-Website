# V1 isolated preview deployment

`render.yaml` defines an isolated V1 API, scheduler, and worker. It never enables automatic deploys and contains no credentials. Render must be pointed at the exact approved branch or commit, with a separate PostgreSQL database and Redis namespace. Before accepting a preview, manually deploy all three services from one recorded commit, set the web `MATCHDAY_BUILD_ID`, and retain the three Render deployment IDs plus the API `/health/ready` and same-host proxied `/api/v1/status` receipts.

The web deployment owns the only browser-facing HTTPS hostname. Configure its server-only `RENDER_API_ORIGIN` with the Render API HTTPS origin; the checked-in Next rewrite proxies only `/api/v1/*`. Set `MATCHDAY_API_BASE_URL` to that same browser hostname, never to the direct Render hostname. This preserves the host-only session cookie across the OIDC callback and organiser BFF.

Before the first start, inject the validated staging variables from [ENVIRONMENTS.md](ENVIRONMENTS.md) through the provider secret store. All three processes call `@matchday/config`; therefore each requires the staging identity, database, Redis, scoring-access, and observability configuration. Only the worker receives `EDGE_CACHE_PURGE_ENDPOINT` and `EDGE_CACHE_PURGE_BEARER_TOKEN`. Run `pnpm db:migrate` once as a controlled release action before API start; do not run migrations from the scheduler or worker.

Render background workers do not have inbound health URLs. Prove scheduler and worker liveness from their structured health logs and queue/Redis receipts. The API readiness endpoint is `/health/ready`; keep `/health/deep` private and supply `DEEP_HEALTH_TOKEN` only to the verification path.
