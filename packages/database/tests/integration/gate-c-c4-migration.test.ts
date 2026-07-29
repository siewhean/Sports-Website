import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "@matchday/config";
import { dropTestSchema, migrateDatabase } from "../../src/migrations.js";

const config = parseConfig(process.env);
const schema = `test_gate_c_c4_migration_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

beforeAll(async () => dropTestSchema(config.databaseUrl, schema));
afterAll(async () => dropTestSchema(config.databaseUrl, schema));

describe("Gate C C4 repair persistence migration", () => {
  it("adds immutable division-scoped public truth and export metadata without mutating retained history", async () => {
    const result = await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory, schema });
    expect(result.current).toContain("0033_gate_c_repair_public_truth_exports.sql");

    const sql = postgres(config.databaseUrl, {
      max: 1,
      prepare: false,
      connection: { search_path: schema },
    });
    try {
      const accountId = randomUUID();
      const organisationId = randomUUID();
      const competitionId = randomUUID();
      const divisionId = randomUUID();
      const otherCompetitionId = randomUUID();
      await sql`INSERT INTO accounts(id,primary_email,display_name)
        VALUES(${accountId},${`${accountId}@example.test`},'C4 migration owner')`;
      await sql.begin(async (tx) => {
        await tx`INSERT INTO organisations(id,name,slug)
          VALUES(${organisationId},'C4 migration organisation',${`c4-${organisationId}`})`;
        await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
          VALUES(${organisationId},${accountId},'owner','active')`;
      });
      await sql`INSERT INTO competitions(id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,plan_tier)
        VALUES(${competitionId},${organisationId},${accountId},'C4 Cup',${`c4-cup-${competitionId}`},'badminton',
          'Asia/Singapore','2027-01-01','2027-01-01','organiser_pro')`;
      await sql`INSERT INTO competitions(id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,plan_tier)
        VALUES(${otherCompetitionId},${organisationId},${accountId},'Other C4 Cup',${`other-c4-${otherCompetitionId}`},'badminton',
          'Asia/Singapore','2027-01-01','2027-01-01','organiser_pro')`;
      await sql`INSERT INTO divisions(id,competition_id,name,team_limit)
        VALUES(${divisionId},${competitionId},'Open',16)`;

      expect(
        await sql<{ table_name: string }[]>`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema=current_schema()
            AND table_name IN (
              'schedule_repair_cases','schedule_repair_revisions','schedule_repair_actions',
              'schedule_repair_decisions','schedule_repair_publication_receipts',
              'public_projection_versions','competition_export_manifests'
            )
          ORDER BY table_name
        `,
      ).toHaveLength(7);

      const [projection] = await sql<{ id: string }[]>`
        INSERT INTO public_projection_versions(
          competition_id,division_id,schedule_version,result_version,projection_version,
          projection,projection_fingerprint,etag,generated_at,source_updated_at
        ) VALUES(
          ${competitionId},${divisionId},1,2,1,${sql.json({ division: "Open" })},${"a".repeat(64)},'"c4-open-v1"',
          '2027-01-01T01:00:00Z','2027-01-01T01:00:00Z'
        ) RETURNING id
      `;
      expect(projection?.id).toBeTruthy();
      await expect(
        sql`UPDATE public_projection_versions SET etag='"changed"' WHERE id=${projection!.id}`,
      ).rejects.toThrow(/append-only/i);
      await expect(sql`DELETE FROM public_projection_versions WHERE id=${projection!.id}`).rejects.toThrow(
        /append-only/i,
      );
      await expect(
        sql`INSERT INTO public_projection_versions(
          competition_id,division_id,schedule_version,result_version,projection_version,
          projection,projection_fingerprint,etag,generated_at,source_updated_at
        ) VALUES(
          ${otherCompetitionId},${divisionId},1,1,1,${sql.json({ division: "Open" })},${"b".repeat(64)},'"wrong-tenant"',
          '2027-01-01T01:00:00Z','2027-01-01T01:00:00Z'
        )`,
      ).rejects.toThrow();

      const [manifest] = await sql<{ id: string }[]>`
        INSERT INTO competition_export_manifests(
          competition_id,division_id,export_kind,schedule_version,result_version,
          projection_fingerprint,source_fingerprint,content_sha256,byte_size,safe_filename,created_by_account_id
        ) VALUES(
          ${competitionId},${divisionId},'badminton_score_sheet',1,2,
          ${"c".repeat(64)},${"d".repeat(64)},${"e".repeat(64)},512,'open-score-sheet.pdf',${accountId}
        ) RETURNING id
      `;
      await expect(sql`DELETE FROM competition_export_manifests WHERE id=${manifest!.id}`).rejects.toThrow(
        /append-only/i,
      );
      expect(
        await sql<{ proname: string }[]>`
          SELECT proname FROM pg_proc WHERE proname='gate_c_append_schedule_repair_revision'
        `,
      ).toEqual([{ proname: "gate_c_append_schedule_repair_revision" }]);
    } finally {
      await sql.end({ timeout: 2 });
    }
  }, 30_000);
});
