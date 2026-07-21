import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "../../src/migrations.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase2_schema_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

type World = {
  accountA: string;
  accountB: string;
  competitionA: string;
  competitionB: string;
  divisionA: string;
  divisionB: string;
  areaA: string;
  areaB: string;
  formatA: string;
  formatB: string;
  matchA: string;
  matchB: string;
  scheduleA: string;
  scheduleB: string;
  passA: string;
  passB: string;
  sessionA: string;
  sessionB: string;
};

let sql!: Sql;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalHash(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(item);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function singleFinalGraph(id: string, matchId: string) {
  return {
    id,
    schemaVersion: 1,
    entryCount: 2,
    stages: [
      {
        id: "final-stage",
        label: "Final",
        kind: "single_elimination",
        order: 1,
        groupIds: [],
        groupSize: null,
        outputRanks: 2,
        matchIds: [matchId],
      },
    ],
    matches: [
      {
        id: matchId,
        stageId: "final-stage",
        round: 1,
        order: 1,
        purpose: "championship",
        home: { type: "entry_seed", seed: 1 },
        away: { type: "entry_seed", seed: 2 },
      },
    ],
    terminalMatchIds: [matchId],
  };
}

async function createOrganisation(accountId: string, label: string): Promise<string> {
  let organisationId = "";
  await sql.begin(async (transaction) => {
    const rows = await transaction<{ id: string }[]>`
      INSERT INTO organisations (name, slug)
      VALUES (${`Schema ${label}`}, ${`schema-${label}-${randomUUID()}`})
      RETURNING id
    `;
    organisationId = rows[0]?.id ?? "";
    await transaction`
      INSERT INTO organisation_memberships (organisation_id, account_id, role, status)
      VALUES (${organisationId}, ${accountId}, 'owner', 'active')
    `;
  });
  return organisationId;
}

async function createWorld(): Promise<World> {
  const accountA = randomUUID();
  const accountB = randomUUID();
  await sql`
    INSERT INTO accounts (id, primary_email, display_name, email_verified_at)
    VALUES
      (${accountA}, ${`${accountA}@example.test`}, 'Schema Actor A', now()),
      (${accountB}, ${`${accountB}@example.test`}, 'Schema Actor B', now())
  `;
  const organisationA = await createOrganisation(accountA, "a");
  const organisationB = await createOrganisation(accountB, "b");
  const competitionA = randomUUID();
  const competitionB = randomUUID();
  await sql`
    INSERT INTO competitions (
      id, organisation_id, created_by, name, slug, timezone, starts_on, ends_on
    ) VALUES
      (${competitionA}, ${organisationA}, ${accountA}, 'Schema Cup A', ${`schema-cup-a-${randomUUID()}`},
       'Asia/Singapore', '2026-08-01', '2026-08-01'),
      (${competitionB}, ${organisationB}, ${accountB}, 'Schema Cup B', ${`schema-cup-b-${randomUUID()}`},
       'Asia/Singapore', '2026-08-02', '2026-08-02')
  `;
  await sql`
    INSERT INTO competition_sport_settings (competition_id, updated_by)
    VALUES (${competitionA}, ${accountA}), (${competitionB}, ${accountB})
  `;

  const divisionA = randomUUID();
  const divisionB = randomUUID();
  await sql`
    INSERT INTO divisions (id, competition_id, name, team_limit)
    VALUES (${divisionA}, ${competitionA}, 'Open A', 8), (${divisionB}, ${competitionB}, 'Open B', 16)
  `;
  const areaA = randomUUID();
  const areaB = randomUUID();
  await sql`
    INSERT INTO playing_areas (id, competition_id, name, slot_minutes)
    VALUES (${areaA}, ${competitionA}, 'Court A', 30), (${areaB}, ${competitionB}, 'Court B', 30)
  `;

  const formatA = randomUUID();
  const formatB = randomUUID();
  const matchA = randomUUID();
  const matchB = randomUUID();
  const definitionA = singleFinalGraph(formatA, matchA);
  const definitionB = singleFinalGraph(formatB, matchB);
  await sql`
    INSERT INTO format_revisions (
      id, competition_id, division_id, revision, definition, definition_hash, created_by, validation_contract
    ) VALUES
      (${formatA}, ${competitionA}, ${divisionA}, 1, ${sql.json(definitionA)}, ${canonicalHash(definitionA)}, ${accountA}, 'phase3'),
      (${formatB}, ${competitionB}, ${divisionB}, 1, ${sql.json(definitionB)}, ${canonicalHash(definitionB)}, ${accountB}, 'phase3')
  `;

  await sql`
    INSERT INTO matches (
      id, competition_id, division_id, format_revision_id, code, stage, round_number, ordinal
    ) VALUES
      (${matchA}, ${competitionA}, ${divisionA}, ${formatA}, 'A-FINAL', 'final', 1, 1),
      (${matchB}, ${competitionB}, ${divisionB}, ${formatB}, 'B-FINAL', 'final', 1, 1)
  `;

  const scheduleA = randomUUID();
  const scheduleB = randomUUID();
  await sql`
    INSERT INTO schedule_revisions (
      id, competition_id, format_revision_id, revision, input_hash, created_by
    ) VALUES
      (${scheduleA}, ${competitionA}, ${formatA}, 1, ${digest(scheduleA)}, ${accountA}),
      (${scheduleB}, ${competitionB}, ${formatB}, 1, ${digest(scheduleB)}, ${accountB})
  `;

  const passA = randomUUID();
  const passB = randomUUID();
  await sql`
    INSERT INTO scoring_access_passes (
      id, match_id, secret_hash, short_code_hash, expires_at, created_by
    ) VALUES
      (${passA}, ${matchA}, ${randomBytes(32)}, ${randomBytes(32)}, '2026-08-01T12:00:00Z', ${accountA}),
      (${passB}, ${matchB}, ${randomBytes(32)}, ${randomBytes(32)}, '2026-08-02T12:00:00Z', ${accountB})
  `;

  const sessionA = randomUUID();
  const sessionB = randomUUID();
  await sql`
    INSERT INTO scoring_access_sessions (
      id, access_pass_id, match_id, session_token_hash, generation, issued_at, expires_at
    ) VALUES
      (${sessionA}, ${passA}, ${matchA}, ${randomBytes(32)}, 1, '2026-08-01T08:00:00Z', '2026-08-01T09:00:00Z'),
      (${sessionB}, ${passB}, ${matchB}, ${randomBytes(32)}, 1, '2026-08-02T08:00:00Z', '2026-08-02T09:00:00Z')
  `;

  return {
    accountA,
    accountB,
    competitionA,
    competitionB,
    divisionA,
    divisionB,
    areaA,
    areaB,
    formatA,
    formatB,
    matchA,
    matchB,
    scheduleA,
    scheduleB,
    passA,
    passB,
    sessionA,
    sessionB,
  };
}

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  sql = postgres(databaseUrl, { max: 6, onnotice: () => undefined, connection: { search_path: schema } });
});

