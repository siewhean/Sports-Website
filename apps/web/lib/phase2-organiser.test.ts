import { describe, expect, it } from "vitest";
import {
  cookieHostMatches,
  isOrganiserWorkspacePayload,
  toOrganiserCompetitionView,
  type OrganiserWorkspacePayload,
} from "./phase2-organiser";

const competitionId = "00000000-0000-4000-8000-000000000010";
const divisionId = "00000000-0000-4000-8000-000000000020";
const homeId = "00000000-0000-4000-8000-000000000030";
const awayId = "00000000-0000-4000-8000-000000000031";
const matchId = "00000000-0000-4000-8000-000000000040";
const secondMatchId = "00000000-0000-4000-8000-000000000041";

function workspace(sportCode = "canoe_polo"): OrganiserWorkspacePayload {
  return {
    competition: {
      id: competitionId,
      name: "National Cup",
      slug: "national-cup",
      sport_code: sportCode,
      timezone: "Asia/Singapore",
      starts_on: "2026-08-01",
      ends_on: "2026-08-02",
      updated_at: "2026-07-17T02:00:00.000Z",
    },
    settings: {
      period_count: 2,
      period_minutes: 10,
      slot_minutes: 30,
      points_win: 3,
      points_draw: 1,
      points_loss: 0,
      tiebreak_order: ["goal_difference", "goals_for"],
    },
    divisions: [
      {
        id: divisionId,
        name: "Open",
        entries: [
          { id: homeId, name: "North", seed: 1, status: "active" },
          { id: awayId, name: "South", seed: 2, status: "active" },
        ],
      },
    ],
    capacity: [
      { id: "court-1", name: "Court 1", windows: [] },
      { id: "court-2", name: "Court 2", windows: [] },
    ],
    current_format: {
      revision: 3,
      definition: {
        groups: [{ id: "A" }],
        matches: [
          {
            id: matchId,
            code: "group-A-r1-m1",
            stage: "group",
            home: { type: "entry", entryId: homeId },
            away: { type: "entry", entryId: awayId },
          },
          {
            id: secondMatchId,
            code: "group-A-r1-m2",
            stage: "group",
            home: { type: "entry", entryId: awayId },
            away: { type: "entry", entryId: homeId },
          },
        ],
      },
    },
    private_schedule: {
      matches: [
        {
          match_id: matchId,
          code: "group-A-r1-m1",
          stage: "group",
          area: "Court 1",
          starts_at: "2026-08-01T01:00:00.000Z",
          state: "corrected",
          home_score: 4,
          away_score: 3,
          result_version: 1,
        },
        {
          match_id: secondMatchId,
          code: "group-A-r1-m2",
          stage: "group",
          area: "Court 2",
          starts_at: "2026-08-01T01:00:00.000Z",
          state: "in_progress",
          home_score: 2,
          away_score: 1,
          result_version: 1,
        },
      ],
    },
    publication: {
      schedule_version: 2,
      result_version: 1,
      schedule_published_at: "2026-07-17T01:00:00.000Z",
    },
    access_passes: [
      {
        id: "pass-1",
        match_id: matchId,
        role: "scorekeeper",
        expires_at: "2026-08-01T02:00:00.000Z",
        revoked_at: null,
        fallback_code_status: "rotation_required",
        token: "must-not-leak",
        short_code: "must-not-leak",
      },
      {
        id: "pass-2",
        match_id: matchId,
        role: "viewer",
        expires_at: "2026-08-01T02:00:00.000Z",
        revoked_at: "2026-07-20T02:00:00.000Z",
        fallback_code_status: "unavailable",
      },
    ],
    permission: "write",
    read_only: false,
  };
}

