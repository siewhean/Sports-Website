import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase, migrationAdvisoryLockId } from "../../src/migrations.js";
import { contendedMigrationTestTimeoutMs } from "./migration-test-settings.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase3_schema_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
let sql!: Sql;

function hash(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item && typeof item === "object") {
      return `{${Object.entries(item)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
        .join(",")}}`;
    }
    return JSON.stringify(item);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}

type TestFormatSource = { type: "entry_seed"; seed: number } | { type: "winner"; matchId: string };
type TestFormatMatch = {
  id: string;
  stageId: string;
  round: number;
  order: number;
  purpose: string;
  home: TestFormatSource;
  away: TestFormatSource;
};
type TestFormatGraph = {
  id: string;
  schemaVersion: number;
  entryCount: number;
  stages: Array<{
    id: string;
    label: string;
    kind: string;
    order: number;
    groupIds: string[];
    groupSize: number | null;
    outputRanks: number;
    matchIds: string[];
  }>;
  matches: TestFormatMatch[];
  terminalMatchIds: string[];
};

function validRoundRobinGraph(entryCount = 8): TestFormatGraph {
  const matches: TestFormatMatch[] = [];
  let order = 1;
  for (let home = 1; home <= entryCount; home += 1) {
    for (let away = home + 1; away <= entryCount; away += 1) {
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
    id: `round-robin-${entryCount}`,
    schemaVersion: 1,
    entryCount,
    stages: [
      {
        id: "round-robin",
        label: "Round robin",
        kind: "round_robin",
        order: 1,
        groupIds: [],
        groupSize: null,
        outputRanks: entryCount,
        matchIds: matches.map((match) => match.id),
      },
    ],
    matches,
    terminalMatchIds: [],
  };
}

function truncatedKnockoutGraph(): TestFormatGraph {
  return {
    id: "truncated-48",
    schemaVersion: 1,
    entryCount: 48,
    stages: [
      {
        id: "knockout",
        label: "Knockout",
        kind: "single_elimination",
        order: 1,
        groupIds: [],
        groupSize: null,
        outputRanks: 2,
        matchIds: ["final"],
      },
    ],
    matches: [
      {
        id: "final",
        stageId: "knockout",
        round: 1,
        order: 1,
        purpose: "championship",
        home: { type: "entry_seed", seed: 1 },
        away: { type: "entry_seed", seed: 2 },
      },
    ],
    terminalMatchIds: ["final"],
  };
}

function validByeGraph(): TestFormatGraph {
  return {
    id: "three-entry-bye",
    schemaVersion: 1,
    entryCount: 3,
    stages: [
      {
        id: "knockout",
        label: "Knockout",
        kind: "single_elimination",
        order: 1,
        groupIds: [],
        groupSize: null,
        outputRanks: 3,
        matchIds: ["semifinal", "final"],
      },
    ],
    matches: [
      {
        id: "semifinal",
        stageId: "knockout",
        round: 1,
        order: 1,
        purpose: "progression",
        home: { type: "entry_seed", seed: 2 },
        away: { type: "entry_seed", seed: 3 },
      },
      {
        id: "final",
        stageId: "knockout",
        round: 2,
        order: 2,
        purpose: "championship",
        home: { type: "entry_seed", seed: 1 },
        away: { type: "winner", matchId: "semifinal" },
      },
    ],
    terminalMatchIds: ["final"],
  };
}

function validLegacyPhase2Definition() {
  const entries = Array.from({ length: 8 }, () => randomUUID());
  const groupIds = ["A", "B"] as const;
  const matches: Array<{
    id: string;
    stage: string;
    round: number;
    order: number;
    home: Record<string, string | number>;
    away: Record<string, string | number>;
    dependencyMatchIds: string[];
  }> = [];
  const groups = groupIds.map((groupId, groupIndex) => {
    const groupEntries = entries.slice(groupIndex * 4, groupIndex * 4 + 4);
    const pairings = [
      [0, 3],
      [1, 2],
      [0, 2],
      [3, 1],
      [0, 1],
      [2, 3],
    ] as const;
    const matchIds = pairings.map(() => randomUUID());
    pairings.forEach(([home, away], index) => {
      matches.push({
        id: matchIds[index]!,
        stage: "group",
        round: Math.floor(index / 2) + 1,
        order: groupIndex * 6 + index + 1,
        home: { type: "entry", entryId: groupEntries[home]! },
        away: { type: "entry", entryId: groupEntries[away]! },
        dependencyMatchIds: [],
      });
    });
    return { id: groupId, entryIds: groupEntries, matchIds };
  });
  const groupDependencies = groups.flatMap((group) => group.matchIds);
  const semifinal1 = randomUUID();
  const semifinal2 = randomUUID();
  const bronze = randomUUID();
  const final = randomUUID();
  matches.push(
    {
      id: semifinal1,
      stage: "semifinal",
      round: 4,
      order: 13,
      home: { type: "group_rank", groupId: "A", rank: 1 },
      away: { type: "group_rank", groupId: "B", rank: 2 },
      dependencyMatchIds: groupDependencies,
    },
    {
      id: semifinal2,
      stage: "semifinal",
      round: 4,
      order: 14,
      home: { type: "group_rank", groupId: "B", rank: 1 },
      away: { type: "group_rank", groupId: "A", rank: 2 },
      dependencyMatchIds: groupDependencies,
    },
    {
      id: bronze,
      stage: "bronze",
      round: 5,
      order: 15,
      home: { type: "loser", matchId: semifinal1 },
      away: { type: "loser", matchId: semifinal2 },
      dependencyMatchIds: [semifinal1, semifinal2],
    },
    {
      id: final,
      stage: "final",
      round: 5,
      order: 16,
      home: { type: "winner", matchId: semifinal1 },
      away: { type: "winner", matchId: semifinal2 },
      dependencyMatchIds: [semifinal1, semifinal2],
    },
  );
  return {
    id: randomUUID(),
    version: 1,
    entryCount: 8,
    groups,
    matches,
    knockoutMatchIds: [semifinal1, semifinal2, bronze, final],
  };
}

async function world() {
  const account = randomUUID();
  const organisation = randomUUID();
  const competition = randomUUID();
  const divisionA = randomUUID();
  const divisionB = randomUUID();
  await sql`INSERT INTO accounts (id,primary_email,display_name) VALUES (${account},${`${account}@example.test`},'Phase 3')`;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organisations (id,name,slug) VALUES (${organisation},'Phase 3',${`phase3-${organisation}`})`;
    await tx`INSERT INTO organisation_memberships (organisation_id,account_id,role,status) VALUES (${organisation},${account},'owner','active')`;
  });
  await sql`INSERT INTO competitions (id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on)
    VALUES (${competition},${organisation},${account},'Phase 3 Cup',${`phase3-cup-${competition}`},'badminton','Asia/Singapore','2027-01-01','2027-01-02')`;
  await sql`INSERT INTO divisions (id,competition_id,name,team_limit) VALUES
    (${divisionA},${competition},'Open',48),(${divisionB},${competition},'Women',48)`;
  return { account, organisation, competition, divisionA, divisionB };
}

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  sql = postgres(databaseUrl, { max: 4, onnotice: () => undefined, connection: { search_path: schema } });
});

afterAll(async () => {
  await sql?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

describeInfrastructure("Phase 3 PostgreSQL guardrails", () => {
  it("installs archive guards across the complete competition aggregate", async () => {
    const expectedTables = [
      "advancement_conflicts",
      "advancement_slots",
      "bracket_snapshots",
      "competition_publications",
      "match_dependencies",
      "match_result_snapshots",
      "match_writer_leases",
      "matches",
      "public_competition_projections",
      "schedule_revisions",
      "scheduled_matches",
      "score_events",
      "scoring_access_passes",
      "scoring_access_sessions",
    ];
    const guards = await sql<{ table_name: string }[]>`
      SELECT event_object_table AS table_name
      FROM information_schema.triggers
      WHERE trigger_schema=${schema}
        AND trigger_name LIKE '%phase3_archive_guard'
        AND event_manipulation='INSERT'
        AND event_object_table=ANY(${expectedTables})
      ORDER BY event_object_table`;
    expect(guards.map((row) => row.table_name)).toEqual(expectedTables);
  });

  it(
    "backfills legacy null slot durations before enforcing competition-wide consistency",
    async () => {
      const upgradeSchema = `test_phase3_upgrade_${randomUUID().replaceAll("-", "")}`;
      const upgradeSql = postgres(databaseUrl, {
        max: 1,
        onnotice: () => undefined,
        connection: { search_path: upgradeSchema },
      });
      try {
        await upgradeSql.unsafe(`CREATE SCHEMA "${upgradeSchema}"`);
        const migrationNames = (await readdir(migrationsDirectory))
          .filter((name) => /^000[1-8]_[a-z0-9_]+\.sql$/.test(name))
          .sort();
        await upgradeSql`SELECT pg_advisory_lock(${migrationAdvisoryLockId})`;
        try {
          for (const name of migrationNames) {
            const contents = await readFile(path.join(migrationsDirectory, name), "utf8");
            await upgradeSql.begin((tx) => tx.unsafe(contents));
          }
        } finally {
          await upgradeSql`SELECT pg_advisory_unlock(${migrationAdvisoryLockId})`;
        }

        const account = randomUUID();
        const organisation = randomUUID();
        const competition = randomUUID();
        await upgradeSql`INSERT INTO accounts (id,primary_email,display_name) VALUES (${account},${`${account}@example.test`},'Upgrade')`;
        await upgradeSql.begin(async (tx) => {
          await tx`INSERT INTO organisations (id,name,slug) VALUES (${organisation},'Upgrade',${`upgrade-${organisation}`})`;
          await tx`INSERT INTO organisation_memberships (organisation_id,account_id,role,status) VALUES (${organisation},${account},'owner','active')`;
        });
        await upgradeSql`INSERT INTO competitions (id,organisation_id,created_by,name,slug,timezone,starts_on,ends_on)
          VALUES (${competition},${organisation},${account},'Upgrade Cup',${`upgrade-cup-${competition}`},'Asia/Singapore','2027-01-01','2027-01-02')`;
        await upgradeSql`INSERT INTO competition_sport_settings (competition_id,slot_minutes,updated_by)
          VALUES (${competition},30,${account})`;
        await upgradeSql`INSERT INTO playing_areas (competition_id,name,slot_minutes)
          VALUES (${competition},'Legacy Court',NULL)`;

        const alignment = await readFile(path.join(migrationsDirectory, "0009_phase3_runtime_alignment.sql"), "utf8");
        await upgradeSql.begin((tx) => tx.unsafe(alignment));
        const areas = await upgradeSql<{ slot_minutes: number }[]>`
          SELECT slot_minutes FROM playing_areas WHERE competition_id=${competition}`;
        expect(areas).toEqual([{ slot_minutes: 30 }]);
        const nullability = await upgradeSql<{ is_nullable: string }[]>`
          SELECT is_nullable FROM information_schema.columns
          WHERE table_schema=${upgradeSchema} AND table_name='playing_areas' AND column_name='slot_minutes'`;
        expect(nullability[0]?.is_nullable).toBe("NO");
        await upgradeSql`INSERT INTO playing_areas (competition_id,name,slot_minutes)
          VALUES (${competition},'Court 2',30)`;
        await expect(
          upgradeSql`INSERT INTO playing_areas (competition_id,name,slot_minutes)
            VALUES (${competition},'Court 3',45)`,
        ).rejects.toThrow(/one competition slot duration/);
      } finally {
        await upgradeSql.end({ timeout: 2 });
        await dropTestSchema(databaseUrl, upgradeSchema);
      }
    },
    contendedMigrationTestTimeoutMs,
  );

  it("serializes the free limit across divisions and preserves entries on upgrade", async () => {
    const value = await world();
    for (let index = 0; index < 16; index += 1) {
      await sql`INSERT INTO division_entries (division_id,name,seed,entry_type,status)
        VALUES (${index % 2 ? value.divisionA : value.divisionB},${`Entry ${index}`},${index + 1},'team','active')`;
    }
    await expect(sql`INSERT INTO division_entries (division_id,name,entry_type,status)
      VALUES (${value.divisionA},'Seventeenth','team','active')`).rejects.toThrow(/16 active entries/);
    await sql`UPDATE competitions SET plan_tier='organiser_pro' WHERE id=${value.competition}`;
    await sql`INSERT INTO division_entries (division_id,name,entry_type,status)
      VALUES (${value.divisionA},'Seventeenth','team','active')`;
    const count = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM division_entries e
      JOIN divisions d ON d.id=e.division_id WHERE d.competition_id=${value.competition}`;
    expect(count[0]?.count).toBe(17);
    await expect(sql`UPDATE competitions SET plan_tier='free' WHERE id=${value.competition}`).rejects.toThrow(
      /cannot downgrade/,
    );
  });

  it("serializes concurrent free-tier inserts across divisions", async () => {
    const value = await world();
    for (let index = 0; index < 15; index += 1) {
      await sql`INSERT INTO division_entries (division_id,name,entry_type,status)
        VALUES (${value.divisionA},${`Existing ${index}`},'team','active')`;
    }
    const attempts = await Promise.allSettled([
      sql`INSERT INTO division_entries (division_id,name,entry_type,status)
        VALUES (${value.divisionA},'Concurrent A','team','active')`,
      sql`INSERT INTO division_entries (division_id,name,entry_type,status)
        VALUES (${value.divisionB},'Concurrent B','team','active')`,
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const count = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM division_entries e
      JOIN divisions d ON d.id=e.division_id WHERE d.competition_id=${value.competition}`;
    expect(count[0]?.count).toBe(16);
  });

  it("rolls back a whole import and its evidence when any row is invalid", async () => {
    const value = await world();
    const importId = randomUUID();
    await expect(
      sql.begin(async (tx) => {
        await tx`INSERT INTO entry_imports (id,competition_id,division_id,source_kind,row_count,created_by)
          VALUES (${importId},${value.competition},${value.divisionA},'csv',2,${value.account})`;
        await tx`INSERT INTO division_entries (division_id,name,entry_type,status) VALUES
          (${value.divisionA},'Valid','team','active'),(${value.divisionA},'','team','active')`;
      }),
    ).rejects.toThrow();
    const imports = await sql`SELECT id FROM entry_imports WHERE id=${importId}`;
    const entries = await sql`SELECT id FROM division_entries WHERE division_id=${value.divisionA}`;
    const audits = await sql`SELECT id FROM audit_events WHERE target_id=${importId}`;
    const outbox = await sql`SELECT id FROM outbox_events WHERE aggregate_id=${importId}`;
    expect(imports).toHaveLength(0);
    expect(entries).toHaveLength(0);
    expect(audits).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });

  it("rejects malformed drafts and publications through direct SQL", async () => {
    const value = await world();
    const valid = validRoundRobinGraph();
    const invalidDefinitions = [
      { ...valid, stages: [] },
      { ...valid, stages: [{ ...valid.stages[0]!, matchIds: valid.stages[0]!.matchIds.slice(1) }] },
      {
        ...valid,
        matches: valid.matches.map((match, index) => (index === 0 ? { ...match, stageId: "missing" } : match)),
      },
      {
        ...valid,
        matches: valid.matches.map((match, index) =>
          index === 0 ? { ...match, home: { type: "entry_seed", seed: 99 } } : match,
        ),
      },
      { ...valid, terminalMatchIds: ["missing-match"] },
      truncatedKnockoutGraph(),
    ];
    for (const [index, definition] of invalidDefinitions.entries()) {
      await expect(sql`INSERT INTO format_revisions
        (competition_id,division_id,revision,definition,definition_hash,status,published_at,created_by,validation_contract)
        VALUES (${value.competition},${value.divisionA},${index + 1},${sql.json(definition)},${hash(definition)},'draft',null,${value.account},'phase3')`).rejects.toThrow(
        /structurally invalid/,
      );
    }
    const cyclic = {
      id: "cycle",
      schemaVersion: 1,
      entryCount: 2,
      stages: [
        {
          id: "ko",
          label: "KO",
          kind: "single_elimination",
          order: 1,
          groupIds: [],
          groupSize: null,
          outputRanks: 2,
          matchIds: ["m1", "m2"],
        },
      ],
      matches: [
        {
          id: "m1",
          stageId: "ko",
          round: 1,
          order: 2,
          purpose: "championship",
          home: { type: "winner", matchId: "m2" },
          away: { type: "entry_seed", seed: 1 },
        },
        {
          id: "m2",
          stageId: "ko",
          round: 1,
          order: 1,
          purpose: "championship",
          home: { type: "winner", matchId: "m1" },
          away: { type: "entry_seed", seed: 2 },
        },
      ],
      terminalMatchIds: ["m1"],
    };
    await expect(sql`INSERT INTO format_revisions
      (competition_id,division_id,revision,definition,definition_hash,status,published_at,created_by,validation_contract)
      VALUES (${value.competition},${value.divisionA},10,${sql.json(cyclic)},${hash(cyclic)},'published',now(),${value.account},'phase3')`).rejects.toThrow(
      /structurally invalid/,
    );
  });

  it("closes every direct-SQL legacy validation bypass", async () => {
    const value = await world();
    const malformed = { id: randomUUID(), version: 1, entryCount: 8, groups: [], matches: [], knockoutMatchIds: [] };
    const legacy = validLegacyPhase2Definition();

    await expect(sql`INSERT INTO format_revisions
      (competition_id,division_id,revision,definition,definition_hash,created_by)
      VALUES (${value.competition},${value.divisionA},1,${sql.json(malformed)},${hash(malformed)},${value.account})`).rejects.toThrow(
      /structurally invalid/,
    );
    await expect(sql`INSERT INTO format_revisions
      (competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract)
      VALUES (${value.competition},${value.divisionA},2,${sql.json(malformed)},${hash(malformed)},${value.account},'phase2')`).rejects.toThrow(
      /phase2 format revision definition is structurally invalid/,
    );
    await expect(sql`INSERT INTO format_revisions
      (competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract)
      VALUES (${value.competition},${value.divisionA},3,${sql.json(legacy)},${"0".repeat(64)},${value.account},'phase2')`).rejects.toThrow(
      /hash does not match/,
    );
    await expect(sql`INSERT INTO format_revisions
      (competition_id,division_id,revision,definition,definition_hash,created_by)
      VALUES (${value.competition},${value.divisionA},4,${sql.json(legacy)},${hash(legacy)},${value.account})`).rejects.toThrow(
      /structurally invalid/,
    );
    await expect(sql`INSERT INTO format_revisions
      (competition_id,division_id,revision,definition,definition_hash,status,published_at,created_by,validation_contract)
      VALUES (${value.competition},${value.divisionA},5,${sql.json(legacy)},${hash(legacy)},'published',now(),${value.account},'phase2')`).rejects.toThrow(
      /validated phase2 storage|complete schedule|current aggregate capacity/,
    );
  });

  it("requires complete entrant seed coverage while preserving knockout byes", async () => {
    const [truncated, bye] = await Promise.all([
      sql<{ valid: boolean }[]>`
        SELECT phase3_format_definition_db_valid(${sql.json(truncatedKnockoutGraph())}::jsonb) AS valid`,
      sql<{ valid: boolean }[]>`
        SELECT phase3_format_definition_db_valid(${sql.json(validByeGraph())}::jsonb) AS valid`,
    ]);
    expect(truncated[0]?.valid).toBe(false);
    expect(bye[0]?.valid).toBe(true);
  });

  it("guards format entry count against the division limit and eligible population", async () => {
    const value = await world();
    await sql`UPDATE divisions SET team_limit=8 WHERE id=${value.divisionA}`;

    const oversized = validRoundRobinGraph(12);
    await expect(sql`INSERT INTO format_revisions
      (competition_id,division_id,revision,definition,definition_hash,status,published_at,created_by,validation_contract)
      VALUES (${value.competition},${value.divisionA},1,${sql.json(oversized)},${hash(oversized)},'draft',null,${value.account},'phase3')`).rejects.toThrow(
      /entry count does not match division eligibility and limit/,
    );

    const preregistration = validRoundRobinGraph(8);
    const preregistrationId = randomUUID();
    await sql`INSERT INTO division_entries (division_id,name,entry_type,status,withdrawn_at,withdrawal_reason)
      VALUES (${value.divisionA},'Withdrawn entrant','team','withdrawn',now(),'Test withdrawal')`;
    await sql`INSERT INTO format_revisions
      (id,competition_id,division_id,revision,definition,definition_hash,status,published_at,created_by,validation_contract)
      VALUES (${preregistrationId},${value.competition},${value.divisionA},2,${sql.json(preregistration)},${hash(preregistration)},'draft',null,${value.account},'phase3')`;

    await sql`INSERT INTO division_entries (division_id,name,entry_type,status) VALUES
      (${value.divisionA},'Eligible 1','team','active'),
      (${value.divisionA},'Eligible 2','team','confirmed')`;
    await expect(sql`UPDATE format_revisions SET status='published',published_at=now()
      WHERE id=${preregistrationId}`).rejects.toThrow(
      /publish entry count does not match division eligibility and limit/,
    );

    const mismatched = { ...preregistration, id: "mismatched-eight" };
    await expect(sql`INSERT INTO format_revisions
      (competition_id,division_id,revision,definition,definition_hash,status,published_at,created_by,validation_contract)
      VALUES (${value.competition},${value.divisionA},3,${sql.json(mismatched)},${hash(mismatched)},'draft',null,${value.account},'phase3')`).rejects.toThrow(
      /entry count does not match division eligibility and limit/,
    );

    await sql`INSERT INTO division_entries (division_id,name,entry_type,status) VALUES
      (${value.divisionA},'Eligible 3','team','active'),
      (${value.divisionA},'Eligible 4','team','active'),
      (${value.divisionA},'Eligible 5','team','active'),
      (${value.divisionA},'Eligible 6','team','active'),
      (${value.divisionA},'Eligible 7','team','active'),
      (${value.divisionA},'Eligible 8','team','active')`;
    const exact = { ...preregistration, id: "exact-eight" };
    await sql`INSERT INTO format_revisions
      (competition_id,division_id,revision,definition,definition_hash,status,published_at,created_by,validation_contract)
      VALUES (${value.competition},${value.divisionA},4,${sql.json(exact)},${hash(exact)},'draft',null,${value.account},'phase3')`;
  });

  it("recomputes valid graph evidence and publishes a complete round robin", async () => {
    const value = await world();
    const validFormatId = randomUUID();
    const validDefinition = validRoundRobinGraph();
    const validHash = hash(validDefinition);
    const databaseValidation = await sql<{ valid: boolean }[]>`
      SELECT phase3_format_definition_db_valid(${sql.json(validDefinition)}::jsonb) AS valid`;
    expect(databaseValidation[0]?.valid).toBe(true);

    const areaId = randomUUID();
    await sql`INSERT INTO playing_areas (id,competition_id,name,slot_minutes) VALUES (${areaId},${value.competition},'Court',30)`;
    await sql`INSERT INTO competition_availability_windows (competition_id,playing_area_id,starts_at,ends_at)
      VALUES (${value.competition},${areaId},'2027-01-01T00:00:00Z','2027-01-01T14:00:00Z')`;
    await sql`INSERT INTO format_revisions (id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract)
      VALUES (${validFormatId},${value.competition},${value.divisionA},1,${sql.json(validDefinition)},${validHash},${value.account},'phase3')`;
    const secondDraft = { ...validDefinition, id: "round-robin-draft-delete" };
    const secondDraftId = randomUUID();
    await sql`INSERT INTO format_revisions (id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract)
      VALUES (${secondDraftId},${value.competition},${value.divisionA},2,${sql.json(secondDraft)},${hash(secondDraft)},${value.account},'phase3')`;
    await expect(sql`DELETE FROM format_revisions WHERE id=${secondDraftId}`).rejects.toThrow(/append-only/);
    await sql`INSERT INTO format_validation_evidence
      (format_revision_id,definition_hash,valid,graph_acyclic,graph_reachable,slots_unambiguous,
       deterministic_match_count,available_match_slots,required_match_slots,recommendation_fits_capacity,validated_by)
      VALUES (${validFormatId},${validHash},false,false,false,false,999,999,999,false,${value.account})`;
    const evidence = await sql<
      {
        valid: boolean;
        graph_acyclic: boolean;
        deterministic_match_count: number;
        available_match_slots: number;
      }[]
    >`SELECT valid,graph_acyclic,deterministic_match_count,available_match_slots
      FROM format_validation_evidence WHERE format_revision_id=${validFormatId}`;
    expect(evidence[0]).toEqual({
      valid: true,
      graph_acyclic: true,
      deterministic_match_count: 28,
      available_match_slots: 28,
    });
    await sql`UPDATE format_revisions SET status='published',published_at=now() WHERE id=${validFormatId}`;
    await expect(sql`UPDATE format_revisions SET definition='{}'::jsonb WHERE id=${validFormatId}`).rejects.toThrow(
      /immutable/,
    );
    await expect(sql`DELETE FROM format_revisions WHERE id=${validFormatId}`).rejects.toThrow(/append-only|immutable/);
  });

  it("enforces per-area reserves and aggregate multi-division format capacity", async () => {
    const reserved = await world();
    const shortArea = randomUUID();
    const longArea = randomUUID();
    await sql`INSERT INTO playing_areas (id,competition_id,name,slot_minutes,fixed_reserve_slots) VALUES
      (${shortArea},${reserved.competition},'Short',30,5),
      (${longArea},${reserved.competition},'Long',30,1)`;
    await sql`INSERT INTO competition_availability_windows (competition_id,playing_area_id,starts_at,ends_at) VALUES
      (${reserved.competition},${shortArea},'2027-01-01T00:00:00Z','2027-01-01T01:00:00Z'),
      (${reserved.competition},${longArea},'2027-01-01T00:00:00Z','2027-01-01T03:00:00Z')`;
    expect(
      (
        await sql<{ slots: number }[]>`
          SELECT phase3_available_match_slots(${reserved.competition})::int AS slots`
      )[0]?.slots,
    ).toBe(5);

    const shared = await world();
    const area = randomUUID();
    await sql`INSERT INTO playing_areas (id,competition_id,name,slot_minutes) VALUES
      (${area},${shared.competition},'Shared',30)`;
    await sql`INSERT INTO competition_availability_windows (competition_id,playing_area_id,starts_at,ends_at)
      VALUES (${shared.competition},${area},'2027-01-01T00:00:00Z','2027-01-01T20:00:00Z')`;
    const firstDefinition = { ...validRoundRobinGraph(), id: "aggregate-first" };
    const secondDefinition = { ...validRoundRobinGraph(), id: "aggregate-second" };
    const firstId = randomUUID();
    const secondId = randomUUID();
    await sql`INSERT INTO format_revisions
      (id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract)
      VALUES (${firstId},${shared.competition},${shared.divisionA},1,${sql.json(firstDefinition)},${hash(firstDefinition)},${shared.account},'phase3')`;
    await sql`INSERT INTO format_validation_evidence
      (format_revision_id,definition_hash,valid,graph_acyclic,graph_reachable,slots_unambiguous,
       deterministic_match_count,available_match_slots,required_match_slots,recommendation_fits_capacity,validated_by)
      VALUES (${firstId},${hash(firstDefinition)},false,false,false,false,0,0,0,false,${shared.account})`;
    await sql`UPDATE format_revisions SET status='published',published_at=now() WHERE id=${firstId}`;
    await sql`INSERT INTO format_revisions
      (id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract)
      VALUES (${secondId},${shared.competition},${shared.divisionB},1,${sql.json(secondDefinition)},${hash(secondDefinition)},${shared.account},'phase3')`;
    await sql`INSERT INTO format_validation_evidence
      (format_revision_id,definition_hash,valid,graph_acyclic,graph_reachable,slots_unambiguous,
       deterministic_match_count,available_match_slots,required_match_slots,recommendation_fits_capacity,validated_by)
      VALUES (${secondId},${hash(secondDefinition)},false,false,false,false,0,0,0,true,${shared.account})`;
    expect(
      (
        await sql<{ available: number; required: number; fits: boolean }[]>`
          SELECT available_match_slots::int AS available,required_match_slots::int AS required,
                 recommendation_fits_capacity AS fits
          FROM format_validation_evidence WHERE format_revision_id=${secondId}`
      )[0],
    ).toEqual({ available: 40, required: 56, fits: false });
    await expect(
      sql`UPDATE format_revisions SET status='published',published_at=now() WHERE id=${secondId}`,
    ).rejects.toThrow(/aggregate capacity evidence/);
  });

  it("rejects a valid graph paired with a caller-forged hash", async () => {
    const value = await world();
    const definition = validRoundRobinGraph();
    await expect(sql`INSERT INTO format_revisions
      (competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract)
      VALUES (${value.competition},${value.divisionA},1,${sql.json(definition)},${"0".repeat(64)},${value.account},'phase3')`).rejects.toThrow(
      /hash does not match/,
    );
  });

  it("enforces canonical sport-pack hashes, draft defaults, one active version, and append-only content", async () => {
    const value = await world();
    const definition = { schemaVersion: 1, sport: "badminton" };
    await sql`INSERT INTO sport_pack_versions
      (sport_code,version,schema_version,definition,definition_hash,created_by)
      VALUES ('badminton','test-immutable',1,${sql.json(definition)},${hash(definition)},${value.account})`;
    const inserted = await sql<{ status: string; activated_at: Date | null }[]>`
      SELECT status,activated_at FROM sport_pack_versions
      WHERE sport_code='badminton' AND version='test-immutable'`;
    expect(inserted[0]).toEqual({ status: "draft", activated_at: null });
    await expect(sql`INSERT INTO sport_pack_versions
      (sport_code,version,schema_version,definition,definition_hash,created_by)
      VALUES ('badminton','test-forged',1,${sql.json(definition)},${"0".repeat(64)},${value.account})`).rejects.toThrow(
      /hash does not match/,
    );
    await sql`UPDATE sport_pack_versions SET status='active',revision=revision+1,activated_at=now(),activated_by=${value.account}
      WHERE sport_code='badminton' AND version='test-immutable'`;
    const secondDefinition = { schemaVersion: 1, sport: "badminton", label: "second" };
    await sql`INSERT INTO sport_pack_versions
      (sport_code,version,schema_version,definition,definition_hash,created_by)
      VALUES ('badminton','test-second',1,${sql.json(secondDefinition)},${hash(secondDefinition)},${value.account})`;
    await expect(sql`UPDATE sport_pack_versions SET status='active',revision=revision+1,activated_at=now(),activated_by=${value.account}
      WHERE sport_code='badminton' AND version='test-second'`).rejects.toThrow();
    await expect(sql`UPDATE sport_pack_versions SET definition='{}'::jsonb
      WHERE sport_code='badminton' AND version='test-immutable'`).rejects.toThrow(/immutable/);
    await expect(sql`DELETE FROM sport_pack_versions
      WHERE sport_code='badminton' AND version='test-immutable'`).rejects.toThrow(/append-only/);
  });

  it("rejects forged standings and binds immutable server snapshots to current persisted result provenance", async () => {
    const value = await world();
    await sql`INSERT INTO competition_publications (competition_id,result_version) VALUES (${value.competition},1)`;
    await expect(sql`INSERT INTO standings_snapshots
      (competition_id,division_id,result_version,standings,explanation,calculation_input_hash)
      VALUES (${value.competition},${value.divisionA},1,'{"winner":"attacker"}'::jsonb,'{}'::jsonb,${"0".repeat(64)})`).rejects.toThrow(
      /server calculated/,
    );
    await expect(sql`INSERT INTO standings_snapshots
      (competition_id,division_id,result_version,standings,explanation,calculation_input_hash,calculation_provenance,
       source_result_hash,settings_version,snapshot_fingerprint)
      VALUES (${value.competition},${value.divisionA},1,'{}'::jsonb,'{}'::jsonb,${"0".repeat(64)},'server_calculated',
        ${"0".repeat(64)},'forged','0123456789abcdef')`).rejects.toThrow(
      /server results transaction|provenance does not match/,
    );
    const snapshot = await sql.begin(async (tx) => {
      await tx`SELECT set_config('matchday.server_results','on',true)`;
      const source = await tx<{ value: string }[]>`
        SELECT phase3_standings_source_hash(${value.competition},${value.divisionA},1) AS value`;
      const sourceHash = source[0]?.value;
      if (!sourceHash) throw new Error("Expected source hash");
      const inserted = await tx<{ id: string }[]>`INSERT INTO standings_snapshots
        (competition_id,division_id,result_version,standings,explanation,calculation_input_hash,calculation_provenance,
         source_result_hash,settings_version,snapshot_fingerprint)
        VALUES (${value.competition},${value.divisionA},1,'{"rows":[]}'::jsonb,'{}'::jsonb,${sourceHash},
          'server_calculated',${sourceHash},'test-pack-v1','0123456789abcdef') RETURNING id`;
      return inserted[0];
    });
    if (!snapshot) throw new Error("Expected standings snapshot");
    await expect(sql`UPDATE standings_snapshots SET standings='[]'::jsonb WHERE id=${snapshot.id}`).rejects.toThrow(
      /append-only/,
    );
    await expect(sql`DELETE FROM standings_snapshots WHERE id=${snapshot.id}`).rejects.toThrow(/append-only/);
  });
});
