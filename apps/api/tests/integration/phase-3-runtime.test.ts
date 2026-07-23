import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import {
  SPORT_PACKS,
  createDefaultFormatTemplates,
  createRoundRobinFormatGraph,
  type FormatGraph,
} from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { phase3DomainAdapter } from "../../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../../src/phase-3-runtime.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase3_runtime_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
let client!: Sql;
let runtime!: Phase3Runtime;
let accountId = "";
let organisationId = "";

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  client = postgres(databaseUrl, { max: 8, onnotice: () => undefined, connection: { search_path: schema } });
  accountId = required(
    await client<
      { id: string }[]
    >`INSERT INTO accounts (primary_email,display_name,email_verified_at) VALUES ('owner@phase3.test','Owner',now()) RETURNING id`,
  ).id;
  await client.begin(async (tx) => {
    organisationId = required(
      await tx<
        { id: string }[]
      >`INSERT INTO organisations (name,slug) VALUES ('Phase 3 Org','phase-3-runtime-org') RETURNING id`,
    ).id;
    await tx`INSERT INTO organisation_memberships (organisation_id,account_id,role,status) VALUES (${organisationId},${accountId},'owner','active')`;
  });
  runtime = new Phase3Runtime(client as unknown as PostgresJsSql, phase3DomainAdapter);
});

