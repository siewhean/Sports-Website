import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as confirmMove } from "../../app/api/phase4/schedule/revisions/[revisionId]/moves/route";
import { POST as validateMove } from "../../app/api/phase4/schedule/revisions/[revisionId]/moves/validate/route";

const origin = "https://matchday.test";
const revisionId = "70000000-0000-4000-8000-000000000004";
const matchId = "30000000-0000-4000-8000-000000000001";
const target = {
  match_id: matchId,
  playing_area_id: "20000000-0000-4000-8000-000000000002",
  slot_id: "slot-2",
  start_epoch_ms: 1_787_010_000_000,
  end_epoch_ms: 1_787_011_800_000,
};
const consequences = {
  moved_match_id: matchId,
  from: {
    area_id: "20000000-0000-4000-8000-000000000001",
    slot_id: "slot-1",
    start_epoch_ms: 1_787_008_200_000,
    end_epoch_ms: 1_787_010_000_000,
  },
  to: target,
  affected_match_ids: [matchId],
  dependency_match_ids: [],
  locked_match_ids: [],
  messages: ["Only the selected match changes."],
  quality: null,
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function identity() {
  return {
    account: {
      id: "account-a",
      primary_email: "organiser@example.test",
      display_name: "Organiser",
      email_verified_at: null,
    },
    csrf_token: "csrf-token-at-least-16-characters",
    idle_expires_at: "2026-07-22T02:00:00.000Z",
    absolute_expires_at: "2026-07-22T08:00:00.000Z",
  };
}

function request(path: string, body: unknown): NextRequest {
  return new NextRequest(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: "matchday_session=valid-session",
      host: "matchday.test",
      origin,
    },
    body: JSON.stringify(body),
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

describe("schedule move BFF", () => {
  it("forwards exact server validation input with authenticated CSRF context", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/identity/me")) return json(identity());
      expect(url).toBe(`${origin}/api/v1/schedule-revisions/${revisionId}/moves/validate`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual(target);
      expect(new Headers(init?.headers).get("x-csrf-token")).toBe("csrf-token-at-least-16-characters");
      return json({ validation: { valid: true, violations: [] }, assignments: [], consequences });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await validateMove(
      request(`/api/phase4/schedule/revisions/${revisionId}/moves/validate`, target),
      { params: Promise.resolve({ revisionId }) },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("forwards the exact optimistic confirm command and validates the new revision response", async () => {
    const command = { ...target, idempotency_key: "move-move-move-move", expected_revision: 4 };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/identity/me")) return json(identity());
      expect(url).toBe(`${origin}/api/v1/schedule-revisions/${revisionId}/moves`);
      expect(JSON.parse(String(init?.body))).toEqual(command);
      return json({
        id: "70000000-0000-4000-8000-000000000005",
        competition_id: "competition-1",
        revision: 5,
        parent_revision_id: revisionId,
        source_job_id: "job-1",
        source_option_id: null,
        status: "ready_for_review",
        editable_until: "2026-08-22T00:00:00.000Z",
        published_at: null,
        expired_at: null,
        created_at: "2026-07-22T00:00:00.000Z",
        updated_at: "2026-07-22T00:00:00.000Z",
        assignment_hash: "a".repeat(64),
        quality: null,
        assignments: [],
        idempotent_replay: false,
        consequences,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await confirmMove(request(`/api/phase4/schedule/revisions/${revisionId}/moves`, command), {
      params: Promise.resolve({ revisionId }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects extra client fields before reaching identity or the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await validateMove(
      request(`/api/phase4/schedule/revisions/${revisionId}/moves/validate`, { ...target, invented: true }),
      { params: Promise.resolve({ revisionId }) },
    );
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
