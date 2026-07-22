import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultFormatTemplates } from "../../../domain/src/index.js";
import { dropTestSchema, migrateDatabase } from "../../src/migrations.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase4_setup_refresh_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
let sql!: Sql;

function hashDefinition(value: unknown): string {
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

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  sql = postgres(databaseUrl, { max: 2, onnotice: () => undefined, connection: { search_path: schema } });
});

afterAll(async () => {
  await sql?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

describeInfrastructure("Phase 4 setup reference refresh", () => {
  it("refreshes canonical capacity and clears only dependent evidence", async () => {
    const account = randomUUID();
    const organisation = randomUUID();
    const competition = randomUUID();
    const area = randomUUID();
    await sql`INSERT INTO accounts(id,primary_email,display_name)
      VALUES(${account},${`${account}@example.test`},'Reference organiser')`;
    await sql.begin(async (tx) => {
      await tx`INSERT INTO organisations(id,name,slug)
        VALUES(${organisation},'Reference organisation',${`reference-${organisation}`})`;
      await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
        VALUES(${organisation},${account},'owner','active')`;
    });
    const packDefinition = { recommendedSlotMinutes: 60, recommendedSettings: { bestOf: 3, slotMinutes: 60 } };
    await sql`INSERT INTO sport_pack_versions(
      sport_code,version,schema_version,definition,definition_hash,status,activated_at
    ) VALUES(
      'volleyball','refresh-1',1,
      ${sql.json(packDefinition)},${hashDefinition(packDefinition)},'active',now()
    )`;
    await sql`INSERT INTO competitions(
      id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,
      venue,address,locality,country_code,locale,plan_tier
    ) VALUES(
      ${competition},${organisation},${account},'Volleyball Cup',${`volleyball-${competition}`},'volleyball',
      'Asia/Singapore','2027-04-01','2027-04-02','Arena','1 Arena Road','Singapore','SG','en-SG','organiser_pro'
    )`;
    await sql`INSERT INTO competition_sport_settings(
      competition_id,updated_by,sport_code,pack_version,pack_schema_version,recommended_snapshot,settings_override
    ) VALUES(
      ${competition},${account},'volleyball','refresh-1',1,${sql.json({ bestOf: 3 })},'{}'::jsonb
    )`;
    await sql`INSERT INTO playing_areas(id,competition_id,name,slot_minutes)
      VALUES(${area},${competition},'Court A',60)`;
    await sql`INSERT INTO competition_availability_windows(
      competition_id,playing_area_id,starts_at,ends_at
    ) VALUES(${competition},${area},'2027-04-01T00:00:00Z','2027-04-01T04:00:00Z')`;
    await sql`SELECT phase4_create_setup_draft(
      ${organisation},${competition},${account},'reference-create-1','reference-create-request-1'
    )`;

    const [before] = await sql<{ revision: number; steps: Record<string, unknown> }[]>`
      SELECT revision,steps FROM setup_drafts WHERE competition_id=${competition}`;
    expect(before?.steps.format_preferences).toMatchObject({
      minimum_matches: { per_entry: 3 },
      priority: { value: "participation" },
    });
    expect(before?.steps.capacity).toMatchObject({ effective: { availableMatchSlots: 4, slotMinutes: 60 } });

    await sql`UPDATE competition_availability_windows
      SET ends_at='2027-04-01T06:00:00Z' WHERE competition_id=${competition}`;
    const [stale] = await sql<{ revision: number }[]>`UPDATE setup_drafts SET
      revision=revision+1,
      steps=jsonb_set(
        jsonb_set(
          jsonb_set(steps,'{format_recommendations}',${sql.json({ recommendations: [{ id: "stale" }] })},true),
          '{schedule_review}',${sql.json({ schedule_job_id: "stale" })},true
        ),
        '{review_publish}',${sql.json({ publication_status: "not_requested" })},true
      ),
      updated_at=clock_timestamp()
      WHERE competition_id=${competition}
      RETURNING revision`;

    const [refreshed] = await sql<
      {
        value: { revision: number; steps: Record<string, unknown> };
      }[]
    >`SELECT phase4_refresh_setup_draft_references(
      ${organisation},${competition},${account},'reference-refresh-request-1'
    ) value`;

    expect(refreshed?.value.revision).toBe((stale?.revision ?? 0) + 1);
    expect(refreshed?.value.steps.capacity).toMatchObject({ effective: { availableMatchSlots: 6, slotMinutes: 60 } });
    expect(refreshed?.value.steps.format_preferences).toEqual(before?.steps.format_preferences);
    expect(refreshed?.value.steps).toMatchObject({
      format_recommendations: null,
      schedule_review: null,
      review_publish: null,
    });

    const [replayedRead] = await sql<{ value: { revision: number } }[]>`
      SELECT phase4_refresh_setup_draft_references(
        ${organisation},${competition},${account},'reference-refresh-request-2'
      ) value`;
    expect(replayedRead?.value.revision).toBe(refreshed?.value.revision);
  });

  it("refreshes each canonical reference and stale evidence independently without no-op draft writes", async () => {
    const [context] = await sql<
      {
        organisation_id: string;
        competition_id: string;
        updated_by: string;
        revision: number;
      }[]
    >`SELECT organisation_id,competition_id,updated_by,revision
      FROM setup_drafts ORDER BY created_at DESC LIMIT 1`;
    if (!context) throw new Error("Expected reference setup draft");

    await sql`UPDATE competition_sport_settings
      SET revision=revision+1,customised=true,settings_override='{"bestOf":5}'::jsonb,updated_at=clock_timestamp()
      WHERE competition_id=${context.competition_id}`;
    const [settingsRefresh] = await sql<{ value: { revision: number; steps: Record<string, unknown> } }[]>`
      SELECT phase4_refresh_setup_draft_references(
        ${context.organisation_id},${context.competition_id},${context.updated_by},'settings-only-refresh'
      ) value`;
    expect(settingsRefresh?.value.revision).toBe(context.revision + 1);
    expect(settingsRefresh?.value.steps.settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "competition", settings_revision: 2, mode: "customised" }),
      ]),
    );

    const division = randomUUID();
    await sql`INSERT INTO divisions(id,competition_id,name,team_limit)
      VALUES(${division},${context.competition_id},'New division',8)`;
    const [entriesRefresh] = await sql<{ value: { revision: number; steps: Record<string, unknown> } }[]>`
      SELECT phase4_refresh_setup_draft_references(
        ${context.organisation_id},${context.competition_id},${context.updated_by},'entries-only-refresh'
      ) value`;
    expect(entriesRefresh?.value.revision).toBe((settingsRefresh?.value.revision ?? 0) + 1);
    expect(entriesRefresh?.value.steps.entries).toMatchObject({
      divisions: [expect.objectContaining({ division_id: division, confirmed_count: 0 })],
      total_entry_count: 0,
    });

    const graph = structuredClone(createDefaultFormatTemplates(8)[0]!.graph);
    const formatRevision = randomUUID();
    await sql`INSERT INTO format_revisions(
      id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract
    ) VALUES(
      ${formatRevision},${context.competition_id},${division},1,${sql.json(graph)},${hashDefinition(graph)},
      ${context.updated_by},'phase3'
    )`;
    await sql`SELECT phase4_refresh_setup_draft_references(
      ${context.organisation_id},${context.competition_id},${context.updated_by},'format-capacity-refresh'
    )`;
    const unselectedRecommendations = {
      recommendations: [
        {
          id: "recommendation-1",
          format_revision_id: formatRevision,
          format_definition_hash: hashDefinition(graph),
          name: "Group to knockout",
          structure: "Groups followed by knockout",
          advantage: "Balanced participation",
          match_count: graph.matches.length,
          minimum_matches_per_entry: 3,
          capacity_status: "fits",
          scheduling_status: "feasible",
          warning_codes: [],
        },
      ],
      requires_changes: null,
      selected_recommendation_id: null,
      acknowledged_capacity_shortfall: false,
      recommendation_set_hash: "valid-unselected-set",
    };
    const [unselectedDraft] = await sql<{ revision: number }[]>`UPDATE setup_drafts
      SET revision=revision+1,
          steps=jsonb_set(steps,'{format_recommendations}',${sql.json(unselectedRecommendations)},true),
          updated_at=clock_timestamp()
      WHERE competition_id=${context.competition_id}
      RETURNING revision`;
    const [unselectedRefresh] = await sql<{ value: { revision: number; steps: Record<string, unknown> } }[]>`
      SELECT phase4_refresh_setup_draft_references(
        ${context.organisation_id},${context.competition_id},${context.updated_by},'valid-unselected-refresh'
      ) value`;
    expect(unselectedRefresh?.value.revision).toBe(unselectedDraft?.revision);
    expect(unselectedRefresh?.value.steps.format_recommendations).toEqual(unselectedRecommendations);

    const evidenceCases = [
      ["format_recommendations", { recommendations: [], selected_recommendation_id: null }],
      ["schedule_review", { schedule_job_id: "stale" }],
      ["review_publish", { selected_format_revision_id: "stale" }],
    ] as const;
    let expectedRevision = entriesRefresh?.value.revision ?? 0;
    for (const [step, staleEvidence] of evidenceCases) {
      const [injected] = await sql<{ revision: number }[]>`UPDATE setup_drafts
        SET revision=revision+1,
            steps=jsonb_set(steps,ARRAY[${step}],${sql.json(staleEvidence)},true),
            updated_at=clock_timestamp()
        WHERE competition_id=${context.competition_id}
        RETURNING revision`;
      expectedRevision = injected!.revision + 1;
      const [refreshed] = await sql<{ value: { revision: number; steps: Record<string, unknown> } }[]>`
        SELECT phase4_refresh_setup_draft_references(
          ${context.organisation_id},${context.competition_id},${context.updated_by},${`${step}-only-refresh`}
        ) value`;
      expect(refreshed?.value.revision).toBe(expectedRevision);
      expect(refreshed?.value.steps[step]).toBeNull();
    }

    const [beforeNoop] = await sql<{ revision: number; audit_count: number; outbox_count: number }[]>`
      SELECT draft.revision,
        (SELECT count(*)::integer FROM audit_events WHERE action='setup.references.refreshed') audit_count,
        (SELECT count(*)::integer FROM outbox_events WHERE event_type='setup.references.refreshed') outbox_count
      FROM setup_drafts draft WHERE competition_id=${context.competition_id}`;
    const [noOp] = await sql<{ value: { revision: number } }[]>`
      SELECT phase4_refresh_setup_draft_references(
        ${context.organisation_id},${context.competition_id},${context.updated_by},'no-op-refresh'
      ) value`;
    const [afterNoop] = await sql<{ revision: number; audit_count: number; outbox_count: number }[]>`
      SELECT draft.revision,
        (SELECT count(*)::integer FROM audit_events WHERE action='setup.references.refreshed') audit_count,
        (SELECT count(*)::integer FROM outbox_events WHERE event_type='setup.references.refreshed') outbox_count
      FROM setup_drafts draft WHERE competition_id=${context.competition_id}`;
    expect(noOp?.value.revision).toBe(beforeNoop?.revision);
    expect(afterNoop).toEqual(beforeNoop);
  });
});
