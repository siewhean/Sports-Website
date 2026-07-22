import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Phase4SetupDocument } from "@matchday/contracts";
import { PATCH, POST, PUT } from "../../lib/phase4-bff-setup";

const origin = "https://matchday.test";
const competitionId = "4dc85811-e715-40f4-8609-2523f7516e5a";
const stepIds = [
  "basics",
  "capacity",
  "settings",
  "entries",
  "format_preferences",
  "format_recommendations",
  "schedule_review",
  "review_publish",
] as const;

const document: Phase4SetupDocument = {
  schema_version: 1,
  id: "setup-a",
  organisation_id: "org-a",
  competition_id: competitionId,
  competition_status: "draft",
  revision: 1,
  status: "active",
  current_step: "basics",
  completed_steps: [],
  steps: stepIds.map((id, index) => ({
    id,
    status: index === 0 ? "current" : "not_started",
    prerequisite_step_ids: index === 0 ? [] : [stepIds[index - 1]!],
    errors: [],
    completed_at: null,
  })),
  values: {
    basics: null,
    capacity: null,
    settings: null,
    entries: null,
    format_preferences: null,
    format_recommendations: null,
    schedule_review: null,
    review_publish: null,
  },
  permission: "write",
  read_only: false,
  autosave: { status: "idle", last_saved_at: null, expires_at: "2026-08-22T00:00:00.000Z" },
  created_at: "2026-07-22T00:00:00.000Z",
  updated_at: "2026-07-22T00:00:00.000Z",
  completed_at: null,
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function request(): NextRequest {
  return new NextRequest(`${origin}/api/phase4/competitions/${competitionId}/setup-draft`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: "matchday_session=valid-session",
      host: "matchday.test",
      origin,
    },
    body: JSON.stringify({ idempotency_key: "create-draft-0001" }),
  });
}

function mutationRequest(method: "PUT" | "PATCH", body: unknown): NextRequest {
  return new NextRequest(`${origin}/api/phase4/competitions/${competitionId}/setup-draft`, {
    method,
    headers: { "content-type": "application/json", host: "matchday.test", origin },
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

describe("Assisted Setup create BFF", () => {
  it("accepts and forwards the exact create wrapper returned by the API", async () => {
    const wrapper = { document, idempotent_replay: false };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/v1/identity/me")) {
        return json({
          account: {
            id: "account-a",
            primary_email: "organiser@example.test",
            display_name: "Organiser",
            email_verified_at: null,
          },
          csrf_token: "csrf-token-at-least-16-characters",
          idle_expires_at: "2026-07-22T02:00:00.000Z",
          absolute_expires_at: "2026-07-22T08:00:00.000Z",
        });
      }
      expect(url).toBe(`${origin}/api/v1/competitions/${competitionId}/setup-draft`);
      return json(wrapper);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request(), { params: Promise.resolve({ competitionId }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(wrapper);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed discriminated PUT and PATCH values before forwarding", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const putResponse = await PUT(
      mutationRequest("PUT", {
        expected_revision: 2,
        idempotency_key: "save-step-0001",
        transition: { kind: "save_step", step: { step_id: "basics", value: null } },
      }),
      { params: Promise.resolve({ competitionId }) },
    );
    const patchResponse = await PATCH(
      mutationRequest("PATCH", {
        expected_revision: 2,
        idempotency_key: "patch-step-0001",
        step: { step_id: "basics", value: {} },
      }),
      { params: Promise.resolve({ competitionId }) },
    );

    expect(putResponse.status).toBe(400);
    expect(patchResponse.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
