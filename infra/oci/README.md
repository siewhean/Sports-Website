# OCI controlled staging

This is a provider-specific deployment for the Matchday API, PostgreSQL, Redis, worker, and Caddy HTTPS proxy. It is intended to replace the free Render service for Gate D controlled staging while preserving exact-SHA and retained-receipt rules. Base and dependency images are pinned by digest; update those digests as a reviewed dependency change.

## VM and network

Create an OCI Always Free Ampere A1 VM in the tenancy home region. The current Always Free allowance is up to 2 OCPUs and 12 GB RAM in total, subject to OCI capacity. Use Ubuntu ARM64. Add ingress rules for TCP 22 from the operator IP and TCP 80/443 from the internet. Do not expose PostgreSQL 5432 or Redis 6379.

Install Docker Engine and the Compose plugin, clone this repository, and create `infra/oci/.env.oci` from `.env.oci.example`. Generate unique URL-safe secrets; do not commit the file. Replace every `CHANGE_ME` token and both `staging.example.com` and `example.com` values with the real staging hostname and its apex registrable domain. Keep `SCORING_SESSION_SEAL_KEY` separate from the API HMAC keys because the web BFF uses it to seal its host-only scoring cookie. Configure the required OIDC tenant, edge-cache purge bridge, and SMTP sink/provider. Create an A record for `OCI_PUBLIC_HOSTNAME` pointing to the VM before starting Caddy so it can obtain a certificate. The fixed Compose address `172.30.0.10` is Caddy; keep `API_TRUSTED_PROXIES=172.30.0.10` so client IPs survive the proxy for rate limiting.

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

The script refuses a dirty checkout, runs migrations in a one-shot container, starts the API and worker, waits for `/health/ready`, and verifies `/api/v1/meta/build` reports the exact candidate SHA. PostgreSQL and Redis are reachable only on the Compose backend network.

The workflow intentionally accepts any full SHA that the staging checkout can fetch; release approval supplies the candidate SHA and the API attestation prevents a different image from being mistaken for it. Keep branch and approval policy in the protected GitHub environment rather than relying on a provider-specific branch name.

The API already runs the scheduler inline. The worker service is included for the email outbox and queue work. For a scoring-only qualification, the worker may remain running but must not share the VM with unrelated workloads.

## Gate D qualification

After the deployment is ready, run the unchanged QA-010 and QA-011 staging workload from the controlled runner with `TARGET_URL=https://staging.example.com` and `CANDIDATE_SHA` set to the deployed full SHA. Retain the seed, scoring, result-propagation, and public-load receipts. OCI deployment readiness is infrastructure evidence; it does not replace the local pilot, physical-device, tabletop, or independent-review evidence required by the Gate D freeze validator.

For the scoring latency investigation, compare `DB_POOL_MAX=8`, `12`, and `20` in separate clean runs. Keep the configuration that produces server p95 below 400 ms and client p95 below 500 ms. Do not change the QA-011 workload, threshold, or receipt validator.

## Operations

```sh
docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml ps
docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml logs --tail=200 api
docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml logs --tail=200 postgres redis
```

Back up the PostgreSQL volume before destructive maintenance. Rotate the `.env.oci` secrets through the configured secret-handling process, then redeploy a new exact SHA. Treat the VM as staging infrastructure and keep database/Redis ports private.
