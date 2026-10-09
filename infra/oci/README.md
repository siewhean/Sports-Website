# OCI controlled staging

This is a provider-specific deployment for the Matchday API, PostgreSQL, Redis, worker, and Caddy HTTPS proxy. It replaced the former free-tier hosted staging service and preserves exact-SHA and retained-receipt rules. Base and dependency images are pinned by digest; update those digests as a reviewed dependency change.

## VM and network

Use an OCI Ampere A1 VM with at least 2 OCPUs and 12 GB RAM running Ubuntu ARM64. Confirm the tenancy's available Always Free allocation and capacity before provisioning. Add ingress rules for TCP 22 from the operator IP and TCP 80/443 from the internet. Do not expose PostgreSQL 5432 or Redis 6379.

Install Docker Engine and the Compose plugin, clone this repository, and create `infra/oci/.env.oci` from `.env.oci.example`. Generate unique URL-safe secrets; do not commit the file. Replace every `CHANGE_ME` token and both `staging.example.com` and `example.com` values with the real staging hostname and its apex registrable domain. Keep `SCORING_SESSION_SEAL_KEY` separate from the API HMAC keys because the web BFF uses it to seal its host-only scoring cookie. Configure the required OIDC tenant, edge-cache purge bridge, and SMTP sink/provider. Create an A record for `OCI_PUBLIC_HOSTNAME` pointing to the VM before starting Caddy so it can obtain a certificate. The fixed Compose addresses are Caddy (`172.30.0.10`) and Web (`172.30.0.12`); keep `API_TRUSTED_PROXIES=172.30.0.10,172.30.0.12` (and `172.31.0.10,172.31.0.12` in production) so Fastify resolves the browser IP for requests Caddy proxies straight to the API. That does not cover server-side Web BFF calls: Node `fetch` sends no `X-Forwarded-For`, so the API would see only the web container. The BFF instead sends the end-user IP (taken from the right-most, Caddy-written `X-Forwarded-For` hop) in `x-matchday-client-ip` with an HMAC-SHA256 signature over the IP and a timestamp (`x-matchday-client-ip-signature`, 60-second validity); the API uses it for rate-limit keys only when the signature verifies and otherwise falls back to the transport address. Set the same `MATCHDAY_CLIENT_IP_SECRET` (32+ bytes, unique) for both API and web (production requires it); in production the web container resolves `OCI_PUBLIC_HOSTNAME` to Caddy on the internal bridge (`extra_hosts`) instead of hairpinning through the public IP.

## Deploy an exact candidate

From the VM repository checkout:

```sh
cp infra/oci/.env.oci.example infra/oci/.env.oci
chmod 600 infra/oci/.env.oci
# Edit every CHANGE_ME value, the example hostname/domain values, and set the real OCI hostname.
git fetch --all --tags
export CANDIDATE_SHA=40_CHARACTER_SHA
export OCI_PUBLIC_HOSTNAME=staging.example.com
git checkout --detach "$CANDIDATE_SHA"
infra/oci/deploy.sh
```

The script refuses a dirty checkout or unresolved secret placeholders, runs migrations in a one-shot container, starts the services, waits for `/health/ready` with bounded requests, and verifies both the API Git SHA and web build-ID header. It also rejects a stopped or restarting worker during three startup observations. PostgreSQL and Redis are reachable only on the Compose backend network, and Caddy blocks public `/health/deep` requests. `Dockerfile.dockerignore` excludes nested environment files and local dependencies from the build context.

The exported `CANDIDATE_SHA` is authoritative for each deployment; updating application code does not require editing the secret file. Set `IDENTITY_HOSTED_RECOVERY_URL` to the real identity provider's recovery page. SMTP port 587 uses `SMTP_SECURE=false` for STARTTLS; implicit TLS on port 465 uses `true`. Configure both SMTP authentication fields when required by the provider.

Run deployment regression checks with `node --test infra/oci/deploy.test.mjs`. These exercise preflight and rollout control flow with mock commands; they do not prove container startup or OCI performance.

The workflow intentionally accepts any full SHA that the staging checkout can fetch; release approval supplies the candidate SHA and the API attestation prevents a different image from being mistaken for it. Keep branch and approval policy in the protected GitHub environment rather than relying on a provider-specific branch name.

The API already runs the scheduler inline. The worker service is included for the email outbox and queue work. For a scoring-only qualification, the worker may remain running but must not share the VM with unrelated workloads.

## Gate D qualification

After the deployment is ready, run the unchanged QA-010 and QA-011 staging workload from the controlled runner with `TARGET_URL=https://staging.example.com` and `CANDIDATE_SHA` set to the deployed full SHA. Retain the seed, scoring, result-propagation, and public-load receipts. OCI deployment readiness is infrastructure evidence; it does not replace the local pilot, physical-device, tabletop, or independent-review evidence required by the Gate D freeze validator.

