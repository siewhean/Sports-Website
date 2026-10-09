import { afterEach, describe, expect, it, vi } from "vitest";

const originalBuildId = process.env.MATCHDAY_BUILD_ID;
const originalLegacyApiOrigin = process.env.RENDER_API_ORIGIN;
const originalApiOrigin = process.env.API_ORIGIN;

afterEach(() => {
  vi.resetModules();
  if (originalBuildId === undefined) delete process.env.MATCHDAY_BUILD_ID;
  else process.env.MATCHDAY_BUILD_ID = originalBuildId;
  if (originalLegacyApiOrigin === undefined) delete process.env.RENDER_API_ORIGIN;
  else process.env.RENDER_API_ORIGIN = originalLegacyApiOrigin;
  if (originalApiOrigin === undefined) delete process.env.API_ORIGIN;
  else process.env.API_ORIGIN = originalApiOrigin;
});

describe("V1 preview API rewrite", () => {
  it("does not add a proxy route until an origin is configured", async () => {
    delete process.env.RENDER_API_ORIGIN;
    delete process.env.API_ORIGIN;
    process.env.MATCHDAY_BUILD_ID = "v1-preview-without-api-origin";

    const config = (await import("../../next.config")).default;

    await expect(config.rewrites?.()).resolves.toEqual([]);
  });

  it("proxies only the API namespace to the validated server-only origin", async () => {
    process.env.API_ORIGIN = "https://api.example.test";
    process.env.MATCHDAY_BUILD_ID = "v1-preview-with-api-origin";

    const config = (await import("../../next.config")).default;

    await expect(config.rewrites?.()).resolves.toEqual([
      {
        source: "/api/v1/:path*",
        destination: "https://api.example.test/api/v1/:path*",
      },
    ]);
  });

  it("falls back to the deprecated RENDER_API_ORIGIN when API_ORIGIN is unset, and prefers API_ORIGIN", async () => {
    delete process.env.API_ORIGIN;
    process.env.RENDER_API_ORIGIN = "https://legacy.example.test";
    process.env.MATCHDAY_BUILD_ID = "v1-preview-legacy-origin-fallback";
    const legacy = (await import("../../next.config")).default;
    await expect(legacy.rewrites?.()).resolves.toEqual([
      { source: "/api/v1/:path*", destination: "https://legacy.example.test/api/v1/:path*" },
    ]);

    vi.resetModules();
    process.env.API_ORIGIN = "https://api.example.test";
    const preferred = (await import("../../next.config")).default;
    await expect(preferred.rewrites?.()).resolves.toEqual([
      { source: "/api/v1/:path*", destination: "https://api.example.test/api/v1/:path*" },
    ]);
  });

  it("redirects interactive identity routes directly to the API origin to preserve host-bound OIDC flow cookies", async () => {
    process.env.API_ORIGIN = "https://api.example.test";
    process.env.MATCHDAY_BUILD_ID = "v1-preview-with-api-origin";

    const config = (await import("../../next.config")).default;

    await expect(config.redirects?.()).resolves.toEqual([
      {
        source: "/api/v1/identity/authorize",
        destination: "https://api.example.test/api/v1/identity/authorize",
        permanent: false,
      },
      {
        source: "/api/v1/identity/callback",
        destination: "https://api.example.test/api/v1/identity/callback",
        permanent: false,
      },
      {
        source: "/api/v1/identity/recovery",
        destination: "https://api.example.test/api/v1/identity/recovery",
        permanent: false,
      },
      {
        source: "/api/v1/identity/sign-out",
        destination: "https://api.example.test/api/v1/identity/sign-out",
        permanent: false,
      },
    ]);
  });

  it.each([
    "http://api.example.test",
    "https://user:secret@api.example.test",
    "https://api.example.test/api/v1",
    "https://api.example.test?token=secret",
    "https://api.example.test#fragment",
  ])("rejects an unsafe API origin: %s", async (origin) => {
    process.env.API_ORIGIN = origin;
    process.env.MATCHDAY_BUILD_ID = "v1-preview-invalid-api-origin";

    await expect(import("../../next.config")).rejects.toThrow("API_ORIGIN");
  });

  it("configures workspace transpilePackages and deterministic turbopack root", async () => {
    delete process.env.RENDER_API_ORIGIN;
    delete process.env.API_ORIGIN;
    process.env.MATCHDAY_BUILD_ID = "v1-preview-test-transpile-packages";

    const config = (await import("../../next.config")).default;

    expect(config.transpilePackages).toEqual([
      "@matchday/contracts",
      "@matchday/domain",
      "@matchday/feature-flags",
      "@matchday/ui",
    ]);
    expect(config.turbopack?.root).toBeDefined();
    expect(typeof config.turbopack?.root).toBe("string");
  });
});
