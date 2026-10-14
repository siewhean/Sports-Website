import type { NextConfig } from "next";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const requestedBuildId = process.env.MATCHDAY_BUILD_ID?.trim();
if (requestedBuildId !== undefined && !/^[A-Za-z0-9._-]{8,128}$/u.test(requestedBuildId)) {
  throw new Error("MATCHDAY_BUILD_ID must contain 8-128 URL-safe characters");
}

// API_ORIGIN is the canonical server-only HTTPS origin of the API service. There is deliberately no fallback:
// MATCHDAY_API_BASE_URL may be a local http origin in e2e builds and must not enable the HTTPS rewrite.
export function apiOrigin(value = process.env.API_ORIGIN): string | null {
  const configured = value?.trim();
  if (!configured) return null;

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("API_ORIGIN must be an absolute HTTPS origin");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("API_ORIGIN must be an absolute HTTPS origin without credentials, path, query, or fragment");
  }

  return parsed.origin;
}

// Next's generated build ID is normally internal. Owning it here lets the
// release verifier bind a running origin to the exact signed-off manifest.
const releaseBuildId = requestedBuildId ?? randomBytes(18).toString("base64url");
const configuredApiOrigin = apiOrigin();

// Sentry release/environment are inlined at build time for both runtimes. The
// DSN itself is never defaulted here: with no DSN configured Sentry is inert.
const sentryRelease = requestedBuildId ?? process.env.VERCEL_GIT_COMMIT_SHA?.trim() ?? releaseBuildId;
const sentryEnvironment = process.env.APP_ENV?.trim() || process.env.VERCEL_ENV?.trim() || process.env.NODE_ENV;

export const productRouteRewrites = [
  // R6.3 Product route aliases for phase3 / phase4 / gate-c routes
  {
    source: "/api/competitions/:competitionId/divisions/:path*",
    destination: "/api/phase3/competitions/:competitionId/divisions/:path*",
  },
  {
    source: "/api/competitions/:competitionId/divisions",
    destination: "/api/phase3/competitions/:competitionId/divisions",
  },
  {
    source: "/api/competitions/:competitionId/capacity",
    destination: "/api/phase3/competitions/:competitionId/capacity",
  },
  {
    source: "/api/competitions/:competitionId/settings/:path*",
    destination: "/api/phase3/competitions/:competitionId/settings/:path*",
  },
  {
    source: "/api/competitions/:competitionId/settings",
    destination: "/api/phase3/competitions/:competitionId/settings",
  },
  {
    source: "/api/competitions/:competitionId/setup-draft/:path*",
    destination: "/api/phase4/competitions/:competitionId/setup-draft/:path*",
  },
  {
    source: "/api/competitions/:competitionId/setup-draft",
    destination: "/api/phase4/competitions/:competitionId/setup-draft",
  },
  {
    source: "/api/competitions/:competitionId/officials/:path*",
    destination: "/api/phase4/competitions/:competitionId/officials/:path*",
  },
  {
    source: "/api/competitions/:competitionId/officials",
    destination: "/api/phase4/competitions/:competitionId/officials",
  },
  {
    source: "/api/competitions/:competitionId/matches/:path*",
    destination: "/api/phase4/competitions/:competitionId/matches/:path*",
  },
  {
    source: "/api/competitions/:competitionId/matches",
    destination: "/api/phase4/competitions/:competitionId/matches",
  },
  {
    source: "/api/competitions/:competitionId/schedule/:path*",
    destination: "/api/phase4/competitions/:competitionId/schedule/:path*",
  },
  {
    source: "/api/competitions/:competitionId/v1-format-recommendations/:path*",
    destination: "/api/phase4/competitions/:competitionId/v1-format-recommendations/:path*",
  },
  {
    source: "/api/competitions/:competitionId/repairs/:path*",
    destination: "/api/gate-c/competitions/:competitionId/repairs/:path*",
  },
  {
    source: "/api/competitions/:competitionId/repairs",
    destination: "/api/gate-c/competitions/:competitionId/repairs",
  },
  {
    source: "/api/competitions/:competitionId/access-passes/:path*",
    destination: "/api/gate-c/competitions/:competitionId/access-passes/:path*",
  },
  {
    source: "/api/competitions/:competitionId/access-passes",
    destination: "/api/gate-c/competitions/:competitionId/access-passes",
  },
  {
    source: "/api/competitions/:competitionId/result-conflicts/:path*",
    destination: "/api/gate-c/competitions/:competitionId/result-conflicts/:path*",
  },
  {
    source: "/api/competitions/:competitionId/result-conflicts",
    destination: "/api/gate-c/competitions/:competitionId/result-conflicts",
  },
  {
    source: "/api/competitions/:competitionId/takeover-requests/:path*",
    destination: "/api/gate-c/competitions/:competitionId/takeover-requests/:path*",
  },
  {
    source: "/api/competitions/:competitionId/exports/:path*",
    destination: "/api/gate-c/competitions/:competitionId/exports/:path*",
  },
  {
    source: "/api/competitions",
    destination: "/api/phase3/competitions",
  },
  {
    source: "/api/competitions/:competitionId",
    destination: "/api/phase3/competitions/:competitionId",
  },
  {
    source: "/api/organisations/bootstrap",
    destination: "/api/phase3/organisations/bootstrap",
  },
  {
    source: "/api/organisations/:organisationId/format-templates/:path*",
    destination: "/api/phase4/organisations/:organisationId/format-templates/:path*",
  },
  {
    source: "/api/organisations/:organisationId/format-templates",
    destination: "/api/phase4/organisations/:organisationId/format-templates",
  },
  {
    source: "/api/organisations/:organisationId/ai/:path*",
    destination: "/api/phase4/organisations/:organisationId/ai/:path*",
  },
  {
    source: "/api/schedule/:path*",
    destination: "/api/phase4/schedule/:path*",
  },
  {
    source: "/api/format-revisions/:path*",
    destination: "/api/phase4/format-revisions/:path*",
  },
  {
    source: "/api/admin/feature-flags/:path*",
    destination: "/api/phase3/admin/feature-flags/:path*",
  },
  {
    source: "/api/admin/sport-packs/:path*",
    destination: "/api/phase3/admin/sport-packs/:path*",
  },
];

