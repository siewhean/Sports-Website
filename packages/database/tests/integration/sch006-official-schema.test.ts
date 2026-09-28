import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "@matchday/config";
import { dropTestSchema, migrateDatabase } from "../../src/migrations.js";

const config = parseConfig(process.env);
const schema = `test_sch006_schema_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
let sql!: Sql;

beforeAll(async () => {
  await dropTestSchema(config.databaseUrl, schema);
  await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory, schema });
  sql = postgres(config.databaseUrl, { max: 1, connection: { search_path: schema } });
}, 30_000);

afterAll(async () => {
  await sql?.end({ timeout: 2 });
  await dropTestSchema(config.databaseUrl, schema);
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function roundRobinGraph(id = "fmt-8") {
  const matches = [];
  let order = 1;
  for (let home = 1; home <= 8; home += 1) {
    for (let away = home + 1; away <= 8; away += 1) {
      matches.push({
        id: `rr-${home}-${away}`,
        stageId: "round-robin",
        round: home,
        order,
        purpose: "pool",
        home: { type: "entry_seed", seed: home },
        away: { type: "entry_seed", seed: away },
      });
      order += 1;
    }
  }
  return {
    id,
    schemaVersion: 1,
    entryCount: 8,
    stages: [
      {
        id: "round-robin",
        label: "Round robin",
        kind: "round_robin",
        order: 1,
        groupIds: [],
        groupSize: null,
        outputRanks: 8,
        matchIds: matches.map((match) => match.id),
      },
    ],
    matches,
    terminalMatchIds: [],
  };
}

async function createCompetitionContext(label = "SCH-006") {
  const accountId = randomUUID();
  const organisationId = randomUUID();
  const competitionId = randomUUID();
  const divisionId = randomUUID();
  const formatRevisionId = randomUUID();

  const definition = roundRobinGraph(`fmt-${formatRevisionId}`);
  const layout = { schema_version: 1, stage_positions: [{ stage_id: "round-robin", x: 0, y: 0 }] };

  await sql.begin(async (tx) => {
    await tx`INSERT INTO accounts (id, primary_email, display_name) VALUES (${accountId}, ${`${accountId}@example.com`}, ${label})`;
    await tx`INSERT INTO organisations (id, name, slug) VALUES (${organisationId}, ${label}, ${`org-${organisationId}`})`;
    await tx`INSERT INTO organisation_memberships (organisation_id, account_id, role, status) VALUES (${organisationId}, ${accountId}, 'owner', 'active')`;
    await tx`INSERT INTO competitions (id, organisation_id, created_by, name, slug, sport_code, timezone, starts_on, ends_on, plan_tier)
             VALUES (${competitionId}, ${organisationId}, ${accountId}, ${`${label} Cup`}, ${`comp-${competitionId}`}, 'canoe_polo', 'UTC', '2026-09-01', '2026-09-02', 'organiser_pro')`;
    await tx`INSERT INTO divisions (id, competition_id, name, team_limit) VALUES (${divisionId}, ${competitionId}, 'Division 1', 16)`;
    await tx`INSERT INTO format_revisions (id, competition_id, division_id, revision, definition, definition_hash, layout, created_by, validation_contract)
             VALUES (${formatRevisionId}, ${competitionId}, ${divisionId}, 1, ${tx.json(definition)}, ${hash(definition)}, ${tx.json(layout)}, ${accountId}, 'phase3')`;
    await tx`SELECT phase4_materialize_format_revision(${formatRevisionId})`;
  });

  const storedMatches = await sql<{ id: string }[]>`
    SELECT id FROM matches WHERE format_revision_id = ${formatRevisionId} ORDER BY ordinal LIMIT 2
  `;
  const matchId1 = storedMatches[0]!.id;
  const matchId2 = storedMatches[1]!.id;

  return { accountId, organisationId, competitionId, divisionId, formatRevisionId, matchId1, matchId2 };
}

describe("SCH-006 Database Schema & Persistence Constraints", () => {
  it("enforces official identity constraints and non-destructive archival", async () => {
    const ctx = await createCompetitionContext("Identity");
    const officialId = randomUUID();

    // 1. Valid official creation
    await sql`INSERT INTO competition_officials (id, competition_id, organisation_id, name, default_role)
              VALUES (${officialId}, ${ctx.competitionId}, ${ctx.organisationId}, 'Sarah Connor', 'Lead Referee')`;

    const [official] = await sql<
      { id: string; name: string; default_role: string | null; archived_at: Date | null }[]
    >`SELECT id, name, default_role, archived_at FROM competition_officials WHERE id = ${officialId}`;
    expect(official).toBeDefined();
    expect(official!.name).toBe("Sarah Connor");
    expect(official!.default_role).toBe("Lead Referee");
    expect(official!.archived_at).toBeNull();

    // 2. Reject blank name
    await expect(
      sql`INSERT INTO competition_officials (competition_id, organisation_id, name)
          VALUES (${ctx.competitionId}, ${ctx.organisationId}, '   ')`,
    ).rejects.toThrow();

    // 3. Reject name over 80 characters
    await expect(
      sql`INSERT INTO competition_officials (competition_id, organisation_id, name)
          VALUES (${ctx.competitionId}, ${ctx.organisationId}, ${"A".repeat(81)})`,
    ).rejects.toThrow();

    // 4. Reject default_role over 40 characters
    await expect(
      sql`INSERT INTO competition_officials (competition_id, organisation_id, name, default_role)
          VALUES (${ctx.competitionId}, ${ctx.organisationId}, 'Valid Name', ${"R".repeat(41)})`,
    ).rejects.toThrow();

    // 5. Update metadata
    await sql`UPDATE competition_officials SET name = 'Sarah J. Connor', default_role = 'Referee' WHERE id = ${officialId}`;
    const [updated] = await sql<
      { name: string; default_role: string | null }[]
    >`SELECT name, default_role FROM competition_officials WHERE id = ${officialId}`;
    expect(updated!.name).toBe("Sarah J. Connor");
    expect(updated!.default_role).toBe("Referee");

    // 6. Archive official: row remains present with archived_at populated
    await sql`UPDATE competition_officials SET archived_at = now() WHERE id = ${officialId}`;
    const [archived] = await sql<
      { archived_at: Date | null }[]
    >`SELECT archived_at FROM competition_officials WHERE id = ${officialId}`;
    expect(archived!.archived_at).not.toBeNull();

    // 7. Active index excludes archived
    const activeOfficials =
      await sql`SELECT id FROM competition_officials WHERE competition_id = ${ctx.competitionId} AND archived_at IS NULL`;
    expect(activeOfficials.some((o) => o.id === officialId)).toBe(false);

    // 8. Restore official
    await sql`UPDATE competition_officials SET archived_at = NULL WHERE id = ${officialId}`;
    const [restored] = await sql<
      { archived_at: Date | null }[]
    >`SELECT archived_at FROM competition_officials WHERE id = ${officialId}`;
    expect(restored!.archived_at).toBeNull();
  });

  it("enforces tenant and cross-competition isolation for officials", async () => {
    const ctxA = await createCompetitionContext("CompA");
    const ctxB = await createCompetitionContext("CompB");

    // Attempt to create official with competition A but organisation B -> Foreign key violation
    await expect(
      sql`INSERT INTO competition_officials (competition_id, organisation_id, name)
          VALUES (${ctxA.competitionId}, ${ctxB.organisationId}, 'Cross Org Official')`,
    ).rejects.toThrow();
  });

  it("enforces official availability window constraints", async () => {
    const ctx = await createCompetitionContext("Availability");
    const officialId = randomUUID();
    await sql`INSERT INTO competition_officials (id, competition_id, organisation_id, name)
              VALUES (${officialId}, ${ctx.competitionId}, ${ctx.organisationId}, 'Ref Mark')`;

    // 1. Valid window
    const windowId = randomUUID();
    await sql`INSERT INTO official_availability_windows (id, competition_id, organisation_id, official_id, starts_at, ends_at)
              VALUES (${windowId}, ${ctx.competitionId}, ${ctx.organisationId}, ${officialId}, '2026-09-01T09:00:00Z', '2026-09-01T12:00:00Z')`;

    const [window] = await sql<{ id: string }[]>`SELECT id FROM official_availability_windows WHERE id = ${windowId}`;
    expect(window).toBeDefined();

    // 2. Reject zero-duration window (ends_at = starts_at)
    await expect(
      sql`INSERT INTO official_availability_windows (competition_id, organisation_id, official_id, starts_at, ends_at)
          VALUES (${ctx.competitionId}, ${ctx.organisationId}, ${officialId}, '2026-09-01T09:00:00Z', '2026-09-01T09:00:00Z')`,
    ).rejects.toThrow();

    // 3. Reject negative duration window (ends_at < starts_at)
    await expect(
      sql`INSERT INTO official_availability_windows (competition_id, organisation_id, official_id, starts_at, ends_at)
          VALUES (${ctx.competitionId}, ${ctx.organisationId}, ${officialId}, '2026-09-01T12:00:00Z', '2026-09-01T09:00:00Z')`,
    ).rejects.toThrow();

    // 4. Overlapping window is accepted in DB (canonicalisation happens in application layer)
    await sql`INSERT INTO official_availability_windows (competition_id, organisation_id, official_id, starts_at, ends_at)
              VALUES (${ctx.competitionId}, ${ctx.organisationId}, ${officialId}, '2026-09-01T11:00:00Z', '2026-09-01T14:00:00Z')`;

    // 5. Adjacent window is accepted in DB
    await sql`INSERT INTO official_availability_windows (competition_id, organisation_id, official_id, starts_at, ends_at)
              VALUES (${ctx.competitionId}, ${ctx.organisationId}, ${officialId}, '2026-09-01T14:00:00Z', '2026-09-01T16:00:00Z')`;

    // 6. Exact duplicate window is rejected by UNIQUE (official_id, starts_at, ends_at)
    await expect(
      sql`INSERT INTO official_availability_windows (competition_id, organisation_id, official_id, starts_at, ends_at)
          VALUES (${ctx.competitionId}, ${ctx.organisationId}, ${officialId}, '2026-09-01T14:00:00Z', '2026-09-01T16:00:00Z')`,
    ).rejects.toThrow();

    // 7. Cross-competition availability rejected
    const ctxOther = await createCompetitionContext("OtherComp");
    await expect(
      sql`INSERT INTO official_availability_windows (competition_id, organisation_id, official_id, starts_at, ends_at)
          VALUES (${ctxOther.competitionId}, ${ctxOther.organisationId}, ${officialId}, '2026-09-01T09:00:00Z', '2026-09-01T12:00:00Z')`,
    ).rejects.toThrow();
  });

  it("enforces match official assignment integrity and foreign keys", async () => {
    const ctxA = await createCompetitionContext("AssignA");
    const ctxB = await createCompetitionContext("AssignB");

    const officialA = randomUUID();
    await sql`INSERT INTO competition_officials (id, competition_id, organisation_id, name)
              VALUES (${officialA}, ${ctxA.competitionId}, ${ctxA.organisationId}, 'Official A')`;

    // 1. Valid assignment
    await sql`INSERT INTO match_official_assignments (competition_id, organisation_id, match_id, official_id, assigned_role)
              VALUES (${ctxA.competitionId}, ${ctxA.organisationId}, ${ctxA.matchId1}, ${officialA}, 'First Referee')`;

    // 2. Reject duplicate assignment of same official on same match
    await expect(
      sql`INSERT INTO match_official_assignments (competition_id, organisation_id, match_id, official_id)
          VALUES (${ctxA.competitionId}, ${ctxA.organisationId}, ${ctxA.matchId1}, ${officialA})`,
    ).rejects.toThrow();

    // 3. Same official assigned to multiple different matches is allowed
    await sql`INSERT INTO match_official_assignments (competition_id, organisation_id, match_id, official_id)
              VALUES (${ctxA.competitionId}, ${ctxA.organisationId}, ${ctxA.matchId2}, ${officialA})`;

    // 4. Official from Competition B assigned to Match in Competition A is rejected
    const officialB = randomUUID();
    await sql`INSERT INTO competition_officials (id, competition_id, organisation_id, name)
              VALUES (${officialB}, ${ctxB.competitionId}, ${ctxB.organisationId}, 'Official B')`;

    await expect(
      sql`INSERT INTO match_official_assignments (competition_id, organisation_id, match_id, official_id)
          VALUES (${ctxA.competitionId}, ${ctxA.organisationId}, ${ctxA.matchId1}, ${officialB})`,
    ).rejects.toThrow();

    // 5. Official from Competition A assigned to Match in Competition B is rejected
    await expect(
      sql`INSERT INTO match_official_assignments (competition_id, organisation_id, match_id, official_id)
          VALUES (${ctxB.competitionId}, ${ctxB.organisationId}, ${ctxB.matchId1}, ${officialA})`,
    ).rejects.toThrow();
  });

  it("cascades cleanly when owning competition is deleted", async () => {
    const ctx = await createCompetitionContext("Cascade");
    const officialId = randomUUID();

    await sql`INSERT INTO competition_officials (id, competition_id, organisation_id, name)
              VALUES (${officialId}, ${ctx.competitionId}, ${ctx.organisationId}, 'Cascade Official')`;

    await sql`INSERT INTO official_availability_windows (competition_id, organisation_id, official_id, starts_at, ends_at)
              VALUES (${ctx.competitionId}, ${ctx.organisationId}, ${officialId}, '2026-09-01T09:00:00Z', '2026-09-01T12:00:00Z')`;

    await sql`INSERT INTO match_official_assignments (competition_id, organisation_id, match_id, official_id)
              VALUES (${ctx.competitionId}, ${ctx.organisationId}, ${ctx.matchId1}, ${officialId})`;

    // Delete competition
    await sql`DELETE FROM competitions WHERE id = ${ctx.competitionId}`;

    // Verify all child rows are deleted via CASCADE
    const remainingOfficials = await sql`SELECT 1 FROM competition_officials WHERE id = ${officialId}`;
    expect(remainingOfficials).toHaveLength(0);

    const remainingWindows = await sql`SELECT 1 FROM official_availability_windows WHERE official_id = ${officialId}`;
    expect(remainingWindows).toHaveLength(0);

    const remainingAssignments = await sql`SELECT 1 FROM match_official_assignments WHERE official_id = ${officialId}`;
    expect(remainingAssignments).toHaveLength(0);
  });
});
