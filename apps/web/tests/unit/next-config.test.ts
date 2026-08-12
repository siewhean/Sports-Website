import { afterEach, describe, expect, it, vi } from "vitest";

const originalBuildId = process.env.MATCHDAY_BUILD_ID;
const originalRenderApiOrigin = process.env.RENDER_API_ORIGIN;

afterEach(() => {
  vi.resetModules();
  if (originalBuildId === undefined) delete process.env.MATCHDAY_BUILD_ID;
  else process.env.MATCHDAY_BUILD_ID = originalBuildId;
  if (originalRenderApiOrigin === undefined) delete process.env.RENDER_API_ORIGIN;
  else process.env.RENDER_API_ORIGIN = originalRenderApiOrigin;
});

describe("V1 preview API rewrite", () => {
  it("does not add a proxy route until an origin is configured", async () => {
    delete process.env.RENDER_API_ORIGIN;
    process.env.MATCHDAY_BUILD_ID = "v1-preview-without-render-origin";

    const config = (await import("../../next.config")).default;

    await expect(config.rewrites?.()).resolves.toEqual([]);
  });

  it("proxies only the API namespace to the validated server-only origin", async () => {
    process.env.RENDER_API_ORIGIN = "https://matchday-v1-api.onrender.com";
    process.env.MATCHDAY_BUILD_ID = "v1-preview-with-render-origin";

    const config = (await import("../../next.config")).default;

    await expect(config.rewrites?.()).resolves.toEqual([
      {
        source: "/api/v1/:path*",
        destination: "https://matchday-v1-api.onrender.com/api/v1/:path*",
      },
    ]);
  });

  it.each([
    "http://matchday-v1-api.onrender.com",
    "https://user:secret@matchday-v1-api.onrender.com",
    "https://matchday-v1-api.onrender.com/api/v1",
    "https://matchday-v1-api.onrender.com?token=secret",
    "https://matchday-v1-api.onrender.com#fragment",
  ])("rejects an unsafe Render API origin: %s", async (origin) => {
    process.env.RENDER_API_ORIGIN = origin;
    process.env.MATCHDAY_BUILD_ID = "v1-preview-invalid-render-origin";

    await expect(import("../../next.config")).rejects.toThrow("RENDER_API_ORIGIN");
  });
});
