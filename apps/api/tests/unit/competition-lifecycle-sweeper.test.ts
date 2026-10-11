import { describe, expect, it, vi } from "vitest";
import type { PostgresJsSql } from "@matchday/identity";
import {
  CompetitionLifecycleSweeper,
  competitionLifecycleSettingsFromEnv,
  type CompetitionLifecycleSettings,
} from "../../src/competition-lifecycle-sweeper.js";

const HOUR = 60 * 60 * 1000;
const settings: CompetitionLifecycleSettings = {
  enabled: true,
  completionGraceMs: 24 * HOUR,
  liveMatchStaleAfterMs: 6 * HOUR,
  intervalMs: 300_000,
  batchSize: 50,
};

type Competition = {
  id: string;
  organisation_id: string;
  status: string;
  revision: number;
  ends_on: Date | string;
  timezone: string;
};

function fakeDatabase(options: {
  competitions: Competition[];
  staleLive?: string[];
  locked?: Set<string>;
  guardRefuses?: boolean;
  publication?: { schedule_version: number; result_version: number } | null;
}) {
  const calls: Array<{ query: string; parameters: readonly unknown[] }> = [];
  const unsafe = vi.fn(async (query: string, parameters: readonly unknown[] = []) => {
    calls.push({ query, parameters });
    if (query.includes("FROM competitions\n       WHERE status = ANY")) {
      return options.competitions
        .filter((competition) => ["active", "live"].includes(competition.status))
        .map(({ id, ends_on, timezone }) => ({ id, ends_on, timezone }));
    }
    if (query.includes("SELECT DISTINCT match.competition_id")) {
      return (options.staleLive ?? []).map((competition_id) => ({ competition_id }));
    }
    if (query.includes("pg_try_advisory_xact_lock")) {
      const key = String(parameters[0]);
      return [{ locked: ![...(options.locked ?? [])].some((id) => key.endsWith(id)) }];
    }
    if (query.includes("FROM competitions WHERE id=$1 FOR UPDATE")) {
      return options.competitions
        .filter((competition) => competition.id === parameters[0])
        .map((competition) => ({ ...competition }));
    }
    if (query.startsWith("UPDATE competitions SET status='completed'")) {
      const competition = options.competitions.find((candidate) => candidate.id === parameters[0])!;
      if (options.guardRefuses)
        return [{ id: competition.id, status: competition.status, revision: competition.revision + 1 }];
      competition.status = "completed";
      competition.revision += 1;
      return [{ id: competition.id, status: "completed", revision: competition.revision }];
    }
    if (query.includes("FROM matches\n         WHERE competition_id=$1 AND state NOT IN")) {
      return [{ id: "match-live", state: "in_progress" }];
    }
    if (query.includes("FROM competition_publications publication")) {
      return options.publication === null ? [] : [options.publication ?? { schedule_version: 2, result_version: 3 }];
    }
    return [];
  });
  const sql = {
    unsafe,
    begin: async <T>(operation: (tx: PostgresJsSql) => Promise<T>) => operation(sql as unknown as PostgresJsSql),
  } as unknown as PostgresJsSql;
  return { sql, calls };
}

