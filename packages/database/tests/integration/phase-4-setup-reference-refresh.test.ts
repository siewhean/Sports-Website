import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "../../src/migrations.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase4_setup_refresh_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
let sql!: Sql;

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
    await sql`INSERT INTO sport_pack_versions(
      sport_code,version,schema_version,definition,definition_hash,status,activated_at
    ) VALUES(
      'volleyball','refresh-1',1,
      ${sql.json({ recommendedSlotMinutes: 60, recommendedSettings: { bestOf: 3 } })},
      ${"b".repeat(64)},'active',now()
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

    const [refreshed] = await sql<{
      value: { revision: number; steps: Record<string, unknown> };
    }[]>`SELECT phase4_refresh_setup_draft_references(
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
});
