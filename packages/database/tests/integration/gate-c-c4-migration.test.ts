import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
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
  it("upgrades populated C4 repair history through 0040 and 0041 without rewriting C3 audit or outbox bytes", async () => {
    const copiedDirectory = await mkdtemp(path.join(os.tmpdir(), "matchday-gate-c-c4-upgrade-"));
    const migrationNames = [
      "0040_gate_c_atomic_result_repair_cases.sql",
      "0041_gate_c_assign_result_repair_parent.sql",
    ] as const;
    const upgradeSchema = `test_gate_c_c4_upgrade_${randomUUID().replaceAll("-", "")}`;
    await cp(migrationsDirectory, copiedDirectory, { recursive: true });
    const migrations = await Promise.all(
      migrationNames.map(async (name) => {
        const migrationPath = path.join(copiedDirectory, name);
        return { migrationPath, name, source: await readFile(migrationPath, "utf8") };
      }),
    );
    await Promise.all(migrations.map(({ migrationPath }) => rm(migrationPath)));
    await migrateDatabase({
      databaseUrl: config.databaseUrl,
      migrationsDirectory: copiedDirectory,
      schema: upgradeSchema,
    });
    const sql = postgres(config.databaseUrl, {
      max: 1,
      prepare: false,
      connection: { search_path: upgradeSchema },
    });
    try {
      const accountId = randomUUID();
      const organisationId = randomUUID();
      const competitionId = randomUUID();
      const divisionId = randomUUID();
      const formatRevisionId = randomUUID();
      const matchId = randomUUID();
      const correctionTransactionId = randomUUID();
      const repairCaseId = randomUUID();
      const fingerprint = "a".repeat(64);
      const outboxKey = `c4-history-${randomUUID()}`;
      const auditRequestId = `c4-history-audit-${randomUUID()}`;

      await sql.begin(async (tx) => {
        await tx`INSERT INTO accounts(id,primary_email,display_name)
          VALUES(${accountId},${`${accountId}@example.test`},'C4 upgrade owner')`;
        await tx`INSERT INTO organisations(id,name,slug)
          VALUES(${organisationId},'C4 upgrade org',${`c4-upgrade-${organisationId}`})`;
        await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
          VALUES(${organisationId},${accountId},'owner','active')`;
      });
      await sql`INSERT INTO competitions(id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,plan_tier)
        VALUES(${competitionId},${organisationId},${accountId},'C4 Upgrade Cup',${`c4-upgrade-cup-${competitionId}`},'badminton',
          'Asia/Singapore','2027-02-01','2027-02-01','organiser_pro')`;
      await sql`INSERT INTO divisions(id,competition_id,name,team_limit) VALUES(${divisionId},${competitionId},'Open',16)`;
      const pack = { recommendedSlotMinutes: 20, recommendedSettings: { slotMinutes: 20 } };
      const [packHash] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(pack)}) hash`;
      await sql`INSERT INTO sport_pack_versions(sport_code,version,schema_version,definition,definition_hash,status,activated_at)
        VALUES('badminton','c4-upgrade-1',1,${sql.json(pack)},${packHash!.hash},'active',now())`;
      const definition = {
        id: formatRevisionId,
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
      const [definitionHash] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(definition)}) hash`;
      await sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,status,created_by)
        VALUES(${formatRevisionId},${competitionId},${divisionId},1,${sql.json(definition)},${definitionHash!.hash},'draft',${accountId})`;
      await sql`INSERT INTO matches(id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal)
        VALUES(${matchId},${competitionId},${divisionId},${formatRevisionId},'M1','final',1,1)`;
      await sql`INSERT INTO match_score_streams(
        match_id,competition_id,division_id,sport_code,pack_version,settings_snapshot,settings_fingerprint
      ) VALUES(${matchId},${competitionId},${divisionId},'badminton','c4-upgrade-1',${sql.json({})},${fingerprint})`;
      await sql`INSERT INTO score_correction_transactions(
        id,competition_id,division_id,match_id,client_event_id,command_fingerprint,reason,
        from_aggregate_version,through_aggregate_version,result_version,actor_account_id
      ) VALUES(${correctionTransactionId},${competitionId},${divisionId},${matchId},${randomUUID()},${fingerprint},'Upgrade correction',
        0,1,1,${accountId})`;
      await sql`INSERT INTO schedule_repair_cases(
        id,competition_id,corrected_division_id,corrected_match_id,correction_transaction_id,
        source_result_version,source_schedule_version,source_projection_version,analysis_fingerprint,
        analysis_fingerprint_input,created_by_account_id
      ) VALUES(${repairCaseId},${competitionId},${divisionId},${matchId},${correctionTransactionId},
        1,0,0,${fingerprint},'upgrade repair analysis',${accountId})`;
      await sql`INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
        VALUES('match','c4-upgrade-history','scoring_event.appended',to_jsonb(${JSON.stringify({ match_id: matchId })}::text),${outboxKey})`;
      await sql`INSERT INTO audit_events(
        request_id,actor_type,organisation_id,action,target_type,target_id,before_state,after_state
      ) VALUES(${auditRequestId},'system',${organisationId},'scoring_event.appended','match','c4-upgrade-history',
        to_jsonb(${"before"}::text),to_jsonb(${"after"}::text))`;
      const [before] = await sql<{ payload: string; before_state: string; after_state: string }[]>`
        SELECT outbox.payload::text payload,audit.before_state::text before_state,audit.after_state::text after_state
        FROM outbox_events outbox JOIN audit_events audit ON audit.request_id=${auditRequestId}
        WHERE outbox.idempotency_key=${outboxKey}
      `;
      if (!before) throw new Error("Expected retained C3 audit and outbox fixture");

      await Promise.all(migrations.map(({ migrationPath, source }) => writeFile(migrationPath, source)));
      const upgraded = await migrateDatabase({
        databaseUrl: config.databaseUrl,
        migrationsDirectory: copiedDirectory,
        schema: upgradeSchema,
      });
      expect(upgraded.applied).toEqual([...migrationNames]);
      const [after] = await sql<{ payload: string; before_state: string; after_state: string }[]>`
        SELECT outbox.payload::text payload,audit.before_state::text before_state,audit.after_state::text after_state
        FROM outbox_events outbox JOIN audit_events audit ON audit.request_id=${auditRequestId}
        WHERE outbox.idempotency_key=${outboxKey}
      `;
      expect(after).toEqual(before);
      expect(createHash("sha256").update(JSON.stringify(after)).digest("hex")).toBe(
        createHash("sha256").update(JSON.stringify(before)).digest("hex"),
      );
      const [resultCase] = await sql<{ id: string }[]>`
        SELECT id FROM result_repair_cases WHERE correction_transaction_id=${correctionTransactionId}
      `;
      expect(resultCase?.id).toBeTruthy();
      expect(
        await sql<{ result_repair_case_id: string }[]>`
          SELECT result_repair_case_id FROM schedule_repair_cases WHERE id=${repairCaseId}
        `,
      ).toEqual([{ result_repair_case_id: resultCase!.id }]);
      expect(
        await sql<{ event_type: string }[]>`
          SELECT event_type FROM result_repair_case_events WHERE result_repair_case_id=${resultCase!.id} ORDER BY event_type
        `,
      ).toEqual([{ event_type: "analysis_ready" }, { event_type: "created" }]);
    } finally {
      await sql.end({ timeout: 2 });
      await rm(copiedDirectory, { recursive: true, force: true });
      await dropTestSchema(config.databaseUrl, upgradeSchema);
    }
  }, 30_000);

  it("adds immutable division-scoped public truth and export metadata without mutating retained history", async () => {
    const result = await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory, schema });
    expect(result.current).toContain("0033_gate_c_repair_public_truth_exports.sql");
    expect(result.current).toContain("0036_z_gate_c_repair_append_only_compatibility.sql");
    expect(result.current).toContain("0040_gate_c_atomic_result_repair_cases.sql");
    expect(result.current).toContain("0041_gate_c_assign_result_repair_parent.sql");

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
      const siblingDivisionId = randomUUID();
      const otherCompetitionId = randomUUID();
      const formatRevisionId = randomUUID();
      const matchId = randomUUID();
      const correctionTransactionId = randomUUID();
      const repairCaseId = randomUUID();
      const scheduleRevisionId = randomUUID();
      const fingerprint = "f".repeat(64);
      const firstEntryId = randomUUID();
      const secondEntryId = randomUUID();
      await sql`INSERT INTO accounts(id,primary_email,display_name)
        VALUES(${accountId},${`${accountId}@example.test`},'C4 migration owner')`;
      await sql.begin(async (tx) => {
        await tx`INSERT INTO organisations(id,name,slug)
          VALUES(${organisationId},'C4 migration organisation',${`c4-${organisationId}`})`;
        await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
          VALUES(${organisationId},${accountId},'owner','active')`;
      });
      await sql`INSERT INTO competitions(id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,plan_tier,status)
        VALUES(${competitionId},${organisationId},${accountId},'C4 Cup',${`c4-cup-${competitionId}`},'badminton',
          'Asia/Singapore','2027-01-01','2027-01-01','organiser_pro','active')`;
      await sql`INSERT INTO competitions(id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,plan_tier)
        VALUES(${otherCompetitionId},${organisationId},${accountId},'Other C4 Cup',${`other-c4-${otherCompetitionId}`},'badminton',
          'Asia/Singapore','2027-01-01','2027-01-01','organiser_pro')`;
      await sql`INSERT INTO divisions(id,competition_id,name,team_limit)
        VALUES(${divisionId},${competitionId},'Open',16)`;
      await sql`INSERT INTO divisions(id,competition_id,name,team_limit)
        VALUES(${siblingDivisionId},${competitionId},'Reserve',16)`;
      await sql`INSERT INTO division_entries(id,division_id,name,seed,entry_type,status) VALUES
        (${firstEntryId},${divisionId},'First entry',1,'placeholder','confirmed'),
        (${secondEntryId},${divisionId},'Second entry',2,'placeholder','confirmed')`;
      const pack = { recommendedSlotMinutes: 20, recommendedSettings: { slotMinutes: 20 } };
      const [packHash] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(pack)}) hash`;
      await sql`INSERT INTO sport_pack_versions(sport_code,version,schema_version,definition,definition_hash,status,activated_at)
        VALUES('badminton','c4-migration-1',1,${sql.json(pack)},${packHash!.hash},'active',now())`;
      const definition = {
        id: formatRevisionId,
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
      const [definitionHash] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(definition)}) hash`;
      await sql`INSERT INTO format_revisions(
        id,competition_id,division_id,revision,definition,definition_hash,status,created_by
      ) VALUES(
        ${formatRevisionId},${competitionId},${divisionId},1,${sql.json(definition)},${definitionHash!.hash},'draft',${accountId}
      )`;
      await sql`INSERT INTO matches(id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal)
        VALUES(${matchId},${competitionId},${divisionId},${formatRevisionId},'M1','final',1,1)`;
      await sql`INSERT INTO match_score_streams(
        match_id,competition_id,division_id,sport_code,pack_version,settings_snapshot,settings_fingerprint
      ) VALUES(
        ${matchId},${competitionId},${divisionId},'badminton','c4-migration-1',${sql.json({})},${fingerprint}
      )`;
      await sql`INSERT INTO score_correction_transactions(
        id,competition_id,division_id,match_id,client_event_id,command_fingerprint,reason,
        from_aggregate_version,through_aggregate_version,result_version,actor_account_id
      ) VALUES(
        ${correctionTransactionId},${competitionId},${divisionId},${matchId},${randomUUID()},${fingerprint},'Correction reason',
        0,1,1,${accountId}
      )`;
      const [resultRepairCase] = await sql<{ id: string }[]>`
        SELECT id FROM result_repair_cases
        WHERE correction_transaction_id=${correctionTransactionId}
          AND competition_id=${competitionId}
          AND division_id=${divisionId}
          AND corrected_match_id=${matchId}
          AND source_result_version=1
      `;
      expect(resultRepairCase?.id).toBeTruthy();
      expect(
        await sql<{ event_type: string }[]>`
          SELECT event_type FROM result_repair_case_events
          WHERE result_repair_case_id=${resultRepairCase!.id}
          ORDER BY event_type
        `,
      ).toEqual([{ event_type: "created" }]);
      expect(
        await sql<{ action: string; event_type: string }[]>`
          SELECT audit.action,outbox.event_type
          FROM audit_events audit
          JOIN outbox_events outbox ON outbox.aggregate_id=${resultRepairCase!.id}::text
          WHERE audit.target_id=${resultRepairCase!.id}::text
        `,
      ).toEqual([{ action: "result_repair_case.created", event_type: "result_repair_case.created" }]);
      await sql`INSERT INTO schedule_repair_cases(
        id,competition_id,corrected_division_id,corrected_match_id,correction_transaction_id,
        source_result_version,source_schedule_version,source_projection_version,analysis_fingerprint,
        analysis_fingerprint_input,created_by_account_id
      ) VALUES(
        ${repairCaseId},${competitionId},${divisionId},${matchId},${correctionTransactionId},
        1,0,0,${fingerprint},'canonical repair analysis',${accountId}
      )`;
      expect(
        await sql<{ result_repair_case_id: string }[]>`
          SELECT result_repair_case_id FROM schedule_repair_cases WHERE id=${repairCaseId}
        `,
      ).toEqual([{ result_repair_case_id: resultRepairCase!.id }]);
      expect(
        await sql<{ event_type: string }[]>`
          SELECT event_type FROM result_repair_case_events
          WHERE result_repair_case_id=${resultRepairCase!.id}
          ORDER BY event_type
        `,
      ).toEqual([{ event_type: "analysis_ready" }, { event_type: "created" }]);
      await expect(sql`DELETE FROM result_repair_cases WHERE id=${resultRepairCase!.id}`).rejects.toThrow(
        /append-only/i,
      );
      await expect(
        sql`DELETE FROM result_repair_case_events WHERE result_repair_case_id=${resultRepairCase!.id}`,
      ).rejects.toThrow(/append-only/i);

      async function expectAtomicRepairIntakeRollback(label: "repair case" | "audit" | "outbox"): Promise<void> {
        const failedCorrectionId = randomUUID();
        const resultVersion = label === "repair case" ? 2 : label === "audit" ? 3 : 4;
        const failingFunction = `gate_c4_fail_${label.replaceAll(" ", "_")}_intake`;
        const failingTrigger = `${failingFunction}_trigger`;
        const targetTable =
          label === "repair case" ? "result_repair_cases" : label === "audit" ? "audit_events" : "outbox_events";
        const condition =
          label === "audit"
            ? " WHEN (NEW.action = 'result_repair_case.created')"
            : label === "outbox"
              ? " WHEN (NEW.event_type = 'result_repair_case.created')"
              : "";

        await sql.unsafe(`
          CREATE FUNCTION ${failingFunction}() RETURNS trigger AS $$
          BEGIN
            RAISE EXCEPTION 'forced ${label} intake failure';
          END;
          $$ LANGUAGE plpgsql;
          CREATE TRIGGER ${failingTrigger}
          BEFORE INSERT ON ${targetTable}
          FOR EACH ROW${condition} EXECUTE FUNCTION ${failingFunction}();
        `);
        try {
          await expect(
            sql`INSERT INTO score_correction_transactions(
              id,competition_id,division_id,match_id,client_event_id,command_fingerprint,reason,
              from_aggregate_version,through_aggregate_version,result_version,actor_account_id
            ) VALUES(
              ${failedCorrectionId},${competitionId},${divisionId},${matchId},${randomUUID()},${fingerprint},'Forced rollback',
              0,${resultVersion},${resultVersion},${accountId}
            )`,
          ).rejects.toThrow(`forced ${label} intake failure`);
        } finally {
          await sql.unsafe(`DROP TRIGGER IF EXISTS ${failingTrigger} ON ${targetTable};`);
          await sql.unsafe(`DROP FUNCTION IF EXISTS ${failingFunction}();`);
        }

        expect(
          await sql<{ count: string }[]>`
            SELECT count(*)::text count FROM score_correction_transactions WHERE id=${failedCorrectionId}
          `,
        ).toEqual([{ count: "0" }]);
        expect(
          await sql<{ count: string }[]>`
            SELECT count(*)::text count FROM result_repair_cases WHERE correction_transaction_id=${failedCorrectionId}
          `,
        ).toEqual([{ count: "0" }]);
        expect(
          await sql<{ count: string }[]>`
            SELECT count(*)::text count
            FROM audit_events
            WHERE request_id=${`correction-repair-case:${failedCorrectionId}`}
          `,
        ).toEqual([{ count: "0" }]);
        expect(
          await sql<{ count: string }[]>`
            SELECT count(*)::text count FROM outbox_events
            WHERE payload->>'correction_transaction_id'=${failedCorrectionId}
          `,
        ).toEqual([{ count: "0" }]);
      }

      await expectAtomicRepairIntakeRollback("repair case");
      await expectAtomicRepairIntakeRollback("audit");
      await expectAtomicRepairIntakeRollback("outbox");

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
          SELECT proc.proname
          FROM pg_proc proc
          JOIN pg_namespace namespace ON namespace.oid=proc.pronamespace
          WHERE proc.proname='gate_c_append_schedule_repair_revision' AND namespace.nspname=current_schema()
        `,
      ).toEqual([{ proname: "gate_c_append_schedule_repair_revision" }]);
      expect(
        await sql<{ tgname: string }[]>`
          SELECT tgname FROM pg_trigger
          WHERE tgrelid IN (
            'schedule_repair_cases'::regclass,
            'schedule_repair_revisions'::regclass,
            'schedule_repair_actions'::regclass,
            'schedule_repair_decisions'::regclass,
            'schedule_repair_publication_receipts'::regclass,
            'public_projection_versions'::regclass,
            'competition_export_manifests'::regclass
          )
            AND tgname LIKE '%_immutable'
          ORDER BY tgname
        `,
      ).toHaveLength(7);

      const appendRevision = (parentRevisionId: string | null) =>
        sql<{ id: string; revision: number }[]>`
          SELECT id,revision FROM gate_c_append_schedule_repair_revision(
            ${repairCaseId},1,0,${fingerprint},${parentRevisionId},'draft',${null},${accountId}
          )
        `;
      const [firstRevision] = await appendRevision(null);
      expect(firstRevision?.revision).toBe(1);
      await sql`INSERT INTO schedule_revisions(
        id,competition_id,format_revision_id,revision,input_hash,created_by
      ) VALUES(${scheduleRevisionId},${competitionId},${formatRevisionId},1,${"9".repeat(64)},${accountId})`;
      const [sourcedProjection] = await sql<{ id: string }[]>`
        INSERT INTO public_projection_versions(
          competition_id,division_id,schedule_version,result_version,projection_version,source_repair_revision_id,
          projection,projection_fingerprint,etag,generated_at,source_updated_at
        ) VALUES(
          ${competitionId},${divisionId},2,2,2,${firstRevision!.id},${sql.json({ division: "Open", repaired: true })},
          ${"c".repeat(64)},'"c4-open-v2"','2027-01-01T02:00:00Z','2027-01-01T01:00:00Z'
        ) RETURNING id
      `;
      const [publicationReceipt] = await sql<{ id: string }[]>`
        INSERT INTO schedule_repair_publication_receipts(
          competition_id,repair_case_id,repair_revision_id,request_fingerprint,idempotency_key,schedule_revision_id,
          schedule_version,result_version,analysis_fingerprint,response,published_by_account_id
        ) VALUES(
          ${competitionId},${repairCaseId},${firstRevision!.id},${fingerprint},${`c4-${repairCaseId}`},${scheduleRevisionId},
          2,2,${fingerprint},${sql.json({})},${accountId}
        ) RETURNING id
      `;
      await expect(
        sql`INSERT INTO schedule_repair_publication_projection_versions(
          publication_receipt_id,competition_id,division_id,public_projection_version_id
        ) VALUES(${publicationReceipt!.id},${competitionId},${divisionId},${projection!.id})`,
      ).rejects.toThrow(/receipt repair revision/i);
      await sql`INSERT INTO schedule_repair_publication_projection_versions(
        publication_receipt_id,competition_id,division_id,public_projection_version_id
      ) VALUES(${publicationReceipt!.id},${competitionId},${divisionId},${sourcedProjection!.id})`;
      const [action] = await sql<{ id: string }[]>`
        INSERT INTO schedule_repair_actions(
          repair_revision_id,repair_case_id,competition_id,ordinal,match_id,division_id,slot,
          source_action,dependency_path,reason
        ) VALUES(
          ${firstRevision!.id},${repairCaseId},${competitionId},1,${matchId},${divisionId},'home',
          'no_change',${sql.json([])},'No repair required for this slot'
        ) RETURNING id
      `;
      const [decision] = await sql<{ id: string }[]>`
        INSERT INTO schedule_repair_decisions(
          repair_action_id,repair_revision_id,repair_case_id,competition_id,match_id,division_id,slot,
          decision,reason,client_event_id,request_fingerprint,decided_by_account_id
        ) VALUES(
          ${action!.id},${firstRevision!.id},${repairCaseId},${competitionId},${matchId},${divisionId},'home',
          'keep_current','Keep the current slot',${randomUUID()},${fingerprint},${accountId}
        ) RETURNING id
      `;
      await expect(sql`DELETE FROM schedule_repair_cases WHERE id=${repairCaseId}`).rejects.toThrow(/append-only/i);
      await expect(sql`DELETE FROM schedule_repair_revisions WHERE id=${firstRevision!.id}`).rejects.toThrow(
        /append-only/i,
      );
      await expect(sql`DELETE FROM schedule_repair_actions WHERE id=${action!.id}`).rejects.toThrow(/append-only/i);
      await expect(sql`DELETE FROM schedule_repair_decisions WHERE id=${decision!.id}`).rejects.toThrow(/append-only/i);
      await expect(
        sql`INSERT INTO schedule_repair_revisions(
          repair_case_id,competition_id,revision,parent_revision_id,status,
          source_result_version,source_schedule_version,source_projection_version,
          analysis_fingerprint,created_by_account_id
        ) VALUES(
          ${repairCaseId},${competitionId},3,${firstRevision!.id},'draft',
          1,0,0,${fingerprint},${accountId}
        )`,
      ).rejects.toThrow(/contiguous/i);
      await expect(
        sql`INSERT INTO schedule_repair_revisions(
          repair_case_id,competition_id,revision,parent_revision_id,status,
          source_result_version,source_schedule_version,source_projection_version,
          analysis_fingerprint,created_by_account_id
        ) VALUES(
          ${repairCaseId},${competitionId},2,${firstRevision!.id},'draft',
          2,0,0,${fingerprint},${accountId}
        )`,
      ).rejects.toThrow(/immutable repair case/i);
      await expect(
        sql`INSERT INTO public_projection_versions(
          competition_id,division_id,schedule_version,result_version,projection_version,
          source_repair_revision_id,projection,projection_fingerprint,etag,generated_at,source_updated_at
        ) VALUES(
          ${competitionId},${siblingDivisionId},1,2,1,${firstRevision!.id},${sql.json({ division: "Reserve" })},
          ${"b".repeat(64)},'"c4-reserve-v1"','2027-01-01T01:00:00Z','2027-01-01T01:00:00Z'
        )`,
      ).rejects.toThrow(/division is not affected/i);

      await sql`INSERT INTO public_projection_versions(
        competition_id,division_id,schedule_version,result_version,projection_version,
        projection,projection_fingerprint,etag,generated_at,source_updated_at
      ) VALUES(
        ${competitionId},${siblingDivisionId},2,2,1,${sql.json({ division: "Reserve", repaired: false })},
        ${"e".repeat(64)},'c4-reserve-v2','2027-01-01T02:00:00Z','2027-01-01T01:00:00Z'
      )`;
      await sql`INSERT INTO competition_publications(
        competition_id,schedule_version,result_version,updated_at
      ) VALUES(${competitionId},2,2,'2027-01-01T01:00:00Z')`;
      await sql`INSERT INTO public_competition_projections(
        competition_id,schedule_version,result_version,projection,generated_at
      ) VALUES(
        ${competitionId},2,2,
        ${sql.json({
          competition: {
            id: competitionId,
            name: "C4 Cup",
            slug: `c4-cup-${competitionId}`,
            sport_code: "badminton",
            timezone: "Asia/Singapore",
            starts_on: "2027-01-01",
            ends_on: "2027-01-01",
            status: "active",
          },
          divisions: [
            { division: { id: divisionId, name: "Open" }, schedule: [], results: [], standings: null, bracket: null },
            {
              division: { id: siblingDivisionId, name: "Reserve" },
              schedule: [],
              results: [],
              standings: null,
              bracket: null,
            },
          ],
          division: { id: divisionId, name: "Open" },
          publication: { schedule_version: 2, result_version: 2 },
          schedule: [],
          results: [],
          standings: null,
          bracket: null,
          last_updated_at: "2027-01-01T01:00:00.000Z",
        })},
        '2027-01-01T02:00:00Z'
      )`;
      const [publicTruth] = await sql<
        {
          projection_versions: Record<string, number>;
          projection_version: number;
        }[]
      >`
        SELECT COALESCE((
          SELECT jsonb_object_agg(version.division_id::text, version.projection_version)
          FROM (
            SELECT division_id,max(projection_version)::integer AS projection_version
            FROM public_projection_versions
            WHERE competition_id=${competitionId} AND schedule_version=2 AND result_version=2
            GROUP BY division_id
          ) version
        ),'{}'::jsonb) AS projection_versions,
        COALESCE((
          SELECT max(projection_version)::integer
          FROM public_projection_versions
          WHERE competition_id=${competitionId} AND schedule_version=2 AND result_version=2
        ),1) AS projection_version
      `;
      expect(publicTruth).toEqual({
        projection_versions: { [divisionId]: 2, [siblingDivisionId]: 1 },
        projection_version: 2,
      });

      const concurrentSql = postgres(config.databaseUrl, {
        max: 1,
        prepare: false,
        connection: { search_path: schema },
      });
      try {
        const secondAttempt = appendRevision(firstRevision!.id);
        const staleConcurrentAttempt = concurrentSql<{ id: string; revision: number }[]>`
          SELECT id,revision FROM gate_c_append_schedule_repair_revision(
            ${repairCaseId},1,0,${fingerprint},${firstRevision!.id},'draft',${null},${accountId}
          )
        `;
        const results = await Promise.allSettled([secondAttempt, staleConcurrentAttempt]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        const fulfilled = results.find((result) => result.status === "fulfilled");
        if (!fulfilled || fulfilled.status !== "fulfilled") {
          throw new Error("one concurrent repair revision append must succeed");
        }
        expect(fulfilled.value[0]?.revision).toBe(2);
        await expect(
          sql`SELECT id FROM gate_c_append_schedule_repair_revision(
            ${repairCaseId},2,0,${fingerprint},${fulfilled!.value[0]!.id},'draft',${null},${accountId}
          )`,
        ).rejects.toThrow(/stale/i);
      } finally {
        await concurrentSql.end({ timeout: 2 });
      }
    } finally {
      await sql.end({ timeout: 2 });
    }
  }, 30_000);
});
