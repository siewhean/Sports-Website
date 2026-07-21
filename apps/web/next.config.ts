import type { NextConfig } from "next";
import { randomBytes } from "node:crypto";
import path from "node:path";

const requestedBuildId = process.env.MATCHDAY_BUILD_ID?.trim();
if (requestedBuildId !== undefined && !/^[A-Za-z0-9._-]{8,128}$/u.test(requestedBuildId)) {
  throw new Error("MATCHDAY_BUILD_ID must contain 8-128 URL-safe characters");
}

// Next's generated build ID is normally internal. Owning it here lets the
// release verifier bind a running origin to the exact signed-off manifest.
const releaseBuildId = requestedBuildId ?? randomBytes(18).toString("base64url");

const nextConfig: NextConfig = {
  compress: true,
  generateBuildId: async () => releaseBuildId,
  headers: async () => [
    {
      source: "/:path*",
      headers: [{ key: "X-Matchday-Build-Id", value: releaseBuildId }],
    },
  ],
  images: {
    formats: ["image/avif", "image/webp"],
    minimumCacheTTL: 31_536_000,
  },
  poweredByHeader: false,
  turbopack: {
    root: path.resolve(process.cwd(), "../.."),
  },
};

export default nextConfig;
