import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultFormatTemplates } from "../../../domain/src/index.js";
import { dropTestSchema, migrateDatabase } from "../../src/migrations.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase4_template_sport_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
let sql!: Sql;

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

describeInfrastructure("Phase 4 format-template sport guard", () => {
  beforeAll(async () => {
    await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
    sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    await sql.unsafe(`SET search_path TO "${schema}", public`);
  });

  afterAll(async () => {
    await sql?.end();
    await dropTestSchema(databaseUrl, schema);
  });

  it("allows same-sport reuse and rejects cross-sport template application", async () => {
    const account = randomUUID();
    const organisation = randomUUID();
    const badmintonCompetition = randomUUID();
    const volleyballCompetition = randomUUID();
    const sourceDivision = randomUUID();
    const sameSportTargetDivision = randomUUID();
    const crossSportTargetDivision = randomUUID();
    const sourceRevision = randomUUID();

    await sql`INSERT INTO accounts(id,primary_email,display_name)
      VALUES(${account},${`${account}@example.test`},'Template guard')`;
    await sql.begin(async (transaction) => {
      await transaction`INSERT INTO organisations(id,name,slug)
        VALUES(${organisation},'Template guard',${`template-guard-${organisation}`})`;
      await transaction`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
        VALUES(${organisation},${account},'owner','active')`;
    });
    await sql`INSERT INTO competitions(id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,plan_tier)
      VALUES
      (${badmintonCompetition},${organisation},${account},'Badminton Cup',${`badminton-${badmintonCompetition}`},'badminton','Asia/Singapore','2027-01-01','2027-01-02','organiser_pro'),
      (${volleyballCompetition},${organisation},${account},'Volleyball Cup',${`volleyball-${volleyballCompetition}`},'volleyball','Asia/Singapore','2027-02-01','2027-02-02','organiser_pro')`;
    await sql`INSERT INTO divisions(id,competition_id,name,team_limit)
      VALUES
      (${sourceDivision},${badmintonCompetition},'Source',16),
      (${sameSportTargetDivision},${badmintonCompetition},'Target',16),
      (${crossSportTargetDivision},${volleyballCompetition},'Target',16)`;

    const graph = structuredClone(createDefaultFormatTemplates(8)[0]!.graph);
    const layout = {
      schema_version: 1,
      stage_positions: graph.stages.map((stage, index) => ({
        stage_id: stage.id,
        x: 80 + index * 260,
        y: 80 + (index % 2) * 180,
      })),
    };
    await sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,layout,created_by,validation_contract)
      VALUES(${sourceRevision},${badmintonCompetition},${sourceDivision},1,${sql.json(graph)},${hash(graph)},${sql.json(layout)},${account},'phase3')`;

    const [template] = await sql<{ id: string }[]>`
      SELECT id FROM phase4_create_format_template(
        ${organisation},${sourceRevision},${account},'Reusable badminton','Same-sport template','template-guard-create'
      )`;
    expect(template?.id).toBeTruthy();

    const sameSportRevision = randomUUID();
    await expect(
      sql`INSERT INTO format_revisions(
        id,competition_id,division_id,revision,definition,definition_hash,status,created_by,
        validation_contract,template_version_id,source_kind,layout
      ) VALUES(
        ${sameSportRevision},${badmintonCompetition},${sameSportTargetDivision},1,${sql.json(graph)},${hash(graph)},'draft',${account},
        'phase3',${template!.id},'template',${sql.json(layout)}
      )`,
    ).resolves.toBeDefined();

    await expect(
      sql`INSERT INTO format_revisions(
        id,competition_id,division_id,revision,definition,definition_hash,status,created_by,
        validation_contract,template_version_id,source_kind,layout
      ) VALUES(
        ${randomUUID()},${volleyballCompetition},${crossSportTargetDivision},1,${sql.json(graph)},${hash(graph)},'draft',${account},
        'phase3',${template!.id},'template',${sql.json(layout)}
      )`,
    ).rejects.toThrow(/template application sport must match the competition sport/i);
  });
});
