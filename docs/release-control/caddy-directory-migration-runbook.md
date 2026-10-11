# Conditional production Caddy mount migration

PLAN ONLY — no commands executed. An authorised operator must approve a maintenance window, expected ingress interruption, tested recovery and both production/staging impact. The live mount is UNKNOWN; migrate only if the preflight proves incompatibility. Do not infer current mount from PR65 age.

## Read-only operator preflight

From the exact approved clean checkout on the host, export the approved non-secret `OCI_PROD_HOSTNAME` and `OCI_STAGING_HOSTNAME`. Use the staging/shared-ingress Compose file with `.env.oci`; production application Compose uses `.env.prod`. Do not print either environment file or unrestricted Compose config.

```sh
git rev-parse HEAD
git status --porcelain
docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml config --quiet
caddy_cid=$(docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml ps -q caddy)
test -n "$caddy_cid"
docker inspect "$caddy_cid" --format '{{range .Mounts}}{{println .Type .Source .Destination .RW}}{{end}}'
docker inspect "$caddy_cid" --format '{{json .NetworkSettings.Networks}}'
docker inspect "$caddy_cid" --format '{{.Config.Image}} {{.Image}}'
docker exec "$caddy_cid" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Accept one read-only directory bind to `/etc/caddy`, no file bind to `/etc/caddy/Caddyfile`, and both required networks. Stop on empty/ambiguous service identity or unexpected topology. Record only mount/network/image observations, not complete `docker inspect` output. Ensure runtime template hostname substitutions match approved public domains and existing active-slot routing. Runtime validation uses the serving container environment; an isolated Caddy validator lacking the hostname values is insufficient.

## Approved conditional migration

If compatible, retain evidence and skip recreation. Otherwise the operator must save the exact previous runtime Caddyfile and Compose/environment configuration privately, identify previous image digest and active-slot routes, verify both hostnames, and validate the proposed config using the same environment as the serving container before scheduling replacement. Read the pinned Caddy image from the approved candidate `infra/oci/compose.yaml`; never reuse a copied historical digest. Pull only the service image, then recreate only shared ingress:

```sh
docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml pull caddy
docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml up -d --no-deps --force-recreate caddy
```

These are mutating operator procedures and require separate explicit approval. Avoid stack-wide `down`, manual network attachment to hide incompatible Compose topology, or changing application slots. Shared ingress recreation can interrupt both staging and production; it is not a zero-downtime proof.

Repeat targeted preflight, serving-environment validation, both domains' TLS/HTTP checks and active-slot API/web identity. A failed check stops forward deployment. Do not test mount freshness by replacing live routing with an unreviewed probe configuration.

## Recovery and evidence

Before proceeding the operator must have a service-only recovery procedure using the privately retained previous config/image and approved hostnames. If recreation fails, restore those files and recreate only `caddy` with the correct `.env.oci` and previous approved image; validate, verify both domains and active-slot routing, and record failure. Never choose a backup by an unverified wildcard or run stack-wide teardown. If recovery cannot be validated, declare an incident and retain traffic state; do not continue deployment.

Receipt: approval/window/operator, UTC timestamps, candidate SHA/tree, previous/new image digests, redacted mount/network observations, hostname correspondence, validation exit codes, TLS/HTTP results, outage duration and recovery result. Successful mount migration alone does not prove deployment freeze, zero-downtime rollout or rollback. See [deployment plan](exact-sha-deployment-plan.md).
