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
      id, competition_id, match_id, secret_hash, short_code_hash, fallback_code_hash_version, expires_at, created_by
    ) VALUES
      (${passA}, ${competitionA}, ${matchA}, ${randomBytes(32)}, ${randomBytes(32)}, 'hmac_sha256_v1', '2030-08-01T12:00:00Z', ${accountA}),
      (${passB}, ${competitionB}, ${matchB}, ${randomBytes(32)}, ${randomBytes(32)}, 'hmac_sha256_v1', '2030-08-02T12:00:00Z', ${accountB})
  `;

  const sessionA = randomUUID();
  const sessionB = randomUUID();
  await sql`
    INSERT INTO scoring_access_sessions (
      id, access_pass_id, competition_id, match_id, session_token_hash, generation, device_id_hash, issued_at, expires_at
    ) VALUES
      (${sessionA}, ${passA}, ${competitionA}, ${matchA}, ${randomBytes(32)}, 1, ${randomBytes(32)}, '2026-08-01T08:00:00Z', '2026-08-01T09:00:00Z'),
      (${sessionB}, ${passB}, ${competitionB}, ${matchB}, ${randomBytes(32)}, 1, ${randomBytes(32)}, '2026-08-02T08:00:00Z', '2026-08-02T09:00:00Z')
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

  it("fences scheduled participant snapshots to one competition and division and keeps them immutable", async () => {
    const world = await createWorld();
    const siblingDivision = randomUUID();
    const homeEntry = randomUUID();
    const awayEntry = randomUUID();
    const replacementEntry = randomUUID();
    const siblingEntry = randomUUID();
    const otherCompetitionEntry = randomUUID();
    await sql`
      INSERT INTO divisions (id, competition_id, name, team_limit)
      VALUES (${siblingDivision}, ${world.competitionA}, 'Sibling division', 8)
    `;
    await sql`
      INSERT INTO division_entries (id, division_id, name, seed)
      VALUES
        (${homeEntry}, ${world.divisionA}, 'Home A', 1),
        (${awayEntry}, ${world.divisionA}, 'Away A', 2),
        (${replacementEntry}, ${world.divisionA}, 'Replacement A', 3),
        (${siblingEntry}, ${siblingDivision}, 'Sibling A', 1),
        (${otherCompetitionEntry}, ${world.divisionB}, 'Other competition B', 1)
    `;
    await sql`
      UPDATE matches
      SET home_entry_id=${homeEntry}, away_entry_id=${awayEntry}
      WHERE id=${world.matchA}
    `;
    await sql`
      INSERT INTO scheduled_matches (
        schedule_revision_id, match_id, competition_id, playing_area_id, starts_at, ends_at
      ) VALUES (
        ${world.scheduleA}, ${world.matchA}, ${world.competitionA}, ${world.areaA},
        '2026-08-01T08:00:00Z', '2026-08-01T08:30:00Z'
      )
    `;
    expect(
      await sql`
        SELECT division_id,home_entry_id,away_entry_id
        FROM scheduled_matches
        WHERE schedule_revision_id=${world.scheduleA} AND match_id=${world.matchA}
      `,
    ).toEqual([
      {
        division_id: world.divisionA,
        home_entry_id: homeEntry,
        away_entry_id: awayEntry,
      },
    ]);

    await expect(sql`
      UPDATE scheduled_matches
      SET home_entry_id=${replacementEntry}
      WHERE schedule_revision_id=${world.scheduleA} AND match_id=${world.matchA}
    `).rejects.toThrow(/participant snapshot identity is immutable/i);

    await sql`ALTER TABLE scheduled_matches DISABLE TRIGGER scheduled_matches_participant_snapshot_immutable`;
    try {
      await expect(sql`
        UPDATE scheduled_matches
        SET home_entry_id=${siblingEntry}
        WHERE schedule_revision_id=${world.scheduleA} AND match_id=${world.matchA}
      `).rejects.toThrow(/scheduled_matches_home_entry_division_fkey|foreign key/i);
      await expect(sql`
        UPDATE scheduled_matches
        SET home_entry_id=${otherCompetitionEntry}
        WHERE schedule_revision_id=${world.scheduleA} AND match_id=${world.matchA}
      `).rejects.toThrow(/scheduled_matches_home_entry_division_fkey|foreign key/i);
    } finally {
      await sql`ALTER TABLE scheduled_matches ENABLE TRIGGER scheduled_matches_participant_snapshot_immutable`;
    }
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
        AND data_type='bytea'
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
        access_pass_id, competition_id, match_id, session_token_hash, generation, device_id_hash, issued_at, expires_at
      ) VALUES (
        ${world.passA}, ${world.competitionB}, ${world.matchB}, ${randomBytes(32)}, 2, ${randomBytes(32)},
        '2026-08-02T09:00:00Z', '2026-08-02T10:00:00Z'
      )
    `).rejects.toThrow();
    await expect(sql`
      UPDATE scoring_access_sessions SET transferred_to_session_id=${world.sessionB} WHERE id=${world.sessionA}
    `).rejects.toThrow();
    await expect(sql`
      INSERT INTO match_writer_leases (
        competition_id, match_id, access_session_id, generation, acquired_at, expires_at
      ) VALUES (
        ${world.competitionB}, ${world.matchB}, ${world.sessionA}, 1,
        '2026-08-02T08:00:00Z', '2026-08-02T08:30:00Z'
      )
    `).rejects.toThrow();
  });

  it("ties a writer lease generation to its session and keeps generations unique per match", async () => {
    const world = await createWorld();
    await expect(sql`
      INSERT INTO match_writer_leases (
        competition_id, match_id, access_session_id, generation, acquired_at, expires_at
      ) VALUES (
        ${world.competitionA}, ${world.matchA}, ${world.sessionA}, 2,
        '2026-08-01T08:00:00Z', '2026-08-01T08:30:00Z'
      )
    `).rejects.toThrow();
    await expect(sql`
      INSERT INTO scoring_access_sessions (
        access_pass_id, competition_id, match_id, session_token_hash, generation, device_id_hash, issued_at, expires_at
      ) VALUES (
        ${world.passA}, ${world.competitionA}, ${world.matchA}, ${randomBytes(32)}, 1, ${randomBytes(32)},
        '2026-08-01T08:10:00Z', '2026-08-01T08:40:00Z'
      )
    `).rejects.toThrow();
    await sql`
      INSERT INTO match_writer_leases (
        competition_id, match_id, access_session_id, generation, acquired_at, expires_at
      ) VALUES (
        ${world.competitionA}, ${world.matchA}, ${world.sessionA}, 1,
        '2026-08-01T08:00:00Z', '2026-08-01T08:30:00Z'
      )
    `;
  });

  it("enforces exact role scopes while allowing multiple generation-free viewers", async () => {
    const world = await createWorld();
    const viewerPass = randomUUID();
    await expect(sql`
      INSERT INTO scoring_access_passes (
        id, competition_id, match_id, role, scope, secret_hash, expires_at, created_by
      ) VALUES (
        ${viewerPass}, ${world.competitionA}, ${world.matchA}, 'viewer',
        '["score:read","score:write"]'::jsonb, ${randomBytes(32)},
        '2030-08-01T12:00:00Z', ${world.accountA}
      )
    `).rejects.toThrow();
    await sql`
      INSERT INTO scoring_access_passes (
        id, competition_id, match_id, role, scope, secret_hash, expires_at, created_by
      ) VALUES (
        ${viewerPass}, ${world.competitionA}, ${world.matchA}, 'viewer',
        '["score:read"]'::jsonb, ${randomBytes(32)},
        '2030-08-01T12:00:00Z', ${world.accountA}
      )
    `;
    await sql`
      INSERT INTO scoring_access_sessions (
        access_pass_id, competition_id, match_id, session_token_hash, mode, generation,
        device_id_hash, issued_at, expires_at
      ) VALUES
        (${viewerPass}, ${world.competitionA}, ${world.matchA}, ${randomBytes(32)}, 'viewer', NULL,
         ${randomBytes(32)}, '2026-08-01T08:00:00Z', '2026-08-01T09:00:00Z'),
        (${viewerPass}, ${world.competitionA}, ${world.matchA}, ${randomBytes(32)}, 'viewer', NULL,
         ${randomBytes(32)}, '2026-08-01T08:00:00Z', '2026-08-01T09:00:00Z')
    `;
    expect(
      await sql`SELECT mode,generation FROM scoring_access_sessions
        WHERE access_pass_id=${viewerPass} ORDER BY id`,
    ).toEqual([
      { mode: "viewer", generation: null },
      { mode: "viewer", generation: null },
    ]);
    await expect(sql`
      INSERT INTO scoring_access_sessions (
        access_pass_id, competition_id, match_id, session_token_hash, mode, generation,
        device_id_hash, issued_at, expires_at
      ) VALUES (
        ${world.passA}, ${world.competitionA}, ${world.matchA}, ${randomBytes(32)}, 'candidate', 2,
        ${randomBytes(32)}, '2026-08-01T08:00:00Z', '2026-08-01T09:00:00Z'
      )
    `).rejects.toThrow();
  });

  it("keeps candidates read-only until a writer lease references a writer generation", async () => {
    const world = await createWorld();
    const candidate = randomUUID();
    await sql`
      INSERT INTO scoring_access_sessions (
        id, access_pass_id, competition_id, match_id, session_token_hash, mode, generation,
        device_id_hash, issued_at, expires_at
      ) VALUES (
        ${candidate}, ${world.passA}, ${world.competitionA}, ${world.matchA}, ${randomBytes(32)},
        'candidate', NULL, ${randomBytes(32)}, '2026-08-01T08:00:00Z', '2026-08-01T09:00:00Z'
      )
    `;
    await expect(sql`
      INSERT INTO match_writer_leases (
        competition_id, match_id, access_session_id, generation, acquired_at, expires_at
      ) VALUES (
        ${world.competitionA}, ${world.matchA}, ${candidate}, 2,
        '2026-08-01T08:00:00Z', '2026-08-01T08:00:45Z'
      )
    `).rejects.toThrow();
    await sql`
      INSERT INTO match_writer_leases (
        competition_id, match_id, access_session_id, generation, acquired_at, expires_at
      ) VALUES (
        ${world.competitionA}, ${world.matchA}, ${world.sessionA}, 1,
        '2026-08-01T08:00:00Z', '2026-08-01T08:00:45Z'
      )
    `;
    await expect(sql`
      INSERT INTO match_writer_leases (
        competition_id, match_id, access_session_id, generation, acquired_at, expires_at
      ) VALUES (
        ${world.competitionA}, ${world.matchA}, ${world.sessionA}, 1,
        '2026-08-01T08:01:00Z', '2026-08-01T08:01:45Z'
      )
    `).rejects.toThrow();
  });

  it("binds takeover and transfer-conflict evidence to one match and explicit resolution", async () => {
    const world = await createWorld();
    const candidate = randomUUID();
    await sql`
      INSERT INTO scoring_access_sessions (
        id, access_pass_id, competition_id, match_id, session_token_hash, mode, generation,
        device_id_hash, issued_at, expires_at
      ) VALUES (
        ${candidate}, ${world.passA}, ${world.competitionA}, ${world.matchA}, ${randomBytes(32)},
        'candidate', NULL, ${randomBytes(32)}, '2026-08-01T08:00:00Z', '2026-08-01T09:00:00Z'
      )
    `;
    await expect(sql`
      INSERT INTO scoring_takeover_requests (
        competition_id, match_id, requesting_session_id, incumbent_session_id,
        requester_pending_event_count, incumbent_pending_state
      ) VALUES (
        ${world.competitionA}, ${world.matchA}, ${world.sessionB}, ${world.sessionA}, 0, 'none'
      )
    `).rejects.toThrow();
    const [takeover] = await sql<{ id: string }[]>`
      INSERT INTO scoring_takeover_requests (
        competition_id, match_id, requesting_session_id, incumbent_session_id,
        requester_pending_event_count, incumbent_pending_state
      ) VALUES (
        ${world.competitionA}, ${world.matchA}, ${candidate}, ${world.sessionA}, 1, 'present'
      ) RETURNING id
    `;
    await expect(sql`
      UPDATE scoring_takeover_requests
      SET status='approved',resolved_at='2026-08-01T08:05:00Z',
          resolved_by_account_id=${world.accountA},resolution_reason='Unsafe pending takeover'
      WHERE id=${takeover!.id}
    `).rejects.toThrow();
    await sql`
      UPDATE scoring_takeover_requests
      SET status='approved',resolved_at='2026-08-01T08:05:00Z',
          resolved_by_account_id=${world.accountA},resolution_reason='Pending events acknowledged',
          override_acknowledged=true
      WHERE id=${takeover!.id}
    `;
    await sql`UPDATE scoring_access_sessions SET mode='writer',generation=2 WHERE id=${candidate}`;
    const [conflict] = await sql<{ id: string }[]>`
      INSERT INTO scoring_transfer_conflicts (
        competition_id,match_id,takeover_request_id,stale_session_id,replacement_session_id,
        stale_generation,pending_event_count,pending_through_sequence
      ) VALUES (
        ${world.competitionA},${world.matchA},${takeover!.id},${world.sessionA},${candidate},1,1,1
      ) RETURNING id
    `;
    await expect(sql`
      UPDATE scoring_transfer_conflicts SET pending_event_count=2 WHERE id=${conflict!.id}
    `).rejects.toThrow(/immutable/i);
    await sql`
      UPDATE scoring_transfer_conflicts
      SET status='discarded',resolved_at='2026-08-01T08:10:00Z',
          resolved_by_account_id=${world.accountA},resolution_reason='Organiser reviewed stale event'
      WHERE id=${conflict!.id}
    `;
    await expect(sql`
      UPDATE scoring_transfer_conflicts SET resolution_reason='Changed later' WHERE id=${conflict!.id}
    `).rejects.toThrow(/immutable/i);

    const unknownCandidate = randomUUID();
    await sql`
      INSERT INTO scoring_access_sessions (
        id, access_pass_id, competition_id, match_id, session_token_hash, mode, generation,
        device_id_hash, issued_at, expires_at
      ) VALUES (
        ${unknownCandidate}, ${world.passA}, ${world.competitionA}, ${world.matchA}, ${randomBytes(32)},
        'candidate', NULL, ${randomBytes(32)}, '2026-08-01T08:11:00Z', '2026-08-01T09:00:00Z'
      )
    `;
    const [unknownTakeover] = await sql<{ id: string }[]>`
      INSERT INTO scoring_takeover_requests (
        competition_id,match_id,requesting_session_id,incumbent_session_id,
        requester_pending_event_count,incumbent_pending_state
      ) VALUES (
        ${world.competitionA},${world.matchA},${unknownCandidate},${candidate},0,'unknown'
      ) RETURNING id
    `;
    await sql`
      UPDATE scoring_takeover_requests
      SET status='approved',resolved_at='2026-08-01T08:12:00Z',
          resolved_by_account_id=${world.accountA},resolution_reason='Unknown pending state acknowledged',
          override_acknowledged=true
      WHERE id=${unknownTakeover!.id}
    `;
    await sql`UPDATE scoring_access_sessions SET mode='transferred' WHERE id=${candidate}`;
    await sql`UPDATE scoring_access_sessions SET mode='writer',generation=3 WHERE id=${unknownCandidate}`;
    await sql`
      INSERT INTO scoring_transfer_conflicts (
        competition_id,match_id,takeover_request_id,stale_session_id,replacement_session_id,
        stale_generation,pending_event_count,pending_through_sequence
      ) VALUES (
        ${world.competitionA},${world.matchA},${unknownTakeover!.id},${candidate},${unknownCandidate},2,0,0
      )
    `;
  });

  it("stores only fixed-length HMACs in the append-only access-attempt ledger", async () => {
    const world = await createWorld();
    const attempt = randomUUID();
    await sql`
      INSERT INTO scoring_access_attempts (
        id,credential_kind,outcome,credential_hmac,ip_hmac,request_id
      ) VALUES (
        ${attempt},'fallback_code','invalid',${randomBytes(32)},${randomBytes(32)},${`attempt-${attempt}`}
      )
    `;
    await expect(sql`
      INSERT INTO scoring_access_attempts (
        competition_id,match_id,access_pass_id,credential_kind,outcome,
        credential_hmac,ip_hmac,request_id
      ) VALUES (
        ${world.competitionB},${world.matchB},${world.passA},'token','accepted',
        ${randomBytes(32)},${randomBytes(32)},${`cross-tenant-${attempt}`}
      )
    `).rejects.toThrow();
    const hashColumns = await sql`
      SELECT column_name,data_type
      FROM information_schema.columns
      WHERE table_schema=${schema}
        AND table_name='scoring_access_attempts'
        AND column_name IN ('credential_hmac','ip_hmac')
      ORDER BY column_name
    `;
    expect(hashColumns).toEqual([
      { column_name: "credential_hmac", data_type: "bytea" },
      { column_name: "ip_hmac", data_type: "bytea" },
    ]);
    await expect(sql`
      UPDATE scoring_access_attempts SET outcome='accepted' WHERE id=${attempt}
    `).rejects.toThrow(/append-only/i);
    await expect(sql`DELETE FROM scoring_access_attempts WHERE id=${attempt}`).rejects.toThrow(/append-only/i);

    const retainedAttempt = randomUUID();
    await sql`
      INSERT INTO scoring_access_attempts (
        id,competition_id,match_id,access_pass_id,credential_kind,outcome,
        credential_hmac,ip_hmac,request_id
      ) VALUES (
        ${retainedAttempt},${world.competitionA},${world.matchA},${world.passA},'token','accepted',
        ${randomBytes(32)},${randomBytes(32)},${`retained-${retainedAttempt}`}
      )
    `;
    await sql`DELETE FROM scoring_access_passes WHERE id=${world.passA}`;
    expect(
      await sql`
        SELECT competition_id,match_id,access_pass_id
        FROM scoring_access_attempts WHERE id=${retainedAttempt}
      `,
    ).toEqual([
      {
        competition_id: world.competitionA,
        match_id: world.matchA,
        access_pass_id: world.passA,
      },
    ]);
  });

  it("binds hash-only offline authority to one writer generation and monotonic terminal transitions", async () => {
    const world = await createWorld();
    const [session] = await sql<{ device_id_hash: Buffer }[]>`
      SELECT device_id_hash FROM scoring_access_sessions WHERE id=${world.sessionA}
    `;
    const authorization = randomUUID();
    await expect(sql`
      INSERT INTO scoring_offline_authorizations (
        competition_id,match_id,access_pass_id,access_session_id,writer_generation,
        resume_secret_hash,device_id_hash,issued_at,last_authority_at,
        recording_expires_at,replay_expires_at
      ) VALUES (
        ${world.competitionA},${world.matchA},${world.passA},${world.sessionA},1,
        ${Buffer.from("plaintext")},${session!.device_id_hash},
        '2026-08-01T08:00:00Z','2026-08-01T08:00:00Z',
        '2026-08-01T08:30:00Z','2026-08-01T08:45:00Z'
      )
    `).rejects.toThrow();
    await sql`
      INSERT INTO scoring_offline_authorizations (
        id,competition_id,match_id,access_pass_id,access_session_id,writer_generation,
        resume_secret_hash,device_id_hash,issued_at,last_authority_at,
        recording_expires_at,replay_expires_at
      ) VALUES (
        ${authorization},${world.competitionA},${world.matchA},${world.passA},${world.sessionA},1,
        ${randomBytes(32)},${session!.device_id_hash},
        '2026-08-01T08:00:00Z','2026-08-01T08:00:00Z',
        '2026-08-01T08:30:00Z','2026-08-01T08:45:00Z'
      )
    `;
    await expect(sql`
      INSERT INTO scoring_offline_authorizations (
        competition_id,match_id,access_pass_id,access_session_id,writer_generation,
        resume_secret_hash,device_id_hash,issued_at,last_authority_at,
        recording_expires_at,replay_expires_at
      ) VALUES (
        ${world.competitionA},${world.matchA},${world.passA},${world.sessionA},1,
        ${randomBytes(32)},${session!.device_id_hash},
        '2026-08-01T08:00:00Z','2026-08-01T08:00:00Z',
        '2026-08-01T12:00:00.001Z','2026-08-01T12:15:00.001Z'
      )
    `).rejects.toThrow();
    await expect(sql`
      INSERT INTO scoring_offline_authorizations (
        competition_id,match_id,access_pass_id,access_session_id,writer_generation,
        resume_secret_hash,device_id_hash,issued_at,last_authority_at,
        recording_expires_at,replay_expires_at
      ) VALUES (
        ${world.competitionB},${world.matchB},${world.passA},${world.sessionA},1,
        ${randomBytes(32)},${session!.device_id_hash},
        '2026-08-01T08:00:00Z','2026-08-01T08:00:00Z',
        '2026-08-01T08:30:00Z','2026-08-01T08:45:00Z'
      )
    `).rejects.toThrow();
    await expect(sql`
      INSERT INTO scoring_offline_authorizations (
        competition_id,match_id,access_pass_id,access_session_id,writer_generation,
        resume_secret_hash,device_id_hash,issued_at,last_authority_at,
        recording_expires_at,replay_expires_at
      ) VALUES (
        ${world.competitionA},${world.matchA},${world.passA},${world.sessionA},1,
        ${randomBytes(32)},${session!.device_id_hash},
        '2026-08-01T08:00:00Z','2026-08-01T08:00:00Z',
        '2026-08-01T08:31:00Z','2026-08-01T08:46:00Z'
      )
    `).rejects.toThrow();
    await expect(sql`
      INSERT INTO scoring_offline_authorizations (
        competition_id,match_id,access_pass_id,access_session_id,writer_generation,
        resume_secret_hash,device_id_hash,issued_at,last_authority_at,
        recording_expires_at,replay_expires_at
      ) VALUES (
        ${world.competitionB},${world.matchB},${world.passB},${world.sessionB},1,
        ${randomBytes(32)},${session!.device_id_hash},
        '2026-08-02T08:00:00Z','2026-08-02T08:00:00Z',
        '2026-08-02T08:30:00Z','2026-08-02T08:45:00Z'
      )
    `).rejects.toThrow();
    await expect(sql`
      UPDATE scoring_offline_authorizations
      SET writer_generation=2 WHERE id=${authorization}
    `).rejects.toThrow(/immutable/i);
    await sql`
      UPDATE scoring_offline_authorizations
      SET status='transferred',revoked_at='2026-08-01T08:10:00Z',
          transition_reason='Organiser approved device transfer'
      WHERE id=${authorization}
    `;
    await expect(sql`
      UPDATE scoring_offline_authorizations
      SET transition_reason='Changed after transfer' WHERE id=${authorization}
    `).rejects.toThrow(/terminal/i);
    expect(
      await sql`
        SELECT status,octet_length(resume_secret_hash)::integer AS hash_bytes
        FROM scoring_offline_authorizations WHERE id=${authorization}
      `,
    ).toEqual([{ status: "transferred", hash_bytes: 32 }]);
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
