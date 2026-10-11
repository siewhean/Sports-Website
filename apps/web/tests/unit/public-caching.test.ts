import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const apiFetchSpy = vi.fn();

vi.mock("@/lib/client-ip.server", () => ({
  apiFetch: (...args: unknown[]) => apiFetchSpy(...args),
}));

vi.mock("next/headers", () => ({
  headers: async () => {
    throw new Error("headers() called outside a request scope");
  },
  cookies: async () => ({ get: () => undefined }),
}));

const {
  getCompetitionListing,
  getCompetitionView,
  PUBLIC_COMPETITIONS_TAG,
  PUBLIC_COMPETITION_REVALIDATE_SECONDS,
  PUBLIC_LISTING_REVALIDATE_SECONDS,
  PublicDataUnavailableError,
  publicCompetitionTag,
  publicReadFreshness,
  readPublicSnapshot,
} = await import("@/lib/phase2-public.server");
const { isPublicDocumentPath, PUBLIC_DOCUMENT_HEADER, PUBLIC_READ_FRESHNESS_HEADER } =
  await import("@/lib/public-routes");
const { resolveSeoOrigin, seoOriginFromEnv, seoOriginFromRequest, vercelProductionOrigin } =
  await import("@/lib/public-origin");
const { proxy } = await import("../../proxy");

function notFoundResponse() {
  return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
}

describe("public read caching", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubEnv("MATCHDAY_API_BASE_URL", "https://api.matchday.test");
    vi.stubEnv("MATCHDAY_PHASE2_DATA_MODE", "api");
    vi.stubGlobal("fetch", fetchSpy);
    fetchSpy.mockReset();
    apiFetchSpy.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reads competitions through the Data Cache with tags and without forwarding an end-user IP", async () => {
    fetchSpy.mockResolvedValue(notFoundResponse());
    await expect(getCompetitionView("summer-cup-a")).resolves.toBeNull();
    expect(apiFetchSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { next?: unknown }];
    expect(url).toBe("https://api.matchday.test/api/v1/public/competitions/summer-cup-a/current");
    expect(init.cache).toBeUndefined();
    expect(init.next).toEqual({
      revalidate: PUBLIC_COMPETITION_REVALIDATE_SECONDS,
      tags: [PUBLIC_COMPETITIONS_TAG, publicCompetitionTag("summer-cup-a")],
    });
    expect(JSON.stringify(init.headers)).not.toContain("x-matchday-client-ip");
  });

  it("bypasses the Data Cache for live reads and keeps the per-client apiFetch", async () => {
    apiFetchSpy.mockResolvedValue(notFoundResponse());
    await expect(getCompetitionView("summer-cup-b", "live")).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(apiFetchSpy).toHaveBeenCalledWith(
      "https://api.matchday.test/api/v1/public/competitions/summer-cup-b/current",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("still distinguishes an upstream outage from a missing competition", async () => {
    fetchSpy.mockResolvedValue(new Response("busy", { status: 503 }));
    const failure = await getCompetitionView("summer-cup-c").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PublicDataUnavailableError);
    expect((failure as InstanceType<typeof PublicDataUnavailableError>).status).toBe(503);
  });

  it("never calls the API for a slug that cannot exist", async () => {
    await expect(getCompetitionView("../../etc")).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("caches the public listing with its own revalidation window", async () => {
    fetchSpy.mockResolvedValue(Response.json({ competitions: [] }));
    await expect(getCompetitionListing()).resolves.toEqual([]);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { next?: unknown }];
    expect(init.next).toEqual({ revalidate: PUBLIC_LISTING_REVALIDATE_SECONDS, tags: [PUBLIC_COMPETITIONS_TAG] });
  });

  it("reads snapshots uncached and server-originated (the route itself is CDN-cached)", async () => {
    fetchSpy.mockResolvedValue(notFoundResponse());
    await expect(readPublicSnapshot("summer-cup-d")).resolves.toEqual({ status: "not_found" });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { next?: unknown }];
    expect(init.cache).toBe("no-store");
    expect(init.next).toBeUndefined();
    expect(apiFetchSpy).not.toHaveBeenCalled();
  });

  it("defaults to cached freshness outside a request scope", async () => {
    await expect(publicReadFreshness()).resolves.toBe("cached");
  });
});

