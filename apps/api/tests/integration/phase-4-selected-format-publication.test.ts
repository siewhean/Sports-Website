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
const schema = `test_phase4_selected_formats_${randomUUID().replaceAll("-", "")}`;
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
      idempotency_key: `selected-format-${step.step_id}-${randomUUID()}`,
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

describeInfrastructure("Assisted Setup selected format publication", () => {
  it("materialises and publishes the exact selected revision before schedule generation", async () => {
    const accountId = randomUUID();
    const organisationId = randomUUID();
    await sql`INSERT INTO accounts(id,primary_email,display_name,email_verified_at)
      VALUES(${accountId},'selected-format@phase4.test','Selected Format Organiser',now())`;
    await sql.begin(async (tx) => {
      await tx`INSERT INTO organisations(id,name,slug)
        VALUES(${organisationId},'Selected Format Organisation',${`selected-format-${organisationId}`})`;
      await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
        VALUES(${organisationId},${accountId},'owner','active')`;
    });

    const phase3 = new Phase3Runtime(sql as unknown as PostgresJsSql, phase3DomainAdapter);
    const enqueueCalls: Array<{ jobId: string; competitionId: string }> = [];
    const phase4 = new ReliableGateBPhase4Runtime(
      sql as unknown as PostgresJsSql,
      phase3,
      {
        enqueueSchedule: async (request) => {
          enqueueCalls.push({ jobId: request.jobId, competitionId: request.competitionId });
          return { id: request.jobId, name: "schedule.optimize", duplicate: false };
        },
      },
      { mode: "disabled", provider: null, timeoutMs: 2_000, maximumAttempts: 1, cacheTtlSeconds: 3_600 },
    );

    const competition = await phase3.createCompetition(
      { accountId },
      {
        organisationId,
        name: "Selected Format Cup",
        slug: `selected-format-cup-${randomUUID()}`,
        sportCode: "badminton",
        venue: "Sports Hall",
        address: "1 Format Road",
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
        `selected-format-create-${randomUUID()}`,
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
    if (!selection || !candidate) throw new Error("Expected a capacity-filtered recommendation");
    document = await saveStep(phase4, accountId, competition.id, document, {
      step_id: "format_recommendations",
      value: {
        ...selection,
        selected_recommendation_id: candidate.id,
        acknowledged_capacity_shortfall: false,
      },
    });

    const selected = document.values.format_recommendations?.recommendations.find((item) => item.id === candidate.id);
    const formatRevisionId = selected?.division_formats[0]?.format_revision_id;
    if (!formatRevisionId) throw new Error("Selected recommendation has no applied format revision");
    const [format] = await sql<
      {
        id: string;
        status: string;
        graph_materialized_at: Date | null;
        graph_match_count: number | null;
        match_count: number;
      }[]
    >`SELECT revision.id,revision.status,revision.graph_materialized_at,revision.graph_match_count,
        count(match.id)::int match_count
      FROM format_revisions revision
      LEFT JOIN matches match ON match.format_revision_id=revision.id
      WHERE revision.id=${formatRevisionId}
      GROUP BY revision.id`;
    expect(format).toMatchObject({
      id: formatRevisionId,
      status: "published",
      graph_materialized_at: expect.any(Date),
      graph_match_count: selected?.division_formats[0]?.match_count,
      match_count: selected?.division_formats[0]?.match_count,
    });

    const workspace = await phase4.scheduleWorkspace({ accountId }, competition.id);
    const generated = await phase4.generateSchedule(
      { accountId },
      competition.id,
      {
        idempotency_key: `selected-format-schedule-${randomUUID()}`,
        expected_source_revision: workspace.generation.source_revision,
        expected_capacity_revision: workspace.generation.capacity_revision,
        objective: "balanced",
        constraints: workspace.generation.constraints,
      },
      randomUUID(),
    );
    expect(generated).toMatchObject({ enqueued: true, recoverable: false, job: { status: "queued" } });
    expect(enqueueCalls).toEqual([{ jobId: generated.job.id, competitionId: competition.id }]);
  });
});