afterAll(async () => {
  await sql?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

describeInfrastructure("Phase 2 PostgreSQL schema invariants", () => {
  it("binds format revisions and capacity windows to the same competition as their parents", async () => {
    const world = await createWorld();
    await expect(sql`
      INSERT INTO format_revisions (
        competition_id, division_id, revision, definition, definition_hash, created_by
      ) VALUES (
        ${world.competitionA}, ${world.divisionB}, 2, '{}'::jsonb, ${digest(randomUUID())}, ${world.accountA}
      )
    `).rejects.toThrow();
    await expect(sql`
      INSERT INTO competition_availability_windows (
        competition_id, playing_area_id, starts_at, ends_at
      ) VALUES (
        ${world.competitionA}, ${world.areaB}, '2026-08-01T08:00:00Z', '2026-08-01T09:00:00Z'
      )
    `).rejects.toThrow();
  });

  it("rejects cross-competition match, schedule, publication, and area references", async () => {
    const world = await createWorld();
    await expect(sql`
      INSERT INTO matches (
        id, competition_id, division_id, format_revision_id, code, stage, round_number, ordinal
      ) VALUES (
        ${randomUUID()}, ${world.competitionA}, ${world.divisionB}, ${world.formatA},
        'WRONG-DIVISION', 'group', 1, 90
      )
    `).rejects.toThrow();
    await expect(sql`
      INSERT INTO matches (
        id, competition_id, division_id, format_revision_id, code, stage, round_number, ordinal
      ) VALUES (
        ${randomUUID()}, ${world.competitionA}, ${world.divisionA}, ${world.formatB},
        'WRONG-FORMAT', 'group', 1, 91
      )
    `).rejects.toThrow();
    await expect(sql`
      INSERT INTO schedule_revisions (
        competition_id, format_revision_id, revision, input_hash, created_by
      ) VALUES (${world.competitionA}, ${world.formatB}, 2, ${digest(randomUUID())}, ${world.accountA})
    `).rejects.toThrow();
    await expect(sql`
      INSERT INTO competition_publications (competition_id, published_schedule_revision_id)
      VALUES (${world.competitionA}, ${world.scheduleB})
    `).rejects.toThrow();
    await expect(sql`
      INSERT INTO scheduled_matches (
        schedule_revision_id, match_id, competition_id, playing_area_id, starts_at, ends_at
      ) VALUES (
        ${world.scheduleA}, ${world.matchA}, ${world.competitionA}, ${world.areaB},
        '2026-08-01T08:00:00Z', '2026-08-01T08:30:00Z'
      )
    `).rejects.toThrow();
  });

  it("preserves Phase 2 seed bounds and uniqueness while accepting Phase 3 division sizes", async () => {
    const world = await createWorld();
    await sql`
      INSERT INTO divisions (competition_id, name, team_limit)
      VALUES (${world.competitionA}, 'Unsupported Twelve', 12)
    `;
    await sql`
      INSERT INTO division_entries (division_id, name, seed)
      VALUES (${world.divisionA}, 'Seed One', 1)
    `;
    await expect(sql`
      INSERT INTO division_entries (division_id, name, seed)
      VALUES (${world.divisionA}, 'Duplicate Seed', 1)
    `).rejects.toThrow();
    await expect(sql`
      INSERT INTO division_entries (division_id, name, seed)
      VALUES (${world.divisionA}, 'Beyond Eight', 9)
    `).rejects.toThrow();
    await expect(sql`
      INSERT INTO division_entries (division_id, name, seed)
      VALUES (${world.divisionB}, 'Beyond Sixteen', 17)
    `).rejects.toThrow();
  });

  it("allows publish and supersede transitions while freezing published format and schedule content", async () => {
    const world = await createWorld();
    await sql`
      INSERT INTO competition_availability_windows (
        competition_id, playing_area_id, starts_at, ends_at
      ) VALUES (
        ${world.competitionA}, ${world.areaA}, '2026-08-01T08:00:00Z', '2026-08-01T08:30:00Z'
      )
    `;
    await sql`
      INSERT INTO scheduled_matches (
        schedule_revision_id, match_id, competition_id, playing_area_id, starts_at, ends_at
      ) VALUES (
        ${world.scheduleA}, ${world.matchA}, ${world.competitionA}, ${world.areaA},
        '2026-08-01T08:00:00Z', '2026-08-01T08:30:00Z'
      )
    `;
    await sql`
      INSERT INTO format_validation_evidence (
        format_revision_id, definition_hash, valid, graph_acyclic, graph_reachable,
        slots_unambiguous, deterministic_match_count, available_match_slots,
        required_match_slots, recommendation_fits_capacity, validated_by
      ) VALUES (
        ${world.formatA}, (SELECT definition_hash FROM format_revisions WHERE id=${world.formatA}),
        false, false, false, false, 0, 0, 0, false, ${world.accountA}
      )
    `;
    await sql`UPDATE format_revisions SET status='published', published_at=now() WHERE id=${world.formatA}`;
    await expect(sql`
      UPDATE format_revisions SET definition='{"changed":true}'::jsonb WHERE id=${world.formatA}
    `).rejects.toThrow(/immutable/i);
    await expect(sql`
      INSERT INTO matches (
        id, competition_id, division_id, format_revision_id, code, stage, round_number, ordinal
      ) VALUES (
        ${randomUUID()}, ${world.competitionA}, ${world.divisionA}, ${world.formatA},
        'LATE-MATCH', 'group', 1, 99
      )
    `).rejects.toThrow(/immutable/i);

    await sql`UPDATE schedule_revisions SET status='published', published_at=now() WHERE id=${world.scheduleA}`;
    await expect(sql`
      UPDATE scheduled_matches SET starts_at='2026-08-01T08:30:00Z', ends_at='2026-08-01T09:00:00Z'
      WHERE schedule_revision_id=${world.scheduleA} AND match_id=${world.matchA}
    `).rejects.toThrow(/immutable/i);

    await sql`UPDATE format_revisions SET status='superseded' WHERE id=${world.formatA}`;
    await sql`UPDATE schedule_revisions SET status='superseded' WHERE id=${world.scheduleA}`;
    await expect(sql`DELETE FROM format_revisions WHERE id=${world.formatA}`).rejects.toThrow(/immutable/i);
    await expect(sql`DELETE FROM schedule_revisions WHERE id=${world.scheduleA}`).rejects.toThrow(/immutable/i);
  });

  it("keeps score and audit event ledgers append-only", async () => {
    const world = await createWorld();
    const scoreEventId = randomUUID();
    await sql`
      INSERT INTO score_events (
        id, match_id, client_event_id, sequence, writer_generation, event_type, team_slot, scorer,
        manual_period, manual_event_seconds, actor_account_id, occurred_at
      ) VALUES (
        ${scoreEventId}, ${world.matchA}, ${randomUUID()}, 1, 1, 'goal_added', 'home', 'Player 7',
        1, 92, ${world.accountA}, '2026-08-01T08:01:32Z'
      )
    `;
    await expect(sql`UPDATE score_events SET scorer='Player 8' WHERE id=${scoreEventId}`).rejects.toThrow(
      /append-only/i,
    );
    await expect(sql`DELETE FROM score_events WHERE id=${scoreEventId}`).rejects.toThrow(/append-only/i);

    const auditId = randomUUID();
    await sql`
      INSERT INTO audit_events (
        id, request_id, actor_account_id, actor_type, organisation_id, action, target_type, target_id
      ) VALUES (
        ${auditId}, ${randomUUID()}, ${world.accountA}, 'account',
        (SELECT organisation_id FROM competitions WHERE id=${world.competitionA}),
        'phase2.schema.tested', 'competition', ${world.competitionA}
      )
    `;
    await expect(sql`UPDATE audit_events SET action='phase2.schema.changed' WHERE id=${auditId}`).rejects.toThrow(
      /append-only/i,
    );
    await expect(sql`DELETE FROM audit_events WHERE id=${auditId}`).rejects.toThrow(/append-only/i);
  });

  it("requires exactly one actor plus manual period, event time, and scorer attribution for goals", async () => {
    const world = await createWorld();
    const base = [world.matchA, randomUUID(), world.accountA] as const;
    await expect(
      sql.unsafe(
        `INSERT INTO score_events (
         match_id,client_event_id,sequence,writer_generation,event_type,team_slot,scorer,
         manual_period,manual_event_seconds,occurred_at
       ) VALUES ($1,$2,1,1,'match_started',NULL,NULL,1,0,now())`,
        [world.matchA, randomUUID()],
      ),
    ).rejects.toThrow();
    await expect(
      sql.unsafe(
        `INSERT INTO score_events (
         match_id,client_event_id,sequence,writer_generation,event_type,team_slot,scorer,
         manual_period,manual_event_seconds,actor_account_id,actor_access_session_id,occurred_at
       ) VALUES ($1,$2,1,1,'match_started',NULL,NULL,1,0,$3,$4,now())`,
        [world.matchA, randomUUID(), world.accountA, world.sessionA],
      ),
    ).rejects.toThrow();
    await expect(
      sql.unsafe(
        `INSERT INTO score_events (
         match_id,client_event_id,sequence,writer_generation,event_type,team_slot,scorer,
         manual_period,manual_event_seconds,actor_account_id,occurred_at
       ) VALUES ($1,$2,1,1,'goal_added','home',NULL,1,20,$3,now())`,
        [...base],
      ),
    ).rejects.toThrow();
    await expect(
      sql.unsafe(
        `INSERT INTO score_events (
         match_id,client_event_id,sequence,writer_generation,event_type,team_slot,scorer,
         manual_period,manual_event_seconds,actor_account_id,occurred_at
       ) VALUES ($1,$2,1,1,'goal_added','home','Player 7',NULL,NULL,$3,now())`,
        [world.matchA, randomUUID(), world.accountA],
      ),
    ).rejects.toThrow();
    await expect(
      sql.unsafe(
        `INSERT INTO score_events (
         match_id,client_event_id,sequence,writer_generation,event_type,team_slot,scorer,
         manual_period,manual_event_seconds,actor_access_session_id,occurred_at
       ) VALUES ($1,$2,1,1,'goal_added','home','Player 7',1,20,$3,now())`,
        [world.matchA, randomUUID(), world.sessionB],
      ),
    ).rejects.toThrow();
  });

  it("stores only fixed-length bytea access hashes", async () => {
    const world = await createWorld();
    const tokenColumns = await sql<{ table_name: string; column_name: string; data_type: string }[]>`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema=current_schema()
        AND table_name IN ('scoring_access_passes', 'scoring_access_sessions')
        AND (column_name LIKE '%secret%' OR column_name LIKE '%token%' OR column_name LIKE '%code%')
      ORDER BY table_name, column_name
    `;
    expect(tokenColumns).toEqual([
      { table_name: "scoring_access_passes", column_name: "secret_hash", data_type: "bytea" },
      { table_name: "scoring_access_passes", column_name: "short_code_hash", data_type: "bytea" },
      { table_name: "scoring_access_sessions", column_name: "session_token_hash", data_type: "bytea" },
    ]);
    await expect(sql`
      INSERT INTO scoring_access_passes (match_id, secret_hash, expires_at, created_by)
      VALUES (${world.matchA}, ${Buffer.from("plaintext")}, '2026-08-01T12:00:00Z', ${world.accountA})
    `).rejects.toThrow();
    await expect(sql`
      INSERT INTO scoring_access_sessions (
        access_pass_id, match_id, session_token_hash, generation, issued_at, expires_at
      ) VALUES (
        ${world.passA}, ${world.matchA}, ${Buffer.from("plaintext")}, 2,
        '2026-08-01T09:00:00Z', '2026-08-01T10:00:00Z'
      )
    `).rejects.toThrow();
  });

  it("prevents pass, session, transfer, and writer-lease references from crossing matches", async () => {
    const world = await createWorld();
    await expect(sql`
      INSERT INTO scoring_access_sessions (
        access_pass_id, match_id, session_token_hash, generation, issued_at, expires_at
      ) VALUES (
        ${world.passA}, ${world.matchB}, ${randomBytes(32)}, 2,
        '2026-08-02T09:00:00Z', '2026-08-02T10:00:00Z'
      )
    `).rejects.toThrow();
    await expect(sql`
      UPDATE scoring_access_sessions SET transferred_to_session_id=${world.sessionB} WHERE id=${world.sessionA}
    `).rejects.toThrow();
    await expect(sql`
      INSERT INTO match_writer_leases (
        match_id, access_session_id, generation, acquired_at, expires_at
      ) VALUES (
        ${world.matchB}, ${world.sessionA}, 1, '2026-08-02T08:00:00Z', '2026-08-02T08:30:00Z'
      )
    `).rejects.toThrow();
  });

  it("ties a writer lease generation to its session and keeps generations unique per match", async () => {
    const world = await createWorld();
    await expect(sql`
      INSERT INTO match_writer_leases (
        match_id, access_session_id, generation, acquired_at, expires_at
      ) VALUES (
        ${world.matchA}, ${world.sessionA}, 2, '2026-08-01T08:00:00Z', '2026-08-01T08:30:00Z'
      )
    `).rejects.toThrow();
    await expect(sql`
      INSERT INTO scoring_access_sessions (
        access_pass_id, match_id, session_token_hash, generation, issued_at, expires_at
      ) VALUES (
        ${world.passA}, ${world.matchA}, ${randomBytes(32)}, 1,
        '2026-08-01T08:10:00Z', '2026-08-01T08:40:00Z'
      )
    `).rejects.toThrow();
    await sql`
      INSERT INTO match_writer_leases (
        match_id, access_session_id, generation, acquired_at, expires_at
      ) VALUES (
        ${world.matchA}, ${world.sessionA}, 1, '2026-08-01T08:00:00Z', '2026-08-01T08:30:00Z'
      )
    `;
  });

  it("isolates result, standings, bracket, and public projection versions", async () => {
    const world = await createWorld();
    await sql`
      INSERT INTO match_result_snapshots (
        match_id, result_version, through_sequence, home_score, away_score, state, snapshot
      ) VALUES (${world.matchA}, 1, 1, 1, 0, 'final', '{}')
    `;
    await expect(sql`
      INSERT INTO match_result_snapshots (
        match_id, result_version, through_sequence, home_score, away_score, state, snapshot
      ) VALUES (${world.matchA}, 1, 2, 2, 0, 'corrected', '{}')
    `).rejects.toThrow();

    await sql`
      INSERT INTO competition_publications (competition_id, result_version)
      VALUES (${world.competitionA}, 1), (${world.competitionB}, 2)
    `;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('matchday.server_results','on',true)`;
      const source = await tx<{ value: string }[]>`
        SELECT phase3_standings_source_hash(${world.competitionA}, ${world.divisionA}, 1) AS value
      `;
      const sourceHash = source[0]?.value;
      if (!sourceHash) throw new Error("Expected standings source hash");
      await tx`
        INSERT INTO standings_snapshots (
          competition_id, division_id, result_version, standings, explanation,
          calculation_input_hash, calculation_provenance, source_result_hash,
          settings_version, snapshot_fingerprint
        ) VALUES (
          ${world.competitionA}, ${world.divisionA}, 1, '[]', '[]', ${sourceHash},
          'server_calculated', ${sourceHash}, 'phase2-schema-v1', '0123456789abcdef'
        )
      `;
    });
    await expect(sql`
      INSERT INTO standings_snapshots (
        competition_id, division_id, result_version, standings, explanation
      ) VALUES (${world.competitionB}, ${world.divisionA}, 2, '[]', '[]')
    `).rejects.toThrow();
    await expect(sql`
      INSERT INTO standings_snapshots (
        competition_id, division_id, result_version, standings, explanation
      ) VALUES (${world.competitionA}, ${world.divisionA}, 1, '[]', '[]')
    `).rejects.toThrow();

    await sql`
      INSERT INTO bracket_snapshots (competition_id, division_id, result_version, bracket)
      VALUES (${world.competitionA}, ${world.divisionA}, 1, '{}')
    `;
    await expect(sql`
      INSERT INTO bracket_snapshots (competition_id, division_id, result_version, bracket)
      VALUES (${world.competitionB}, ${world.divisionA}, 2, '{}')
    `).rejects.toThrow();
    await expect(sql`
      INSERT INTO bracket_snapshots (competition_id, division_id, result_version, bracket)
      VALUES (${world.competitionA}, ${world.divisionA}, 1, '{}')
    `).rejects.toThrow();

    await sql`
      INSERT INTO public_competition_projections (
        competition_id, schedule_version, result_version, projection
      ) VALUES
        (${world.competitionA}, 0, 1, ${sql.json({ kind: "results" })}),
        (${world.competitionA}, 1, 1, ${sql.json({ kind: "schedule-and-results" })})
    `;
    await expect(sql`
      INSERT INTO public_competition_projections (
        competition_id, schedule_version, result_version, projection
      ) VALUES (${world.competitionA}, 1, 1, '{}')
    `).rejects.toThrow();
  });
});
