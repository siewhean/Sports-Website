import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () => {
    throw new Error("headers() called outside a request scope");
  },
  cookies: async () => ({ get: () => undefined }),
}));

const { GET } = await import("../../app/api/public/competitions/[slug]/snapshot/route");
const { fetchPublicSnapshot, publicSnapshotPath } = await import("@/lib/public-snapshot");

function call(slug: string) {
  return GET(new Request(`https://matchday.test${publicSnapshotPath(slug)}`), { params: Promise.resolve({ slug }) });
}

describe("public snapshot route", () => {
  beforeEach(() => {
    vi.stubEnv("MATCHDAY_PHASE2_DATA_MODE", "demo");
    vi.stubEnv("MATCHDAY_ALLOW_DEMO_FIXTURES", "1");
    vi.stubEnv("APP_ENV", "test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("serves the page view model with a short shared CDN cache and an ETag", async () => {
    const response = await call("singapore-open");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=2, stale-while-revalidate=10");
    expect(response.headers.get("etag")).toMatch(/^".+"$/u);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const body = (await response.json()) as { version: number; etag: string; competition: { slug: string } };
    expect(body.version).toBe(1);
    expect(body.competition.slug).toBe("singapore-open");
    expect(response.headers.get("etag")).toBe(`"${body.etag}"`);
  });

  it("returns a briefly cached 404 for unknown or malformed slugs", async () => {
    const malformed = await call("Not_A_Slug");
    expect(malformed.status).toBe(404);
    expect(malformed.headers.get("cache-control")).toContain("s-maxage=10");
  });

  it("reports an upstream outage as an uncached 503, not a 404", async () => {
    vi.stubEnv("MATCHDAY_PHASE2_DATA_MODE", "api");
    vi.stubEnv("MATCHDAY_API_BASE_URL", "https://api.matchday.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("busy", { status: 502 })));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await call("summer-cup");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("fetchPublicSnapshot", () => {
  beforeEach(() => {
    vi.stubEnv("MATCHDAY_PHASE2_DATA_MODE", "demo");
    vi.stubEnv("MATCHDAY_ALLOW_DEMO_FIXTURES", "1");
    vi.stubEnv("APP_ENV", "test");
  });

  afterEach(() => vi.unstubAllEnvs());

  const viaRoute: typeof fetch = async (input) => {
    const slug = String(input).split("/")[4] ?? "";
    return call(decodeURIComponent(slug));
  };

  it("returns the competition view and ETag, then not_modified for the same ETag", async () => {
    const first = await fetchPublicSnapshot("singapore-open", null, { fetchImpl: viaRoute });
    expect(first.status).toBe("updated");
    if (first.status !== "updated") return;
    expect(first.competition.slug).toBe("singapore-open");
    const second = await fetchPublicSnapshot("singapore-open", first.etag, { fetchImpl: viaRoute });
    expect(second).toEqual({ status: "not_modified", etag: first.etag });
  });

  it("sends If-None-Match and maps a CDN 304 to not_modified", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 304 }));
    await expect(fetchPublicSnapshot("summer-cup", "abc", { fetchImpl })).resolves.toEqual({
      status: "not_modified",
      etag: "abc",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/public/competitions/summer-cup/snapshot",
      expect.objectContaining({ credentials: "omit", headers: expect.objectContaining({ "if-none-match": '"abc"' }) }),
    );
  });

  it("maps 404, outages, malformed bodies and network errors without throwing", async () => {
    await expect(
      fetchPublicSnapshot("x", null, { fetchImpl: async () => new Response(null, { status: 404 }) }),
    ).resolves.toEqual({
      status: "not_found",
    });
    await expect(
      fetchPublicSnapshot("x", null, { fetchImpl: async () => new Response(null, { status: 503 }) }),
    ).resolves.toEqual({
      status: "unavailable",
      httpStatus: 503,
    });
    await expect(
      fetchPublicSnapshot("x", null, { fetchImpl: async () => Response.json({ nope: true }) }),
    ).resolves.toEqual({
      status: "unavailable",
      httpStatus: 200,
    });
    await expect(
      fetchPublicSnapshot("x", null, {
        fetchImpl: async () => {
          throw new TypeError("network down");
        },
      }),
    ).resolves.toEqual({ status: "unavailable", httpStatus: null });
  });
});
