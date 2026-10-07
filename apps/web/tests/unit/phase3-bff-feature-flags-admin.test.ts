import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { DELETE, PUT } from "../../app/api/phase3/admin/feature-flags/[key]/override/route";

const origin = "https://matchday.test";

beforeEach(() => {
  process.env.MATCHDAY_API_BASE_URL = origin;
  process.env.MATCHDAY_PUBLIC_ORIGIN = origin;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.MATCHDAY_API_BASE_URL;
  delete process.env.MATCHDAY_PUBLIC_ORIGIN;
});

describe("Feature Flag Admin BFF Route", () => {
  it("rejects unknown feature flag keys with 404", async () => {
    const req = new NextRequest(`${origin}/api/phase3/admin/feature-flags/nonexistent.flag/override`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie: "matchday_session=valid-session",
        host: "matchday.test",
        origin,
      },
      body: JSON.stringify({
        scope: { kind: "global" },
        value: true,
        reason: "testing override",
      }),
    });

    const context = { params: Promise.resolve({ key: "nonexistent.flag" }) };
    const response = await PUT(req, context);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("FEATURE_FLAG_NOT_FOUND");
  });

  it("validates request body requirements", async () => {
    const req = new NextRequest(`${origin}/api/phase3/admin/feature-flags/maintenance.global/override`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie: "matchday_session=valid-session",
        host: "matchday.test",
        origin,
      },
      body: JSON.stringify({
        scope: { kind: "global" },
        // missing value
        reason: "no", // too short (<3 chars)
      }),
    });

    const context = { params: Promise.resolve({ key: "maintenance.global" }) };
    const response = await PUT(req, context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("forwards PUT mutation to API when valid", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/v1/identity/me")) {
        return Response.json({
          account: {
            id: "account-admin-1",
            primary_email: "admin@matchday.test",
            display_name: "Platform Admin",
            email_verified_at: null,
          },
          csrf_token: "csrf-token-at-least-16-characters",
          idle_expires_at: "2027-05-01T02:00:00.000Z",
          absolute_expires_at: "2027-05-01T08:00:00.000Z",
        });
      }
      expect(String(input)).toBe(`${origin}/api/v1/admin/feature-flags/maintenance.global/override`);
      return Response.json({ key: "maintenance.global", scope: { kind: "global" }, value: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const req = new NextRequest(`${origin}/api/phase3/admin/feature-flags/maintenance.global/override`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie: "matchday_session=valid-session",
        host: "matchday.test",
        origin,
      },
      body: JSON.stringify({
        scope: { kind: "global" },
        value: true,
        reason: "emergency maintenance enable",
      }),
    });

    const context = { params: Promise.resolve({ key: "maintenance.global" }) };
    const response = await PUT(req, context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.key).toBe("maintenance.global");
  });

  it("forwards DELETE mutation to API when valid", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/v1/identity/me")) {
        return Response.json({
          account: {
            id: "account-admin-1",
            primary_email: "admin@matchday.test",
            display_name: "Platform Admin",
            email_verified_at: null,
          },
          csrf_token: "csrf-token-at-least-16-characters",
          idle_expires_at: "2027-05-01T02:00:00.000Z",
          absolute_expires_at: "2027-05-01T08:00:00.000Z",
        });
      }
      expect(String(input)).toBe(`${origin}/api/v1/admin/feature-flags/maintenance.global/override`);
      return Response.json({ success: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const req = new NextRequest(`${origin}/api/phase3/admin/feature-flags/maintenance.global/override`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        cookie: "matchday_session=valid-session",
        host: "matchday.test",
        origin,
      },
      body: JSON.stringify({
        scope: { kind: "global" },
        reason: "maintenance window completed",
      }),
    });

    const context = { params: Promise.resolve({ key: "maintenance.global" }) };
    const response = await DELETE(req, context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
  });
});
