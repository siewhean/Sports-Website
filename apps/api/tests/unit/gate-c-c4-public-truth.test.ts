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

describe("Gate C C4 canonical public truth", () => {
  it("reads the persisted projection column and exposes exact freshness", async () => {
    let query = "";
    const sql = {
      unsafe: async <T>(statement: string): Promise<T[]> => {
        query = statement;
        return [
          {
            payload: { division: { id: freshness.division_id, name: "Open" }, divisions: [] },
            ...freshness,
          } as T,
        ];
      },
    } as unknown as PostgresJsSql;

    const result = await new GateCC4PublicTruthRuntime(sql).read("national-cup");

    expect(query).toContain("projection.projection AS payload");
    expect(query).not.toContain("projection.payload");
    expect(result?.freshness).toEqual(freshness);
    expect(result?.headers).toMatchObject({
      etag: '"projection-9"',
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
        payload: { division: { id: freshness.division_id, name: "Open" }, divisions: [] },
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
