import { afterEach, describe, expect, it, vi } from "vitest";

const originalBuildId = process.env.MATCHDAY_BUILD_ID;
const originalApiBaseUrl = process.env.MATCHDAY_API_BASE_URL;
const originalApiOrigin = process.env.API_ORIGIN;

afterEach(() => {
  vi.resetModules();
  if (originalBuildId === undefined) delete process.env.MATCHDAY_BUILD_ID;
  else process.env.MATCHDAY_BUILD_ID = originalBuildId;
  if (originalApiBaseUrl === undefined) delete process.env.MATCHDAY_API_BASE_URL;
  else process.env.MATCHDAY_API_BASE_URL = originalApiBaseUrl;
  if (originalApiOrigin === undefined) delete process.env.API_ORIGIN;
  else process.env.API_ORIGIN = originalApiOrigin;
});

describe("V1 preview API rewrite", () => {
  it("does not add a proxy route until an origin is configured", async () => {
    delete process.env.MATCHDAY_API_BASE_URL;
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

  it("ignores MATCHDAY_API_BASE_URL (including local http e2e values) when API_ORIGIN is unset", async () => {
    delete process.env.API_ORIGIN;
    process.env.MATCHDAY_API_BASE_URL = "http://127.0.0.1:4000";
    process.env.MATCHDAY_BUILD_ID = "v1-preview-base-url-ignored";
    const config = (await import("../../next.config")).default;
    await expect(config.rewrites?.()).resolves.toEqual([]);
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
    delete process.env.MATCHDAY_API_BASE_URL;
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