afterAll(async () => {
  await client?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

function required<T>(rows: readonly T[]): T {
  const value = rows[0];
  if (!value) throw new Error("Expected database row");
  return value;
}

describeInfrastructure("Phase 3 PostgreSQL runtime", () => {
  it("lists active writable organisations and excludes viewer-only memberships", async () => {
    await client.begin(async (tx) => {
      const viewerOrganisation = required(
        await tx<
          { id: string }[]
        >`INSERT INTO organisations (name,slug) VALUES ('Viewer only','phase-3-viewer-only') RETURNING id`,
      ).id;
      const viewerOrganisationOwner = required(
        await tx<{ id: string }[]>`INSERT INTO accounts (primary_email,display_name,email_verified_at)
          VALUES ('viewer-org-owner@phase3.test','Viewer organisation owner',now()) RETURNING id`,
      ).id;
      await tx`INSERT INTO organisation_memberships (organisation_id,account_id,role,status) VALUES
        (${viewerOrganisation},${viewerOrganisationOwner},'owner','active'),
        (${viewerOrganisation},${accountId},'viewer','active')`;
    });

    const options = await runtime.listWritableOrganisations({ accountId });

    expect(options).toEqual([{ id: organisationId, name: "Phase 3 Org", role: "owner" }]);
  });

  it("replays a lost competition-create response and rejects mismatched key reuse", async () => {
    const actor = { accountId };
    const input = {
      organisationId,
      name: "Replay Cup",
      slug: `replay-cup-${randomUUID()}`,
      sportCode: "volleyball" as const,
      venue: "Replay Hall",
      address: "2 Replay Road",
      countryCode: "SG",
      startsOn: "2027-09-01",
      endsOn: "2027-09-02",
      timezone: "Asia/Singapore",
      locale: "en-SG",
    };
    const idempotencyKey = `competition-create-${randomUUID()}`;

    const [originalReceipt, concurrentReceipt] = await Promise.all([
      runtime.createCompetition(actor, input, randomUUID(), idempotencyKey),
      runtime.createCompetition(actor, input, randomUUID(), idempotencyKey),
    ]);
    expect(concurrentReceipt).toEqual(originalReceipt);
    const replayedReceipt = await runtime.createCompetition(actor, input, randomUUID(), idempotencyKey);

    expect(replayedReceipt).toEqual(originalReceipt);
    const { count } = required(
      await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM competitions WHERE slug=${input.slug}`,
    );
    expect(count).toBe(1);
    const { audit_count: auditCount, outbox_count: outboxCount } = required(
      await client<{ audit_count: number; outbox_count: number }[]>`
        SELECT
          (SELECT count(*)::int FROM audit_events
           WHERE target_id=${originalReceipt.id} AND action='competition.created') AS audit_count,
          (SELECT count(*)::int FROM outbox_events
           WHERE aggregate_id=${originalReceipt.id} AND event_type='competition.created') AS outbox_count`,
    );
    expect({ auditCount, outboxCount }).toEqual({ auditCount: 1, outboxCount: 1 });

    await expect(
      runtime.createCompetition(actor, { ...input, name: "Different Cup" }, randomUUID(), idempotencyKey),
    ).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("replays division and entry creation without duplicate domain, audit, or outbox rows", async () => {
    const actor = { accountId };
    const competition = await runtime.createCompetition(
      actor,
      {
        organisationId,
        name: "Entry replay cup",
        slug: `entry-replay-${randomUUID()}`,
        sportCode: "badminton",
        venue: "Replay Hall",
        address: "3 Replay Road",
        countryCode: "SG",
        startsOn: "2027-10-01",
        endsOn: "2027-10-02",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
    );
    const divisionInput = { name: "Open", entryLimit: 16 as const };
    const divisionKey = `division-create-${randomUUID()}`;
    const [divisionResult, divisionReplay] = await Promise.all([
      runtime.createDivision(actor, competition.id, divisionInput, randomUUID(), divisionKey),
      runtime.createDivision(actor, competition.id, divisionInput, randomUUID(), divisionKey),
    ]);
    const division = divisionResult as { id: string };
    expect(divisionReplay).toEqual(expect.objectContaining({ id: division.id }));

    const entryInput = { action: "create" as const, name: "Replay team", seed: 1 };
    const entryKey = `entry-create-${randomUUID()}`;
    const [entryResult, entryReplay] = await Promise.all([
      runtime.mutateEntry(actor, competition.id, division.id, entryInput, randomUUID(), entryKey),
      runtime.mutateEntry(actor, competition.id, division.id, entryInput, randomUUID(), entryKey),
    ]);
    const entry = entryResult as { id: string };
    expect(entryReplay).toEqual(expect.objectContaining({ id: entry.id }));

    await expect(
      runtime.mutateEntry(
        actor,
        competition.id,
        division.id,
        { ...entryInput, name: "Different team" },
        randomUUID(),
        entryKey,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_KEY_REUSED" });

    const counts = required(
      await client<{ division_count: number; entry_count: number; audit_count: number; outbox_count: number }[]>`SELECT
          (SELECT count(*)::int FROM divisions WHERE id=${division.id}) AS division_count,
          (SELECT count(*)::int FROM division_entries WHERE id=${entry.id}) AS entry_count,
          (SELECT count(*)::int FROM audit_events
           WHERE target_id IN (${division.id},${entry.id}) AND action IN ('division.created','entry.created'))
            AS audit_count,
          (SELECT count(*)::int FROM outbox_events
           WHERE aggregate_id IN (${division.id},${entry.id}) AND event_type IN ('division.created','entry.created'))
            AS outbox_count`,
    );
    expect(counts).toEqual({ division_count: 1, entry_count: 1, audit_count: 2, outbox_count: 2 });

    const conflictingKey = `entry-conflict-${randomUUID()}`;
    const conflicts = await Promise.allSettled([
      runtime.mutateEntry(
        actor,
        competition.id,
        division.id,
        { action: "create", name: "Conflict A", seed: 2 },
        randomUUID(),
        conflictingKey,
      ),
      runtime.mutateEntry(
        actor,
        competition.id,
        division.id,
        { action: "create", name: "Conflict B", seed: 3 },
        randomUUID(),
        conflictingKey,
      ),
    ]);
    expect(conflicts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(conflicts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(conflicts.find((result) => result.status === "rejected")).toMatchObject({
      reason: { statusCode: 409, code: "IDEMPOTENCY_KEY_REUSED" },
    });
    const conflictRows = await client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM division_entries
      WHERE division_id=${division.id} AND name IN ('Conflict A','Conflict B')`;
    expect(required(conflictRows).count).toBe(1);
  });

  it("maps the cross-division free-plan entry boundary to an unprocessable request", async () => {
    const actor = { accountId };
    const competition = await runtime.createCompetition(
      actor,
      {
        organisationId,
        name: "Free entry boundary cup",
        slug: `free-entry-boundary-${randomUUID()}`,
        sportCode: "canoe_polo",
        venue: "Boundary Hall",
        address: "16 Boundary Road",
        countryCode: "SG",
        startsOn: "2027-11-01",
        endsOn: "2027-11-02",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
    );
    const divisions = await Promise.all(
      ["Open", "Women"].map((name) =>
        runtime.createDivision(
          actor,
          competition.id,
          { name, entryLimit: 16 },
          randomUUID(),
          `free-boundary-division-${randomUUID()}`,
        ),
      ),
    );
    for (const [divisionIndex, division] of divisions.entries()) {
      for (let seed = 1; seed <= 8; seed += 1) {
        await runtime.mutateEntry(
          actor,
          competition.id,
          (division as { id: string }).id,
          { action: "create", name: `Boundary ${divisionIndex + 1}-${seed}`, seed },
          randomUUID(),
          `free-boundary-entry-${randomUUID()}`,
        );
      }
    }

    await expect(
      runtime.mutateEntry(
        actor,
        competition.id,
        (divisions[0] as { id: string }).id,
        { action: "create", name: "Boundary 17", seed: 9 },
        randomUUID(),
        `free-boundary-rejection-${randomUUID()}`,
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "FREE_ENTRY_LIMIT_REACHED",
    });
  });

  it("matches JavaScript and PostgreSQL canonical hashes across key order and undefined optionals", async () => {
    const value = {
      scorecard: { z: 1, optional: undefined },
      scoreStructure: { a: 2 },
    };
    const normalized = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    const rows = await client<{ hash: string }[]>`
      SELECT encode(pg_catalog.sha256(convert_to(phase3_canonical_jsonb(${client.json(normalized as never)}::jsonb),'UTF8')),'hex') AS hash`;
    expect(phase3DomainAdapter.hash(value)).toBe(rows[0]?.hash);
  });
  it.each(["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"] as const)(
    "derives immutable %s standings and recalculates only automatic qualifiers after correction",
    async (sportCode) => {
      const actor = { accountId };
      const competition = await runtime.createCompetition(
        actor,
        {
          organisationId,
          name: `${sportCode} results`,
          slug: `results-${sportCode.replaceAll("_", "-")}`,
          sportCode,
          venue: "Results Hall",
          address: "10 Results Road",
          countryCode: "SG",
          startsOn: "2027-08-01",
          endsOn: "2027-08-01",
          timezone: "Asia/Singapore",
          locale: "en-SG",
        },
        randomUUID(),
      );
      const division = (await runtime.createDivision(
        actor,
        competition.id,
        { name: "Open", entryLimit: 8 },
        randomUUID(),
        randomUUID(),
      )) as { id: string };
      await runtime.replaceCapacity(
        actor,
        competition.id,
        {
          revision: 1,
          areas: [
            {
              name: "Court",
              slotMinutes: Number(SPORT_PACKS[sportCode].recommendedSettings.slotMinutes),
              availability: [{ date: "2027-08-01", startTime: "08:00", endTime: "20:00" }],
            },
          ],
        },
        randomUUID(),
      );
      for (let seed = 1; seed <= 4; seed += 1) {
        await runtime.mutateEntry(
          actor,
          competition.id,
          division.id,
          { action: "create", name: `${sportCode} team ${seed}`, seed },
          randomUUID(),
          randomUUID(),
        );
      }
      const seededEntries = await client<{ id: string; seed: number }[]>`
        SELECT id,seed FROM division_entries WHERE division_id=${division.id} ORDER BY seed`;
      const bySeed = new Map(seededEntries.map((entry) => [entry.seed, entry.id]));
      const entryForSeed = (seed: number): string => {
        const id = bySeed.get(seed);
        if (!id) throw new Error(`Expected entry seed ${seed}`);
        return id;
      };
      const roundRobin = createRoundRobinFormatGraph(4);
      const graph: FormatGraph = {
        ...roundRobin,
        id: `${sportCode}-results-graph`,
        stages: [
          ...roundRobin.stages,
          {
            id: "final",
            label: "Final",
            kind: "single_elimination",
            order: 2,
            groupIds: [],
            groupSize: null,
            outputRanks: 2,
            matchIds: ["final-m1"],
          },
        ],
        matches: [
          ...roundRobin.matches,
          {
            id: "final-m1",
            stageId: "final",
            round: 1,
            order: 7,
            purpose: "championship",
            home: { type: "stage_rank", stageId: "round-robin", rank: 1 },
            away: { type: "stage_rank", stageId: "round-robin", rank: 2 },
          },
        ],
        terminalMatchIds: ["final-m1"],
      };
      const format = await runtime.createFormatRevision(actor, competition.id, division.id, graph, randomUUID());
      const persistedMatches = new Map<string, string>();
      for (const match of graph.matches) {
        const id = randomUUID();
        persistedMatches.set(match.id, id);
        const home = match.home.type === "entry_seed" ? entryForSeed(match.home.seed) : null;
        const away = match.away.type === "entry_seed" ? entryForSeed(match.away.seed) : null;
        await client`INSERT INTO matches
          (id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal,home_entry_id,away_entry_id,state)
          VALUES (${id},${competition.id},${division.id},${format.id},${match.id},${match.purpose === "pool" ? "group" : "final"},
            ${match.round},${match.order},${home},${away},${match.purpose === "pool" ? "final" : "pending"})`;
      }
      const finalId = persistedMatches.get("final-m1");
      if (!finalId) throw new Error("Expected final match");
      await client`INSERT INTO advancement_slots
        (competition_id,division_id,match_id,slot,entry_id,control,result_version)
        VALUES (${competition.id},${division.id},${finalId},'away',${entryForSeed(4)},'manual',0)`;
      await client`UPDATE matches SET away_entry_id=${entryForSeed(4)} WHERE id=${finalId}`;
      await runtime.publishFormat(actor, competition.id, format.id, format.definition_hash, randomUUID());
      for (const match of graph.matches.filter((candidate) => candidate.purpose === "pool")) {
        if (match.home.type !== "entry_seed" || match.away.type !== "entry_seed") throw new Error("Expected seeds");
        const winnerHome = match.home.seed < match.away.seed;
        const matchId = persistedMatches.get(match.id);
        if (!matchId) throw new Error(`Expected match ${match.id}`);
        await client`INSERT INTO match_result_snapshots
          (match_id,result_version,through_sequence,home_score,away_score,state,snapshot)
          VALUES (${matchId},1,1,${winnerHome ? 2 : 0},${winnerHome ? 0 : 2},'final',
            ${client.json({ homeSegments: winnerHome ? [2] : [0], awaySegments: winnerHome ? [0] : [2] })})`;
      }
      await client`UPDATE competition_publications SET result_version=1 WHERE competition_id=${competition.id}`;
      const first = (await runtime.recalculateStandings(actor, competition.id, division.id, randomUUID())) as {
        result_version: number;
        source_result_hash: string;
      };
      expect(first.result_version).toBe(1);
      expect(first.source_result_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(
        required(
          await client<{ entry_id: string }[]>`SELECT entry_id FROM advancement_slots
        WHERE match_id=${finalId} AND slot='home'`,
        ).entry_id,
      ).toBe(entryForSeed(1));
      expect(
        required(
          await client<{ entry_id: string; control: string }[]>`SELECT entry_id,control FROM advancement_slots
        WHERE match_id=${finalId} AND slot='away'`,
        ),
      ).toEqual({ entry_id: entryForSeed(4), control: "manual" });

      if (sportCode === "canoe_polo") {
        await client`UPDATE matches SET state='in_progress' WHERE id=${finalId}`;
      }

      for (const match of graph.matches.filter(
        (candidate) =>
          candidate.purpose === "pool" &&
          ((candidate.home.type === "entry_seed" && candidate.home.seed === 1) ||
            (candidate.away.type === "entry_seed" && candidate.away.seed === 1)),
      )) {
        if (match.home.type !== "entry_seed" || match.away.type !== "entry_seed") throw new Error("Expected seeds");
        const homeLoses = match.home.seed === 1;
        const matchId = persistedMatches.get(match.id);
        if (!matchId) throw new Error(`Expected match ${match.id}`);
        await client`INSERT INTO match_result_snapshots
          (match_id,result_version,through_sequence,home_score,away_score,state,snapshot)
          VALUES (${matchId},2,2,${homeLoses ? 0 : 2},${homeLoses ? 2 : 0},'corrected',
            ${client.json({ corrected: true, homeSegments: homeLoses ? [0] : [2], awaySegments: homeLoses ? [2] : [0] })})`;
        if (sportCode === "badminton") {
          await client`INSERT INTO match_result_snapshots
            (match_id,result_version,through_sequence,home_score,away_score,state,snapshot)
            VALUES (${matchId},3,3,${homeLoses ? 2 : 0},${homeLoses ? 0 : 2},'corrected',
              ${client.json({ future: true, homeSegments: homeLoses ? [2] : [0], awaySegments: homeLoses ? [0] : [2] })})`;
        }
      }
      await client`UPDATE competition_publications SET result_version=2 WHERE competition_id=${competition.id}`;
      const corrected = (await runtime.recalculateStandings(actor, competition.id, division.id, randomUUID())) as {
        result_version: number;
      };
      expect(corrected.result_version).toBe(2);
      expect(
        required(
          await client<
            { entry_id: string; result_version: number }[]
          >`SELECT entry_id,result_version FROM advancement_slots
        WHERE match_id=${finalId} AND slot='home'`,
        ),
      ).toEqual(
        sportCode === "canoe_polo"
          ? { entry_id: entryForSeed(1), result_version: 1 }
          : { entry_id: entryForSeed(2), result_version: 2 },
      );
      if (sportCode === "canoe_polo") {
        const targetSlotId = `${finalId}:home`;
        expect(
          required(await client<{ home_entry_id: string }[]>`SELECT home_entry_id FROM matches WHERE id=${finalId}`)
            .home_entry_id,
        ).toBe(entryForSeed(1));
        expect(
          required(
            await client<{ reason: string }[]>`SELECT reason FROM advancement_conflicts
              WHERE division_id=${division.id} AND result_version=2 AND target_slot_id=${targetSlotId}`,
          ).reason,
        ).toBe("downstream_match_started");
      }
      expect(
        required(
          await client<{ entry_id: string; control: string }[]>`SELECT entry_id,control FROM advancement_slots
        WHERE match_id=${finalId} AND slot='away'`,
        ),
      ).toEqual({ entry_id: entryForSeed(4), control: "manual" });
      expect(
        required(
          await client<{ count: number }[]>`SELECT count(*)::int AS count FROM standings_snapshots
        WHERE division_id=${division.id} AND calculation_provenance='server_calculated'`,
        ).count,
      ).toBe(2);
      const loaded = (await runtime.readStandings(actor, competition.id, division.id)) as unknown as {
        result_version: number;
        advancement_slots: Array<{
          control: string;
          controlled_by_rule_id: string | null;
          source_fingerprint: string | null;
          result_version: number;
        }>;
        advancement_conflicts: Array<{ status: string; result_version: number; rule_id: string }>;
      };
      expect(loaded.result_version).toBe(2);
      expect(loaded.advancement_slots.every((slot) => slot.result_version <= loaded.result_version)).toBe(true);
      expect(loaded.advancement_slots.some((slot) => slot.control === "manual")).toBe(true);
      expect(
        loaded.advancement_slots
          .filter((slot) => slot.control === "automatic" && slot.source_fingerprint !== null)
          .every((slot) => slot.controlled_by_rule_id !== null),
      ).toBe(true);
      expect(
        loaded.advancement_conflicts.every(
          (conflict) => conflict.result_version === loaded.result_version && conflict.status === "open",
        ),
      ).toBe(true);
    },
  );

  it("keeps a pre-first-match withdrawal result-neutral", async () => {
    const actor = { accountId };
    const competition = await runtime.createCompetition(
      actor,
      {
        organisationId,
        name: "Pre-start Withdrawal Cup",
        slug: "pre-start-withdrawal-runtime",
        sportCode: "canoe_polo",
        venue: "Quiet Hall",
        address: "1 Before Road",
        countryCode: "SG",
        startsOn: "2027-08-15",
        endsOn: "2027-08-15",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
    );
    const division = (await runtime.createDivision(
      actor,
      competition.id,
      { name: "Open", entryLimit: 8 },
      randomUUID(),
      randomUUID(),
    )) as { id: string };
    await runtime.replaceCapacity(
      actor,
      competition.id,
      {
        revision: 1,
        areas: [
          {
            name: "Pitch",
            slotMinutes: 30,
            availability: [{ date: "2027-08-15", startTime: "08:00", endTime: "10:00" }],
          },
        ],
      },
      randomUUID(),
    );
    const entryIds: string[] = [];
    for (let seed = 1; seed <= 2; seed += 1) {
      const entry = (await runtime.mutateEntry(
        actor,
        competition.id,
        division.id,
        { action: "create", name: `Pre-start team ${seed}`, seed },
        randomUUID(),
        randomUUID(),
      )) as { id: string };
      entryIds.push(entry.id);
    }
    const graph = createRoundRobinFormatGraph(2);
    const format = await runtime.createFormatRevision(actor, competition.id, division.id, graph, randomUUID());
    const match = required(graph.matches);
    const homeEntryId = entryIds[0];
    const awayEntryId = entryIds[1];
    if (!homeEntryId || !awayEntryId) throw new Error("Expected pre-start entries");
    await client`INSERT INTO matches
      (id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal,home_entry_id,away_entry_id,state)
      VALUES (${randomUUID()},${competition.id},${division.id},${format.id},${match.id},'group',1,1,
        ${homeEntryId},${awayEntryId},'ready')`;
    await runtime.publishFormat(actor, competition.id, format.id, format.definition_hash, randomUUID());
    await runtime.mutateEntry(
      actor,
      competition.id,
      division.id,
      { action: "withdraw", entryId: homeEntryId, reason: "Withdrew before play" },
      randomUUID(),
      randomUUID(),
    );
    expect(
      required(
        await client<{ result_version: number; snapshots: number }[]>`SELECT publication.result_version,
                 (SELECT count(*)::int FROM match_result_snapshots result
                  JOIN matches m ON m.id=result.match_id WHERE m.division_id=${division.id}) AS snapshots
           FROM competition_publications publication WHERE publication.competition_id=${competition.id}`,
      ),
    ).toEqual({ result_version: 0, snapshots: 0 });
  });

  it("applies a pinned withdrawal forfeit policy, versions its source, and recalculates advancement atomically", async () => {
    const actor = { accountId };
    const competition = await runtime.createCompetition(
      actor,
      {
        organisationId,
        name: "Withdrawal Cup",
        slug: "withdrawal-results-runtime",
        sportCode: "badminton",
        venue: "Withdrawal Hall",
        address: "17 Policy Road",
        countryCode: "SG",
        startsOn: "2027-09-01",
        endsOn: "2027-09-01",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
    );
    const division = (await runtime.createDivision(
      actor,
      competition.id,
      { name: "Open", entryLimit: 8 },
      randomUUID(),
      randomUUID(),
    )) as { id: string };
    await runtime.replaceCapacity(
      actor,
      competition.id,
      {
        revision: 1,
        areas: [
          {
            name: "Court",
            slotMinutes: 20,
            availability: [{ date: "2027-09-01", startTime: "08:00", endTime: "20:00" }],
          },
        ],
      },
      randomUUID(),
    );
    for (let seed = 1; seed <= 4; seed += 1) {
      await runtime.mutateEntry(
        actor,
        competition.id,
        division.id,
        { action: "create", name: `Withdrawal team ${seed}`, seed },
        randomUUID(),
        randomUUID(),
      );
    }
    const entries = await client<{ id: string; seed: number }[]>`
      SELECT id,seed FROM division_entries WHERE division_id=${division.id} ORDER BY seed`;
    const bySeed = new Map(entries.map((entry) => [entry.seed, entry.id]));
    const entryForSeed = (seed: number): string => {
      const entryId = bySeed.get(seed);
      if (!entryId) throw new Error(`Expected withdrawal entry seed ${seed}`);
      return entryId;
    };
    const roundRobin = createRoundRobinFormatGraph(4);
    const graph: FormatGraph = {
      ...roundRobin,
      id: "withdrawal-results-graph",
      stages: [
        ...roundRobin.stages,
        {
          id: "final",
          label: "Final",
          kind: "single_elimination",
          order: 2,
          groupIds: [],
          groupSize: null,
          outputRanks: 2,
          matchIds: ["withdrawal-final"],
        },
      ],
      matches: [
        ...roundRobin.matches,
        {
          id: "withdrawal-final",
          stageId: "final",
          round: 1,
          order: 7,
          purpose: "championship",
          home: { type: "stage_rank", stageId: "round-robin", rank: 1 },
          away: { type: "stage_rank", stageId: "round-robin", rank: 2 },
        },
      ],
      terminalMatchIds: ["withdrawal-final"],
    };
    const format = await runtime.createFormatRevision(actor, competition.id, division.id, graph, randomUUID());
    const persistedMatches = new Map<string, string>();
    for (const match of graph.matches) {
      const matchId = randomUUID();
      persistedMatches.set(match.id, matchId);
      const home = match.home.type === "entry_seed" ? entryForSeed(match.home.seed) : null;
      const away = match.away.type === "entry_seed" ? entryForSeed(match.away.seed) : null;
      await client`INSERT INTO matches
        (id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal,home_entry_id,away_entry_id,state)
        VALUES (${matchId},${competition.id},${division.id},${format.id},${match.id},${match.purpose === "pool" ? "group" : "final"},
          ${match.round},${match.order},${home},${away},'pending')`;
    }
    await runtime.publishFormat(actor, competition.id, format.id, format.definition_hash, randomUUID());
    const completedGraphMatch = required(
      graph.matches.filter(
        (match) =>
          match.home.type === "entry_seed" &&
          match.away.type === "entry_seed" &&
          new Set([match.home.seed, match.away.seed]).has(1) &&
          new Set([match.home.seed, match.away.seed]).has(2),
      ),
    );
    if (completedGraphMatch.home.type !== "entry_seed" || completedGraphMatch.away.type !== "entry_seed")
      throw new Error("Expected seeded completed match");
    const completedId = persistedMatches.get(completedGraphMatch.id);
    if (!completedId) throw new Error("Expected completed withdrawal match");
    const seedOneHome = completedGraphMatch.home.seed === 1;
    await client`UPDATE matches SET state='final' WHERE id=${completedId}`;
    await client`INSERT INTO match_result_snapshots
      (match_id,result_version,through_sequence,home_score,away_score,state,snapshot)
      VALUES (${completedId},1,1,${seedOneHome ? 2 : 0},${seedOneHome ? 0 : 2},'final',
        ${client.json({ homeSegments: seedOneHome ? [2] : [0], awaySegments: seedOneHome ? [0] : [2] })})`;
    await client`UPDATE competition_publications SET result_version=1 WHERE competition_id=${competition.id}`;
    const initial = (await runtime.recalculateStandings(actor, competition.id, division.id, randomUUID())) as {
      id: string;
      source_result_hash: string;
    };
    const finalId = persistedMatches.get("withdrawal-final");
    if (!finalId) throw new Error("Expected withdrawal final");
    expect(
      required(await client<{ home_entry_id: string }[]>`SELECT home_entry_id FROM matches WHERE id=${finalId}`)
        .home_entry_id,
    ).toBe(entryForSeed(1));
    const protectedFixture = graph.matches.find(
      (match) =>
        match.purpose === "pool" &&
        match.id !== completedGraphMatch.id &&
        match.home.type === "entry_seed" &&
        match.away.type === "entry_seed" &&
        match.home.seed !== 1 &&
        match.away.seed !== 1,
    );
    const protectedFixtureId = protectedFixture ? persistedMatches.get(protectedFixture.id) : undefined;
    if (!protectedFixtureId) throw new Error("Expected protected participant fixture");
    await expect(client`UPDATE matches SET home_entry_id=${entryForSeed(3)} WHERE id=${completedId}`).rejects.toThrow(
      /participant|result snapshot|immutable/i,
    );
    const originalProtectedHome = required(
      await client<{ home_entry_id: string }[]>`SELECT home_entry_id FROM matches WHERE id=${protectedFixtureId}`,
    ).home_entry_id;
    await client`UPDATE matches SET home_entry_id=${entryForSeed(1)} WHERE id=${protectedFixtureId}`;
    await expect(runtime.recalculateStandings(actor, competition.id, division.id, randomUUID())).rejects.toMatchObject({
      code: "STANDINGS_SOURCE_STALE",
    });
    await client`UPDATE matches SET home_entry_id=${originalProtectedHome} WHERE id=${protectedFixtureId}`;

    await client`UPDATE competition_sport_settings
      SET settings_override=settings_override || ${client.json({ forfeitWinnerScore: 17 })}::jsonb
      WHERE competition_id=${competition.id}`;
    await expect(runtime.recalculateStandings(actor, competition.id, division.id, randomUUID())).rejects.toMatchObject({
      code: "STANDINGS_SOURCE_STALE",
    });

    const withdrawalRequestId = randomUUID();
    await runtime.mutateEntry(
      actor,
      competition.id,
      division.id,
      { action: "withdraw", entryId: entryForSeed(1), reason: "Injury" },
      withdrawalRequestId,
      withdrawalRequestId,
    );
    expect(
      required(
        await client<
          { result_version: number }[]
        >`SELECT result_version FROM competition_publications WHERE competition_id=${competition.id}`,
      ).result_version,
    ).toBe(2);
    expect(
      required(
        await client<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM match_result_snapshots WHERE match_id=${completedId}`,
      ).count,
    ).toBe(1);
    const forfeits = await client<
      {
        match_id: string;
        home_score: number;
        away_score: number;
        snapshot: Record<string, unknown>;
      }[]
    >`
      SELECT s.match_id,s.home_score,s.away_score,s.snapshot
      FROM match_result_snapshots s JOIN matches m ON m.id=s.match_id
      WHERE m.division_id=${division.id} AND s.result_version=2
      ORDER BY s.match_id`;
    expect(forfeits).toHaveLength(2);
    for (const forfeit of forfeits) {
      const snapshot = typeof forfeit.snapshot === "string" ? JSON.parse(forfeit.snapshot) : forfeit.snapshot;
      expect(snapshot).toMatchObject({
        forfeitLoserEntryId: entryForSeed(1),
        generatedBy: "entry_withdrawal",
        settingsVersion: expect.any(String),
      });
      expect([forfeit.home_score, forfeit.away_score].sort((left, right) => left - right)).toEqual([0, 34]);
    }
    const snapshots = await client<{ id: string; result_version: number; source_result_hash: string }[]>`
      SELECT id,result_version,source_result_hash FROM standings_snapshots
      WHERE division_id=${division.id} ORDER BY result_version`;
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      id: initial.id,
      result_version: 1,
      source_result_hash: initial.source_result_hash,
    });
    expect(snapshots[1]?.result_version).toBe(2);
    expect(snapshots[1]?.source_result_hash).not.toBe(initial.source_result_hash);
    expect(
      required(await client<{ home_entry_id: string }[]>`SELECT home_entry_id FROM matches WHERE id=${finalId}`)
        .home_entry_id,
    ).not.toBe(entryForSeed(1));
    const evidence = required(
      await client<{ audits: number; outbox: number }[]>`
        SELECT
          (SELECT count(*)::int FROM audit_events WHERE request_id=${withdrawalRequestId}
            AND action='entry.withdrawal_results_applied') AS audits,
          (SELECT count(*)::int FROM outbox_events WHERE idempotency_key=${`${withdrawalRequestId}:entry.withdrawal_results_applied:${entryForSeed(1)}`}) AS outbox`,
    );
    expect(evidence).toEqual({ audits: 1, outbox: 1 });
  });

  it("discovers every persisted pool and advances a best-N cross-group qualifier beyond group winners", async () => {
    const actor = { accountId };
    const competition = await runtime.createCompetition(
      actor,
      {
        organisationId,
        name: "Cross Group Cup",
        slug: "cross-group-runtime",
        sportCode: "basketball",
        venue: "Pools Hall",
        address: "8 Pools Road",
        countryCode: "SG",
        startsOn: "2027-10-01",
        endsOn: "2027-10-01",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
    );
    const division = (await runtime.createDivision(
      actor,
      competition.id,
      { name: "Open", entryLimit: 8 },
      randomUUID(),
      randomUUID(),
    )) as { id: string };
    await runtime.replaceCapacity(
      actor,
      competition.id,
      {
        revision: 1,
        areas: [
          {
            name: "Court",
            slotMinutes: 40,
            availability: [{ date: "2027-10-01", startTime: "08:00", endTime: "23:00" }],
          },
        ],
      },
      randomUUID(),
    );
    for (let seed = 1; seed <= 8; seed += 1) {
      await runtime.mutateEntry(
        actor,
        competition.id,
        division.id,
        { action: "create", name: `Pool team ${seed}`, seed },
        randomUUID(),
        randomUUID(),
      );
    }
    const entries = await client<{ id: string; seed: number }[]>`
      SELECT id,seed FROM division_entries WHERE division_id=${division.id} ORDER BY seed`;
    const bySeed = new Map(entries.map((entry) => [entry.seed, entry.id]));
    const entryForSeed = (seed: number): string => {
      const entryId = bySeed.get(seed);
      if (!entryId) throw new Error(`Expected pool entry seed ${seed}`);
      return entryId;
    };
    const base = createDefaultFormatTemplates(8).find((template) => template.strategy === "championship_focus")!.graph;
    const groupStage = required(base.stages.filter((stage) => stage.kind === "group"));
    const groupMatches = base.matches.filter((match) => match.stageId === groupStage.id);
    const graph: FormatGraph = {
      id: "cross-group-best-n",
      schemaVersion: 1,
      entryCount: 8,
      stages: [
        groupStage,
        {
          id: "best-n-final",
          label: "Best N playoff",
          kind: "single_elimination",
          order: 2,
          groupIds: [],
          groupSize: null,
          outputRanks: 2,
          matchIds: ["best-n-m1"],
        },
      ],
      matches: [
        ...groupMatches,
        {
          id: "best-n-m1",
          stageId: "best-n-final",
          round: 1,
          order: groupMatches.length + 1,
          purpose: "progression",
          home: { type: "stage_rank", stageId: groupStage.id, rank: 3 },
          away: { type: "stage_rank", stageId: groupStage.id, groupId: "G1", rank: 1 },
        },
      ],
      terminalMatchIds: ["best-n-m1"],
    };
    const format = await runtime.createFormatRevision(actor, competition.id, division.id, graph, randomUUID());
    const persistedMatches = new Map<string, string>();
    for (const match of graph.matches) {
      const matchId = randomUUID();
      persistedMatches.set(match.id, matchId);
      const home = match.home.type === "entry_seed" ? entryForSeed(match.home.seed) : null;
      const away = match.away.type === "entry_seed" ? entryForSeed(match.away.seed) : null;
      await client`INSERT INTO matches
        (id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal,home_entry_id,away_entry_id,state)
        VALUES (${matchId},${competition.id},${division.id},${format.id},${match.id},${match.purpose === "pool" ? "group" : "final"},
          ${match.round},${match.order},${home},${away},${match.purpose === "pool" ? "final" : "pending"})`;
    }
    await runtime.publishFormat(actor, competition.id, format.id, format.definition_hash, randomUUID());
    for (const match of groupMatches) {
      if (match.home.type !== "entry_seed" || match.away.type !== "entry_seed") throw new Error("Expected group seeds");
      const homeWins = match.home.seed < match.away.seed;
      const matchId = persistedMatches.get(match.id);
      if (!matchId) throw new Error(`Expected persisted pool match ${match.id}`);
      await client`INSERT INTO match_result_snapshots
        (match_id,result_version,through_sequence,home_score,away_score,state,snapshot)
        VALUES (${matchId},1,1,${homeWins ? 10 : 5},${homeWins ? 5 : 10},'final',${client.json({})})`;
    }
    await client`UPDATE competition_publications SET result_version=1 WHERE competition_id=${competition.id}`;
    const snapshot = (await runtime.recalculateStandings(actor, competition.id, division.id, randomUUID())) as {
      standings: Record<string, unknown> | string;
    };
    const standings = typeof snapshot.standings === "string" ? JSON.parse(snapshot.standings) : snapshot.standings;
    expect(Object.keys((standings as { groups: Record<string, unknown> }).groups).sort()).toEqual(["G1", "G2"]);
    const finalId = persistedMatches.get("best-n-m1");
    if (!finalId) throw new Error("Expected best-N final");
    expect(
      required(await client<{ home_entry_id: string }[]>`SELECT home_entry_id FROM matches WHERE id=${finalId}`)
        .home_entry_id,
    ).toBe(entryForSeed(3));
    expect(
      required(
        await client<
          { controlled_by_rule_id: string; source_fingerprint: string }[]
        >`SELECT controlled_by_rule_id,source_fingerprint FROM advancement_slots
           WHERE match_id=${finalId} AND slot='home' AND control='automatic'`,
      ),
    ).toMatchObject({ controlled_by_rule_id: "best-n-m1:home:groups:*:3", source_fingerprint: expect.any(String) });
  });

  it("persists lifecycle, CRUD, defaults, capacity and evidence atomically", async () => {
    const actor = { accountId };
    const competition = await runtime.createCompetition(
      actor,
      {
        organisationId,
        name: "Badminton Cup",
        slug: "badminton-runtime",
        sportCode: "badminton",
        venue: "Hall",
        address: "1 Road",
        countryCode: "SG",
        startsOn: "2027-02-01",
        endsOn: "2027-02-02",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
    );
    const division = (await runtime.createDivision(
      actor,
      competition.id,
      { name: "Open", entryLimit: 48 },
      randomUUID(),
      randomUUID(),
    )) as { id: string };
    await runtime.updateSettings(
      actor,
      competition.id,
      { divisionId: division.id, packVersion: "0.1.0-draft.1", revision: 1, override: {} },
      randomUUID(),
    );
    await runtime.saveAccountDefault(
      actor,
      "badminton",
      {
        packVersion: "0.1.0-draft.1",
        settings: { ...SPORT_PACKS.badminton.recommendedSettings },
      },
      randomUUID(),
    );
    await runtime.replaceCapacity(
      actor,
      competition.id,
      {
        revision: 1,
        areas: [
          {
            name: "Court 1",
            slotMinutes: 30,
            fixedReserveSlots: 1,
            availability: [{ date: "2027-02-01", startTime: "08:00", endTime: "20:00" }],
            unavailable: [{ date: "2027-02-01", startTime: "12:00", endTime: "13:00" }],
          },
        ],
      },
      randomUUID(),
    );
    const capacity = await runtime.capacity(actor, competition.id);
    expect(capacity.effective.availableMatchSlots).toBe(21);

    for (let index = 0; index < 16; index += 1)
      await runtime.mutateEntry(
        actor,
        competition.id,
        division.id,
        { action: "create", name: `Team ${index + 1}` },
        randomUUID(),
        randomUUID(),
      );
    const first = required(
      await client<
        { id: string }[]
      >`SELECT id FROM division_entries WHERE division_id=${division.id} ORDER BY created_at,id LIMIT 1`,
    );
    await runtime.mutateEntry(
      actor,
      competition.id,
      division.id,
      { action: "replace", entryId: first.id, replacementName: "Replacement" },
      randomUUID(),
      randomUUID(),
    );
    expect(
      required(
        await client<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM division_entries WHERE division_id=${division.id} AND status='active'`,
      ).count,
    ).toBe(16);

    const duplicated = await runtime.duplicateCompetition(
      actor,
      competition.id,
      { name: "Copy", slug: "badminton-runtime-copy" },
      randomUUID(),
    );
    const copied = required(
      await client<
        { plan_tier: string; availability_count: number }[]
      >`SELECT c.plan_tier,(SELECT count(*)::int FROM division_entries e JOIN divisions d ON d.id=e.division_id WHERE d.competition_id=c.id AND jsonb_array_length(e.availability)>0) AS availability_count FROM competitions c WHERE c.id=${duplicated.id}`,
    );
    expect(copied).toMatchObject({ plan_tier: "free", availability_count: 0 });
    await runtime.replaceCapacity(
      actor,
      duplicated.id,
      {
        revision: 1,
        areas: [
          {
            name: "Copy Court",
            slotMinutes: 30,
            availability: [{ date: "2027-02-01", startTime: "08:00", endTime: "09:00" }],
          },
        ],
      },
      randomUUID(),
    );
    const duplicatedChildren = required(
      await client<{ divisions: number; areas: number; settings: number }[]>`SELECT
          (SELECT count(*)::int FROM divisions WHERE competition_id=${duplicated.id}) AS divisions,
          (SELECT count(*)::int FROM playing_areas WHERE competition_id=${duplicated.id}) AS areas,
          (SELECT count(*)::int FROM competition_sport_settings WHERE competition_id=${duplicated.id}) AS settings`,
    );
    expect(duplicatedChildren.divisions).toBeGreaterThan(0);
    expect(duplicatedChildren.areas).toBeGreaterThan(0);
    expect(duplicatedChildren.settings).toBe(1);
    await expect(runtime.deleteCompetition(actor, duplicated.id, randomUUID())).resolves.toEqual({
      id: duplicated.id,
      deleted: true,
    });
    expect(
      required(
        await client<{ competitions: number; divisions: number; areas: number }[]>`SELECT
            (SELECT count(*)::int FROM competitions WHERE id=${duplicated.id}) AS competitions,
            (SELECT count(*)::int FROM divisions WHERE competition_id=${duplicated.id}) AS divisions,
            (SELECT count(*)::int FROM playing_areas WHERE competition_id=${duplicated.id}) AS areas`,
      ),
    ).toEqual({ competitions: 0, divisions: 0, areas: 0 });

    const archived = (await runtime.mutateCompetition(
      actor,
      competition.id,
      { action: "archive", revision: 1 },
      randomUUID(),
    )) as { revision: number };
    await expect(
      runtime.createDivision(actor, competition.id, { name: "Blocked", entryLimit: 8 }, randomUUID(), randomUUID()),
    ).rejects.toMatchObject({ code: "COMPETITION_ARCHIVED" });
    await runtime.mutateCompetition(
      actor,
      competition.id,
      { action: "restore", revision: archived.revision },
      randomUUID(),
    );
    const evidence = required(
      await client<
        { audits: number; outbox: number }[]
      >`SELECT (SELECT count(*)::int FROM audit_events WHERE actor_account_id=${accountId}) AS audits,(SELECT count(*)::int FROM outbox_events) AS outbox`,
    );
    expect(evidence.audits).toBe(evidence.outbox);
    expect(evidence.audits).toBeGreaterThan(20);
  });

  it("serializes concurrent format revisions and rejects invalid graphs before persistence", async () => {
    const actor = { accountId };
    const competition = await runtime.createCompetition(
      actor,
      {
        organisationId,
        name: "Format Cup",
        slug: "format-runtime",
        sportCode: "badminton",
        venue: "Hall",
        address: "2 Road",
        countryCode: "SG",
        startsOn: "2027-03-01",
        endsOn: "2027-03-02",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
    );
    const division = (await runtime.createDivision(
      actor,
      competition.id,
      { name: "Open", entryLimit: 8 },
      randomUUID(),
      randomUUID(),
    )) as { id: string };
    await runtime.replaceCapacity(
      actor,
      competition.id,
      {
        revision: 1,
        areas: [
          {
            name: "Court",
            slotMinutes: 30,
            availability: [{ date: "2027-03-01", startTime: "00:00", endTime: "00:00", crossMidnight: true }],
          },
        ],
      },
      randomUUID(),
    );
    const graph = createRoundRobinFormatGraph(8);
    const results = await Promise.all([
      runtime.createFormatRevision(actor, competition.id, division.id, { ...graph, id: "concurrent-a" }, randomUUID()),
      runtime.createFormatRevision(actor, competition.id, division.id, { ...graph, id: "concurrent-b" }, randomUUID()),
    ]);
    expect(results.map((item) => item.revision).sort()).toEqual([1, 2]);
    const invalid = {
      ...graph,
      id: "invalid",
      matches: [{ ...graph.matches[0]!, home: { type: "winner" as const, matchId: "unknown" } }],
    };
    await expect(
      runtime.createFormatRevision(actor, competition.id, division.id, invalid, randomUUID()),
    ).rejects.toMatchObject({ statusCode: 422, code: "FORMAT_INVALID" });
    const counts = required(
      await client<
        { revisions: number; evidence: number }[]
      >`SELECT (SELECT count(*)::int FROM format_revisions WHERE division_id=${division.id}) AS revisions,(SELECT count(*)::int FROM format_validation_evidence e JOIN format_revisions f ON f.id=e.format_revision_id WHERE f.division_id=${division.id}) AS evidence`,
    );
    expect(counts).toEqual({ revisions: 2, evidence: 2 });
  });

  it("validates the complete competition patch and lifecycle contract", async () => {
    const actor = { accountId };
    await expect(
      runtime.createCompetition(
        actor,
        {
          organisationId,
          name: "Invalid zone",
          slug: "invalid-zone",
          sportCode: "badminton",
          venue: "Hall",
          address: "1 Road",
          countryCode: "SG",
          startsOn: "2027-04-31",
          endsOn: "2027-04-01",
          timezone: "Mars/Olympus",
          locale: "en-SG",
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 422 });
    expect(
      required(
        await client<{ count: number }[]>`SELECT count(*)::int AS count FROM competitions WHERE slug='invalid-zone'`,
      ).count,
    ).toBe(0);

    const competition = await runtime.createCompetition(
      actor,
      {
        organisationId,
        name: "Lifecycle Cup",
        slug: "lifecycle-runtime",
        sportCode: "badminton",
        venue: "Old Hall",
        address: "1 Road",
        countryCode: "SG",
        startsOn: "2027-04-01",
        endsOn: "2027-04-02",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
    );
    await expect(
      runtime.transitionCompetition(actor, competition.id, { revision: 1, status: "ready" }, randomUUID()),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const updated = (await runtime.mutateCompetition(
      actor,
      competition.id,
      {
        action: "update",
        revision: 1,
        patch: {
          name: "Lifecycle Championship",
          slug: "lifecycle-championship",
          sportCode: "volleyball",
          venue: "New Hall",
          address: "2 Road",
          locality: "Singapore",
          countryCode: "SG",
          startsOn: "2027-04-03",
          endsOn: "2027-04-04",
          timezone: "Asia/Singapore",
          locale: "en-SG",
        },
      },
      randomUUID(),
    )) as { revision: number };
    expect(updated.revision).toBe(2);
    const stored = required(
      await client<
        { name: string; slug: string; sport_code: string; venue: string; starts_on: string; ends_on: string }[]
      >`
      SELECT name,slug,sport_code,venue,starts_on::text,ends_on::text FROM competitions WHERE id=${competition.id}`,
    );
    expect(stored).toMatchObject({
      name: "Lifecycle Championship",
      slug: "lifecycle-championship",
      sport_code: "volleyball",
      venue: "New Hall",
      starts_on: "2027-04-03",
      ends_on: "2027-04-04",
    });
    await runtime.createDivision(actor, competition.id, { name: "Open", entryLimit: 8 }, randomUUID(), randomUUID());
    const ready = (await runtime.transitionCompetition(
      actor,
      competition.id,
      { revision: 2, status: "ready" },
      randomUUID(),
    )) as { revision: number };
    expect(ready.revision).toBe(3);
    await expect(
      runtime.transitionCompetition(actor, competition.id, { revision: 3, status: "completed" }, randomUUID()),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await client`UPDATE competitions SET first_match_started_at=now() WHERE id=${competition.id}`;
    await expect(
      runtime.mutateCompetition(
        actor,
        competition.id,
        {
          action: "update",
          revision: 3,
          patch: { sportCode: "basketball" },
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "SPORT_LOCKED" });
  });

  it("validates availability, withdrawal reason, replacement lineage, and idempotent import rollback", async () => {
    const actor = { accountId };
    const competition = await runtime.createCompetition(
      actor,
      {
        organisationId,
        name: "Entries Cup",
        slug: "entries-runtime",
        sportCode: "badminton",
        venue: "Hall",
        address: "3 Road",
        countryCode: "SG",
        startsOn: "2027-05-01",
        endsOn: "2027-05-02",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
    );
    const division = (await runtime.createDivision(
      actor,
      competition.id,
      { name: "Open", entryLimit: 8 },
      randomUUID(),
      randomUUID(),
    )) as { id: string };
    const invalid = await runtime.importEntries(
      actor,
      competition.id,
      division.id,
      {
        sourceKind: "paste",
        rows: [{ name: "Invalid availability", availability: [{ start: "2027-05-01", end: "2027-05-01" }] }],
      },
      randomUUID(),
    );
    expect(invalid.ok).toBe(false);
    expect(
      required(
        await client<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM entry_imports WHERE competition_id=${competition.id}`,
      ).count,
    ).toBe(0);

    const committed = await runtime.importEntries(
      actor,
      competition.id,
      division.id,
      {
        sourceKind: "csv",
        rows: [
          {
            name: "Imported One",
            seed: 1,
            availability: [{ start: "2027-05-01T01:00:00.000Z", end: "2027-05-01T02:00:00.000Z" }],
          },
          { name: "Imported Two", seed: 2 },
        ],
      },
      randomUUID(),
    );
    expect(committed).toMatchObject({ ok: true, inserted: 2 });
    if (!committed.ok) throw new Error("Expected committed import");
    const firstRollback = await runtime.rollbackEntryImport(
      actor,
      competition.id,
      division.id,
      committed.import_id,
      randomUUID(),
    );
    const replay = await runtime.rollbackEntryImport(
      actor,
      competition.id,
      division.id,
      committed.import_id,
      randomUUID(),
    );
    expect(firstRollback).toMatchObject({ removed: 2, idempotent_replay: false });
    expect(replay).toMatchObject({ removed: 0, idempotent_replay: true });
    const rollbackEvidence = required(
      await client<{ audits: number; outbox: number }[]>`
      SELECT (SELECT count(*)::int FROM audit_events WHERE target_id=${committed.import_id} AND action='entry_import.rolled_back') AS audits,
             (SELECT count(*)::int FROM outbox_events WHERE aggregate_id=${committed.import_id} AND event_type='entry_import.rolled_back') AS outbox`,
    );
    expect(rollbackEvidence).toEqual({ audits: 1, outbox: 1 });

    const entry = (await runtime.mutateEntry(
      actor,
      competition.id,
      division.id,
      { action: "create", name: "Withdraw me" },
      randomUUID(),
      randomUUID(),
    )) as { id: string };
    await expect(
      runtime.mutateEntry(
        actor,
        competition.id,
        division.id,
        { action: "withdraw", entryId: entry.id },
        randomUUID(),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await runtime.mutateEntry(
      actor,
      competition.id,
      division.id,
      { action: "withdraw", entryId: entry.id, reason: "Player unavailable" },
      randomUUID(),
      randomUUID(),
    );
    await runtime.mutateEntry(
      actor,
      competition.id,
      division.id,
      { action: "replace", entryId: entry.id, replacementName: "Replacement team" },
      randomUUID(),
      randomUUID(),
    );
    const lineage = required(
      await client<{ status: string; withdrawal_reason: string; replacement_entry_id: string; reciprocal: string }[]>`
      SELECT source.status,source.withdrawal_reason,source.replacement_entry_id,replacement.replaces_entry_id AS reciprocal
      FROM division_entries source JOIN division_entries replacement ON replacement.id=source.replacement_entry_id
      WHERE source.id=${entry.id}`,
    );
    expect(lineage.status).toBe("replaced");
    expect(lineage.withdrawal_reason).toBe("Player unavailable");
    expect(lineage.reciprocal).toBe(entry.id);
  });

  it("rejects archived nested writes and inconsistent competition slot durations at the database boundary", async () => {
    const actor = { accountId };
    const competition = await runtime.createCompetition(
      actor,
      {
        organisationId,
        name: "Guard Cup",
        slug: "guard-runtime",
        sportCode: "badminton",
        venue: "Hall",
        address: "4 Road",
        countryCode: "SG",
        startsOn: "2027-06-01",
        endsOn: "2027-06-02",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
    );
    const division = (await runtime.createDivision(
      actor,
      competition.id,
      { name: "Open", entryLimit: 8 },
      randomUUID(),
      randomUUID(),
    )) as { id: string };
    await expect(
      runtime.replaceCapacity(
        actor,
        competition.id,
        {
          revision: 1,
          areas: [
            { name: "Court 1", slotMinutes: 30, availability: [] },
            { name: "Court 2", slotMinutes: 20, availability: [] },
          ],
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "CAPACITY_SLOT_MISMATCH" });
    const area = randomUUID();
    await client`INSERT INTO playing_areas (id,competition_id,name,slot_minutes) VALUES (${area},${competition.id},'Court 1',30)`;
    await expect(
      client`INSERT INTO playing_areas (competition_id,name,slot_minutes) VALUES (${competition.id},'Court 2',20)`,
    ).rejects.toThrow(/one competition slot duration/i);
    await expect(client`UPDATE competitions SET status='completed' WHERE id=${competition.id}`).rejects.toThrow(
      /lifecycle transition is not allowed/i,
    );
    await runtime.mutateCompetition(actor, competition.id, { action: "archive", revision: 1 }, randomUUID());
    await expect(
      client`UPDATE competitions SET archived_from_status='ready' WHERE id=${competition.id}`,
    ).rejects.toThrow(/lifecycle state cannot change/i);
    await expect(client`UPDATE divisions SET name='Bypass' WHERE id=${division.id}`).rejects.toThrow(
      /archived competitions are immutable/i,
    );
    await expect(
      client`UPDATE competition_sport_settings SET settings_override='{}'::jsonb WHERE competition_id=${competition.id}`,
    ).rejects.toThrow(/archived competitions are immutable/i);
    await expect(client`DELETE FROM playing_areas WHERE id=${area}`).rejects.toThrow(
      /archived competitions are immutable/i,
    );
  });

  it("round-trips lossless capacity with optimistic concurrency, idempotency, and read permissions", async () => {
    const actor = { accountId };
    const competition = await runtime.createCompetition(
      actor,
      {
        organisationId,
        name: "Capacity Contract",
        slug: "capacity-contract-runtime",
        sportCode: "badminton",
        venue: "Hall",
        address: "7 Road",
        countryCode: "GB",
        startsOn: "2027-10-31",
        endsOn: "2027-10-31",
        timezone: "Europe/London",
        locale: "en-GB",
      },
      randomUUID(),
    );
    const areaId = randomUUID();
    const availableId = randomUUID();
    const unavailableId = randomUUID();
    const requestId = randomUUID();
    const first = await runtime.replaceCapacity(
      actor,
      competition.id,
      {
        revision: 1,
        timezone: "Europe/London",
        areas: [
          {
            id: areaId,
            name: "Court 1",
            sortOrder: 4,
            slotMinutes: 30,
            fixedReserveSlots: 2,
            availability: [{ id: availableId, date: "2027-10-31", startTime: "01:00", endTime: "03:00" }],
            unavailable: [{ id: unavailableId, date: "2027-10-31", startTime: "01:30", endTime: "02:00" }],
          },
        ],
      },
      requestId,
    );
    expect(first).toMatchObject({ revision: 2, timezone: "Europe/London", permission: "write", read_only: false });
    expect(first.areas[0]).toMatchObject({
      id: areaId,
      sort_order: 4,
      slot_minutes: 30,
      fixed_reserve_slots: 2,
      availability: [{ id: availableId, date: "2027-10-31", start_time: "01:00", end_time: "03:00" }],
      unavailable: [{ id: unavailableId, date: "2027-10-31", start_time: "01:30", end_time: "02:00" }],
    });
    const replay = await runtime.replaceCapacity(
      actor,
      competition.id,
      { revision: 1, timezone: "Europe/London", areas: [] },
      requestId,
    );
    expect(replay).toMatchObject({ revision: 2, idempotent_replay: true });
    expect(replay.areas).toEqual(first.areas);
    expect(
      required(
        await client<{ audits: number; outbox: number }[]>`SELECT
          (SELECT count(*)::int FROM audit_events WHERE request_id=${requestId} AND action='capacity.replaced') AS audits,
          (SELECT count(*)::int FROM outbox_events WHERE idempotency_key=${`${requestId}:capacity.replaced:${competition.id}`}) AS outbox`,
      ),
    ).toEqual({ audits: 1, outbox: 1 });

    const viewer = randomUUID();
    await client`INSERT INTO accounts (id,primary_email,display_name) VALUES (${viewer},${`${viewer}@example.test`},'Viewer')`;
    await client`INSERT INTO organisation_memberships (organisation_id,account_id,role,status)
      VALUES (${organisationId},${viewer},'viewer','active')`;
    expect(await runtime.capacity({ accountId: viewer }, competition.id)).toMatchObject({
      permission: "read",
      read_only: true,
    });
    await expect(
      runtime.replaceCapacity({ accountId: viewer }, competition.id, { revision: 2, areas: [] }, randomUUID()),
    ).rejects.toMatchObject({ code: "COMPETITION_ACCESS_DENIED" });
    await expect(
      runtime.replaceCapacity(actor, competition.id, { revision: 1, areas: [] }, randomUUID()),
    ).rejects.toMatchObject({ code: "CAPACITY_REVISION_CONFLICT", statusCode: 409 });

    const roundTrip = {
      revision: first.revision,
      timezone: first.timezone,
      areas: first.areas.map((area) => ({
        id: area.id,
        name: area.name,
        sortOrder: area.sort_order,
        slotMinutes: area.slot_minutes,
        fixedReserveSlots: area.fixed_reserve_slots,
        availability: area.availability.map((window) => ({
          id: window.id,
          date: window.date,
          startTime: window.start_time,
          endTime: window.end_time,
          crossMidnight: window.cross_midnight,
        })),
        unavailable: area.unavailable.map((window) => ({
          id: window.id,
          date: window.date,
          startTime: window.start_time,
          endTime: window.end_time,
          crossMidnight: window.cross_midnight,
        })),
      })),
    };
    const second = await runtime.replaceCapacity(actor, competition.id, roundTrip, randomUUID());
    expect(second).toMatchObject({ revision: 3, areas: first.areas });
    const attempts = await Promise.allSettled([
      runtime.replaceCapacity(actor, competition.id, { ...roundTrip, revision: 3 }, randomUUID()),
      runtime.replaceCapacity(actor, competition.id, { ...roundTrip, revision: 3 }, randomUUID()),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect((await runtime.capacity(actor, competition.id)).revision).toBe(4);
  });

  it("uses per-area reserves and aggregate lifecycle format demand for capacity feasibility", async () => {
    const actor = { accountId };
    const competition = await runtime.createCompetition(
      actor,
      {
        organisationId,
        name: "Shared Capacity Cup",
        slug: "shared-capacity-runtime",
        sportCode: "badminton",
        venue: "Shared Hall",
        address: "8 Capacity Road",
        countryCode: "SG",
        startsOn: "2027-11-01",
        endsOn: "2027-11-01",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
    );
    const firstDivision = (await runtime.createDivision(
      actor,
      competition.id,
      { name: "Open", entryLimit: 8 },
      randomUUID(),
      randomUUID(),
    )) as { id: string };
    const secondDivision = (await runtime.createDivision(
      actor,
      competition.id,
      { name: "Women", entryLimit: 8 },
      randomUUID(),
      randomUUID(),
    )) as { id: string };

    const empty = await runtime.replaceCapacity(
      actor,
      competition.id,
      {
        revision: 1,
        areas: [
          {
            name: "Short court",
            slotMinutes: 30,
            fixedReserveSlots: 5,
            availability: [{ date: "2027-11-01", startTime: "08:00", endTime: "09:00" }],
          },
          {
            name: "Long court",
            slotMinutes: 30,
            fixedReserveSlots: 1,
            availability: [{ date: "2027-11-01", startTime: "08:00", endTime: "11:00" }],
          },
        ],
      },
      randomUUID(),
    );
    expect(empty.effective).toMatchObject({
      rawTotalSlots: 8,
      fixedReserveSlots: 6,
      availableMatchSlots: 5,
      requiredMatchSlots: 0,
      status: "comfortable",
    });

    const expanded = await runtime.replaceCapacity(
      actor,
      competition.id,
      {
        revision: empty.revision,
        areas: [
          {
            name: "Main court",
            slotMinutes: 30,
            availability: [{ date: "2027-11-01", startTime: "00:00", endTime: "20:00" }],
          },
        ],
      },
      randomUUID(),
    );
    expect(expanded.effective).toMatchObject({ availableMatchSlots: 40, requiredMatchSlots: 0 });

    const graph = createRoundRobinFormatGraph(8);
    const firstFormat = await runtime.createFormatRevision(
      actor,
      competition.id,
      firstDivision.id,
      { ...graph, id: "capacity-first" },
      randomUUID(),
    );
    expect(firstFormat).toMatchObject({
      required_match_slots: 28,
      available_match_slots: 40,
      recommendation_fits_capacity: true,
    });
    await runtime.publishFormat(actor, competition.id, firstFormat.id, firstFormat.definition_hash, randomUUID());

    const secondFormat = await runtime.createFormatRevision(
      actor,
      competition.id,
      secondDivision.id,
      { ...graph, id: "capacity-second" },
      randomUUID(),
    );
    expect(secondFormat).toMatchObject({
      required_match_slots: 56,
      available_match_slots: 40,
      recommendation_fits_capacity: false,
    });
    expect((await runtime.capacity(actor, competition.id)).effective).toMatchObject({
      requiredMatchSlots: 56,
      remainingMatchSlots: -16,
      status: "does_not_fit",
    });
    await expect(
      runtime.publishFormat(actor, competition.id, secondFormat.id, secondFormat.definition_hash, randomUUID()),
    ).rejects.toMatchObject({ code: "CAPACITY_INSUFFICIENT", statusCode: 422 });
  });

  it("rejects publication when capacity changed after format validation", async () => {
    const actor = { accountId };
    const competition = await runtime.createCompetition(
      actor,
      {
        organisationId,
        name: "Stale Capacity Cup",
        slug: "stale-capacity-runtime",
        sportCode: "badminton",
        venue: "Stale Hall",
        address: "9 Capacity Road",
        countryCode: "SG",
        startsOn: "2027-11-02",
        endsOn: "2027-11-02",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
    );
    const division = (await runtime.createDivision(
      actor,
      competition.id,
      { name: "Open", entryLimit: 8 },
      randomUUID(),
      randomUUID(),
    )) as { id: string };
    const initial = await runtime.replaceCapacity(
      actor,
      competition.id,
      {
        revision: 1,
        areas: [
          {
            name: "Court",
            slotMinutes: 30,
            availability: [{ date: "2027-11-02", startTime: "08:00", endTime: "22:00" }],
          },
        ],
      },
      randomUUID(),
    );
    const graph = createRoundRobinFormatGraph(8);
    const format = await runtime.createFormatRevision(
      actor,
      competition.id,
      division.id,
      { ...graph, id: "stale-capacity" },
      randomUUID(),
    );
    expect((await runtime.capacity(actor, competition.id)).effective.status).toBe("tight");
    await runtime.replaceCapacity(
      actor,
      competition.id,
      {
        revision: initial.revision,
        areas: [
          {
            name: "Court",
            slotMinutes: 30,
            availability: [{ date: "2027-11-02", startTime: "08:00", endTime: "21:30" }],
          },
        ],
      },
      randomUUID(),
    );
    expect((await runtime.capacity(actor, competition.id)).effective.status).toBe("does_not_fit");
    await expect(
      runtime.publishFormat(actor, competition.id, format.id, format.definition_hash, randomUUID()),
    ).rejects.toMatchObject({ code: "FORMAT_CAPACITY_STALE", statusCode: 409 });
  });

  it("enforces the real platform-admin boundary for immutable sport-pack draft activation", async () => {
    const nonAdmin = randomUUID();
    const expiredAdmin = randomUUID();
    const revokedAdmin = randomUUID();
    await client`INSERT INTO accounts (id,primary_email,display_name) VALUES
      (${nonAdmin},${`${nonAdmin}@example.test`},'Non Admin'),
      (${expiredAdmin},${`${expiredAdmin}@example.test`},'Expired Admin'),
      (${revokedAdmin},${`${revokedAdmin}@example.test`},'Revoked Admin')`;
    await client`INSERT INTO account_platform_roles
      (account_id,role,granted_at,expires_at,revoked_at,reason,granted_by) VALUES
      (${expiredAdmin},'platform_admin',now() - interval '2 days',now() - interval '1 day',NULL,'Expired test grant',${accountId}),
      (${revokedAdmin},'platform_admin',now() - interval '2 days',NULL,now() - interval '1 day','Revoked test grant',${accountId})`;
    const definition = { ...SPORT_PACKS.badminton, version: "0.1.0-admin-test.1" };
    await expect(runtime.createSportPackDraft({ accountId: nonAdmin }, definition, randomUUID())).rejects.toMatchObject(
      {
        code: "PLATFORM_ADMIN_REQUIRED",
      },
    );
    await expect(
      runtime.createSportPackDraft({ accountId: expiredAdmin }, definition, randomUUID()),
    ).rejects.toMatchObject({ code: "PLATFORM_ADMIN_REQUIRED" });
    await expect(
      runtime.createSportPackDraft({ accountId: revokedAdmin }, definition, randomUUID()),
    ).rejects.toMatchObject({ code: "PLATFORM_ADMIN_REQUIRED" });
    await client`INSERT INTO account_platform_roles (account_id,role,reason,granted_by)
      VALUES (${accountId},'platform_admin','Phase 3 contract test',${accountId})`;
    const oldCompetition = await runtime.createCompetition(
      { accountId },
      {
        organisationId,
        name: "Pinned Before Activation",
        slug: `pinned-before-${randomUUID()}`,
        sportCode: "badminton",
        venue: "Hall",
        address: "1 Pack Road",
        countryCode: "SG",
        startsOn: "2027-07-01",
        endsOn: "2027-07-01",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
    );
    const requestId = randomUUID();
    expect(await runtime.createSportPackDraft({ accountId }, definition, requestId)).toMatchObject({
      sport_code: "badminton",
      status: "draft",
      revision: 1,
      idempotent_replay: false,
    });
    expect(await runtime.createSportPackDraft({ accountId }, {}, requestId)).toMatchObject({ idempotent_replay: true });
    expect(await runtime.readSportPackAdmin({ accountId }, "badminton", definition.version)).toMatchObject({
      status: "draft",
      revision: 1,
      read_only: true,
    });
    const activeBefore = await client<{ version: string }[]>`
      SELECT version FROM sport_pack_versions WHERE sport_code='badminton' AND status='active'`;
    const expectedActiveVersion = activeBefore[0]?.version ?? null;
    await expect(
      runtime.activateSportPack({ accountId }, "badminton", definition.version, 2, expectedActiveVersion, randomUUID()),
    ).rejects.toMatchObject({ code: "SPORT_PACK_REVISION_CONFLICT" });
    const activationRequest = randomUUID();
    expect(
      await runtime.activateSportPack(
        { accountId },
        "badminton",
        definition.version,
        1,
        expectedActiveVersion,
        activationRequest,
      ),
    ).toMatchObject({
      status: "active",
      revision: 2,
      idempotent_replay: false,
    });
    expect(
      await runtime.activateSportPack(
        { accountId },
        "badminton",
        definition.version,
        1,
        expectedActiveVersion,
        activationRequest,
      ),
    ).toMatchObject({
      idempotent_replay: true,
    });
    const newCompetition = await runtime.createCompetition(
      { accountId },
      {
        organisationId,
        name: "Pinned After Activation",
        slug: `pinned-after-${randomUUID()}`,
        sportCode: "badminton",
        venue: "Hall",
        address: "2 Pack Road",
        countryCode: "SG",
        startsOn: "2027-07-02",
        endsOn: "2027-07-02",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
    );
    const pins = await client<{ competition_id: string; pack_version: string }[]>`
      SELECT competition_id,pack_version FROM competition_sport_settings
      WHERE competition_id IN (${oldCompetition.id},${newCompetition.id}) ORDER BY competition_id`;
    expect(pins.find((pin) => pin.competition_id === oldCompetition.id)?.pack_version).toBe(expectedActiveVersion);
    expect(pins.find((pin) => pin.competition_id === newCompetition.id)?.pack_version).toBe(definition.version);
    await expect(
      client`UPDATE sport_pack_versions SET definition='{}'::jsonb WHERE sport_code='badminton' AND version=${definition.version}`,
    ).rejects.toThrow(/sport pack version content is immutable/);
    if (expectedActiveVersion) {
      await expect(
        client`UPDATE sport_pack_versions SET definition='{}'::jsonb
          WHERE sport_code='badminton' AND version=${expectedActiveVersion}`,
      ).rejects.toThrow(/superseded sport pack versions are immutable/);
    }
    const audit = await client<{ actor_type: string; action: string }[]>`
      SELECT actor_type,action FROM audit_events
      WHERE request_id IN (${requestId},${activationRequest}) ORDER BY action`;
    expect(audit).toEqual([
      { actor_type: "platform_admin", action: "sport_pack.activated" },
      { actor_type: "platform_admin", action: "sport_pack.drafted" },
    ]);
  });

  it("serializes competing sport-pack activations and blocks adoption when no active pack exists", async () => {
    const actor = { accountId };
    await client`INSERT INTO account_platform_roles (account_id,role,reason,granted_by)
      SELECT ${accountId},'platform_admin','Sport pack concurrency test',${accountId}
      WHERE NOT EXISTS (
        SELECT 1 FROM account_platform_roles
        WHERE account_id=${accountId} AND role='platform_admin' AND revoked_at IS NULL
      )`;
    for (const sportCode of ["volleyball", "basketball"] as const) {
      await runtime.createCompetition(
        actor,
        {
          organisationId,
          name: `${sportCode} bootstrap`,
          slug: `${sportCode}-bootstrap-${randomUUID()}`,
          sportCode,
          venue: "Hall",
          address: "Bootstrap Road",
          countryCode: "SG",
          startsOn: "2027-07-01",
          endsOn: "2027-07-01",
          timezone: "Asia/Singapore",
          locale: "en-SG",
        },
        randomUUID(),
      );
    }
    const active = required(
      await client<{ version: string }[]>`
        SELECT version FROM sport_pack_versions WHERE sport_code='volleyball' AND status='active'`,
    );
    const candidates = ["0.1.0-concurrent-a", "0.1.0-concurrent-b"] as const;
    for (const version of candidates) {
      await runtime.createSportPackDraft(actor, { ...SPORT_PACKS.volleyball, version }, randomUUID());
    }
    const attempts = await Promise.allSettled(
      candidates.map((version) =>
        runtime.activateSportPack(actor, "volleyball", version, 1, active.version, randomUUID()),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({
      reason: { code: "SPORT_PACK_ACTIVE_VERSION_CONFLICT", statusCode: 409 },
    });
    const activeRows = await client<{ version: string }[]>`
      SELECT version FROM sport_pack_versions WHERE sport_code='volleyball' AND status='active'`;
    expect(activeRows).toHaveLength(1);
    expect(candidates).toContain(activeRows[0]?.version);

    const basketballActive = required(
      await client<{ version: string }[]>`
        SELECT version FROM sport_pack_versions WHERE sport_code='basketball' AND status='active'`,
    );
    const successorVersion = "0.1.0-no-active-successor";
    await runtime.createSportPackDraft(actor, { ...SPORT_PACKS.basketball, version: successorVersion }, randomUUID());
    await client`UPDATE sport_pack_versions SET
      status='superseded', revision=revision+1, superseded_at=now(), superseded_by=${accountId},
      superseded_by_version=${successorVersion}
      WHERE sport_code='basketball' AND version=${basketballActive.version}`;
    await expect(
      runtime.createCompetition(
        actor,
        {
          organisationId,
          name: "No Active Pack",
          slug: `no-active-pack-${randomUUID()}`,
          sportCode: "basketball",
          venue: "Hall",
          address: "3 Pack Road",
          countryCode: "SG",
          startsOn: "2027-07-03",
          endsOn: "2027-07-03",
          timezone: "Asia/Singapore",
          locale: "en-SG",
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "SPORT_PACK_NOT_ACTIVE", statusCode: 409 });
  });

  it("rejects DST gaps and persists the documented earlier instant for DST folds", async () => {
    const actor = { accountId };
    const gapCompetition = await runtime.createCompetition(
      actor,
      {
        organisationId,
        name: "DST Gap",
        slug: "dst-gap-runtime",
        sportCode: "badminton",
        venue: "Hall",
        address: "5 Road",
        countryCode: "GB",
        startsOn: "2027-03-28",
        endsOn: "2027-03-28",
        timezone: "Europe/London",
        locale: "en-GB",
      },
      randomUUID(),
    );
    await expect(
      runtime.replaceCapacity(
        actor,
        gapCompetition.id,
        {
          revision: 1,
          areas: [
            {
              name: "Court",
              slotMinutes: 30,
              availability: [{ date: "2027-03-28", startTime: "01:30", endTime: "03:00" }],
            },
          ],
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "CAPACITY_INVALID" });

    const foldCompetition = await runtime.createCompetition(
      actor,
      {
        organisationId,
        name: "DST Fold",
        slug: "dst-fold-runtime",
        sportCode: "badminton",
        venue: "Hall",
        address: "6 Road",
        countryCode: "GB",
        startsOn: "2027-10-31",
        endsOn: "2027-10-31",
        timezone: "Europe/London",
        locale: "en-GB",
      },
      randomUUID(),
    );
    await runtime.replaceCapacity(
      actor,
      foldCompetition.id,
      {
        revision: 1,
        areas: [
          {
            name: "Court",
            slotMinutes: 30,
            availability: [{ date: "2027-10-31", startTime: "01:00", endTime: "02:00" }],
          },
        ],
      },
      randomUUID(),
    );
    const interval = required(
      await client<{ starts_at: string; ends_at: string }[]>`
      SELECT to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
             to_char(ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at
      FROM competition_availability_windows WHERE competition_id=${foldCompetition.id}`,
    );
    expect(interval).toEqual({ starts_at: "2027-10-31T00:00:00Z", ends_at: "2027-10-31T02:00:00Z" });
  });
});
