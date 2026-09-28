import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "@matchday/config";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { OfficialRepository, type SqlExecutor } from "../../src/repositories/index.js";

const config = parseConfig(process.env);
const schema = `test_official_repo_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
let sql!: Sql;
let repo!: OfficialRepository;

beforeAll(async () => {
  await dropTestSchema(config.databaseUrl, schema);
  await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory, schema });
  sql = postgres(config.databaseUrl, { max: 5, connection: { search_path: schema } });
  repo = new OfficialRepository(sql as unknown as SqlExecutor);
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

async function createCompetitionContext(label = "RepoInteg") {
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
    await tx`INSERT INTO competitions (id, organisation_id, created_by, name, slug, sport_code, timezone, starts_on, ends_on, revision, plan_tier)
              VALUES (${competitionId}, ${organisationId}, ${accountId}, ${`${label} Cup`}, ${`comp-${competitionId}`}, 'canoe_polo', 'UTC', '2026-09-01', '2026-09-02', 1, 'organiser_pro')`;
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

async function getRevision(competitionId: string): Promise<number> {
  const [row] = await sql<{ revision: number }[]>`SELECT revision FROM competitions WHERE id = ${competitionId}`;
  return row?.revision ?? 0;
}

describe("OfficialRepository (PostgreSQL Integration)", () => {
  it("strictly implements Checkpoint 1A revision behavior matrix", async () => {
    const ctx = await createCompetitionContext("RevisionMatrix");
    expect(await getRevision(ctx.competitionId)).toBe(1);

    // 1. Create unassigned official -> NO revision bump
    const official1 = await repo.createOfficial({
      competitionId: ctx.competitionId,
      organisationId: ctx.organisationId,
      name: "Referee One",
      defaultRole: "First Referee",
      actorId: ctx.accountId,
    });
    expect(await getRevision(ctx.competitionId)).toBe(1);

    // 2. Rename official -> NO revision bump
    await repo.updateOfficialMetadata({
      competitionId: ctx.competitionId,
      officialId: official1.id,
      name: "Referee One Renamed",
    });
    expect(await getRevision(ctx.competitionId)).toBe(1);

    // 3. Availability for unassigned official -> NO revision bump
    const avail1Result = await repo.replaceAvailability({
      competitionId: ctx.competitionId,
      organisationId: ctx.organisationId,
      officialId: official1.id,
      windows: [{ startsAt: "2026-09-01T08:00:00Z", endsAt: "2026-09-01T12:00:00Z" }],
    });
    expect(avail1Result.bumpedRevision).toBe(false);
    expect(await getRevision(ctx.competitionId)).toBe(1);

    // 4. Assign official to match -> BUMPS revision
    const assignResult = await repo.assignOfficial({
      competitionId: ctx.competitionId,
      organisationId: ctx.organisationId,
      matchId: ctx.matchId1,
      officialId: official1.id,
      assignedRole: "Head Referee",
      actorId: ctx.accountId,
    });
    expect(assignResult.bumpedRevision).toBe(true);
    expect(await getRevision(ctx.competitionId)).toBe(2);

    // 5. Availability for assigned official -> BUMPS revision
    const avail2Result = await repo.replaceAvailability({
      competitionId: ctx.competitionId,
      organisationId: ctx.organisationId,
      officialId: official1.id,
      windows: [
        { startsAt: "2026-09-01T08:00:00Z", endsAt: "2026-09-01T11:00:00Z" },
        { startsAt: "2026-09-01T11:00:00Z", endsAt: "2026-09-01T14:00:00Z" },
      ],
    });
    expect(avail2Result.bumpedRevision).toBe(true);
    expect(await getRevision(ctx.competitionId)).toBe(3);

    // 6. Unassign official -> BUMPS revision
    const unassignResult = await repo.unassignOfficial({
      competitionId: ctx.competitionId,
      organisationId: ctx.organisationId,
      matchId: ctx.matchId1,
      officialId: official1.id,
      actorId: ctx.accountId,
    });
    expect(unassignResult.bumpedRevision).toBe(true);
    expect(await getRevision(ctx.competitionId)).toBe(4);

    // 7. Create a second official, assign them, then test archival
    const official2 = await repo.createOfficial({
      competitionId: ctx.competitionId,
      organisationId: ctx.organisationId,
      name: "Referee Two",
    });
    expect(await getRevision(ctx.competitionId)).toBe(4); // No bump on create unassigned

    // 8. Archive unassigned official (official1 is now unassigned) -> NO revision bump
    const archiveUnassigned = await repo.archiveOfficial({
      competitionId: ctx.competitionId,
      officialId: official1.id,
    });
    expect(archiveUnassigned.bumpedRevision).toBe(false);
    expect(await getRevision(ctx.competitionId)).toBe(4);

    // Assign official2 -> BUMPS revision
    await repo.assignOfficial({
      competitionId: ctx.competitionId,
      organisationId: ctx.organisationId,
      matchId: ctx.matchId2,
      officialId: official2.id,
    });
    expect(await getRevision(ctx.competitionId)).toBe(5);

    // 9. Archive assigned official (official2) -> BUMPS revision
    const archiveAssigned = await repo.archiveOfficial({
      competitionId: ctx.competitionId,
      officialId: official2.id,
    });
    expect(archiveAssigned.bumpedRevision).toBe(true);
    expect(await getRevision(ctx.competitionId)).toBe(6);

    // Historical assignment for official2 must still be present even after archival
    const assignmentsAfterArchive = await repo.listMatchAssignments(ctx.competitionId, ctx.matchId2);
    expect(assignmentsAfterArchive).toHaveLength(1);
    expect(assignmentsAfterArchive[0]?.official_id).toBe(official2.id);
  });

  it("verifies audit and outbox persistence in same transaction", async () => {
    const ctx = await createCompetitionContext("AuditOutbox");
    const requestId = randomUUID();

    const official = await repo.createOfficial({
      competitionId: ctx.competitionId,
      organisationId: ctx.organisationId,
      name: "Audit Test Ref",
      actorId: ctx.accountId,
      requestId,
    });

    const auditRows = await sql`
      SELECT action, target_type, target_id, actor_account_id, request_id
      FROM audit_events
      WHERE request_id = ${requestId}
    `;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe("official.created");
    expect(auditRows[0]?.target_type).toBe("competition_official");
    expect(auditRows[0]?.target_id).toBe(official.id);

    const outboxRows = await sql`
      SELECT aggregate_type, aggregate_id, event_type, idempotency_key
      FROM outbox_events
      WHERE aggregate_id = ${official.id}
    `;
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.event_type).toBe("official.created");
    expect(outboxRows[0]?.idempotency_key).toContain(requestId);
  });

  it("atomically rolls back mutations and revision increments on transaction failure", async () => {
    const ctx = await createCompetitionContext("Rollback");
    const initialRev = await getRevision(ctx.competitionId);

    const official = await repo.createOfficial({
      competitionId: ctx.competitionId,
      organisationId: ctx.organisationId,
      name: "Rollback Ref",
    });

    // Attempt transactional operation that fails halfway
    await expect(
      sql.begin(async (tx) => {
        const txRepo = new OfficialRepository(tx as unknown as SqlExecutor);
        await txRepo.assignOfficial({
          competitionId: ctx.competitionId,
          organisationId: ctx.organisationId,
          matchId: ctx.matchId1,
          officialId: official.id,
        });
        // Intentionally throw
        throw new Error("Deliberate transaction failure");
      }),
    ).rejects.toThrow("Deliberate transaction failure");

    // Revision should remain unchanged
    expect(await getRevision(ctx.competitionId)).toBe(initialRev);

    // Assignment must not exist
    const assignments = await repo.listMatchAssignments(ctx.competitionId, ctx.matchId1);
    expect(assignments).toHaveLength(0);
  });

  it("handles concurrent scheduling mutations without losing revision updates", async () => {
    const ctx = await createCompetitionContext("Concurrency");
    const initialRev = await getRevision(ctx.competitionId);

    const officialA = await repo.createOfficial({
      competitionId: ctx.competitionId,
      organisationId: ctx.organisationId,
      name: "Ref A",
    });
    const officialB = await repo.createOfficial({
      competitionId: ctx.competitionId,
      organisationId: ctx.organisationId,
      name: "Ref B",
    });

    // Two concurrent assignments on different matches
    await Promise.all([
      repo.assignOfficial({
        competitionId: ctx.competitionId,
        organisationId: ctx.organisationId,
        matchId: ctx.matchId1,
        officialId: officialA.id,
      }),
      repo.assignOfficial({
        competitionId: ctx.competitionId,
        organisationId: ctx.organisationId,
        matchId: ctx.matchId2,
        officialId: officialB.id,
      }),
    ]);

    // Both increments must be captured
    const finalRev = await getRevision(ctx.competitionId);
    expect(finalRev).toBe(initialRev + 2);
  });
});
