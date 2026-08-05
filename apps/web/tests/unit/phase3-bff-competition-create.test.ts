import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "../../app/api/phase3/competitions/route";

const origin = "https://matchday.test";
const organisationId = "79685f62-e0f7-4c41-a329-5532bf41cfa2";

function request(body: Record<string, unknown>, requestOrigin = origin) {
  return new NextRequest(`${origin}/api/phase3/competitions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: "matchday_session=valid-session",
      host: "matchday.test",
      origin: requestOrigin,
    },
    body: JSON.stringify(body),
  });
}

const body = {
  organisation_id: organisationId,
  name: "National Open",
  slug: "national-open",
  sport_code: "table_tennis",
  venue: "National Hall",
  address: "1 Arena Road",
  locality: "Singapore",
  country_code: "SG",
  starts_on: "2027-05-01",
  ends_on: "2027-05-02",
  timezone: "Asia/Singapore",
  locale: "en-SG",
  idempotency_key: "competition-create-0001",
};

beforeEach(() => {
  process.env.MATCHDAY_API_BASE_URL = origin;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.MATCHDAY_API_BASE_URL;
  delete process.env.MATCHDAY_PUBLIC_ORIGIN;
});

describe("competition creation BFF", () => {
  it("loads authenticated writable organisation names without exposing viewer options", async () => {
    const options = [{ id: organisationId, name: "National Sports", role: "organiser" }];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(`${origin}/api/v1/organisations/competition-options`);
      return Response.json(options);
    });
    vi.stubGlobal("fetch", fetchMock);
    const organisationRequest = new NextRequest(`${origin}/api/phase3/competitions`, {
      headers: { cookie: "matchday_session=valid-session", host: "matchday.test" },
    });

    const response = await GET(organisationRequest);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(options);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("forwards an authenticated organisation read through a proxy only to the configured public API host", async () => {
    const stagingOrigin = "https://c5-staging.poladex.shop";
    process.env.MATCHDAY_API_BASE_URL = stagingOrigin;
    process.env.MATCHDAY_PUBLIC_ORIGIN = stagingOrigin;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(`${stagingOrigin}/api/v1/organisations/competition-options`);
      return Response.json([{ id: organisationId, name: "Staging organisation", role: "owner" }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new NextRequest(`${stagingOrigin}/api/phase3/competitions`, {
        headers: {
          cookie: "__Host-matchday_session=valid-session",
          host: "matchdayweb-c3-staging.up.railway.app",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses the configured public origin for proxied competition creation", async () => {
    const stagingOrigin = "https://c5-staging.poladex.shop";
    process.env.MATCHDAY_API_BASE_URL = stagingOrigin;
    process.env.MATCHDAY_PUBLIC_ORIGIN = stagingOrigin;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/v1/identity/me")) {
        return Response.json({
          account: {
            id: "account-a",
            primary_email: "organiser@example.test",
            display_name: "Organiser",
            email_verified_at: null,
          },
          csrf_token: "csrf-token-at-least-16-characters",
          idle_expires_at: "2027-05-01T02:00:00.000Z",
          absolute_expires_at: "2027-05-01T08:00:00.000Z",
        });
      }
      return Response.json({
        id: "4dc85811-e715-40f4-8609-2523f7516e5a",
        status: "draft",
        sport_code: "table_tennis",
        revision: 1,
        account_default_applied: false,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new NextRequest(`${stagingOrigin}/api/phase3/competitions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "__Host-matchday_session=valid-session",
          host: "matchdayweb-c3-staging.up.railway.app",
          origin: stagingOrigin,
        },
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the upstream organisation response includes a viewer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([{ id: organisationId, name: "Read only", role: "viewer" }])),
    );
    const organisationRequest = new NextRequest(`${origin}/api/phase3/competitions`, {
      headers: { cookie: "matchday_session=valid-session", host: "matchday.test" },
    });

    const response = await GET(organisationRequest);

    expect(response.status).toBe(502);
  });

  it("forwards the exact selected sport through the authenticated CSRF boundary", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/identity/me"))
        return Response.json({
          account: {
            id: "account-a",
            primary_email: "organiser@example.test",
            display_name: "Organiser",
            email_verified_at: null,
          },
          csrf_token: "csrf-token-at-least-16-characters",
          idle_expires_at: "2027-05-01T02:00:00.000Z",
          absolute_expires_at: "2027-05-01T08:00:00.000Z",
        });
      expect(url).toBe(`${origin}/api/v1/competitions/phase3`);
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        origin,
        "x-csrf-token": "csrf-token-at-least-16-characters",
      });
      expect(JSON.parse(String(init?.body))).toEqual(body);
      return Response.json({
        id: "4dc85811-e715-40f4-8609-2523f7516e5a",
        status: "draft",
        sport_code: "table_tennis",
        revision: 1,
        account_default_applied: false,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request(body));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ sport_code: "table_tennis" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported sports before any upstream call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ ...body, sport_code: "football" }));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an upstream receipt that substitutes a different sport", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/v1/identity/me"))
        return Response.json({
          account: {
            id: "account-a",
            primary_email: "organiser@example.test",
            display_name: "Organiser",
            email_verified_at: null,
          },
          csrf_token: "csrf-token-at-least-16-characters",
          idle_expires_at: "2027-05-01T02:00:00.000Z",
          absolute_expires_at: "2027-05-01T08:00:00.000Z",
        });
      return Response.json({
        id: "4dc85811-e715-40f4-8609-2523f7516e5a",
        status: "draft",
        sport_code: "canoe_polo",
        revision: 1,
        account_default_applied: false,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request(body));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "COMMAND_RESPONSE_INVALID" } });
  });

  it("rejects cross-origin form submissions before authentication", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request(body, "https://attacker.test"));

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