const nextConfig: NextConfig = {
  compress: true,
  env: {
    NEXT_PUBLIC_SENTRY_RELEASE: sentryRelease,
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: sentryEnvironment ?? "development",
  },
  generateBuildId: async () => releaseBuildId,
  headers: async () => [
    {
      source: "/:path*",
      headers: [{ key: "X-Matchday-Build-Id", value: releaseBuildId }],
    },
  ],
  redirects: async () =>
    configuredApiOrigin
      ? [
          {
            source: "/api/v1/identity/authorize",
            destination: `${configuredApiOrigin}/api/v1/identity/authorize`,
            permanent: false,
          },
          {
            source: "/api/v1/identity/callback",
            destination: `${configuredApiOrigin}/api/v1/identity/callback`,
            permanent: false,
          },
          {
            source: "/api/v1/identity/recovery",
            destination: `${configuredApiOrigin}/api/v1/identity/recovery`,
            permanent: false,
          },
          {
            source: "/api/v1/identity/sign-out",
            destination: `${configuredApiOrigin}/api/v1/identity/sign-out`,
            permanent: false,
          },
        ]
      : [],
  rewrites: async () => [
    ...(configuredApiOrigin
      ? [
          {
            source: "/api/v1/:path*",
            destination: `${configuredApiOrigin}/api/v1/:path*`,
          },
        ]
      : []),
    ...productRouteRewrites,
  ],
  images: {
    formats: ["image/avif", "image/webp"],
    minimumCacheTTL: 31_536_000,
  },
  transpilePackages: ["@matchday/contracts", "@matchday/domain", "@matchday/feature-flags", "@matchday/ui"],
  poweredByHeader: false,
  turbopack: {
    root: monorepoRoot,
  },
};

// Source-map upload is opt-in: only wrap with the Sentry build plugin when an
// auth token is present, so builds never need (or contact) Sentry by default.
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN?.trim();
// next.config.ts cannot use top-level await, so load the plugin lazily and synchronously.
const exportedConfig: NextConfig = sentryAuthToken
  ? (
      createRequire(import.meta.url)("@sentry/nextjs/config") as typeof import("@sentry/nextjs/config")
    ).withSentryConfig(nextConfig, {
      authToken: sentryAuthToken,
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      release: { name: sentryRelease },
      silent: true,
      telemetry: false,
      sourcemaps: { deleteSourcemapsAfterUpload: true },
    })
  : nextConfig;

export default exportedConfig;
