import type { NextConfig } from "next";
import { randomBytes } from "node:crypto";
import path from "node:path";

const requestedBuildId = process.env.MATCHDAY_BUILD_ID?.trim();
if (requestedBuildId !== undefined && !/^[A-Za-z0-9._-]{8,128}$/u.test(requestedBuildId)) {
  throw new Error("MATCHDAY_BUILD_ID must contain 8-128 URL-safe characters");
}

const appEnvironment = process.env.APP_ENV?.trim() || "local";
if (!["local", "test", "staging", "production"].includes(appEnvironment)) {
  throw new Error("APP_ENV must be local, test, staging, or production");
}
const dataMode = process.env.MATCHDAY_PHASE2_DATA_MODE?.trim() || "api";
if (dataMode !== "api" && dataMode !== "demo") {
  throw new Error("MATCHDAY_PHASE2_DATA_MODE must be api or demo");
}
if ((appEnvironment === "staging" || appEnvironment === "production") && dataMode === "demo") {
  throw new Error("MATCHDAY_PHASE2_DATA_MODE=demo is forbidden in staging and production");
}
if ((appEnvironment === "staging" || appEnvironment === "production") && !process.env.MATCHDAY_API_BASE_URL?.trim()) {
  throw new Error("MATCHDAY_API_BASE_URL must be configured in staging and production");
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
