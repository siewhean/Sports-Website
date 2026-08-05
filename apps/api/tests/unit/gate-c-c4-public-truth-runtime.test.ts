import { describe, expect, it } from "vitest";
import type { PostgresJsSql } from "@matchday/identity";
import { GateCC4PublicTruthRuntime } from "../../src/gate-c-c4-public-truth.js";

const competitionId = "11111111-1111-4111-8111-111111111111";
const divisionId = "22222222-2222-4222-8222-222222222222";

function projection(extra: Record<string, unknown> = {}) {
  return {
    competition: {
      id: competitionId,
      name: "National Open",
      slug: "national-open",
      sport_code: "canoe_polo",
      timezone: "Asia/Singapore",
      starts_on: "2026-08-01",
      ends_on: "2026-08-03",
      status: "active",
    },
    divisions: [
      {
        division: { id: divisionId, name: "Open" },
        schedule: [],
        results: [],
        standings: null,
        bracket: null,
      },
    ],
    division: { id: divisionId, name: "Open" },
    publication: { schedule_version: 4, result_version: 7 },
    schedule: [],
    results: [],
    standings: null,
    bracket: null,
    last_updated_at: "2026-08-01T00:00:00.000Z",
    ...extra,
  };
}

function runtimeWithRows(rows: readonly unknown[]) {
  const calls: Array<{ query: string; parameters: readonly unknown[] }> = [];
  const sql = {
    unsafe: async (query: string, parameters: readonly unknown[]) => {
      calls.push({ query, parameters });
      return rows;
    },
  } as unknown as PostgresJsSql;
  return { runtime: new GateCC4PublicTruthRuntime(sql), calls };
}

const divisionFreshness = {
  division_id: divisionId,
  schedule_version: 4,
  result_version: 7,
  projection_version: 3,
  generated_at: "2026-08-01T00:00:05.000Z",
  source_updated_at: "2026-08-01T00:00:04.000Z",
  etag: "c4-division-3",
};

describe("Gate C C4 public truth runtime", () => {
  it("reads only the projection matching the current schedule and result publication versions", async () => {
    const { runtime, calls } = runtimeWithRows([
      {
        competition_id: competitionId,
        payload: projection(),
        schedule_version: 4,
        result_version: 7,
        generated_at: "2026-08-01T00:00:05.000Z",
        source_updated_at: "2026-08-01T00:00:04.000Z",
        division_freshness: [divisionFreshness],
      },
    ]);

    const first = await runtime.read("national-open");
    const second = await runtime.read("national-open");

    expect(first).not.toBeNull();
    expect(first).toEqual(second);
    expect(first?.payload).toMatchObject({
      publication: { schedule_version: 4, result_version: 7 },
      freshness: {
        schedule_version: 4,
        result_version: 7,
        projection_version: 3,
        generated_at: "2026-08-01T00:00:05.000Z",
        source_updated_at: "2026-08-01T00:00:04.000Z",
        division_freshness: [divisionFreshness],
      },
      last_updated_at: "2026-08-01T00:00:04.000Z",
    });
    expect(first?.freshness.etag).toMatch(/^c4-current-[a-f0-9]{64}$/u);
    expect(calls[0]?.parameters).toEqual(["national-open"]);
    expect(calls[0]?.query).toContain("projection.schedule_version=publication.schedule_version");
    expect(calls[0]?.query).toContain("projection.result_version=publication.result_version");
    expect(calls[0]?.query).toContain("division_projection.schedule_version=publication.schedule_version");
  });

  it("returns null when no exact current projection exists", async () => {
    const { runtime } = runtimeWithRows([]);
    await expect(runtime.read("missing-open")).resolves.toBeNull();
  });

  it("rejects a public projection containing private credentials", async () => {
    const { runtime } = runtimeWithRows([
      {
        competition_id: competitionId,
        payload: projection({ access_token: "must-not-leak" }),
        schedule_version: 4,
        result_version: 7,
        generated_at: "2026-08-01T00:00:05.000Z",
        source_updated_at: "2026-08-01T00:00:04.000Z",
        division_freshness: [divisionFreshness],
      },
    ]);

    await expect(runtime.read("national-open")).rejects.toThrow(/forbidden data/i);
  });
});
