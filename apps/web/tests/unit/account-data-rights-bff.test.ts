import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { messages } from "@matchday/ui";
import { GET as exportData } from "../../app/api/account/data-export/route";
import { POST as deleteAccount } from "../../app/api/account/deletion/route";

const origin = "https://matchday.test";
const csrfFixture = ["csrf", "fixture", "value", "0001"].join("-");
const sessionCookieFixture = ["matchday_session", "fixture-session"].join("=");

function identityResponse() {
  return Response.json({
    account: { id: "a", primary_email: "p@example.test", display_name: "P", email_verified_at: null },
    csrf_token: csrfFixture,
    idle_expires_at: "2027-05-01T02:00:00.000Z",
    absolute_expires_at: "2027-05-01T08:00:00.000Z",
  });
}

const deleteRequest = (body: unknown, requestOrigin = origin) =>
  new NextRequest(`${origin}/api/account/deletion`, {
    method: "POST",
    headers: { cookie: sessionCookieFixture, host: "matchday.test", origin: requestOrigin },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  process.env.MATCHDAY_API_BASE_URL = origin;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.MATCHDAY_API_BASE_URL;
});

describe("account data rights BFF", () => {
  it("serves the export as a no-store JSON attachment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ subject_account_id: "a" })),
    );
    const response = await exportData(
      new NextRequest(`${origin}/api/account/data-export`, {
        headers: { cookie: sessionCookieFixture, host: "matchday.test" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="matchday-account-data-/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(await response.text())).toEqual({ subject_account_id: "a" });
  });

  it("requires a session for the export", async () => {
    const response = await exportData(new NextRequest(`${origin}/api/account/data-export`));
    expect(response.status).toBe(401);
  });

  it("rejects malformed deletion bodies without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await deleteAccount(deleteRequest({}))).status).toBe(400);
    expect((await deleteAccount(deleteRequest({ confirmation: 1 }))).status).toBe(400);
    expect((await deleteAccount(deleteRequest({ confirmation: "x", extra: true }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards deletion with CSRF and clears the local session cookie on success", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/api/v1/identity/me")) return identityResponse();
      expect(String(input)).toBe(`${origin}/api/v1/account/deletion`);
      expect(init?.headers).toMatchObject({ origin, "x-csrf-token": csrfFixture });
      expect(JSON.parse(String(init?.body))).toEqual({ confirmation: messages.account.confirmationPhrase });
      return Response.json({ deleted_at: "2027-05-01T00:00:00.000Z" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await deleteAccount(deleteRequest({ confirmation: messages.account.confirmationPhrase }));
    expect(response.status).toBe(200);
    const cookies = response.headers.getSetCookie().join("\n");
    expect(cookies).toContain("matchday_session=;");
  });

  it("passes the API's blocked-deletion explanation through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/api/v1/identity/me")
          ? identityResponse()
          : Response.json(
              { error: { code: "LIFECYCLE_CONFLICT", message: "You are the only owner", request_id: "r" } },
              { status: 409 },
            ),
      ),
    );
    const response = await deleteAccount(deleteRequest({ confirmation: messages.account.confirmationPhrase }));
    expect(response.status).toBe(409);
    expect((await response.json()).error.message).toBe("You are the only owner");
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("rejects cross-origin deletion", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const response = await deleteAccount(
      deleteRequest({ confirmation: messages.account.confirmationPhrase }, "https://evil.example"),
    );
    expect(response.status).toBe(403);
  });
});
