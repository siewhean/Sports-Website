# OCI staging image for the Matchday monorepo.

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build

WORKDIR /app
ENV COREPACK_HOME=/tmp/corepack

RUN corepack enable \
  && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
COPY apps/ apps/
COPY packages/ packages/
RUN pnpm install --frozen-lockfile

COPY . .
ARG MATCHDAY_BUILD_ID
ARG MATCHDAY_PUBLIC_ORIGIN
ENV MATCHDAY_BUILD_ID=${MATCHDAY_BUILD_ID}
ENV MATCHDAY_PUBLIC_ORIGIN=${MATCHDAY_PUBLIC_ORIGIN}
RUN pnpm --filter @matchday/api... build \
  && pnpm --filter @matchday/worker... build \
  && pnpm --filter @matchday/scheduler... build \
  && pnpm --filter @matchday/web... build

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV COREPACK_HOME=/tmp/corepack

RUN corepack enable \
  && corepack prepare pnpm@10.33.0 --activate

COPY --from=build /app ./

FROM runtime AS api
CMD ["pnpm", "--filter", "@matchday/api", "start"]

FROM runtime AS worker
CMD ["pnpm", "--filter", "@matchday/worker", "start"]

FROM runtime AS web
CMD ["pnpm", "--filter", "@matchday/web", "start"]

FROM runtime AS migrate
CMD ["pnpm", "--filter", "@matchday/database", "db:migrate"]