function sweeperFor(database: ReturnType<typeof fakeDatabase>, now: string) {
  const writer = { liveMatchStaleAfterMs: 0, writePublicProjection: vi.fn(async () => undefined) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const sweeper = new CompetitionLifecycleSweeper(database.sql, writer, settings, logger, () => new Date(now));
  return { sweeper, writer, logger };
}

describe("competition lifecycle settings", () => {
  it("defaults to a 24h completion grace, a 6h live staleness window and a 5 minute sweep", () => {
    expect(competitionLifecycleSettingsFromEnv({})).toEqual(settings);
  });

  it("accepts explicit overrides and the disable switch", () => {
    expect(
      competitionLifecycleSettingsFromEnv({
        MATCHDAY_COMPETITION_LIFECYCLE_SWEEP_ENABLED: "false",
        MATCHDAY_COMPETITION_AUTO_COMPLETE_GRACE_HOURS: "48",
        MATCHDAY_LIVE_MATCH_STALE_AFTER_HOURS: "1.5",
        MATCHDAY_COMPETITION_LIFECYCLE_SWEEP_INTERVAL_SECONDS: "60",
      }),
    ).toEqual({
      ...settings,
      enabled: false,
      completionGraceMs: 48 * HOUR,
      liveMatchStaleAfterMs: 1.5 * HOUR,
      intervalMs: 60_000,
    });
  });

  it.each([
    ["MATCHDAY_COMPETITION_AUTO_COMPLETE_GRACE_HOURS", "0"],
    ["MATCHDAY_LIVE_MATCH_STALE_AFTER_HOURS", "soon"],
    ["MATCHDAY_COMPETITION_LIFECYCLE_SWEEP_INTERVAL_SECONDS", "-1"],
    ["MATCHDAY_COMPETITION_LIFECYCLE_SWEEP_ENABLED", "maybe"],
  ])("rejects an invalid %s", (key, value) => {
    expect(() => competitionLifecycleSettingsFromEnv({ [key]: value })).toThrow(key);
  });
});

describe("competition lifecycle sweeper", () => {
  const stale = (): Competition => ({
    id: "competition-stale",
    organisation_id: "organisation-1",
    status: "active",
    revision: 4,
    ends_on: new Date("2026-09-20T00:00:00.000Z"),
    timezone: "Asia/Singapore",
  });

  it("shares one live staleness window with the projection writer", () => {
    const { writer } = sweeperFor(fakeDatabase({ competitions: [] }), "2026-10-09T00:00:00.000Z");
    expect(writer.liveMatchStaleAfterMs).toBe(6 * HOUR);
  });

  it("completes an elapsed competition with a system audit event and a regenerated projection", async () => {
    const database = fakeDatabase({ competitions: [stale()] });
    const { sweeper, writer } = sweeperFor(database, "2026-10-09T00:00:00.000Z");

    await expect(sweeper.sweep()).resolves.toEqual({
      completed: ["competition-stale"],
      refreshed: [],
      skipped: [],
      failed: [],
    });

    const queries = database.calls.map((call) => call.query);
    const enable = queries.findIndex((query) => query.includes("'matchday.competition_schedule_elapsed','on'"));
    const update = queries.findIndex((query) => query.startsWith("UPDATE competitions SET status='completed'"));
    const disable = queries.findIndex((query) => query.includes("'matchday.competition_schedule_elapsed','off'"));
    expect(enable).toBeGreaterThan(-1);
    expect(enable).toBeLessThan(update);
    expect(update).toBeLessThan(disable);
    expect(queries[update]).toContain("revision=revision+1");

    const audit = database.calls.find((call) => call.query.includes("INSERT INTO audit_events"));
    expect(audit?.query).toContain("'system'");
    expect(audit?.parameters).toEqual([
      new Date("2026-10-09T00:00:00.000Z"),
      "system:competition-lifecycle:competition-stale:completed",
      "organisation-1",
      "competition.transitioned",
      "competition-stale",
      "Competition schedule elapsed",
      { status: "active", revision: 4 },
      { id: "competition-stale", status: "completed", revision: 5 },
      expect.objectContaining({
        trigger: "schedule_elapsed",
        ends_on: "2026-09-20",
        timezone: "Asia/Singapore",
        unfinished_matches: [{ id: "match-live", state: "in_progress" }],
      }),
    ]);
    // Unfinished matches are reported, never finalised.
    expect(queries.some((query) => /UPDATE matches/iu.test(query))).toBe(false);
    expect(writer.writePublicProjection).toHaveBeenCalledWith(expect.anything(), "competition-stale", 2, 3);
  });

  it("is idempotent: a completed competition is not selected again", async () => {
    const database = fakeDatabase({ competitions: [stale()] });
    const { sweeper, writer } = sweeperFor(database, "2026-10-09T00:00:00.000Z");
    await sweeper.sweep();
    await expect(sweeper.sweep()).resolves.toEqual({ completed: [], refreshed: [], skipped: [], failed: [] });
    expect(writer.writePublicProjection).toHaveBeenCalledTimes(1);
  });

  it("waits for the grace period measured in the competition timezone", async () => {
    // Final day ended 2026-09-20T16:00Z in Singapore; 23h59m later is still inside the grace period.
    const database = fakeDatabase({ competitions: [stale()] });
    const { sweeper, writer } = sweeperFor(database, "2026-09-21T15:59:00.000Z");
    await expect(sweeper.sweep()).resolves.toMatchObject({ completed: [] });
    expect(database.calls.some((call) => call.query.includes("FOR UPDATE"))).toBe(false);
    expect(writer.writePublicProjection).not.toHaveBeenCalled();
  });

  it("skips a competition another instance is already handling", async () => {
    const database = fakeDatabase({ competitions: [stale()], locked: new Set(["competition-stale"]) });
    const { sweeper } = sweeperFor(database, "2026-10-09T00:00:00.000Z");
    await expect(sweeper.sweep()).resolves.toMatchObject({ completed: [], skipped: ["competition-stale"] });
    expect(database.calls.some((call) => call.query.includes("INSERT INTO audit_events"))).toBe(false);
  });

  it("records nothing when the database lifecycle guard keeps the competition open", async () => {
    const database = fakeDatabase({ competitions: [stale()], guardRefuses: true });
    const { sweeper, writer, logger } = sweeperFor(database, "2026-10-09T00:00:00.000Z");
    await expect(sweeper.sweep()).resolves.toMatchObject({ completed: [], failed: ["competition-stale"] });
    expect(database.calls.some((call) => call.query.includes("INSERT INTO audit_events"))).toBe(false);
    expect(writer.writePublicProjection).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("isolates a competition with an unresolvable timezone", async () => {
    const database = fakeDatabase({
      competitions: [{ ...stale(), id: "competition-bad-zone", timezone: "Mars/Olympus" }, stale()],
    });
    const { sweeper } = sweeperFor(database, "2026-10-09T00:00:00.000Z");
    await expect(sweeper.sweep()).resolves.toMatchObject({
      completed: ["competition-stale"],
      failed: ["competition-bad-zone"],
    });
  });

  it("regenerates projections that still show an abandoned live match, without touching the match", async () => {
    const database = fakeDatabase({ competitions: [], staleLive: ["competition-running"] });
    const { sweeper, writer } = sweeperFor(database, "2026-10-09T12:00:00.000Z");
    await expect(sweeper.sweep()).resolves.toMatchObject({ refreshed: ["competition-running"] });
    const staleQuery = database.calls.find((call) => call.query.includes("SELECT DISTINCT match.competition_id"));
    expect(staleQuery?.parameters).toEqual([new Date("2026-10-09T06:00:00.000Z"), 6 * HOUR, 50]);
    expect(staleQuery?.query).toContain("projection.generated_at < stream.updated_at");
    expect(writer.writePublicProjection).toHaveBeenCalledWith(expect.anything(), "competition-running", 2, 3);
    expect(database.calls.some((call) => /UPDATE matches/iu.test(call.query))).toBe(false);
  });

  it("does not write a projection for an unpublished competition", async () => {
    const database = fakeDatabase({ competitions: [], staleLive: ["competition-draft"], publication: null });
    const { sweeper, writer } = sweeperFor(database, "2026-10-09T12:00:00.000Z");
    await expect(sweeper.sweep()).resolves.toMatchObject({ refreshed: [], skipped: ["competition-draft"] });
    expect(writer.writePublicProjection).not.toHaveBeenCalled();
  });
});