For the scoring latency investigation, compare `DB_POOL_MAX=8`, `12`, and `20` in separate clean runs. Keep the configuration that produces server p95 below 400 ms and client p95 below 500 ms. Do not change the QA-011 workload, threshold, or receipt validator.

## Production and Staging Dual-Stack Architecture

The OCI host supports isolated dual-stack execution with shared Caddy ingress:

- **Shared Ingress (Caddy)**: Single Caddy container (`matchday-oci-caddy-1`) attached to both backend subnets:
  - Staging IP: `172.30.0.10`
  - Production IP: `172.31.0.10`
  - Ports: 80, 443
  - Routes `$OCI_PROD_HOSTNAME` (currently `matchday.poladex.shop`) -> Production API (`172.31.0.11:4000`), Web (`172.31.0.12:3000`)
  - Routes `$OCI_STAGING_HOSTNAME` (currently `c5-drill.poladex.shop`) -> Staging API (`172.30.0.11:4000`), Web (`172.30.0.12:3000`)
  - Blocks `/health/deep*` publicly with HTTP 404
- **Production Stack (`matchday-prod`)**:
  - Network: `matchday-prod_backend` (`172.31.0.0/24`)
  - Database: `matchday_prod` on `172.31.0.2` (`matchday-prod-postgres-1`)
  - Redis: `172.31.0.3` (`matchday-prod-redis-1`)
  - API: `172.31.0.11:4000` (alias `prod-api`)
  - Web: `172.31.0.12:3000` (alias `prod-web`)
  - Worker: `172.31.0.13` (alias `prod-worker`)
  - Environment file: `infra/oci/.env.prod` (mode 600)
- **Staging Stack (`matchday-oci`)**:
  - Network: `matchday-oci_backend` (`172.30.0.0/24`)
  - Database: `matchday` on `172.30.0.2` (`matchday-oci-postgres-1`)
  - Redis: `172.30.0.3` (`matchday-oci-redis-1`)
  - API: `172.30.0.11:4000` (alias `staging-api`)
  - Web: `172.30.0.12:3000` (alias `staging-web`)
  - Worker: `172.30.0.13` (alias `staging-worker`)
  - Environment file: `infra/oci/.env.oci` (mode 600)

## Production Deployment

Images are built by CI (job `images` in `.github/workflows/ci.yml`, on `main` and `v*` tags) and pushed to
`ghcr.io/siewhean/matchday-{api,web,worker,migrate,backup}:<full git sha>`. `deploy-prod.sh` pulls those exact tags,
verifies each image's `org.opencontainers.image.revision` label equals `CANDIDATE_SHA`, then runs the unchanged
pre-migration snapshot, migration, health-gated promotion and rollback flow. Nothing is compiled on the VM.
Wait for the `images` job of the candidate commit to finish first.

From `/opt/matchday/oci-src`:

```sh
export CANDIDATE_SHA=40_CHARACTER_SHA
export OCI_PUBLIC_HOSTNAME=<production hostname>      # currently matchday.poladex.shop
export OCI_PROD_HOSTNAME="$OCI_PUBLIC_HOSTNAME"       # Caddy site address; must match
git checkout --detach "$CANDIDATE_SHA"
infra/oci/deploy-prod.sh
```

Break-glass: `infra/oci/deploy-prod.sh --build-locally` (or `MATCHDAY_BUILD_LOCALLY=1`) builds the images on the VM with
`docker compose build --pull` (600s `MATCHDAY_BUILD_TIMEOUT`) when GHCR or CI is unavailable. It competes with live
traffic; use only in an emergency. `MATCHDAY_IMAGE_REGISTRY` overrides the registry namespace and
`MATCHDAY_PULL_TIMEOUT` (default 300s) bounds the pull.

If the packages are private, run `docker login ghcr.io` on the VM once with a read-only (`read:packages`) token.

### Hostnames are configuration

The Caddyfile uses `{$OCI_PROD_HOSTNAME}` and `{$OCI_STAGING_HOSTNAME}`; `compose.yaml` passes both to the Caddy
container (defaults `prod.localhost` / `staging.localhost`, which never request public certificates). Moving to a new
domain means changing `OCI_PUBLIC_HOSTNAME`, `OCI_PROD_HOSTNAME`, `OCI_STAGING_HOSTNAME`, `OCI_COOKIE_SITE`,
`API_ALLOWED_ORIGINS`, `MATCHDAY_PUBLIC_ORIGIN` and the repository variables `MATCHDAY_PUBLIC_ORIGIN` /
`NEXT_PUBLIC_*` (the web image bakes the public origin at build time, so re-run the `images` job), pointing DNS at the
VM, and recreating Caddy (`docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml up -d caddy`).
An existing `/etc/matchday/caddy/Caddyfile` keeps its literal hostnames until it is replaced from the template;
`deploy-prod.sh` refuses to promote if a templated runtime Caddyfile and the Caddy container's `OCI_PROD_HOSTNAME`
disagree.