describe("organiser competition workspace mapping", () => {
  it("validates and maps authenticated workspace data without access secrets", () => {
    const payload = workspace();
    expect(isOrganiserWorkspacePayload(payload)).toBe(true);

    const view = toOrganiserCompetitionView(payload);

    expect(view).toMatchObject({
      id: competitionId,
      slug: "national-cup",
      name: "National Cup",
      sport: "Canoe Polo",
      venue: "Court 1 · Court 2",
      publicationRevision: "sch_2 · res_1",
      publicationState: "published",
      division: { id: divisionId, name: "Open", teamCount: 2, matchCount: 2 },
      teams: ["North", "South"],
      canEdit: true,
    });
    expect(view.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: matchId,
          home: "North",
          away: "South",
          area: "Court 1",
          homeScore: 4,
          awayScore: 3,
          status: "final",
        }),
        expect.objectContaining({
          id: secondMatchId,
          status: "live",
        }),
      ]),
    );
    expect(view.matches.find((match) => match.id === secondMatchId)).not.toHaveProperty("homeScore");
    expect(view.matches.find((match) => match.id === secondMatchId)).not.toHaveProperty("awayScore");
    expect(view.accessPasses).toEqual([
      expect.objectContaining({
        matchId,
        role: "scorekeeper",
        displayCode: "••••••••••••",
        revoked: false,
        status: "active",
        fallbackCodeStatus: "rotation_required",
      }),
      expect.objectContaining({
        matchId,
        role: "viewer",
        displayCode: "••••••••••••",
        revoked: true,
        status: "revoked",
        fallbackCodeStatus: "unavailable",
      }),
    ]);
    expect(view.divisions).toEqual([
      {
        id: divisionId,
        name: "Open",
        entries: [
          { id: homeId, name: "North", seed: 1, status: "active" },
          { id: awayId, name: "South", seed: 2, status: "active" },
        ],
      },
    ]);
    expect(JSON.stringify(view)).not.toContain("must-not-leak");
    expect(view.accessPasses?.[0]).not.toHaveProperty("scoringHref");
    expect(view.scheduleRows).toEqual([
      {
        id: "2026-08-01T01:00:00.000Z",
        time: "09:00",
        cells: ["group-A-r1-m1 · Group", "group-A-r1-m2 · Group"],
      },
    ]);
    expect(view.formatSummary).toEqual([
      ["Format revision", "3"],
      ["Groups", "1"],
      ["Matches", "2"],
      ["Knockout stages", "—"],
    ]);
  });

  it.each([
    ["canoe_polo", "Canoe Polo"],
    ["badminton", "Badminton"],
    ["table_tennis", "Table Tennis"],
    ["volleyball", "Volleyball"],
    ["basketball", "Basketball"],
  ])("accepts the launch sport %s and maps its public label", (sportCode, sportLabel) => {
    const payload = workspace(sportCode);
    expect(isOrganiserWorkspacePayload(payload)).toBe(true);
    expect(toOrganiserCompetitionView(payload).sport).toBe(sportLabel);
  });

  it("keeps unpublished, unconfigured, and date-only data truthful", () => {
    const payload = workspace();
    payload.competition.timezone = "America/Los_Angeles";
    payload.settings = null;
    payload.publication = null;
    payload.current_format = null;
    payload.capacity = [
      {
        id: "court-1",
        name: "Court 1",
        windows: [{ starts_at: "2026-08-01T00:00:00.000Z", ends_at: "2026-08-01T01:00:00.000Z" }],
      },
    ];

    const view = toOrganiserCompetitionView(payload);

    expect(view).toMatchObject({
      dateLabel: "1 August 2026–2 August 2026",
      publicationState: "draft",
      publicationRevision: "Not published",
      publishedAt: "—",
      settings: [],
      availableCapacity: null,
      capacityAreas: [{ name: "Court 1", slotCount: null }],
      formatSummary: [],
    });
  });

  it("accepts only exact or local-loopback-equivalent cookie hosts", () => {
    expect(cookieHostMatches("app.matchday.test:3000", "app.matchday.test")).toBe(true);
    expect(cookieHostMatches("localhost:3000", "127.0.0.1")).toBe(true);
    expect(cookieHostMatches("[::1]:3000", "localhost")).toBe(true);
    expect(cookieHostMatches("app.matchday.test:3000", "api.matchday.test")).toBe(false);
    expect(cookieHostMatches("app.matchday.test.evil:3000", "app.matchday.test")).toBe(false);
  });

  it("projects viewer permission as read only", () => {
    const payload = workspace();
    payload.permission = "read";
    payload.read_only = true;
    expect(toOrganiserCompetitionView(payload).canEdit).toBe(false);
  });

  it("rejects payloads outside the supported organiser workspace contract", () => {
    expect(isOrganiserWorkspacePayload({ competition: { id: competitionId } })).toBe(false);
    expect(isOrganiserWorkspacePayload(workspace("football"))).toBe(false);
    expect(() => toOrganiserCompetitionView(workspace("football"))).toThrow("missing or unsupported");

    const malformedStatus = workspace();
    const malformedEntries = malformedStatus.divisions[0]?.entries as Array<Record<string, unknown>>;
    delete malformedEntries[0]?.status;
    expect(isOrganiserWorkspacePayload(malformedStatus)).toBe(false);

    const missingPermission = workspace();
    delete (missingPermission as Partial<OrganiserWorkspacePayload>).permission;
    expect(isOrganiserWorkspacePayload(missingPermission)).toBe(false);

    const unsupportedMatchState = workspace();
    (unsupportedMatchState.private_schedule?.matches as Array<Record<string, unknown>>)[0]!.state = "abandoned";
    expect(isOrganiserWorkspacePayload(unsupportedMatchState)).toBe(false);
    expect(() => toOrganiserCompetitionView(unsupportedMatchState)).toThrow("invalid scoring state");

    const incompleteFinalScore = workspace();
    (incompleteFinalScore.private_schedule?.matches as Array<Record<string, unknown>>)[0]!.home_score = null;
    expect(isOrganiserWorkspacePayload(incompleteFinalScore)).toBe(false);

    const pendingWithRetainedResult = workspace();
    (pendingWithRetainedResult.private_schedule?.matches as Array<Record<string, unknown>>)[1]!.state = "pending";
    expect(isOrganiserWorkspacePayload(pendingWithRetainedResult)).toBe(false);
  });
});
