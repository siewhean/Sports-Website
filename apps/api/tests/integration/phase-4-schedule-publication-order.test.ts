import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Phase4SetupDocument, Phase4SetupStepValue } from "@matchday/contracts";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import type { PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { phase3DomainAdapter } from "../../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../../src/phase-3-runtime.js";
import { ReliableGateBPhase4Runtime } from "../../src/phase-4-reliable-runtime.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase4_schedule_order_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
let sql!: Sql;

function required<T>(rows: readonly T[], message: string): T {
  const row = rows[0];
  if (!row) throw new Error(message);
  return row;
}

async function saveStep(
  runtime: ReliableGateBPhase4Runtime,
  accountId: string,
  competitionId: string,
  document: Phase4SetupDocument,
  step: Phase4SetupStepValue,
): Promise<Phase4SetupDocument> {
  const result = await runtime.autosaveSetupDraft(
    { accountId },
    competitionId,
    {
      expected_revision: document.revision,
      idempotency_key: `schedule-order-${step.step_id}-${randomUUID()}`,
      transition: { kind: "save_step", step },
    },
    randomUUID(),
  );
  if (result.outcome !== "saved" && result.outcome !== "idempotent_replay") {
    throw new Error(`Unable to save ${step.step_id}: ${result.outcome}`);
  }
  return result.document;
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

describeInfrastructure("Phase 4 published schedule ordering", () => {
  it("allows private newer work but rejects rollback over a newer published revision", async () => {
    const accountId = randomUUID();
    const organisationId = randomUUID();
    await sql`INSERT INTO accounts(id,primary_email,display_name,email_verified_at)
      VALUES(${accountId},'schedule-order@phase4.test','Schedule Order Organiser',now())`;
    await sql.begin(async (tx) => {
      await tx`INSERT INTO organisations(id,name,slug)
        VALUES(${organisationId},'Schedule Order Organisation',${`schedule-order-${organisationId}`})`;
      await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
        VALUES(${organisationId},${accountId},'owner','active')`;
    });

    const phase3 = new Phase3Runtime(sql as unknown as PostgresJsSql, phase3DomainAdapter);
    const phase4 = new ReliableGateBPhase4Runtime(
      sql as unknown as PostgresJsSql,
      phase3,
      { enqueueSchedule: async (request) => ({ id: request.jobId, name: "schedule.optimize", duplicate: false }) },
      { mode: "disabled", provider: null, timeoutMs: 2_000, maximumAttempts: 1, cacheTtlSeconds: 3_600 },
    );
    const competition = await phase3.createCompetition(
      { accountId },
      {
        organisationId,
        name: "Schedule Order Cup",
        slug: `schedule-order-cup-${randomUUID()}`,
        sportCode: "badminton",
        venue: "Sports Hall",
        address: "1 Schedule Road",
        countryCode: "SG",
        startsOn: "2027-09-01",
        endsOn: "2027-09-01",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
    );
    const divisionId = randomUUID();
    await sql`INSERT INTO divisions(id,competition_id,name,team_limit)
      VALUES(${divisionId},${competition.id},'Singles',8)`;
    const pack = required(
      await sql<{ pack_version: string }[]>`
        SELECT pack_version FROM competition_sport_settings WHERE competition_id=${competition.id}`,
      "Competition sport settings were not created",
    );
    await sql`INSERT INTO division_sport_settings(
      division_id,competition_id,sport_code,pack_version,settings_override,updated_by
    ) VALUES(${divisionId},${competition.id},'badminton',${pack.pack_version},'{}'::jsonb,${accountId})`;
    for (let seed = 1; seed <= 8; seed += 1) {
      await sql`INSERT INTO division_entries(division_id,name,seed,status,entry_type)
        VALUES(${divisionId},${`Player ${seed}`},${seed},'confirmed','individual')`;
    }
    await phase3.replaceCapacity(
      { accountId },
      competition.id,
      {
        revision: 1,
        areas: [
          {
            name: "Court 1",
            slotMinutes: 40,
            availability: [{ date: "2027-09-01", startTime: "08:00", endTime: "22:00" }],
          },
        ],
      },
      randomUUID(),
    );

    let document = (
      await phase4.createSetupDraft(
        { accountId },
        competition.id,
        `schedule-order-create-${randomUUID()}`,
        randomUUID(),
      )
    ).document;
    for (const stepId of ["basics", "capacity", "settings", "entries"] as const) {
      const value = document.values[stepId];
      if (!value) throw new Error(`Seeded setup has no ${stepId}`);
      document = await saveStep(phase4, accountId, competition.id, document, {
        step_id: stepId,
        value,
      } as Phase4SetupStepValue);
    }
    if (!document.values.format_preferences) throw new Error("Seeded setup has no format preferences");
    document = await saveStep(phase4, accountId, competition.id, document, {
      step_id: "format_preferences",
      value: {
        ...document.values.format_preferences,
        minimum_matches: { per_entry: 1 },
        ranking: { rank_all_entries: false },
        placement: { required: false },
        priority: { value: "speed" },
      },
    });
    const selection = document.values.format_recommendations;
    const candidate = selection?.recommendations[0];
    if (!selection || !candidate) throw new Error("Expected a format recommendation");
    document = await saveStep(phase4, accountId, competition.id, document, {
      step_id: "format_recommendations",
      value: { ...selection, selected_recommendation_id: candidate.id, acknowledged_capacity_shortfall: false },
    });
    const selected = document.values.format_recommendations?.recommendations.find((item) => item.id === candidate.id);
    const formatRevisionId = selected?.division_formats[0]?.format_revision_id;
    if (!formatRevisionId) throw new Error("Selected recommendation has no published format revision");

    const match = required(
      await sql<{ id: string }[]>`
        SELECT id FROM matches WHERE format_revision_id=${formatRevisionId} ORDER BY ordinal LIMIT 1`,
      "Selected format has no materialised match",
    );
    const area = required(
      await sql<{ id: string; starts_at: Date; ends_at: Date }[]>`
        SELECT area.id,window.starts_at,window.ends_at
        FROM playing_areas area
        JOIN competition_availability_windows window ON window.playing_area_id=area.id
        WHERE area.competition_id=${competition.id}
        ORDER BY window.starts_at LIMIT 1`,
      "Competition has no playing area availability",
    );

    const createRevision = async (revision: number, ready: boolean) => {
      const revisionId = randomUUID();
      await sql`INSERT INTO schedule_revisions(
        id,competition_id,format_revision_id,revision,input_hash,status,created_by
      ) VALUES(
        ${revisionId},${competition.id},${formatRevisionId},${revision},${revision.toString(16).padStart(64, "0")},'draft',${accountId}
      )`;
      await sql`INSERT INTO schedule_revision_formats(
        schedule_revision_id,competition_id,division_id,format_revision_id
      ) VALUES(${revisionId},${competition.id},${divisionId},${formatRevisionId})`;
      const startsAt = new Date(area.starts_at.getTime() + (revision - 1) * 40 * 60_000);
      const endsAt = new Date(startsAt.getTime() + 40 * 60_000);
      if (endsAt > area.ends_at) throw new Error("Schedule order fixture exceeded capacity window");
      await sql`INSERT INTO scheduled_matches(
        schedule_revision_id,match_id,competition_id,playing_area_id,starts_at,ends_at
      ) VALUES(${revisionId},${match.id},${competition.id},${area.id},${startsAt},${endsAt})`;
      if (ready) await markReady(revisionId);
      return revisionId;
    };
    const markReady = async (revisionId: string) => {
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('matchday.phase4_accept_schedule','on',true)`;
        await tx`UPDATE schedule_revisions
          SET assignment_hash=phase4_schedule_assignment_hash(id),status='ready_for_review',updated_at=now()
          WHERE id=${revisionId}`;
      });
    };

    const revisionOne = await createRevision(1, true);
    const revisionTwo = await createRevision(2, false);
    const revisionThree = await createRevision(3, true);

    await sql`SELECT phase4_publish_schedule_revision(${revisionOne},${accountId},${`publish-${revisionOne}`})`;
    expect(
      required(
        await sql<{ published_schedule_revision_id: string; schedule_version: number }[]>`
          SELECT published_schedule_revision_id,schedule_version
          FROM competition_publications WHERE competition_id=${competition.id}`,
        "Competition publication was not created",
      ),
    ).toEqual({ published_schedule_revision_id: revisionOne, schedule_version: 1 });

    await sql`SELECT phase4_publish_schedule_revision(${revisionThree},${accountId},${`publish-${revisionThree}`})`;
    await markReady(revisionTwo);
    await expect(
      sql`SELECT phase4_publish_schedule_revision(${revisionTwo},${accountId},${`publish-${revisionTwo}`})`,
    ).rejects.toThrow(/cannot replace a newer published revision with an older revision/i);

    expect(
      required(
        await sql<{ published_schedule_revision_id: string; schedule_version: number }[]>`
          SELECT published_schedule_revision_id,schedule_version
          FROM competition_publications WHERE competition_id=${competition.id}`,
        "Competition publication disappeared",
      ),
    ).toEqual({ published_schedule_revision_id: revisionThree, schedule_version: 2 });
  });
});
