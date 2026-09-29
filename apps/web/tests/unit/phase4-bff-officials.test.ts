import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getWorkspace } from "../../app/api/phase4/competitions/[competitionId]/officials/workspace/route";
import { POST as createOfficial } from "../../app/api/phase4/competitions/[competitionId]/officials/route";
import { PATCH as updateOfficial } from "../../app/api/phase4/competitions/[competitionId]/officials/[officialId]/route";
import { POST as archiveOfficial } from "../../app/api/phase4/competitions/[competitionId]/officials/[officialId]/archive/route";
import { POST as restoreOfficial } from "../../app/api/phase4/competitions/[competitionId]/officials/[officialId]/restore/route";
import { PUT as replaceAvailability } from "../../app/api/phase4/competitions/[competitionId]/officials/[officialId]/availability/route";
import { PUT as replaceAssignments } from "../../app/api/phase4/competitions/[competitionId]/matches/[matchId]/officials/route";
import { readFile } from "node:fs/promises";

const origin = "https://matchday.test";
const competitionId = "10000000-0000-4000-8000-000000000001";
const officialId = "60000000-0000-4000-8000-000000000001";
const matchId = "30000000-0000-4000-8000-000000000001";

function makeMutationRequest(
  method: string,
  path: string,
  body?: Record<string, unknown> | null,
  requestOrigin: string | null = origin,
  cookie: string | null = "matchday_session=valid-session",
) {
  const headers: Record<string, string> = {
    host: "matchday.test",
  };
  if (requestOrigin) headers.origin = requestOrigin;
  if (cookie) headers.cookie = cookie;
  if (body) headers["content-type"] = "application/json";

  return new NextRequest(`${origin}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function makeGetRequest(path: string, cookie: string | null = "matchday_session=valid-session") {
  const headers: Record<string, string> = {
    host: "matchday.test",
  };
  if (cookie) headers.cookie = cookie;

  return new NextRequest(`${origin}${path}`, {
    method: "GET",
    headers,
  });
}

function mockIdentityResponse() {
  return Response.json({
    account: {
      id: "account-test",
      primary_email: "organiser@example.test",
      display_name: "Lead Organiser",
      email_verified_at: null,
    },
    csrf_token: "csrf-token-at-least-16-characters",
    idle_expires_at: "2027-05-01T02:00:00.000Z",
    absolute_expires_at: "2027-05-01T08:00:00.000Z",
  });
}

const mockOfficialPayload = {
  id: officialId,
  competition_id: competitionId,
  name: "Official A",
  default_role: "Lead Official",
  archived: false,
  created_at: "2026-08-10T00:00:00.000Z",
  updated_at: "2026-08-10T00:00:00.000Z",
};

beforeEach(() => {
  process.env.MATCHDAY_API_BASE_URL = origin;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.MATCHDAY_API_BASE_URL;
});

describe("Phase 4 Officials BFF", () => {
  // -------------------------------------------------------------
  // 1. Workspace GET
  // -------------------------------------------------------------
  describe("GET /api/phase4/competitions/[competitionId]/officials/workspace", () => {
    it("returns parsed canonical workspace on valid upstream response", async () => {
      const validWorkspace = {
        officials: [mockOfficialPayload],
        availability: {
          [officialId]: [{ starts_at: "2026-08-15T09:00:00.000Z", ends_at: "2026-08-15T12:00:00.000Z" }],
        },
        assignments: [
          {
            match_id: matchId,
            official_id: officialId,
            assigned_role: "Lead Official",
          },
        ],
      };

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          expect(String(input)).toBe(`${origin}/api/v1/phase4/competitions/${competitionId}/officials/workspace`);
          return Response.json(validWorkspace);
        }),
      );

      const res = await getWorkspace(makeGetRequest(`/api/phase4/competitions/${competitionId}/officials/workspace`), {
        params: Promise.resolve({ competitionId }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual(validWorkspace);
    });

    it("returns 502 COMMAND_RESPONSE_INVALID when upstream workspace is malformed", async () => {
      const malformedWorkspace = {
        officials: [{ ...mockOfficialPayload, unknown_secret: true }],
        availability: {},
        assignments: [],
      };

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(malformedWorkspace)),
      );

      const res = await getWorkspace(makeGetRequest(`/api/phase4/competitions/${competitionId}/officials/workspace`), {
        params: Promise.resolve({ competitionId }),
      });

      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({
        error: { code: "COMMAND_RESPONSE_INVALID" },
      });
    });

    it("returns 401 when session cookie is missing", async () => {
      const res = await getWorkspace(
        makeGetRequest(`/api/phase4/competitions/${competitionId}/officials/workspace`, null),
        { params: Promise.resolve({ competitionId }) },
      );

      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        error: { code: "AUTH_REQUIRED" },
      });
    });

    it("returns 503 when API base URL is not configured", async () => {
      delete process.env.MATCHDAY_API_BASE_URL;

      const res = await getWorkspace(makeGetRequest(`/api/phase4/competitions/${competitionId}/officials/workspace`), {
        params: Promise.resolve({ competitionId }),
      });

      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        error: { code: "API_UNAVAILABLE" },
      });
    });
  });

  // -------------------------------------------------------------
  // 2. Create Official POST
  // -------------------------------------------------------------
  describe("POST /api/phase4/competitions/[competitionId]/officials", () => {
    it("forwards valid create request and returns 201", async () => {
      const body = { name: "Official Alpha", default_role: "Lead" };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/api/v1/identity/me")) return mockIdentityResponse();
          expect(url).toBe(`${origin}/api/v1/phase4/competitions/${competitionId}/officials`);
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toEqual(body);
          return Response.json(mockOfficialPayload, { status: 201 });
        }),
      );

      const res = await createOfficial(
        makeMutationRequest("POST", `/api/phase4/competitions/${competitionId}/officials`, body),
        { params: Promise.resolve({ competitionId }) },
      );

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockOfficialPayload);
    });

    it("rejects blank name before calling upstream", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const res = await createOfficial(
        makeMutationRequest("POST", `/api/phase4/competitions/${competitionId}/officials`, { name: "   " }),
        { params: Promise.resolve({ competitionId }) },
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects overlong name before calling upstream", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const res = await createOfficial(
        makeMutationRequest("POST", `/api/phase4/competitions/${competitionId}/officials`, {
          name: "A".repeat(81),
        }),
        { params: Promise.resolve({ competitionId }) },
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects unknown field in create body", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const res = await createOfficial(
        makeMutationRequest("POST", `/api/phase4/competitions/${competitionId}/officials`, {
          name: "Valid Name",
          organisation_id: "injected",
        }),
        { params: Promise.resolve({ competitionId }) },
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("preserves upstream duplicate name conflict error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          if (String(input).endsWith("/api/v1/identity/me")) return mockIdentityResponse();
          return Response.json(
            {
              error: {
                code: "OFFICIAL_NAME_CONFLICT",
                message: "An official with this name already exists",
              },
            },
            { status: 409 },
          );
        }),
      );

      const res = await createOfficial(
        makeMutationRequest("POST", `/api/phase4/competitions/${competitionId}/officials`, {
          name: "Official A",
        }),
        { params: Promise.resolve({ competitionId }) },
      );

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: { code: "OFFICIAL_NAME_CONFLICT" },
      });
    });

    it("returns 502 when upstream create returns malformed success object", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          if (String(input).endsWith("/api/v1/identity/me")) return mockIdentityResponse();
          return Response.json({ invalid: "payload" }, { status: 201 });
        }),
      );

      const res = await createOfficial(
        makeMutationRequest("POST", `/api/phase4/competitions/${competitionId}/officials`, {
          name: "Official A",
        }),
        { params: Promise.resolve({ competitionId }) },
      );

      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({
        error: { code: "COMMAND_RESPONSE_INVALID" },
      });
    });
  });

  // -------------------------------------------------------------
  // 3. Update Official PATCH
  // -------------------------------------------------------------
  describe("PATCH /api/phase4/competitions/[competitionId]/officials/[officialId]", () => {
    it("forwards valid rename and returns 200", async () => {
      const body = { name: "Official Renamed" };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/api/v1/identity/me")) return mockIdentityResponse();
          expect(url).toBe(`${origin}/api/v1/phase4/competitions/${competitionId}/officials/${officialId}`);
          expect(init?.method).toBe("PATCH");
          return Response.json({ ...mockOfficialPayload, name: "Official Renamed" });
        }),
      );

      const res = await updateOfficial(
        makeMutationRequest("PATCH", `/api/phase4/competitions/${competitionId}/officials/${officialId}`, body),
        { params: Promise.resolve({ competitionId, officialId }) },
      );

      expect(res.status).toBe(200);
      expect((await res.json()).name).toBe("Official Renamed");
    });

    it("forwards null default_role to clear role", async () => {
      const body = { default_role: null };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          if (String(input).endsWith("/api/v1/identity/me")) return mockIdentityResponse();
          return Response.json({ ...mockOfficialPayload, default_role: null });
        }),
      );

      const res = await updateOfficial(
        makeMutationRequest("PATCH", `/api/phase4/competitions/${competitionId}/officials/${officialId}`, body),
        { params: Promise.resolve({ competitionId, officialId }) },
      );

      expect(res.status).toBe(200);
      expect((await res.json()).default_role).toBeNull();
    });

    it("rejects empty PATCH body", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const res = await updateOfficial(
        makeMutationRequest("PATCH", `/api/phase4/competitions/${competitionId}/officials/${officialId}`, {}),
        { params: Promise.resolve({ competitionId, officialId }) },
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects unknown field in PATCH body", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const res = await updateOfficial(
        makeMutationRequest("PATCH", `/api/phase4/competitions/${competitionId}/officials/${officialId}`, {
          name: "New Name",
          role: "unknown_key",
        }),
        { params: Promise.resolve({ competitionId, officialId }) },
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------
  // 4. Archive & Restore POST
  // -------------------------------------------------------------
  describe("Archive & Restore POST", () => {
    it("archives official and preserves bumped_revision true", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/api/v1/identity/me")) return mockIdentityResponse();
          expect(url).toBe(`${origin}/api/v1/phase4/competitions/${competitionId}/officials/${officialId}/archive`);
          expect(init?.method).toBe("POST");
          return Response.json({
            official: { ...mockOfficialPayload, archived: true },
            bumped_revision: true,
          });
        }),
      );

      const res = await archiveOfficial(
        makeMutationRequest("POST", `/api/phase4/competitions/${competitionId}/officials/${officialId}/archive`, null),
        { params: Promise.resolve({ competitionId, officialId }) },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.official.archived).toBe(true);
      expect(json.bumped_revision).toBe(true);
    });

    it("restores official and preserves bumped_revision false", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/api/v1/identity/me")) return mockIdentityResponse();
          expect(url).toBe(`${origin}/api/v1/phase4/competitions/${competitionId}/officials/${officialId}/restore`);
          expect(init?.method).toBe("POST");
          return Response.json({
            official: { ...mockOfficialPayload, archived: false },
            bumped_revision: false,
          });
        }),
      );

      const res = await restoreOfficial(
        makeMutationRequest("POST", `/api/phase4/competitions/${competitionId}/officials/${officialId}/restore`, null),
        { params: Promise.resolve({ competitionId, officialId }) },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.official.archived).toBe(false);
      expect(json.bumped_revision).toBe(false);
    });

    it("rejects unexpected body on archive", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const res = await archiveOfficial(
        makeMutationRequest("POST", `/api/phase4/competitions/${competitionId}/officials/${officialId}/archive`, {
          unexpected: "field",
        }),
        { params: Promise.resolve({ competitionId, officialId }) },
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------
  // 5. Replace Availability PUT
  // -------------------------------------------------------------
  describe("PUT /api/phase4/competitions/[competitionId]/officials/[officialId]/availability", () => {
    it("forwards valid availability windows and preserves bumped_revision", async () => {
      const body = {
        windows: [
          { starts_at: "2026-08-15T09:00:00.000Z", ends_at: "2026-08-15T12:00:00.000Z" },
          { starts_at: "2026-08-15T11:00:00.000Z", ends_at: "2026-08-15T14:00:00.000Z" }, // overlapping accepted
        ],
      };

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          if (String(input).endsWith("/api/v1/identity/me")) return mockIdentityResponse();
          return Response.json({
            windows: [
              { starts_at: "2026-08-15T09:00:00.000Z", ends_at: "2026-08-15T14:00:00.000Z" }, // canonical merged
            ],
            bumped_revision: true,
          });
        }),
      );

      const res = await replaceAvailability(
        makeMutationRequest(
          "PUT",
          `/api/phase4/competitions/${competitionId}/officials/${officialId}/availability`,
          body,
        ),
        { params: Promise.resolve({ competitionId, officialId }) },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.windows).toHaveLength(1);
      expect(json.bumped_revision).toBe(true);
    });

    it("accepts empty windows array []", async () => {
      const body = { windows: [] };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          if (String(input).endsWith("/api/v1/identity/me")) return mockIdentityResponse();
          return Response.json({ windows: [], bumped_revision: false });
        }),
      );

      const res = await replaceAvailability(
        makeMutationRequest(
          "PUT",
          `/api/phase4/competitions/${competitionId}/officials/${officialId}/availability`,
          body,
        ),
        { params: Promise.resolve({ competitionId, officialId }) },
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ windows: [], bumped_revision: false });
    });

    it("rejects window where starts_at >= ends_at", async () => {
      const body = {
        windows: [{ starts_at: "2026-08-15T12:00:00.000Z", ends_at: "2026-08-15T09:00:00.000Z" }],
      };

      const res = await replaceAvailability(
        makeMutationRequest(
          "PUT",
          `/api/phase4/competitions/${competitionId}/officials/${officialId}/availability`,
          body,
        ),
        { params: Promise.resolve({ competitionId, officialId }) },
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    });

    it("rejects unknown nested field in window item", async () => {
      const body = {
        windows: [
          {
            starts_at: "2026-08-15T09:00:00.000Z",
            ends_at: "2026-08-15T12:00:00.000Z",
            extra_field: "disallowed",
          },
        ],
      };

      const res = await replaceAvailability(
        makeMutationRequest(
          "PUT",
          `/api/phase4/competitions/${competitionId}/officials/${officialId}/availability`,
          body,
        ),
        { params: Promise.resolve({ competitionId, officialId }) },
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    });

    it("rejects unknown top-level field in availability body", async () => {
      const body = {
        windows: [],
        unexpected: "top_level",
      };

      const res = await replaceAvailability(
        makeMutationRequest(
          "PUT",
          `/api/phase4/competitions/${competitionId}/officials/${officialId}/availability`,
          body,
        ),
        { params: Promise.resolve({ competitionId, officialId }) },
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    });
  });

  // -------------------------------------------------------------
  // 6. Replace Match Assignments PUT
  // -------------------------------------------------------------
  describe("PUT /api/phase4/competitions/[competitionId]/matches/[matchId]/officials", () => {
    it("forwards multiple official assignments with optional roles", async () => {
      const official2Id = "60000000-0000-4000-8000-000000000002";
      const body = {
        assignments: [
          { official_id: officialId, assigned_role: "Lead" },
          { official_id: official2Id, assigned_role: null },
        ],
      };

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          if (String(input).endsWith("/api/v1/identity/me")) return mockIdentityResponse();
          return Response.json({
            assignments: [
              { match_id: matchId, official_id: officialId, assigned_role: "Lead" },
              { match_id: matchId, official_id: official2Id, assigned_role: null },
            ],
            bumped_revision: true,
          });
        }),
      );

      const res = await replaceAssignments(
        makeMutationRequest("PUT", `/api/phase4/competitions/${competitionId}/matches/${matchId}/officials`, body),
        { params: Promise.resolve({ competitionId, matchId }) },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.assignments).toHaveLength(2);
      expect(json.bumped_revision).toBe(true);
    });

    it("rejects duplicate official ID client-side", async () => {
      const body = {
        assignments: [
          { official_id: officialId, assigned_role: "Lead" },
          { official_id: officialId, assigned_role: "Second" },
        ],
      };

      const res = await replaceAssignments(
        makeMutationRequest("PUT", `/api/phase4/competitions/${competitionId}/matches/${matchId}/officials`, body),
        { params: Promise.resolve({ competitionId, matchId }) },
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    });

    it("rejects unknown nested field like role or organisation_id", async () => {
      const body = {
        assignments: [{ official_id: officialId, assigned_role: "Lead", role: "lead" }],
      };

      const res = await replaceAssignments(
        makeMutationRequest("PUT", `/api/phase4/competitions/${competitionId}/matches/${matchId}/officials`, body),
        { params: Promise.resolve({ competitionId, matchId }) },
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    });

    it("preserves upstream conflict for archived official", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          if (String(input).endsWith("/api/v1/identity/me")) return mockIdentityResponse();
          return Response.json(
            {
              error: {
                code: "OFFICIAL_ARCHIVED",
                message: "Cannot assign archived official to match",
              },
            },
            { status: 409 },
          );
        }),
      );

      const res = await replaceAssignments(
        makeMutationRequest("PUT", `/api/phase4/competitions/${competitionId}/matches/${matchId}/officials`, {
          assignments: [{ official_id: officialId, assigned_role: null }],
        }),
        { params: Promise.resolve({ competitionId, matchId }) },
      );

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: { code: "OFFICIAL_ARCHIVED" },
      });
    });
  });

  // -------------------------------------------------------------
  // 7. Security Regressions & Server-Only Boundaries
  // -------------------------------------------------------------
  describe("Security Regressions", () => {
    it("rejects mutation when Origin header is missing", async () => {
      const res = await createOfficial(
        makeMutationRequest(
          "POST",
          `/api/phase4/competitions/${competitionId}/officials`,
          { name: "Official Alpha" },
          null,
        ),
        { params: Promise.resolve({ competitionId }) },
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: "ORIGIN_REJECTED" },
      });
    });

    it("rejects mutation when Origin header is disallowed", async () => {
      const res = await createOfficial(
        makeMutationRequest(
          "POST",
          `/api/phase4/competitions/${competitionId}/officials`,
          { name: "Official Alpha" },
          "https://evil.attacker.test",
        ),
        { params: Promise.resolve({ competitionId }) },
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: "ORIGIN_REJECTED" },
      });
    });

    it("rejects mutation when session cookie is absent", async () => {
      const res = await createOfficial(
        makeMutationRequest(
          "POST",
          `/api/phase4/competitions/${competitionId}/officials`,
          { name: "Official Alpha" },
          origin,
          null,
        ),
        { params: Promise.resolve({ competitionId }) },
      );

      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        error: { code: "AUTH_REQUIRED" },
      });
    });

    it("guarantees server loader files have import 'server-only'", async () => {
      const serverLoader = await readFile(new URL("../../lib/phase4-officials.server.ts", import.meta.url), "utf8");
      const serverBff = await readFile(new URL("../../lib/phase4-officials-bff.server.ts", import.meta.url), "utf8");

      expect(serverLoader).toContain('import "server-only";');
      expect(serverBff).toContain('import "server-only";');
    });

    it("guarantees client component does not import .server modules", async () => {
      const rosterView = await readFile(
        new URL("../../components/phase4/officials/OfficialsRosterView.tsx", import.meta.url),
        "utf8",
      );

      expect(rosterView).not.toContain(".server");
      expect(rosterView).toContain('"use client";');
    });
  });
});
