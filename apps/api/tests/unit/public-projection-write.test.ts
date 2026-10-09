import { describe, expect, it } from "vitest";
import { assertPublicProjectionPrivacy } from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../../src/phase-2-runtime.js";

const competitionId = "11111111-1111-4111-8111-111111111111";
const divisionId = "22222222-2222-4222-8222-222222222222";
const matchId = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-10-09T12:00:00.000Z");

function fakeTransaction() {
  const calls: Array<{ query: string; parameters: readonly unknown[] }> = [];
  const tx = {
    unsafe: async (query: string, parameters: readonly unknown[] = []) => {
      calls.push({ query, parameters });
      if (query.includes("FROM competitions WHERE id=$1")) {
        return [
          {
            id: competitionId,
            name: "National Open",
            slug: "national-open",
            sport_code: "volleyball",
            timezone: "Asia/Singapore",
            starts_on: "2026-09-19",
            ends_on: "2026-09-20",
            status: "active",
          },
        ];
      }
      if (query.includes("FROM divisions WHERE competition_id")) return [{ id: divisionId, name: "Open" }];
      if (query.includes("JOIN match_result_snapshots s")) {
        return [
          {
            id: matchId,
            division_id: divisionId,
            code: "OPEN-1",
            stage: "group",
            home_entry_id: "55555555-5555-4555-8555-555555555555",
            away_entry_id: "66666666-6666-4666-8666-666666666666",
            home_name: "Marina Blue",
            away_name: "Harbour Gold",
            home_score: 2,
            away_score: 1,
            state: "final",
            created_at: "2026-09-20T08:00:00.000Z",
            snapshot: {
              currentSegment: 3,
              segments: [
                { number: 1, home: 25, away: 20 },
                { number: 2, home: 22, away: 25 },
                { number: 3, home: 15, away: 11 },
              ],
              actions: [{ manualTimeSeconds: 3600, reversed: false }],
            },
          },
        ];
      }
      return [];
    },
  } as unknown as PostgresJsSql;
  return { tx, calls };
}

describe("public projection write", () => {
  it("keeps set and segment detail on every public result while passing the privacy guard", async () => {
    const runtime = new Phase2Runtime({} as PostgresJsSql, phase2DomainAdapter, () => now, undefined, "x".repeat(32));
    const { tx, calls } = fakeTransaction();

    await runtime.writePublicProjection(tx, competitionId, 0, 1);

    const insert = calls.find((call) => call.query.includes("INSERT INTO public_competition_projections"));
    const projection = JSON.parse(String(insert?.parameters[3])) as {
      divisions: Array<{ results: Array<Record<string, unknown>> }>;
      results: Array<Record<string, unknown>>;
    };
    const expected = {
      id: matchId,
      state: "final",
      current_segment: 3,
      segments: [
        { number: 1, home: 25, away: 20 },
        { number: 2, home: 22, away: 25 },
        { number: 3, home: 15, away: 11 },
      ],
      recorded_time_seconds: 3600,
    };
    expect(projection.divisions[0]?.results[0]).toMatchObject(expected);
    expect(projection.results[0]).toMatchObject(expected);
    expect(() => assertPublicProjectionPrivacy(projection as unknown as Record<string, unknown>)).not.toThrow();
    // Content-only upsert: the database trigger owns live_revision, the writer never sets it.
    expect(insert?.query).not.toContain("live_revision");
  });

  it("withholds in-progress matches without recent scoring activity from the live view", async () => {
    const runtime = new Phase2Runtime({} as PostgresJsSql, phase2DomainAdapter, () => now, undefined, "x".repeat(32));
    runtime.liveMatchStaleAfterMs = 6 * 60 * 60 * 1000;
    const { tx, calls } = fakeTransaction();

    await runtime.writePublicProjection(tx, competitionId, 0, 1, {
      liveScores: new Map([[matchId, { home: 1, away: 0 }]]),
    });

    const live = calls.find((call) => call.query.includes("JOIN match_score_streams stream"));
    expect(live?.query).toContain("m.state='in_progress'");
    expect(live?.query).toContain("stream.updated_at > $2");
    expect(live?.parameters).toEqual([competitionId, new Date("2026-10-09T06:00:00.000Z"), [matchId]]);
  });
});
