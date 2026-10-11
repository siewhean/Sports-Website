import { describe, expect, it } from "vitest";
import type { PostgresJsSql } from "@matchday/identity";
import { Phase3Runtime } from "../../src/phase-3-runtime.js";
import { Phase4Runtime, type Phase4AiOptions } from "../../src/phase-4-runtime.js";
import { assertChildInCompetition, assertDivisionInCompetition } from "../../src/tenant-scope.js";

const ACTOR = { accountId: "00000000-0000-4000-8000-0000000000a1" };
const ORG = "00000000-0000-4000-8000-0000000000b1";
const COMPETITION = "00000000-0000-4000-8000-0000000000c1";
// A division (or repair case) that belongs to some OTHER organisation's competition.
const FOREIGN_DIVISION = "00000000-0000-4000-8000-0000000000d9";
const OWN_DIVISION = "00000000-0000-4000-8000-0000000000d1";
const FOREIGN_CASE = "00000000-0000-4000-8000-0000000000e9";

type Recorded = { sql: string; params: readonly unknown[] };

/**
 * Minimal postgres.js stand-in. The caller is a fully authorised organiser of COMPETITION; only
 * OWN_DIVISION is owned by it. Everything else is "owned elsewhere" and so invisible to a
 * competition-scoped lookup, exactly as it is in Postgres.
 */
const createSql = () => {
  const queries: Recorded[] = [];
  const unsafe = (async (sql: string, params: readonly unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes("m.account_id=$2") && sql.includes("FROM competitions c")) {
      return [
        {
          id: COMPETITION,
          organisation_id: ORG,
          sport_code: "football",
          status: "draft",
          timezone: "UTC",
          capacity_revision: 1,
          revision: 1,
          membership_role: "organiser",
        },
      ];
    }
    if (sql.includes("FROM organisation_memberships WHERE organisation_id=$1")) return [{ "?column?": 1 }];
    if (sql.includes("FROM divisions t WHERE t.id=$1 AND t.competition_id=$2")) {
      return params[0] === OWN_DIVISION && params[1] === COMPETITION ? [{ id: OWN_DIVISION }] : [];
    }
    return [];
  }) as PostgresJsSql["unsafe"];
  const sql = {
    unsafe,
    begin: async <T>(callback: (tx: PostgresJsSql) => Promise<T>) => callback(sql as unknown as PostgresJsSql),
  } as unknown as PostgresJsSql;
  return { sql, queries };
};

const createRuntimes = () => {
  const { sql, queries } = createSql();
  const phase3 = new Phase3Runtime(sql, {} as never);
  const ai: Phase4AiOptions = {
    mode: "disabled",
    provider: null,
    timeoutMs: 1000,
    maximumAttempts: 1,
    cacheTtlSeconds: 60,
  };
  const phase4 = new Phase4Runtime(sql, phase3, { enqueue: async () => undefined } as never, ai);
  return { phase3, phase4, queries };
};

const touched = (queries: Recorded[], fragment: string) => queries.some((query) => query.sql.includes(fragment));

const notFound = (code: string) => expect.objectContaining({ statusCode: 404, code });

describe("tenant-scope helper", () => {
  it("returns the same 404 for a missing child and for a child owned by another competition", async () => {
    const { sql } = createSql();
    const missing = await assertDivisionInCompetition(sql, "00000000-0000-4000-8000-00000000ffff", COMPETITION).catch(
      (error: unknown) => error,
    );
    const foreign = await assertDivisionInCompetition(sql, FOREIGN_DIVISION, COMPETITION).catch(
      (error: unknown) => error,
    );
    expect(missing).toMatchObject({ statusCode: 404, code: "DIVISION_NOT_FOUND", message: "Division not found" });
    expect(foreign).toMatchObject({ statusCode: 404, code: "DIVISION_NOT_FOUND", message: "Division not found" });
    await expect(assertDivisionInCompetition(sql, OWN_DIVISION, COMPETITION)).resolves.toBeUndefined();
  });

  it("applies the lock clause only when requested and only where a row lock is legal", async () => {
    const { sql, queries } = createSql();
    await assertDivisionInCompetition(sql, OWN_DIVISION, COMPETITION, { forUpdate: true });
    expect(queries.at(-1)?.sql).toContain("FOR UPDATE OF t");
    await assertChildInCompetition(sql, "repair_case", FOREIGN_CASE, COMPETITION, { forUpdate: true }).catch(
      () => undefined,
    );
    expect(queries.at(-1)?.sql).not.toContain("FOR UPDATE");
  });
});

