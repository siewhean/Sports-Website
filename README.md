# MATCHDAY

Competition planning, scheduling, scorekeeping, and public results platform. The repository is a pnpm/Turborepo monorepo with a Next.js web application, Fastify API, BullMQ worker, PostgreSQL domain storage, shared packages, and local production-like dependencies.

## Prerequisites

- Node `24.18.0` (see `.nvmrc` / `.node-version`)
- pnpm `10.33.0` via Corepack
- Docker Desktop with Compose
- Git and Gitleaks (the secrets script uses a pinned Docker fallback if Gitleaks is absent)

## Fresh-machine setup

```sh
nvm install
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm install --frozen-lockfile
pnpm run setup:workspace
docker compose -f infra/local/compose.yaml up -d --wait
pnpm db:migrate
pnpm check
pnpm test:e2e
```

Local services:

- web: `http://127.0.0.1:3000`
- API: `http://127.0.0.1:4000`
- API documentation outside production: `http://127.0.0.1:4000/docs`
- Mailpit: `http://127.0.0.1:8025`
- OpenTelemetry health when the `telemetry` Compose profile is enabled: `http://127.0.0.1:13133`

Start the application after dependencies and migrations are ready:

```sh
pnpm dev
```

## Verification commands

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm db:migrate:check
pnpm test:integration
pnpm backup:verify
pnpm validate:fixtures
pnpm validate:phase2
pnpm validate:phase3
pnpm openapi:check
pnpm secrets:scan
pnpm build
pnpm test:e2e
pnpm test:a11y
pnpm test:visual
```

Local/test verification is not evidence that hosted identity, sending-domain, CDN, telemetry, backup-retention, or deployment controls exist. Environment separation and provider evidence are tracked in `docs/operations/` and the execution roadmap.

## Repository map

- `apps/web` — public and role-specific shells plus Phase 0 prototypes
- `apps/api` — versioned HTTP API and health/observability controls
- `apps/worker` — typed durable job processing
- `packages/*` — config, contracts, database, domain, flags, identity, jobs, notifications, observability, and UI
- `infra/local` — PostgreSQL, Redis, Mailpit, and OpenTelemetry Collector
- `validation` — canonical competition fixtures and oracles
- `docs` — roadmap, decisions, product defaults, policies, QA, and operational runbooks
