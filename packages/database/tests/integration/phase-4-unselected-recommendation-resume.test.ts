import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultFormatTemplates } from "../../../domain/src/index.js";
import { dropTestSchema, migrateDatabase } from "../../src/migrations.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase4_recommendation_resume_${randomUUID().replaceAll("-", "")}`;
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

describeInfrastructure("Phase 4 unselected recommendation resume", () => {
  it("preserves canonical recommendation evidence before the organiser selects a format", async () => {
    const account = randomUUID();
    const organisation = randomUUID();
    const competition = randomUUID();
    const division = randomUUID();
    const area = randomUUID();
    const setupDraft = randomUUID();

    await sql`INSERT INTO accounts(id,primary_email,display_name)
      VALUES(${account},${`${account}@example.test`},'Recommendation organiser')`;
    await sql.begin(async (tx) => {
      await tx`INSERT INTO organisations(id,name,slug)
        VALUES(${organisation},'Recommendation organisation',${`recommendation-${organisation}`})`;
      await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
        VALUES(${organisation},${account},'owner','active')`;
    });
    await sql`INSERT INTO sport_pack_versions(
      sport_code,version,schema_version,definition,definition_hash,status,activated_at
    ) VALUES(
      'badminton','resume-1',1,
      ${sql.json({
        recommendedSlotMinutes: 40,
        recommendedSettings: { slotMinutes: 40, bestOf: 3, targetPoints: 21 },
      })},
      ${"c".repeat(64)},'active',now()
    )`;
    await sql`INSERT INTO competitions(
      id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,
      venue,address,locality,country_code,locale,plan_tier
    ) VALUES(
      ${competition},${organisation},${account},'Recommendation Open',${`recommendation-${competition}`},'badminton',
      'Asia/Singapore','2027-05-01','2027-05-01','Sports Hall','1 Resume Road','Singapore','SG','en-SG','organiser_pro'
    )`;
    await sql`INSERT INTO competition_sport_settings(
      competition_id,updated_by,sport_code,pack_version,pack_schema_version,recommended_snapshot,settings_override
    ) VALUES(
      ${competition},${account},'badminton','resume-1',1,
      ${sql.json({ slotMinutes: 40, bestOf: 3, targetPoints: 21 })},'{}'::jsonb
    )`;
    await sql`INSERT INTO divisions(id,competition_id,name,team_limit)
      VALUES(${division},${competition},'Singles',8)`;
    await sql`INSERT INTO division_sport_settings(
      division_id,competition_id,sport_code,pack_version,settings_override,updated_by
    ) VALUES(${division},${competition},'badminton','resume-1','{}'::jsonb,${account})`;
    for (let seed = 1; seed <= 8; seed += 1) {
      await sql`INSERT INTO division_entries(division_id,name,entry_type,status,seed)
        VALUES(${division},${`Player ${seed}`},'individual','confirmed',${seed})`;
    }
    await sql`INSERT INTO playing_areas(id,competition_id,name,slot_minutes)
      VALUES(${area},${competition},'Court 1',40)`;
    await sql`INSERT INTO competition_availability_windows(competition_id,playing_area_id,starts_at,ends_at)
      VALUES(${competition},${area},'2027-05-01T00:00:00Z','2027-05-01T12:00:00Z')`;

    await sql`SELECT phase4_create_setup_draft(
      ${organisation},${competition},${account},${`resume-create-${randomUUID()}`},${`resume-request-${randomUUID()}`}
    )`;
    const [seeded] = await sql<{
      id: string;
      revision: number;
      steps: Record<string, any>;
    }[]>`SELECT id,revision,steps FROM setup_drafts WHERE competition_id=${competition}`;
    if (!seeded) throw new Error("Expected setup draft");
    expect(seeded.id).toBeTruthy();

    const template = createDefaultFormatTemplates(8).find((candidate) => candidate.strategy === "championship_focus");
    if (!template) throw new Error("Expected championship-focus template");
    const definitionHash = (
      await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(template.graph)}::jsonb) hash`
    )[0]!.hash;
    const sourceEvidence = {
      sport_code: "badminton",
      capacity: {
        revision: seeded.steps.capacity.revision,
        source_hash: seeded.steps.capacity.source_hash,
        available_match_slots: seeded.steps.capacity.effective.availableMatchSlots,
      },
      entries: seeded.steps.entries.divisions.map((item: Record<string, any>) => ({
        division_id: item.division_id,
        division_revision: item.division_revision,
        entry_ids: [...item.entry_ids].sort(),
        entry_count: item.confirmed_count + item.placeholder_count,
      })),
      preferences: seeded.steps.format_preferences,
    };
    const recommendationSetHash = (
      await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(sourceEvidence)}::jsonb) hash`
    )[0]!.hash;
    const recommendationSet = randomUUID();
    const candidate = randomUUID();
    const candidateDivision = randomUUID();
    const layout = {
      schema_version: 1,
      stage_positions: template.graph.stages.map((stage, index) => ({
        stage_id: stage.id,
        x: index * 240,
        y: 0,
      })),
    };
    const rankingCoverage = "podium" as const;

    await sql.begin(async (tx) => {
      await tx`INSERT INTO phase4_format_recommendation_sets(
        id,organisation_id,competition_id,setup_draft_id,source_hash,source_evidence,created_by
      ) VALUES(
        ${recommendationSet},${organisation},${competition},${seeded.id},${recommendationSetHash},${sql.json(sourceEvidence)},${account}
      )`;
      await tx`INSERT INTO phase4_format_recommendation_candidates(
        id,recommendation_set_id,family,category,ordinal,aggregate_metrics
      ) VALUES(
        ${candidate},${recommendationSet},'championship_focus','normal',1,
        ${sql.json({
          name: template.label,
          structure: "1 division · championship focus",
          advantage: template.advantage,
          match_count: template.metrics.matchCount,
          guaranteed_matches: template.metrics.guaranteedMatches,
          ranking_coverage: rankingCoverage,
          available_match_slots: seeded.steps.capacity.effective.availableMatchSlots,
          capacity_status: "fits",
          scheduling_status: "feasible",
          warning_codes: [],
        })}
      )`;
      await tx`INSERT INTO phase4_format_recommendation_candidate_divisions(
        id,candidate_id,division_id,definition,definition_hash,layout,metrics
      ) VALUES(
        ${candidateDivision},${candidate},${division},${sql.json(template.graph)},${definitionHash},${sql.json(layout)},
        ${sql.json({
          match_count: template.metrics.matchCount,
          guaranteed_matches: template.metrics.guaranteedMatches,
          ranking_coverage: rankingCoverage,
        })}
      )`;
    });

    const recommendation = {
      id: candidate,
      format_revision_id: null,
      format_definition_hash: definitionHash,
      name: template.label,
      structure: "1 division · championship focus",
      advantage: template.advantage,
      match_count: template.metrics.matchCount,
      minimum_matches_per_entry: template.metrics.guaranteedMatches,
      guaranteed_matches: template.metrics.guaranteedMatches,
      ranking_coverage: rankingCoverage,
      available_match_slots: seeded.steps.capacity.effective.availableMatchSlots,
      division_formats: [
        {
          division_id: division,
          candidate_division_id: candidateDivision,
          format_revision_id: null,
          format_definition_hash: definitionHash,
          match_count: template.metrics.matchCount,
          guaranteed_matches: template.metrics.guaranteedMatches,
          ranking_coverage: rankingCoverage,
        },
      ],
      capacity_status: "fits",
      scheduling_status: "feasible",
      warning_codes: [],
    };
    await sql`UPDATE setup_drafts
      SET revision=revision+1,
          current_step='format_recommendations',
          steps=jsonb_set(steps,'{format_recommendations}',${sql.json({
            recommendations: [recommendation],
            requires_changes: null,
            selected_recommendation_id: null,
            acknowledged_capacity_shortfall: false,
            recommendation_set_hash: recommendationSetHash,
          })},true),
          updated_at=clock_timestamp()
      WHERE competition_id=${competition}`;
    const [beforeResume] = await sql<{ revision: number }[]>`
      SELECT revision FROM setup_drafts WHERE competition_id=${competition}`;

    const [resumed] = await sql<{ value: { revision: number; current_step: string; steps: Record<string, any> } }[]>`
      SELECT phase4_resume_setup_draft(
        ${organisation},${competition},${account},${`resume-unselected-${randomUUID()}`},${`resume-unselected-request-${randomUUID()}`}
      ) value`;

    expect(resumed?.value.revision).toBe(beforeResume?.revision);
    expect(resumed?.value.current_step).toBe("format_recommendations");
    expect(resumed?.value.steps.format_recommendations).toMatchObject({
      selected_recommendation_id: null,
      recommendation_set_hash: recommendationSetHash,
      recommendations: [{ id: candidate, format_revision_id: null }],
    });
  });
});