Post-deploy topology verification (arguments or `OCI_PROD_HOSTNAME` / `OCI_STAGING_HOSTNAME`):

```sh
./infra/oci/verify-production-topology.sh "$OCI_PROD_HOSTNAME" "$OCI_STAGING_HOSTNAME" "$CANDIDATE_SHA"
```

Runtime images run as the unprivileged `node` user and contain production dependencies and build output only (no
pnpm, TypeScript or build toolchain). The only writable paths they need are `/tmp` and `apps/web/.next/cache`.

## Operations

```sh
# Production stack
docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml ps
docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml logs --tail=200 api

# Staging stack
docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml ps
docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml logs --tail=200 api
```

Back up the PostgreSQL volume before destructive maintenance. Rotate the `.env.prod` and `.env.oci` secrets through the configured secret-handling process, then redeploy a new exact SHA. Keep database and Redis ports strictly internal to their respective Docker bridge networks.

## G3 production telemetry collector (source support only)

Telemetry remains disabled by default. API and worker send OTLP HTTP to the exact internal endpoint `http://otel-collector:4318`; other production endpoints require HTTPS and reject loopback, embedded credentials, query strings and fragments. The optional `observability` profile adds the pinned ARM64-compatible collector on `matchday-prod_backend` only (`172.31.0.14`). It publishes no host ports. This profile does not change the official deployment script or enable current production telemetry.

A later separately authorized rollout must configure `OTEL_ENABLED=true`, the internal application endpoint and a validated `OTEL_COLLECTOR_EXTERNAL_ENDPOINT=https://...` in `infra/oci/.env.prod`. The latter is a non-secret base OTLP ingest URL; the collector appends `/v1/traces` and `/v1/metrics`. Keep all provider credentials out of that environment file and out of API/worker environments. The operator must provision `/etc/matchday/secrets/otel-bearer-token` outside Git, owned by root with mode `600`, containing only the provider token. The collector alone mounts it read-only and uses the bearer-token authenticator to generate authenticated outbound HTTPS headers. It runs as root solely to read this root-only file, with all Linux capabilities dropped, no new privileges and a read-only filesystem. Missing token files fail closed rather than creating directories.

For that future rollout, validate production configuration first. This preflight is mandatory: the pinned collector accepts an HTTP endpoint at startup, so its successful startup alone does not prove HTTPS enforcement. The production validator rejects external HTTP, loopback, credentials, query strings and fragments. It also rejects non-empty `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TRACES_HEADERS` and `OTEL_EXPORTER_OTLP_METRICS_HEADERS`, even while telemetry is disabled, so provider authentication stays at the collector boundary. Every production Compose command must explicitly load the established environment file:

```sh
node scripts/validate-production-config.mjs infra/oci/.env.prod
docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml --profile observability config --quiet
# Only after separate production authorization:
docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml --profile observability up -d otel-collector
# Internal health check through the existing application container; no public listener:
docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml exec -T api node -e "fetch('http://otel-collector:13133/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
```

The health extension proves collector process readiness, not provider delivery. Future certification must independently confirm traces and both API/worker metrics arriving at the provider. The collector caps memory at 256 MiB, limits pipeline memory to 192 MiB, batches 256 records (maximum 512), uses a bounded sending queue and retries within 30 seconds. Under prolonged outage telemetry may be dropped; application requests/jobs remain independent. Resource metadata adds only the production environment and Matchday namespace, preserving application service names; there is no SQL, log-body, header or host-resource receiver.

Worker shutdown stops email intake, drains queue work, closes background email handles, then flushes and shuts down telemetry. Concurrent signals share one lifecycle. A 60-second watchdog exits nonzero if application draining cannot finish; the declarative worker stop grace is 70 seconds. Unacknowledged provider acceptance retains its durable lease and follows existing crash-equivalent recovery, with possible duplicate delivery. See [worker shutdown and acknowledgement](../../docs/operations/WORKER_SHUTDOWN.md) for the timeout hierarchy, startup coverage and recovery limits.

Rollback in a separately authorized checkpoint disables application telemetry, recreates API/worker using the official exact-SHA workflow (which retains `--env-file infra/oci/.env.prod`) and stops the optional collector. No database, Redis, Caddy or routing change is required. Never run `docker compose config` without `--quiet` against real production secrets or print the token. Source rendering tests use only a disposable repository copy and synthetic `.env.prod` values.

Implementation references: [collector configuration](https://opentelemetry.io/docs/collector/configuration/), [file-backed bearer-token authenticator](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.161.0/extension/bearertokenauthextension/README.md), [OTLP HTTP exporter](https://github.com/open-telemetry/opentelemetry-collector/blob/v0.161.0/exporter/otlphttpexporter/README.md).
