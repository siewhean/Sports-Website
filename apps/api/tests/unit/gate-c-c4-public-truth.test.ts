import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { PostgresJsSql } from "@matchday/identity";
import { GateCC4PublicTruthRuntime, registerGateCC4PublicTruthRoutes } from "../../src/gate-c-c4-public-truth.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

const freshness = {
  division_id: "00000000-0000-4000-8000-000000000101",
  schedule_version: 4,
  result_version: 7,
  projection_version: 9,
  generated_at: "2026-08-01T00:00:05.000Z",
  source_updated_at: "2026-08-01T00:00:00.000Z",
  etag: "projection-9",
};

const payload = {
  competition: {
    id: "00000000-0000-4000-8000-000000000001",
    name: "National Cup",
    slug: "national-cup",
    sport_code: "canoe_polo",
    timezone: "Asia/Singapore",
    starts_on: "2026-08-01",
    ends_on: "2026-08-02",
    status: "active",
  },
  divisions: [
    {
      division: { id: freshness.division_id, name: "Open" },
      schedule: [],
      results: [],
      standings: null,
      bracket: null,
    },
  ],
  division: { id: freshness.division_id, name: "Open" },
  publication: { schedule_version: 4, result_version: 7 },
  schedule: [],
  results: [],
  standings: null,
  bracket: null,
  last_updated_at: freshness.source_updated_at,
  freshness: {
    schedule_version: freshness.schedule_version,
    result_version: freshness.result_version,
    projection_version: freshness.projection_version,
    generated_at: freshness.generated_at,
    source_updated_at: freshness.source_updated_at,
    etag: freshness.etag,
    division_freshness: [freshness],
  },
  public_notices: [],
};

describe("Gate C C4 canonical public truth", () => {
  it("reads the persisted projection column and exposes exact freshness", async () => {
    let query = "";
    const sql = {
      unsafe: async <T>(statement: string): Promise<T[]> => {
        query = statement;
        return [
          {
            payload,
            ...freshness,
            division_freshness: [freshness],
          } as T,
        ];
      },
    } as unknown as PostgresJsSql;

    const result = await new GateCC4PublicTruthRuntime(sql).read("national-cup");

    expect(query).toContain("projection.projection AS payload");
    expect(query).toContain("JOIN public_competition_projections projection");
    expect(query).not.toContain("LIMIT 1");
    expect(result?.freshness).toMatchObject({
      schedule_version: freshness.schedule_version,
      result_version: freshness.result_version,
      projection_version: freshness.projection_version,
      division_freshness: [freshness],
    });
    expect(result?.headers).toMatchObject({
      etag: `"${result?.freshness.etag}"`,
      "x-matchday-schedule-version": "4",
      "x-matchday-result-version": "7",
      "x-matchday-projection-version": "9",
    });
  });

  it("registers the unauthenticated canonical endpoint with conditional responses", async () => {
    const app = Fastify();
    apps.push(app);
    const runtime = {
      read: async () => ({
        payload,
        freshness,
        headers: {
          etag: '"projection-9"',
          "last-modified": "Sat, 01 Aug 2026 00:00:00 GMT",
          "cache-control": "public, max-age=0, s-maxage=15, must-revalidate",
          "x-matchday-schedule-version": "4",
          "x-matchday-result-version": "7",
          "x-matchday-projection-version": "9",
        },
      }),
    } as unknown as GateCC4PublicTruthRuntime;
    await registerGateCC4PublicTruthRoutes(app, runtime);

    const current = await app.inject({ method: "GET", url: "/api/v1/public/competitions/national-cup/current" });
    const cached = await app.inject({
      method: "GET",
      url: "/api/v1/public/competitions/national-cup/current",
      headers: { "if-none-match": '"projection-9"' },
    });

    expect(current.statusCode).toBe(200);
    expect(current.headers.etag).toBe('"projection-9"');
    expect(cached.statusCode).toBe(304);
  });
});