describe("division/case ids are tied to the authorised competition before any child query", () => {
  it("readFormatBuilder does not disclose another competition's format history", async () => {
    const { phase4, queries } = createRuntimes();
    await expect(phase4.readFormatBuilder(ACTOR, COMPETITION, FOREIGN_DIVISION)).rejects.toMatchObject({
      statusCode: 404,
      code: "DIVISION_NOT_FOUND",
    });
    expect(touched(queries, "FROM format_revisions")).toBe(false);
  });

  it("readFormatBuilder scopes the revision listing by competition for an owned division", async () => {
    const { phase4, queries } = createRuntimes();
    await expect(phase4.readFormatBuilder(ACTOR, COMPETITION, OWN_DIVISION)).resolves.toEqual({
      revisions: [],
      draft: null,
    });
    const listing = queries.find((query) => query.sql.includes("FROM format_revisions"));
    expect(listing?.sql).toContain("competition_id = $2");
    expect(listing?.params).toEqual([OWN_DIVISION, COMPETITION]);
  });

  it("applyFormatTemplate never locks or reads a foreign division's format row", async () => {
    const { phase4, queries } = createRuntimes();
    await expect(
      phase4.applyFormatTemplate(
        ACTOR,
        ORG,
        {
          competition_id: COMPETITION,
          division_id: FOREIGN_DIVISION,
          template_version_id: "00000000-0000-4000-8000-0000000000f1",
          expected_format_revision: null,
          idempotency_key: "k".repeat(16),
        },
        "req-1",
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "DIVISION_NOT_FOUND" });
    expect(touched(queries, "FROM format_revisions")).toBe(false);
    expect(touched(queries, "FOR UPDATE")).toBe(false);
  });

  it("recalculateStandings rejects a foreign division before locking publication state or reading standings", async () => {
    const { phase3, queries } = createRuntimes();
    await expect(phase3.recalculateStandings(ACTOR, COMPETITION, FOREIGN_DIVISION, "req-2")).rejects.toMatchObject({
      statusCode: 404,
      code: "DIVISION_NOT_FOUND",
    });
    expect(touched(queries, "competition_publications")).toBe(false);
    expect(touched(queries, "standings_snapshots")).toBe(false);
    expect(touched(queries, "phase3_standings_source_hash")).toBe(false);
  });

  it("AI formatModify and schedulePreferences reject a foreign division before starting an AI ledger entry", async () => {
    const { phase4, queries } = createRuntimes();
    const document = {} as never;
    await expect(
      phase4.formatModify(
        ACTOR,
        ORG,
        COMPETITION,
        FOREIGN_DIVISION,
        { idempotency_key: "k".repeat(16), text: "make it double elimination", current_document: document },
        "req-3",
      ),
    ).rejects.toEqual(notFound("DIVISION_NOT_FOUND"));
    await expect(
      phase4.schedulePreferences(
        ACTOR,
        ORG,
        COMPETITION,
        FOREIGN_DIVISION,
        { idempotency_key: "k".repeat(16), text: "rest 30 minutes" } as never,
        "req-4",
      ),
    ).rejects.toEqual(notFound("DIVISION_NOT_FOUND"));
    expect(touched(queries, "phase4_begin_ai_action")).toBe(false);
  });

  it("AI repairRecommendations rejects a case from another competition before starting an AI ledger entry", async () => {
    const { phase4, queries } = createRuntimes();
    await expect(
      phase4.repairRecommendations(
        ACTOR,
        ORG,
        COMPETITION,
        FOREIGN_CASE,
        { idempotency_key: "k".repeat(16), text: "delay pitch 1" },
        "req-5",
      ),
    ).rejects.toEqual(notFound("REPAIR_CASE_NOT_FOUND"));
    expect(touched(queries, "phase4_begin_ai_action")).toBe(false);
  });
});
