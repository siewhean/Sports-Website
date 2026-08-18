import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "../../app/api/phase3/competitions/route";

const webOrigin = "https://web.matchday.test";
const apiOrigin = "https://api.matchday.test";
const organisationId = "79685f62-e0f7-4c41-a329-5532bf41cfa2";

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

function request(method: "GET" | "POST", requestBody?: Record<string, unknown>) {
  return new NextRequest(`${webOrigin}/api/phase3/competitions`, {
    method,
    headers: {
      ...(requestBody ? { "content-type": "application/json" } : {}),
      cookie: "matchday_session=valid-session",
      host: "web.matchday.test",
      origin: webOrigin,
    },
    ...(requestBody ? { body: JSON.stringify(requestBody) } : {}),
  });
}

beforeEach(() => {
  process.env.MATCHDAY_API_BASE_URL = apiOrigin;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.MATCHDAY_API_BASE_URL;
});

describe("split-host authenticated competition BFF", () => {
  it("forwards a signed-in read to the trusted configured API host", async () => {
    const options = [{ id: organisationId, name: "National Sports", role: "organiser" }];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`${apiOrigin}/api/v1/organisations/competition-options`);
      expect(init?.headers).toMatchObject({
        accept: "application/json",
        cookie: "matchday_session=valid-session",
      });
      return Response.json(options);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request("GET"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(options);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps same-origin CSRF checks while forwarding the session to the trusted API host", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === `${apiOrigin}/api/v1/identity/me`) {
        expect(init?.headers).toMatchObject({ cookie: "matchday_session=valid-session" });
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

      expect(url).toBe(`${apiOrigin}/api/v1/competitions/phase3`);
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        cookie: "matchday_session=valid-session",
        origin: webOrigin,
        "x-csrf-token": "csrf-token-at-least-16-characters",
      });
      return Response.json({
        id: "4dc85811-e715-40f4-8609-2523f7516e5a",
        status: "draft",
        sport_code: "table_tennis",
        revision: 1,
        account_default_applied: false,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request("POST", body));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ sport_code: "table_tennis" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
