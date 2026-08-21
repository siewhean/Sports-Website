import type { NextConfig } from "next";
import { randomBytes } from "node:crypto";
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

const nextConfig: NextConfig = {
  compress: true,
  generateBuildId: async () => releaseBuildId,
  headers: async () => [
    {
      source: "/:path*",
      headers: [{ key: "X-Matchday-Build-Id", value: releaseBuildId }],
    },
  ],
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

export default nextConfig;
