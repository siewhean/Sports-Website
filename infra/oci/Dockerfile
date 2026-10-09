# Matchday monorepo images (api, web, worker, migrate).
#
# Built by CI (.github/workflows/ci.yml, job "images") and pulled by infra/oci/deploy-prod.sh by exact-SHA tag.
# `deploy-prod.sh --build-locally` and the staging compose.yaml still build from this file on the host.
#
# Stages:
#   build         full toolchain + dev dependencies; compiles api/worker/scheduler/web
#   migrate       one-shot migration tool image (needs tsx + workspace sources, so it is the full build stage)
#   prod-assemble prunes dev dependencies and copies only manifests, node_modules and built output
#   runtime       non-root, production dependencies and build output only (no pnpm/corepack, no toolchain)
#   api|worker|web  serving images derived from runtime

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build

WORKDIR /app
# CI=true keeps pnpm non-interactive when it later rewrites node_modules for the production prune.
ENV COREPACK_HOME=/tmp/corepack
ENV CI=true

RUN corepack enable \
  && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/ apps/
COPY packages/ packages/
RUN pnpm install --frozen-lockfile

COPY . .
ARG MATCHDAY_BUILD_ID
ARG BUILD_TIMESTAMP
ARG MATCHDAY_PUBLIC_ORIGIN
# Public (browser-visible) Next.js values are inlined at build time, so they must be supplied as build args.
ARG NEXT_PUBLIC_MATCHDAY_API_BASE_URL
ARG NEXT_PUBLIC_SENTRY_DSN
ENV MATCHDAY_BUILD_ID=${MATCHDAY_BUILD_ID}
ENV BUILD_TIMESTAMP=${BUILD_TIMESTAMP}
ENV MATCHDAY_PUBLIC_ORIGIN=${MATCHDAY_PUBLIC_ORIGIN}
ENV NEXT_PUBLIC_MATCHDAY_API_BASE_URL=${NEXT_PUBLIC_MATCHDAY_API_BASE_URL}
# Inlined into the browser bundle at build time; empty keeps Sentry off.
ENV NEXT_PUBLIC_SENTRY_DSN=${NEXT_PUBLIC_SENTRY_DSN}
RUN pnpm --filter @matchday/api... build \
  && pnpm --filter @matchday/worker... build \
  && pnpm --filter @matchday/scheduler... build \
  && pnpm --filter @matchday/web... build

# ---- migrate: runs once per deploy (`compose run --rm migrate`), never serves traffic -------------------------
FROM build AS migrate
ARG MATCHDAY_BUILD_ID
ARG BUILD_TIMESTAMP
LABEL org.opencontainers.image.revision="${MATCHDAY_BUILD_ID}"
LABEL org.opencontainers.image.created="${BUILD_TIMESTAMP}"
LABEL org.opencontainers.image.source="https://github.com/siewhean/Sports-Website"
USER node
ENV HOME=/tmp
CMD ["pnpm", "--filter", "@matchday/database", "db:migrate"]

# ---- prod-assemble: production dependencies + built output only ----------------------------------------------
FROM build AS prod-assemble
# Remove devDependencies from the already-fetched store; fails the build if the lockfile and manifests disagree.
RUN pnpm install --frozen-lockfile --prod --prefer-offline
RUN set -eux; \
  rm -rf apps/web/.next/cache; \
  mkdir -p /out; \
  cp package.json pnpm-lock.yaml pnpm-workspace.yaml /out/; \
  cp -a node_modules /out/node_modules; \
  for dir in apps/* packages/*; do \
    [ -f "$dir/package.json" ] || continue; \
    mkdir -p "/out/$dir"; \
    cp "$dir/package.json" "/out/$dir/package.json"; \
    for item in dist node_modules .next public next.config.ts; do \
      if [ -e "$dir/$item" ]; then cp -a "$dir/$item" "/out/$dir/$item"; fi; \
    done; \
  done

# ---- runtime ---------------------------------------------------------------------------------------------------
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime

WORKDIR /app
ENV NODE_ENV=production
# Only writable locations: /tmp (HOME) and the Next.js cache directory below. Everything else can be mounted read-only.
ENV HOME=/tmp

ARG MATCHDAY_BUILD_ID
ARG BUILD_TIMESTAMP
ENV MATCHDAY_BUILD_ID=${MATCHDAY_BUILD_ID}
ENV BUILD_TIMESTAMP=${BUILD_TIMESTAMP}

LABEL org.opencontainers.image.revision="${MATCHDAY_BUILD_ID}"
LABEL org.opencontainers.image.created="${BUILD_TIMESTAMP}"
LABEL org.opencontainers.image.source="https://github.com/siewhean/Sports-Website"

# Application files stay root-owned (immutable to the runtime user).
COPY --from=prod-assemble /out/ ./
RUN mkdir -p /app/apps/web/.next/cache \
  && chown node:node /app/apps/web/.next/cache
USER node

FROM runtime AS api
WORKDIR /app/apps/api
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health/live').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]
CMD ["node", "dist/main.js"]

FROM runtime AS worker
WORKDIR /app/apps/worker
CMD ["node", "dist/main.js"]

FROM runtime AS web
WORKDIR /app/apps/web
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]
CMD ["node", "node_modules/next/dist/bin/next", "start"]