describe("public routes and proxy markers", () => {
  it("recognises spectator documents only", () => {
    for (const path of [
      "/",
      "/competitions",
      "/competitions/summer-cup",
      "/competitions/summer-cup/matches/m_1",
      "/pricing",
    ]) {
      expect(isPublicDocumentPath(path), path).toBe(true);
    }
    for (const path of [
      "/organiser",
      "/score",
      "/competitions/Summer",
      "/competitions/a/matches",
      "/api/public/x",
      "/notifications",
    ]) {
      expect(isPublicDocumentPath(path), path).toBe(false);
    }
  });

  it("keeps the service worker's public document patterns in sync with lib/public-routes", async () => {
    const source = await readFile(new URL("../../public/sw.js", import.meta.url), "utf8");
    const literal = /const PUBLIC_DOCUMENT_PATTERNS = (\[[\s\S]*?\]);/u.exec(source)?.[1];
    expect(literal).toBeDefined();
    const workerPatterns = [...(literal ?? "").matchAll(/^\s*\/(.+)\/u,?$/gmu)].map(
      (match) => new RegExp(match[1] ?? "", "u"),
    );
    expect(workerPatterns.length).toBeGreaterThan(3);
    const samples = [
      "/",
      "/competitions",
      "/competitions/",
      "/competitions/summer-cup",
      "/competitions/summer-cup/matches/m-1",
      "/competitions/summer-cup/schedule",
      "/organiser/competitions/summer-cup",
      "/score",
      "/privacy",
      "/notifications",
      "/sign-in",
    ];
    for (const path of samples) {
      expect(
        workerPatterns.some((pattern) => pattern.test(path)),
        path,
      ).toBe(isPublicDocumentPath(path));
    }
    expect(source).toContain(`"${PUBLIC_DOCUMENT_HEADER}"`);
  });

  it("marks RSC requests as live reads and never trusts a client-supplied freshness header", () => {
    const refresh = proxy(new NextRequest("https://matchday.test/competitions/summer-cup", { headers: { rsc: "1" } }));
    expect(refresh.headers.get(`x-middleware-request-${PUBLIC_READ_FRESHNESS_HEADER}`)).toBe("live");

    const spoofed = proxy(
      new NextRequest("https://matchday.test/competitions/summer-cup", {
        headers: { [PUBLIC_READ_FRESHNESS_HEADER]: "live" },
      }),
    );
    expect(spoofed.headers.get(`x-middleware-request-${PUBLIC_READ_FRESHNESS_HEADER}`)).toBe("cached");
    expect(spoofed.headers.get(PUBLIC_DOCUMENT_HEADER)).toBe("1");
    expect(spoofed.headers.get("content-security-policy")).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/u);
    const scriptSrc = spoofed.headers
      .get("content-security-policy")
      ?.split(";")
      .find((directive) => directive.trim().startsWith("script-src "));
    expect(scriptSrc).not.toContain("unsafe-inline");

    const organiser = proxy(new NextRequest("https://matchday.test/organiser"));
    expect(organiser.headers.get(PUBLIC_DOCUMENT_HEADER)).toBeNull();
  });
});

describe("SEO origin fallback chain", () => {
  it("prefers MATCHDAY_PUBLIC_ORIGIN, then the Vercel production hostname", () => {
    expect(
      seoOriginFromEnv({
        MATCHDAY_PUBLIC_ORIGIN: "https://matchday.app",
        VERCEL_PROJECT_PRODUCTION_URL: "x.vercel.app",
      }),
    ).toBe("https://matchday.app");
    expect(seoOriginFromEnv({ VERCEL_PROJECT_PRODUCTION_URL: "matchday-web.vercel.app" })).toBe(
      "https://matchday-web.vercel.app",
    );
    expect(seoOriginFromEnv({ MATCHDAY_PUBLIC_ORIGIN: "http://insecure.example" })).toBeNull();
    expect(vercelProductionOrigin("evil.example/path")).toBeNull();
  });

  it("falls back to the request origin only for HTTPS or loopback", () => {
    const https = new Headers({ host: "preview.matchday.app", "x-forwarded-proto": "https" });
    const http = new Headers({ host: "preview.matchday.app", "x-forwarded-proto": "http" });
    const loopback = new Headers({ host: "localhost:3000" });
    expect(seoOriginFromRequest(https)).toBe("https://preview.matchday.app");
    expect(seoOriginFromRequest(http)).toBeNull();
    expect(seoOriginFromRequest(loopback)).toBe("http://localhost:3000");
    expect(resolveSeoOrigin(https, {})).toBe("https://preview.matchday.app");
    expect(resolveSeoOrigin(https, { MATCHDAY_PUBLIC_ORIGIN: "https://matchday.app" })).toBe("https://matchday.app");
  });
});
