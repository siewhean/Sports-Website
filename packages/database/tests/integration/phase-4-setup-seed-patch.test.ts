import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "../../src/migrations.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase4_setup_seed_${randomUUID().replaceAll("-", "")}`;
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
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

describeInfrastructure("Phase 4 Assisted Setup seed and patch guardrails", () => {
  it("seeds a non-Canoe-Polo draft from canonical competition, pack, capacity, and entries", async () => {
    const account = randomUUID();
    const organisation = randomUUID();
    const competition = randomUUID();
    const division = randomUUID();
    const area = randomUUID();

    await sql`INSERT INTO accounts(id,primary_email,display_name)
      VALUES(${account},${`${account}@example.test`},'Setup organiser')`;
    await sql.begin(async (tx) => {
      await tx`INSERT INTO organisations(id,name,slug)
        VALUES(${organisation},'Setup organisation',${`setup-${organisation}`})`;
      await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
        VALUES(${organisation},${account},'owner','active')`;
    });
    const packDefinition = {
      recommendedSlotMinutes: 40,
      recommendedSettings: { bestOf: 3, slotMinutes: 40, targetPoints: 21 },
    };
    await sql`INSERT INTO sport_pack_versions(
      sport_code,version,schema_version,definition,definition_hash,status,activated_at
    ) VALUES(
      'badminton','test-1',1,
      ${sql.json(packDefinition)},${hashDefinition(packDefinition)},'active',now()
    )`;
    await sql`INSERT INTO competitions(
      id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,
      venue,address,locality,country_code,locale,plan_tier
    ) VALUES(
      ${competition},${organisation},${account},'Badminton Open',${`badminton-${competition}`},'badminton',
      'Asia/Singapore','2027-03-01','2027-03-02','Sports Hall','1 Test Street','Singapore','SG','en-SG','organiser_pro'
    )`;
    await sql`INSERT INTO competition_sport_settings(
      competition_id,updated_by,sport_code,pack_version,pack_schema_version,recommended_snapshot,settings_override
    ) VALUES(
      ${competition},${account},'badminton','test-1',1,
      ${sql.json({ bestOf: 3, targetPoints: 21 })},'{}'::jsonb
    )`;
    await sql`INSERT INTO divisions(id,competition_id,name,team_limit)
      VALUES(${division},${competition},'Singles',8)`;
    await sql`INSERT INTO division_sport_settings(
      division_id,competition_id,sport_code,pack_version,settings_override,updated_by
    ) VALUES(${division},${competition},'badminton','test-1','{}'::jsonb,${account})`;
    for (let seed = 1; seed <= 4; seed += 1) {
      await sql`INSERT INTO division_entries(division_id,name,entry_type,status,seed)
        VALUES(${division},${`Player ${seed}`},'individual','confirmed',${seed})`;
    }
    await sql`INSERT INTO playing_areas(id,competition_id,name,slot_minutes)
      VALUES(${area},${competition},'Court 1',40)`;
    await sql`INSERT INTO competition_availability_windows(
      competition_id,playing_area_id,starts_at,ends_at
    ) VALUES(${competition},${area},'2027-03-01T00:00:00Z','2027-03-01T02:40:00Z')`;

    await sql`SELECT phase4_create_setup_draft(
      ${organisation},${competition},${account},'seed-create-1','seed-request-1'
    )`;
    const [draft] = await sql<
      {
        revision: number;
        current_step: string;
        steps: {
          basics: { sport_code: string; name: string; entry_count: number; division_count: number };
          settings: Array<{ pack_version: string; scope: string }>;
          capacity: { effective: { slotMinutes: number; availableMatchSlots: number } };
          entries: { total_entry_count: number; divisions: Array<{ confirmed_count: number }> };
        };
      }[]
    >`SELECT revision,current_step,steps FROM setup_drafts WHERE competition_id=${competition}`;

    expect(draft).toMatchObject({
      revision: 1,
      current_step: "basics",
      steps: {
        basics: { sport_code: "badminton", name: "Badminton Open", entry_count: 4, division_count: 1 },
        capacity: { effective: { slotMinutes: 40, availableMatchSlots: 4 } },
        entries: { total_entry_count: 4, divisions: [{ confirmed_count: 4 }] },
      },
    });
    expect(draft?.steps.settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "competition", pack_version: "test-1" }),
        expect.objectContaining({ scope: "division", pack_version: "test-1" }),
      ]),
    );
  });

  it("patches one step without navigating and replays the exact idempotent response", async () => {
    const [row] = await sql<
      {
        organisation_id: string;
        competition_id: string;
        created_by: string;
        revision: number;
        current_step: string;
        steps: Record<string, unknown>;
      }[]
    >`SELECT organisation_id,competition_id,created_by,revision,current_step,steps
      FROM setup_drafts ORDER BY created_at DESC LIMIT 1`;
    if (!row) throw new Error("Expected seeded setup draft");
    const nextSteps = JSON.parse(JSON.stringify(row.steps));
    nextSteps.basics = { ...(nextSteps.basics as Record<string, unknown>), name: "Badminton Open Updated" };
    const validation = { valid: false, pending: false, issues: [], completed_at_by_step: {} };

    const first = await sql<{ value: { revision: number; current_step: string; steps: Record<string, unknown> } }[]>`
      SELECT phase4_patch_setup_draft(
        ${row.organisation_id},${row.competition_id},${row.created_by},${row.revision},'basics',
        ${sql.json(nextSteps)},${sql.json([])},${sql.json(validation)},'seed-patch-1','seed-patch-request-1'
      ) value`;
    const replay = await sql<{ value: { revision: number; current_step: string; steps: Record<string, unknown> } }[]>`
      SELECT phase4_patch_setup_draft(
        ${row.organisation_id},${row.competition_id},${row.created_by},${row.revision},'basics',
        ${sql.json(nextSteps)},${sql.json([])},${sql.json(validation)},'seed-patch-1','seed-patch-request-2'
      ) value`;

    expect(first[0]?.value).toEqual(replay[0]?.value);
    expect(first[0]?.value).toMatchObject({ revision: row.revision + 1, current_step: row.current_step });
    expect((first[0]?.value.steps.basics as Record<string, unknown>).name).toBe("Badminton Open Updated");
    await expect(sql`
      SELECT phase4_patch_setup_draft(
        ${row.organisation_id},${row.competition_id},${row.created_by},${row.revision},'basics',
        ${sql.json({ ...nextSteps, basics: { name: "Different" } })},${sql.json([])},${sql.json(validation)},
        'seed-patch-1','seed-patch-request-mismatch'
      )`).rejects.toThrow(/idempotency key was reused/i);
  });

  it("replays resume exactly, rejects mismatched reuse, and authorises before replay", async () => {
    const [row] = await sql<
      {
        organisation_id: string;
        competition_id: string;
        created_by: string;
      }[]
    >`SELECT organisation_id,competition_id,created_by
      FROM setup_drafts ORDER BY created_at DESC LIMIT 1`;
    if (!row) throw new Error("Expected seeded setup draft");

    const first = await sql<{ value: Record<string, unknown> }[]>`
      SELECT phase4_resume_setup_draft(
        ${row.organisation_id},${row.competition_id},${row.created_by},'resume-exact-1','resume-request-1'
      ) value`;
    const replay = await sql<{ value: Record<string, unknown> }[]>`
      SELECT phase4_resume_setup_draft(
        ${row.organisation_id},${row.competition_id},${row.created_by},'resume-exact-1','resume-request-2'
      ) value`;
    expect(replay[0]?.value).toEqual(first[0]?.value);

    const otherCompetition = randomUUID();
    await sql`INSERT INTO competitions(
      id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,plan_tier
    ) VALUES(
      ${otherCompetition},${row.organisation_id},${row.created_by},'Other badminton',${`other-${otherCompetition}`},
      'badminton','Asia/Singapore','2027-03-03','2027-03-04','organiser_pro'
    )`;
    await expect(
      sql`SELECT phase4_resume_setup_draft(
        ${row.organisation_id},${otherCompetition},${row.created_by},'resume-exact-1','resume-mismatch'
      )`,
    ).rejects.toThrow(/idempotency key was reused/i);

    const viewer = randomUUID();
    await sql`INSERT INTO accounts(id,primary_email,display_name)
      VALUES(${viewer},${`${viewer}@example.test`},'Setup viewer')`;
    await sql`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
      VALUES(${row.organisation_id},${viewer},'viewer','active')`;
    await expect(
      sql`SELECT phase4_resume_setup_draft(
        ${row.organisation_id},${row.competition_id},${viewer},'resume-exact-1','viewer-replay'
      )`,
    ).rejects.toThrow(/organiser permission/i);
  });

  it("seeds slotMinutes using effective competition sport settings (overrides and pack version)", async () => {
    const account = randomUUID();
    const organisation = randomUUID();
    const competition = randomUUID();
    const area = randomUUID();

    await sql`INSERT INTO accounts(id,primary_email,display_name)
      VALUES(${account},${`${account}@example.test`},'Volleyball organiser')`;
    await sql.begin(async (tx) => {
      await tx`INSERT INTO organisations(id,name,slug)
        VALUES(${organisation},'Volleyball organisation',${`vb-${organisation}`})`;
      await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
        VALUES(${organisation},${account},'owner','active')`;
    });

    const vbPackDefinition = {
      recommendedSlotMinutes: 90,
      recommendedSettings: { bestOf: 5, slotMinutes: 90 },
    };
    await sql`INSERT INTO sport_pack_versions(
      sport_code,version,schema_version,definition,definition_hash,status,activated_at
    ) VALUES(
      'volleyball','1.0.0',1,
      ${sql.json(vbPackDefinition)},${hashDefinition(vbPackDefinition)},'active',now()
    ) ON CONFLICT (sport_code,version) DO NOTHING`;

    await sql`INSERT INTO competitions(
      id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,
      venue,address,locality,country_code,locale,plan_tier
    ) VALUES(
      ${competition},${organisation},${account},'Volleyball Masters',${`vb-${competition}`},'volleyball',
      'Asia/Singapore','2027-04-01','2027-04-02','Arena','Court Rd','Singapore','SG','en-SG','organiser_pro'
    )`;

    await sql`INSERT INTO competition_sport_settings(
      competition_id,updated_by,sport_code,pack_version,pack_schema_version,recommended_snapshot,settings_override
    ) VALUES(
      ${competition},${account},'volleyball','1.0.0',1,
      ${sql.json({ bestOf: 5, slotMinutes: 90 })},'{}'::jsonb
    )`;

    await sql`INSERT INTO playing_areas(id,competition_id,name,slot_minutes)
      VALUES(${area},${competition},'Court A',90)`;
    await sql`INSERT INTO competition_availability_windows(
      competition_id,playing_area_id,starts_at,ends_at
    ) VALUES(${competition},${area},'2027-04-01T00:00:00Z','2027-04-01T03:00:00Z')`;

    const [seed1] = await sql<{ value: { capacity: { effective: { slotMinutes: number } } } }[]>`
      SELECT phase4_setup_seed_values(${competition}) value`;
    expect(seed1?.value.capacity.effective.slotMinutes).toBe(90);

    // Now override slotMinutes to 45
    await sql`UPDATE playing_areas SET slot_minutes=45 WHERE id=${area}`;
    await sql`UPDATE competition_sport_settings
      SET settings_override=${sql.json({ slotMinutes: 45 })},revision=revision+1
      WHERE competition_id=${competition}`;

    const [seed2] = await sql<{ value: { capacity: { effective: { slotMinutes: number } } } }[]>`
      SELECT phase4_setup_seed_values(${competition}) value`;
    expect(seed2?.value.capacity.effective.slotMinutes).toBe(45);
  });

  it("ensures in-flight setup drafts are not flagged stale or rejected when seeded values are re-read", async () => {
    const [row] = await sql<
      {
        organisation_id: string;
        competition_id: string;
        created_by: string;
      }[]
    >`SELECT organisation_id,competition_id,created_by
      FROM setup_drafts ORDER BY created_at DESC LIMIT 1`;
    if (!row) throw new Error("Expected seeded setup draft");

    // Reading or refreshing the draft after migration does not fail or mark stale
    const [refreshed] = await sql<{ value: Record<string, unknown> }[]>`
      SELECT phase4_resume_setup_draft(
        ${row.organisation_id},${row.competition_id},${row.created_by},'resume-inflight','resume-inflight-req'
      ) value`;
    expect(refreshed?.value).toBeDefined();
    expect(refreshed?.value.stale).toBeFalsy();
  });

  it("preserves archived competition immutability when seed values are computed", async () => {
    const account = randomUUID();
    const organisation = randomUUID();
    const competition = randomUUID();

    await sql`INSERT INTO accounts(id,primary_email,display_name)
      VALUES(${account},${`${account}@example.test`},'Archived organiser')`;
    await sql.begin(async (tx) => {
      await tx`INSERT INTO organisations(id,name,slug)
        VALUES(${organisation},'Archived organisation',${`arch-${organisation}`})`;
      await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
        VALUES(${organisation},${account},'owner','active')`;
    });

    await sql`INSERT INTO competitions(
      id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,
      venue,address,locality,country_code,locale,plan_tier,status
    ) VALUES(
      ${competition},${organisation},${account},'Archived Open',${`arch-${competition}`},'badminton',
      'Asia/Singapore','2026-01-01','2026-01-02','Arena','Court Rd','Singapore','SG','en-SG','organiser_pro',
      'draft'
    )`;

    await sql`INSERT INTO competition_sport_settings(
      competition_id,updated_by,sport_code,pack_version,pack_schema_version,recommended_snapshot,settings_override
    ) VALUES(
      ${competition},${account},'badminton','test-1',1,
      ${sql.json({ bestOf: 3, targetPoints: 21 })},'{}'::jsonb
    )`;

    await sql`UPDATE competitions
      SET status='archived',archived_from_status='draft',archived_at=now()
      WHERE id=${competition}`;

    // Calling phase4_setup_seed_values on archived competition should succeed without triggering any mutation
    const [seed] = await sql<{ value: { basics: { sport_code: string; name: string } } }[]>`
      SELECT phase4_setup_seed_values(${competition}) value`;
    expect(seed?.value.basics.name).toBe("Archived Open");

    // Verify competition remains archived
    const [comp] = await sql<{ status: string }[]>`
      SELECT status FROM competitions WHERE id=${competition}`;
    expect(comp?.status).toBe("archived");
  });
});
