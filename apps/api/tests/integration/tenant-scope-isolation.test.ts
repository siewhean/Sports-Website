import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import type { PostgresJsSql } from "@matchday/identity";
import type { ScheduleEnqueuePort } from "@matchday/scheduler";
import postgres, { type Sql } from "postgres";
import { phase3DomainAdapter } from "../../src/phase-3-domain-adapter.js";
import { Phase3Runtime, type Phase3CapacityReplaceInput } from "../../src/phase-3-runtime.js";
import { Phase4Runtime, type Phase4AiOptions } from "../../src/phase-4-runtime.js";
import { PublishedExportRuntime } from "../../src/published-export-runtime.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_tenant_scope_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);

const ai: Phase4AiOptions = {
  mode: "disabled",
  provider: null,
  timeoutMs: 1_000,
  maximumAttempts: 1,
  cacheTtlSeconds: 60,
};

function required<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (!row) throw new Error("Expected a database row");
  return row;
}

describeInfrastructure("cross-tenant child-id isolation", () => {
  let client!: Sql;
  let phase3!: Phase3Runtime;
  let phase4!: Phase4Runtime;
  let exports!: PublishedExportRuntime;

  // Attacker owns org A / competition A; victim owns org B / competition B.
  let attacker!: { accountId: string };
  let victim!: { accountId: string };
  let attackerOrg!: string;
  let attackerCompetition!: string;
  let victimCompetition!: string;
  let victimDivision!: string;
  let attackerDivision!: string;

  const bootstrap = async (label: string) => {
    const accountId = required(
      await client<{ id: string }[]>`
        INSERT INTO accounts(primary_email,display_name,email_verified_at)
        VALUES(${`${label}-${randomUUID()}@tenant-scope.test`},${label},now()) RETURNING id`,
    ).id;
    // organisations_require_owner is deferred, so the owner membership must commit with the organisation.
    const organisationId = randomUUID();
    await client.begin(async (tx) => {
      await tx`INSERT INTO organisations(id,name,slug) VALUES(${organisationId},${`${label} Org`},${`${label}-${randomUUID()}`})`;
      await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
        VALUES(${organisationId},${accountId},'owner','active')`;
    });
    const competition = await phase3.createCompetition(
      { accountId },
      {
        organisationId,
        name: `${label} Cup`,
        slug: `${label}-cup-${randomUUID()}`,
        sportCode: "canoe_polo",
        venue: "Test Arena",
        address: "1 Test Road",
        countryCode: "SG",
        startsOn: "2027-08-01",
        endsOn: "2027-08-02",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
    );
    const divisionId = required(
      await client<{ id: string }[]>`
        INSERT INTO divisions(competition_id,name,team_limit) VALUES(${competition.id},${`${label} division`},8)
        RETURNING id`,
    ).id;
    return { account: { accountId }, organisationId, competitionId: competition.id, divisionId };
  };

  beforeAll(async () => {
    await dropTestSchema(databaseUrl, schema);
    await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
    client = postgres(databaseUrl, { max: 6, onnotice: () => undefined, connection: { search_path: schema } });
    const sql = client as unknown as PostgresJsSql;
    phase3 = new Phase3Runtime(sql, phase3DomainAdapter);
    phase4 = new Phase4Runtime(sql, phase3, {} as unknown as ScheduleEnqueuePort, ai);
    exports = new PublishedExportRuntime(sql);

    const a = await bootstrap("attacker");
    const v = await bootstrap("victim");
    attacker = a.account;
    victim = v.account;
    attackerOrg = a.organisationId;
    attackerCompetition = a.competitionId;
    attackerDivision = a.divisionId;
    victimCompetition = v.competitionId;
    victimDivision = v.divisionId;

    // A draft format revision on the victim's division: the data the attacker must never see or lock.
    // Minimal structurally valid graph (the format_revisions trigger rejects empty graphs).
    const formatRevisionId = randomUUID();
    const finalMatchId = randomUUID();
    const graph = {
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
          matchIds: [finalMatchId],
        },
      ],
      matches: [
        {
          id: finalMatchId,
          stageId: "final-stage",
          round: 1,
          order: 1,
          purpose: "championship",
          home: { type: "entry_seed", seed: 1 },
          away: { type: "entry_seed", seed: 2 },
        },
      ],
      terminalMatchIds: [finalMatchId],
    };
    const [definitionHash] = await client<{ hash: string }[]>`SELECT phase4_sha256_json(${client.json(graph)}) AS hash`;
    await client`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract)
      VALUES(${formatRevisionId},${victimCompetition},${victimDivision},1,${client.json(graph)},${definitionHash!.hash},${victim.accountId},'phase3')`;
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 2 });
    await dropTestSchema(databaseUrl, schema);
  });

  it("readFormatBuilder: the owner reads their own division but a foreign division id yields a uniform 404", async () => {
    await expect(phase4.readFormatBuilder(attacker, attackerCompetition, attackerDivision)).resolves.toMatchObject({
      revisions: [],
      draft: null,
    });
    await expect(phase4.readFormatBuilder(attacker, attackerCompetition, victimDivision)).rejects.toMatchObject({
      statusCode: 404,
      code: "DIVISION_NOT_FOUND",
    });
    // Same response as a division that does not exist anywhere.
    await expect(phase4.readFormatBuilder(attacker, attackerCompetition, randomUUID())).rejects.toMatchObject({
      statusCode: 404,
      code: "DIVISION_NOT_FOUND",
    });
    // The victim can still read their own history.
    const own = await phase4.readFormatBuilder(victim, victimCompetition, victimDivision);
    expect(own.revisions).toHaveLength(1);
  });

  it("applyFormatTemplate: a foreign division gives the same 404 whatever its revision, with no revision oracle", async () => {
    const attempt = (divisionId: string, expected: number | null) =>
      phase4.applyFormatTemplate(
        attacker,
        attackerOrg,
        {
          competition_id: attackerCompetition,
          division_id: divisionId,
          template_version_id: randomUUID(),
          expected_format_revision: expected,
          idempotency_key: `scope-${randomUUID()}`,
        },
        randomUUID(),
      );
    const foreign = await attempt(victimDivision, 99).catch((error: unknown) => error);
    const missing = await attempt(randomUUID(), 99).catch((error: unknown) => error);
    expect(foreign).toMatchObject({ statusCode: 404, code: "DIVISION_NOT_FOUND" });
    expect(missing).toMatchObject({ statusCode: 404, code: "DIVISION_NOT_FOUND" });
    expect((foreign as Error).message).toBe((missing as Error).message);
  });

  it("recalculateStandings: foreign and missing divisions are indistinguishable 404s", async () => {
    await expect(
      phase3.recalculateStandings(attacker, attackerCompetition, victimDivision, randomUUID()),
    ).rejects.toMatchObject({ statusCode: 404, code: "DIVISION_NOT_FOUND" });
    await expect(
      phase3.recalculateStandings(attacker, attackerCompetition, randomUUID(), randomUUID()),
    ).rejects.toMatchObject({ statusCode: 404, code: "DIVISION_NOT_FOUND" });
  });

  it("AI routes reject foreign division and repair-case ids before charging or recording anything", async () => {
    const text = "tighten the schedule";
    await expect(
      phase4.formatModify(
        attacker,
        attackerOrg,
        attackerCompetition,
        victimDivision,
        { idempotency_key: `ai-${randomUUID()}`, text, current_document: {} as never },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "DIVISION_NOT_FOUND" });
    await expect(
      phase4.schedulePreferences(
        attacker,
        attackerOrg,
        attackerCompetition,
        victimDivision,
        { idempotency_key: `ai-${randomUUID()}`, text } as never,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "DIVISION_NOT_FOUND" });
    await expect(
      phase4.repairRecommendations(
        attacker,
        attackerOrg,
        attackerCompetition,
        randomUUID(),
        { idempotency_key: `ai-${randomUUID()}`, text },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "REPAIR_CASE_NOT_FOUND" });
    const ledger = required(await client<{ count: number }[]>`SELECT count(*)::int count FROM ai_action_ledger`);
    expect(ledger.count).toBe(0);
  });

  it("exports: a signed-in non-member cannot read an unpublished competition; its organiser can", async () => {
    for (const read of [
      () => exports.generateCompetitionCsv(victimCompetition, attacker),
      () => exports.generateStandingsCsv(victimCompetition, attacker),
      () => exports.generateBracketCsv(victimCompetition, attacker),
      () => exports.generateCompetitionJson(victimCompetition, attacker),
      () => exports.generateAuditHistoryExport(attacker, victimCompetition),
    ]) {
      await expect(read()).rejects.toMatchObject({ statusCode: 403 });
    }
    await expect(exports.generateCompetitionJson(victimCompetition, victim)).resolves.toMatchObject({
      competition: { id: victimCompetition },
    });
  });

  describe("replaceCapacity: playing-area and window ids are scoped to the competition", () => {
    const window = { date: "2027-08-01", startTime: "09:00", endTime: "12:00" };
    let victimArea!: {
      id: string;
      name: string;
      sort_order: number;
      slot_minutes: number;
      fixed_reserve_slots: number;
    };
    let victimWindowId!: string;
    let attackerRevision = 1;

    const victimRows = async () => ({
      area: required(
        await client<
          {
            id: string;
            competition_id: string;
            name: string;
            sort_order: number;
            slot_minutes: number;
            fixed_reserve_slots: number;
          }[]
        >`SELECT id,competition_id,name,sort_order,slot_minutes,fixed_reserve_slots FROM playing_areas WHERE id=${victimArea.id}`,
      ),
      windows: await client<{ id: string; competition_id: string; playing_area_id: string }[]>`
        SELECT id,competition_id,playing_area_id FROM competition_availability_windows WHERE competition_id=${victimCompetition}
        ORDER BY id`,
    });

    // Run an attacker capacity replace and reduce the outcome to what the caller can observe, minus the
    // ids the server assigns, so a foreign id and a random id can be compared for equality.
    const attempt = async (input: Omit<Phase3CapacityReplaceInput, "revision">, suppliedIds: readonly string[]) => {
      try {
        const result = await phase3.replaceCapacity(
          attacker,
          attackerCompetition,
          { revision: attackerRevision, ...input },
          randomUUID(),
        );
        attackerRevision = result.revision;
        const returnedIds = [
          ...result.areas.map((area) => area.id),
          ...result.areas.flatMap((area) => [...area.availability, ...area.unavailable].map((value) => value.id)),
        ];
        return {
          ok: true as const,
          echoedSuppliedId: suppliedIds.some((id) => returnedIds.includes(id)),
          areas: result.areas.map((area) => ({
            name: area.name,
            sort_order: area.sort_order,
            slot_minutes: area.slot_minutes,
            fixed_reserve_slots: area.fixed_reserve_slots,
            availability: area.availability.length,
          })),
        };
      } catch (error) {
        const candidate = error as { statusCode?: number; code?: string };
        return { ok: false as const, statusCode: candidate.statusCode ?? 500, code: candidate.code ?? "INTERNAL" };
      }
    };

    beforeAll(async () => {
      const victimCapacity = await phase3.replaceCapacity(
        victim,
        victimCompetition,
        {
          revision: 1,
          areas: [
            { name: "Victim Court", sortOrder: 3, slotMinutes: 30, fixedReserveSlots: 1, availability: [window] },
          ],
        },
        randomUUID(),
      );
      const area = required(victimCapacity.areas);
      victimArea = {
        id: area.id,
        name: area.name,
        sort_order: area.sort_order,
        slot_minutes: area.slot_minutes,
        fixed_reserve_slots: area.fixed_reserve_slots,
      };
      victimWindowId = required(area.availability).id;
    });

    it("a foreign playing-area id with no windows behaves exactly like a random id and never touches the victim court", async () => {
      const before = await victimRows();
      const area = (id: string) => ({
        id,
        name: "Hijacked",
        sortOrder: 9,
        slotMinutes: 30,
        fixedReserveSlots: 7,
        availability: [],
      });
      const randomId = randomUUID();
      const foreign = await attempt({ areas: [area(victimArea.id)] }, [victimArea.id]);
      const missing = await attempt({ areas: [area(randomId)] }, [randomId]);
      expect(foreign).toEqual(missing);
      expect(foreign).toMatchObject({ ok: true, echoedSuppliedId: false });
      expect(await victimRows()).toEqual(before);
      expect(before.area).toMatchObject({ ...victimArea, competition_id: victimCompetition });
    });

    it("a foreign playing-area id with windows is indistinguishable from a random id (no 500 / FK oracle)", async () => {
      const before = await victimRows();
      const area = (id: string) => ({
        id,
        name: "Hijacked",
        sortOrder: 2,
        slotMinutes: 30,
        fixedReserveSlots: 4,
        availability: [window],
      });
      const randomId = randomUUID();
      const foreign = await attempt({ areas: [area(victimArea.id)] }, [victimArea.id]);
      const missing = await attempt({ areas: [area(randomId)] }, [randomId]);
      expect(foreign).toEqual(missing);
      expect(foreign).toMatchObject({ ok: true, echoedSuppliedId: false });
      expect(await victimRows()).toEqual(before);
    });

    it("a foreign availability-window id is indistinguishable from a random window id", async () => {
      const before = await victimRows();
      const area = (windowId: string) => ({
        name: "Attacker Court",
        slotMinutes: 30,
        availability: [{ id: windowId, ...window }],
      });
      const randomId = randomUUID();
      const foreign = await attempt({ areas: [area(victimWindowId)] }, [victimWindowId]);
      const missing = await attempt({ areas: [area(randomId)] }, [randomId]);
      expect(foreign).toEqual(missing);
      expect(foreign).toMatchObject({ ok: true, echoedSuppliedId: false });
      expect(await victimRows()).toEqual(before);
    });

    it("the owner still renames a court in place by its own id and keeps its own window ids", async () => {
      const current = await phase3.capacity(victim, victimCompetition);
      const own = required(current.areas);
      const renamed = await phase3.replaceCapacity(
        victim,
        victimCompetition,
        {
          revision: current.revision,
          areas: [
            {
              id: own.id,
              name: "Victim Centre Court",
              sortOrder: own.sort_order,
              slotMinutes: own.slot_minutes,
              fixedReserveSlots: own.fixed_reserve_slots,
              availability: own.availability.map((value) => ({
                id: value.id,
                date: value.date,
                startTime: value.start_time,
                endTime: value.end_time,
              })),
            },
          ],
        },
        randomUUID(),
      );
      expect(renamed.areas).toHaveLength(1);
      expect(renamed.areas[0]).toMatchObject({ id: victimArea.id, name: "Victim Centre Court" });
      expect(renamed.areas[0]!.availability.map((value) => value.id)).toEqual([victimWindowId]);
    });
  });
});
