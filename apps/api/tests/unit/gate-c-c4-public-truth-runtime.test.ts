import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { PostgresJsSql } from "@matchday/identity";
import { GateCC4PublicTruthRuntime, registerGateCC4PublicTruthRoutes } from "../../src/gate-c-c4-public-truth.js";

const competitionId = "11111111-1111-4111-8111-111111111111";
const divisionId = "22222222-2222-4222-8222-222222222222";
const reserveDivisionId = "33333333-3333-4333-8333-333333333333";

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
      {
        division: { id: reserveDivisionId, name: "Reserve" },
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

describe("Gate C C4 public truth runtime", () => {
  it("reads only the projection matching the current schedule and result publication versions", async () => {
    const { runtime, calls } = runtimeWithRows([
      {
        competition_id: competitionId,
        payload: projection(),
        schedule_version: 4,
        result_version: 7,
        projection_version: 3,
        division_projection_versions: { [divisionId]: 3, [reserveDivisionId]: 2 },
        generated_at: "2026-08-01T00:00:05.000Z",
        source_updated_at: "2026-08-01T00:00:04.000Z",
      },
    ]);

    const first = await runtime.read("national-open");
    const second = await runtime.read("national-open");

    expect(first).not.toBeNull();
    expect(first).toEqual(second);
    expect(first?.payload).toMatchObject({
      publication: { schedule_version: 4, result_version: 7 },
      freshness: {
        division_id: divisionId,
        division_projection_versions: { [divisionId]: 3, [reserveDivisionId]: 2 },
        schedule_version: 4,
        result_version: 7,
        projection_version: 3,
        generated_at: "2026-08-01T00:00:05.000Z",
        source_updated_at: "2026-08-01T00:00:04.000Z",
      },
      last_updated_at: "2026-08-01T00:00:04.000Z",
    });
    expect(first?.freshness.etag).toMatch(/^c4-4-7-3-[a-f0-9]{64}$/u);
    expect(calls[0]?.parameters).toEqual(["national-open"]);
    expect(calls[0]?.query).toContain("current_projection.schedule_version=publication.schedule_version");
    expect(calls[0]?.query).toContain("current_projection.result_version=publication.result_version");
    expect(calls[0]?.query).toContain("jsonb_object_agg(version.division_id::text, version.projection_version)");
  });

  it("returns null when no exact current projection exists", async () => {
    const { runtime } = runtimeWithRows([]);
    await expect(runtime.read("missing-open")).resolves.toBeNull();
  });

  it.each(["published", "live"] as const)("retains %s competitions in the canonical public payload", async (status) => {
    const { runtime } = runtimeWithRows([
      {
        competition_id: competitionId,
        payload: projection({ competition: { ...projection().competition, status } }),
        schedule_version: 4,
        result_version: 7,
        projection_version: 3,
        division_projection_versions: { [divisionId]: 3, [reserveDivisionId]: 2 },
        generated_at: "2026-08-01T00:00:05.000Z",
        source_updated_at: "2026-08-01T00:00:04.000Z",
      },
    ]);

    await expect(runtime.read("national-open")).resolves.toMatchObject({
      payload: { competition: { status } },
    });
  });

  it.each(["published", "live"] as const)(
    "serializes a %s competition through the public HTTP route",
    async (status) => {
      const app = Fastify();
      await registerGateCC4PublicTruthRoutes(app, {
        read: async () => ({
          payload: {
            ...projection({ competition: { ...projection().competition, status } }),
            freshness: {
              division_id: divisionId,
              division_projection_versions: { [divisionId]: 3, [reserveDivisionId]: 2 },
              schedule_version: 4,
              result_version: 7,
              projection_version: 3,
              generated_at: "2026-08-01T00:00:05.000Z",
              source_updated_at: "2026-08-01T00:00:04.000Z",
              etag: "c4-public-status",
            },
          },
          freshness: {
            division_id: divisionId,
            division_projection_versions: { [divisionId]: 3, [reserveDivisionId]: 2 },
            schedule_version: 4,
            result_version: 7,
            projection_version: 3,
            generated_at: "2026-08-01T00:00:05.000Z",
            source_updated_at: "2026-08-01T00:00:04.000Z",
            etag: "c4-public-status",
          },
        }),
      } as unknown as GateCC4PublicTruthRuntime);

      const response = await app.inject("/api/v1/public/competitions/national-open/current");
      await app.close();

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ competition: { status } });
    },
  );

  it("scopes the public response and ETag to one requested division", async () => {
    const { runtime } = runtimeWithRows([
      {
        competition_id: competitionId,
        payload: projection(),
        schedule_version: 4,
        result_version: 7,
        projection_version: 3,
        division_projection_versions: { [divisionId]: 3, [reserveDivisionId]: 2 },
        generated_at: "2026-08-01T00:00:05.000Z",
        source_updated_at: "2026-08-01T00:00:04.000Z",
      },
    ]);

    const wholeCompetition = await runtime.read("national-open");
    const reserveDivision = await runtime.read("national-open", reserveDivisionId);

    expect(reserveDivision?.payload).toMatchObject({
      divisions: [{ division: { id: reserveDivisionId, name: "Reserve" } }],
      division: { id: reserveDivisionId, name: "Reserve" },
      freshness: {
        division_id: reserveDivisionId,
        division_projection_versions: { [reserveDivisionId]: 2 },
        projection_version: 2,
      },
    });
    expect(reserveDivision?.freshness.etag).not.toBe(wholeCompetition?.freshness.etag);
    await expect(runtime.read("national-open", "44444444-4444-4444-8444-444444444444")).resolves.toBeNull();
  });

  it("returns 304 only when the scoped division ETag matches", async () => {
    const selectedDivisionIds: string[] = [];
    const freshness = {
      division_id: reserveDivisionId,
      division_projection_versions: { [reserveDivisionId]: 2 },
      schedule_version: 4,
      result_version: 7,
      projection_version: 2,
      generated_at: "2026-08-01T00:00:05.000Z",
      source_updated_at: "2026-08-01T00:00:04.000Z",
      etag: "c4-reserve-division",
    };
    const source = projection();
    const reservePackage = source.divisions[1]!;
    const app = Fastify();
    await registerGateCC4PublicTruthRoutes(app, {
      read: async (_slug: string, selectedDivisionId?: string) => {
        if (selectedDivisionId) selectedDivisionIds.push(selectedDivisionId);
        return {
          payload: {
            ...source,
            divisions: [reservePackage],
            division: reservePackage.division,
            schedule: reservePackage.schedule,
            results: reservePackage.results,
            standings: reservePackage.standings,
            bracket: reservePackage.bracket,
            freshness,
          },
          freshness,
        };
      },
    } as unknown as GateCC4PublicTruthRuntime);

    const path = `/api/v1/public/competitions/national-open/current?division_id=${reserveDivisionId}`;
    const first = await app.inject(path);
    const cached = await app.inject({ url: path, headers: { "if-none-match": first.headers.etag! } });
    await app.close();

    expect(first.statusCode).toBe(200);
    expect(first.headers.etag).toBe('"c4-reserve-division"');
    expect(first.headers["last-modified"]).toBe("Sat, 01 Aug 2026 00:00:04 GMT");
    expect(first.headers["cache-control"]).toBe("public, max-age=0, s-maxage=15, must-revalidate");
    expect(first.headers["x-matchday-schedule-version"]).toBe("4");
    expect(first.headers["x-matchday-result-version"]).toBe("7");
    expect(first.headers["x-matchday-projection-version"]).toBe("2");
    expect(cached.statusCode).toBe(304);
    expect(cached.headers["cache-control"]).toBe("public, max-age=0, s-maxage=15, must-revalidate");
    expect(selectedDivisionIds).toEqual([reserveDivisionId, reserveDivisionId]);
  });

  it("rejects a public projection containing private credentials", async () => {
    const { runtime } = runtimeWithRows([
      {
        competition_id: competitionId,
        payload: projection({ access_token: "must-not-leak" }),
        schedule_version: 4,
        result_version: 7,
        projection_version: 3,
        division_projection_versions: { [divisionId]: 3, [reserveDivisionId]: 2 },
        generated_at: "2026-08-01T00:00:05.000Z",
        source_updated_at: "2026-08-01T00:00:04.000Z",
      },
    ]);

    await expect(runtime.read("national-open")).rejects.toThrow(/forbidden data/i);
  });

  it("rejects freshness that references a division outside the exact public payload", async () => {
    const { runtime } = runtimeWithRows([
      {
        competition_id: competitionId,
        payload: projection(),
        schedule_version: 4,
        result_version: 7,
        projection_version: 3,
        division_projection_versions: { "44444444-4444-4444-8444-444444444444": 1 },
        generated_at: "2026-08-01T00:00:05.000Z",
        source_updated_at: "2026-08-01T00:00:04.000Z",
      },
    ]);

    await expect(runtime.read("national-open")).rejects.toThrow(/outside its payload/i);
  });
});
