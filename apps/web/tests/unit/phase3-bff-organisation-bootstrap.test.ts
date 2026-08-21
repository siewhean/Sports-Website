import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../../app/api/phase3/organisations/bootstrap/route";

const origin = "https://matchday.test";
const organisationId = "79685f62-e0f7-4c41-a329-5532bf41cfa2";
const csrfFixture = ["csrf", "fixture", "value", "0001"].join("-");
const sessionCookieFixture = ["matchday_session", "fixture-session"].join("=");

function request(requestOrigin = origin) {
  return new NextRequest(`${origin}/api/phase3/organisations/bootstrap`, {
    method: "POST",
    headers: {
      cookie: sessionCookieFixture,
      host: "matchday.test",
      origin: requestOrigin,
    },
  });
}

function identityResponse() {
  return Response.json({
    account: {
      id: "account-a",
      primary_email: "organiser@example.test",
      display_name: "Organiser",
      email_verified_at: null,
    },
    csrf_token: csrfFixture,
    idle_expires_at: "2027-05-01T02:00:00.000Z",
    absolute_expires_at: "2027-05-01T08:00:00.000Z",
  });
}

beforeEach(() => {
  process.env.MATCHDAY_API_BASE_URL = origin;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.MATCHDAY_API_BASE_URL;
});

describe("first organiser workspace bootstrap BFF", () => {
  it("forwards the authenticated command through the origin and CSRF boundary", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/identity/me")) return identityResponse();
      expect(url).toBe(`${origin}/api/v1/organisations/competition-options/bootstrap`);
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        origin,
        "x-csrf-token": csrfFixture,
      });
      expect(init?.body).toBeUndefined();
      return Response.json({
        id: organisationId,
        name: "Organiser workspace",
        role: "owner",
        created: true,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: organisationId,
      name: "Organiser workspace",
      role: "owner",
      created: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the API returns an unexpected bootstrap shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/api/v1/identity/me")
          ? identityResponse()
          : Response.json({ id: organisationId, name: "Workspace", role: "viewer", created: true }),
      ),
    );

    const response = await POST(request());

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "COMMAND_RESPONSE_INVALID" } });
  });

  it("rejects cross-origin bootstrap attempts before authentication", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request("https://attacker.test"));

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
