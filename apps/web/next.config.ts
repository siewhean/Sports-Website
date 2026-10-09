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

export function renderApiOrigin(value = process.env.RENDER_API_ORIGIN): string | null {
  const configured = value?.trim();
  if (!configured) return null;

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("RENDER_API_ORIGIN must be an absolute HTTPS origin");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("RENDER_API_ORIGIN must be an absolute HTTPS origin without credentials, path, query, or fragment");
  }

  return parsed.origin;
}

// Next's generated build ID is normally internal. Owning it here lets the
// release verifier bind a running origin to the exact signed-off manifest.
const releaseBuildId = requestedBuildId ?? randomBytes(18).toString("base64url");
const configuredRenderApiOrigin = renderApiOrigin();

// Sentry release/environment are inlined at build time for both runtimes. The
// DSN itself is never defaulted here: with no DSN configured Sentry is inert.
const sentryRelease = requestedBuildId ?? process.env.VERCEL_GIT_COMMIT_SHA?.trim() ?? releaseBuildId;
const sentryEnvironment = process.env.APP_ENV?.trim() || process.env.VERCEL_ENV?.trim() || process.env.NODE_ENV;

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
    configuredRenderApiOrigin
      ? [
          {
            source: "/api/v1/identity/authorize",
            destination: `${configuredRenderApiOrigin}/api/v1/identity/authorize`,
            permanent: false,
          },
          {
            source: "/api/v1/identity/callback",
            destination: `${configuredRenderApiOrigin}/api/v1/identity/callback`,
            permanent: false,
          },
          {
            source: "/api/v1/identity/recovery",
            destination: `${configuredRenderApiOrigin}/api/v1/identity/recovery`,
            permanent: false,
          },
          {
            source: "/api/v1/identity/sign-out",
            destination: `${configuredRenderApiOrigin}/api/v1/identity/sign-out`,
            permanent: false,
          },
        ]
      : [],
  rewrites: async () =>
    configuredRenderApiOrigin
      ? [
          {
            source: "/api/v1/:path*",
            destination: `${configuredRenderApiOrigin}/api/v1/:path*`,
          },
        ]
      : [],
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
