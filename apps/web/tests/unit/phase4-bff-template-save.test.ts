import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../../lib/phase4-bff-template-save";

const origin = "https://matchday.test";
const competitionId = "4dc85811-e715-40f4-8609-2523f7516e5a";
const organisationId = "79685f62-e0f7-4c41-a329-5532bf41cfa2";
const sourceRevisionId = "5a2f6554-b7bc-46d4-a132-e9f17e45e5ed";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const document = {
  schema_version: 1,
  graph: {
    id: "format-direct",
    schemaVersion: 1,
    entryCount: 2,
    stages: [
      {
        id: "stage-final",
        label: "Final",
        kind: "single_elimination",
        order: 1,
        groupIds: [],
        groupSize: null,
        outputRanks: 1,
        matchIds: ["match-final"],
      },
    ],
    matches: [
      {
        id: "match-final",
        stageId: "stage-final",
        round: 1,
        order: 1,
        purpose: "championship",
        home: { type: "entry_seed", seed: 1 },
        away: { type: "entry_seed", seed: 2 },
      },
    ],
    terminalMatchIds: ["match-final"],
  },
  layout: { schema_version: 1, stage_positions: [{ stage_id: "stage-final", x: 80, y: 80 }] },
};

beforeEach(() => {
  process.env.MATCHDAY_API_BASE_URL = origin;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.MATCHDAY_API_BASE_URL;
});

describe("Advanced Designer template BFF", () => {
  it("saves directly from authenticated competition context without reading a setup draft", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/api/v1/competitions/${competitionId}`))
        return json({ id: competitionId, organisation_id: organisationId, sport_code: "badminton" });
      if (url.endsWith("/api/v1/identity/me"))
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
      expect(url).toBe(`${origin}/api/v1/organisations/${organisationId}/format-templates`);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        sport_code: "badminton",
        source_format_revision_id: sourceRevisionId,
      });
      return json({
        template_id: "00000000-0000-4000-8000-000000000030",
        template_version_id: "00000000-0000-4000-8000-000000000031",
        parent_version_id: null,
        organisation_id: organisationId,
        created_by_account_id: "account-a",
        name: "Direct designer",
        description: null,
        sport_code: "badminton",
        source_format_revision_id: sourceRevisionId,
        status: "active",
        definition_hash: "a".repeat(64),
        document,
        revision: 1,
        template_created_at: "2026-07-22T00:00:00.000Z",
        version_created_at: "2026-07-22T00:00:00.000Z",
        archived_by_account_id: null,
        archived_at: null,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = new NextRequest(`${origin}/api/phase4/organisations/${organisationId}/format-templates`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "matchday_session=valid-session",
        host: "matchday.test",
        origin,
        referer: `${origin}/organiser/competitions/${competitionId}/format`,
      },
      body: JSON.stringify({
        template_id: null,
        parent_version_id: null,
        expected_version: null,
        name: "Direct designer",
        description: null,
        sport_code: "badminton",
        source_format_revision_id: sourceRevisionId,
        idempotency_key: "direct-template-0001",
      }),
    });

    const response = await POST(request, { params: Promise.resolve({ organisationId }) });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/setup-draft/)]),
    );
  });
});
