import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as acknowledgeConflict } from "../../app/api/gate-c/competitions/[competitionId]/result-conflicts/[conflictId]/acknowledge/route";

const origin = "https://matchday.test";
const competitionId = "60000000-0000-4000-8000-000000000006";
const conflictId = "10000000-0000-4000-8000-000000000001";
const clientEventId = "70000000-0000-4000-8000-000000000007";

const conflict = {
  id: conflictId,
  corrected_match_id: "20000000-0000-4000-8000-000000000002",
  downstream_match_id: "30000000-0000-4000-8000-000000000003",
  result_version: 2,
  reason: "downstream_match_started",
  status: "acknowledged",
  detail: { affected_slot: "home", previous_entry_id: null, proposed_entry_id: null },
  created_at: "2026-07-28T01:00:00.000Z",
  acknowledged_at: "2026-07-28T02:00:00.000Z",
  acknowledged_by_account_id: "account-a",
  acknowledgement_reason: "Repair assigned to operations",
  acknowledgement_client_event_id: clientEventId,
};

function request(body: Record<string, unknown>) {
  return new NextRequest(
    `${origin}/api/gate-c/competitions/${competitionId}/result-conflicts/${conflictId}/acknowledge`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "matchday_session=valid-session",
        host: "matchday.test",
        origin,
      },
      body: JSON.stringify(body),
    },
  );
}

function identity() {
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

beforeEach(() => {
  process.env.MATCHDAY_API_BASE_URL = origin;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.MATCHDAY_API_BASE_URL;
});

describe("Gate C result-conflict acknowledgement BFF", () => {
  it("forwards the exact idempotent command and accepts the original replay response", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/identity/me")) return identity();
      expect(url).toBe(`${origin}/api/v1/competitions/${competitionId}/result-conflicts/${conflictId}/acknowledge`);
      expect(JSON.parse(String(init?.body))).toEqual({
        client_event_id: clientEventId,
        reason: "Repair assigned to operations",
        expected_revision: 2,
      });
      return Response.json(conflict);
    });
    vi.stubGlobal("fetch", fetchMock);

    const command = {
      clientEventId,
      reason: "  Repair assigned to operations  ",
      expectedRevision: 2,
    };
    const first = await acknowledgeConflict(request(command), {
      params: Promise.resolve({ competitionId, conflictId }),
    });
    const replay = await acknowledgeConflict(request(command), {
      params: Promise.resolve({ competitionId, conflictId }),
    });

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(conflict);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(conflict);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("rejects a missing client event ID before any upstream request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await acknowledgeConflict(
      request({ reason: "Repair assigned to operations", expectedRevision: 2 }),
      { params: Promise.resolve({ competitionId, conflictId }) },
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "an extra field",
      body: { clientEventId, reason: "Repair assigned", expectedRevision: 2, unexpected: true },
    },
    {
      name: "a malformed client event ID",
      body: { clientEventId: "not-a-uuid", reason: "Repair assigned", expectedRevision: 2 },
    },
    {
      name: "a whitespace-only reason",
      body: { clientEventId, reason: "   ", expectedRevision: 2 },
    },
    {
      name: "an oversized reason",
      body: { clientEventId, reason: "a".repeat(501), expectedRevision: 2 },
    },
    {
      name: "an unsafe revision",
      body: { clientEventId, reason: "Repair assigned", expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    },
    {
      name: "a fractional revision",
      body: { clientEventId, reason: "Repair assigned", expectedRevision: 2.5 },
    },
  ])("rejects $name before any upstream request", async ({ body }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await acknowledgeConflict(request(body), {
      params: Promise.resolve({ competitionId, conflictId }),
    });

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves a changed-idempotency-payload conflict from the API", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/v1/identity/me")) return identity();
      return Response.json(
        {
          error: {
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "The client event ID was already used with different acknowledgement input",
          },
        },
        { status: 409 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await acknowledgeConflict(
      request({ clientEventId, reason: "Changed acknowledgement", expectedRevision: 2 }),
      { params: Promise.resolve({ competitionId, conflictId }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });
  });
});
