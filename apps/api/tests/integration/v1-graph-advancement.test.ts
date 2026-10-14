import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SPORT_PACKS, createDefaultFormatTemplates, type FormatParticipantSource } from "@matchday/domain";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import type { PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../../src/phase-2-runtime.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_v1_advancement_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
const sportId = "basketball" as const;

let sql!: Sql;
let runtime!: Phase2Runtime;
let accountId = "";
let organisationId = "";

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  sql = postgres(databaseUrl, { max: 4, onnotice: () => undefined, connection: { search_path: schema } });
  accountId = (
    await sql<{ id: string }[]>`
      INSERT INTO accounts(primary_email,display_name,email_verified_at)
      VALUES(${`v1-${randomUUID()}@example.test`},'V1 organiser',now()) RETURNING id`
  )[0]!.id;
  await sql.begin(async (tx) => {
    organisationId = (
      await tx<{ id: string }[]>`
        INSERT INTO organisations(name,slug) VALUES('V1 organisation',${`v1-${randomUUID()}`}) RETURNING id`
    )[0]!.id;
    await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
      VALUES(${organisationId},${accountId},'owner','active')`;
  });
  for (const packSport of ["basketball", "badminton"] as const) {
    const pack = SPORT_PACKS[packSport];
    const definition = {
      recommendedSettings: pack.recommendedSettings,
      recommendedSlotMinutes: Number(pack.recommendedSettings.slotMinutes ?? 30),
    };
    const [hash] = await sql<{ value: string }[]>`SELECT phase4_sha256_json(${sql.json(definition)}) value`;
    await sql`INSERT INTO sport_pack_versions(sport_code,version,schema_version,definition,definition_hash,status,activated_at)
      VALUES(${packSport},${pack.version},1,${sql.json(definition)},${hash!.value},'active',now())`;
  }
  runtime = new Phase2Runtime(
    sql as unknown as PostgresJsSql,
    phase2DomainAdapter,
    undefined,
    undefined,
    "v1-advancement-fallback-hmac-secret",
  );
});

afterAll(async () => {
  await sql?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

/** Opens a canonical scoring writer on one match. */
async function scorer(competitionId: string, matchId: string, index: number) {
  const pass = await runtime.createAccessPass(
    { accountId },
    competitionId,
    matchId,
    {
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      role: "scorekeeper",
      idempotencyKey: `v1-${randomUUID()}`,
    },
    randomUUID(),
  );
  if (!pass.token) throw new Error("Expected one-time access token");
  const writer = await runtime.exchangeAccess(
    { token: pass.token, deviceId: randomUUID(), ipAddress: `198.51.100.${(index % 250) + 1}` },
    randomUUID(),
  );
  if (!writer.generation) throw new Error("Expected writer generation");
  const auth = { sessionId: writer.session_id, sessionToken: writer.session_token, generation: writer.generation };
  let version = 0;
  const append = async (command: Record<string, unknown>) => {
    const receipt = await runtime.appendCanonicalScoreEvent(
      auth,
      { client_event_id: randomUUID(), occurred_at: new Date().toISOString(), ...command },
      version,
      randomUUID(),
    );
    version = receipt.aggregate_version;
  };
  const finalise = () => runtime.finalise(auth, randomUUID(), randomUUID(), version);
  return { append, finalise };
}

/** Scores one match through the canonical scoring stream: the home side wins 3-0. */
async function playHomeWin(competitionId: string, matchId: string, index: number) {
  const writer = await scorer(competitionId, matchId, index);
  await writer.append({ type: "match_started" });
  await writer.append({
    type: "three_point_score",
    team_slot: "home",
    participant_id: "Player 3",
    segment_number: 1,
    manual_time_seconds: 25,
  });
  for (const segment of [2, 3, 4]) {
    await writer.append({ type: "period_change", segment_number: segment, manual_time_seconds: 0 });
  }
  return writer.finalise();
}

/** Badminton best-of-3 won 21-0, 21-0 by the home side. */
async function playBadmintonHomeWin(competitionId: string, matchId: string, index: number) {
  const writer = await scorer(competitionId, matchId, index);
  await writer.append({ type: "match_started" });
  for (const segment of [1, 2]) {
    for (let point = 0; point < 21; point += 1) {
      await writer.append({ type: "point", team_slot: "home", segment_number: segment });
    }
    await writer.append({ type: "game_completion", team_slot: "home", segment_number: segment });
  }
  return writer.finalise();
}

/** Records a walkover: the declared winner takes the sport's forfeit score. */
async function playWalkover(competitionId: string, matchId: string, index: number, winner: "home" | "away") {
  const writer = await scorer(competitionId, matchId, index);
  await writer.append({ type: "match_started" });
  await writer.append({ type: "walkover", team_slot: winner });
  return writer.finalise();
}

type MatchRow = {
  id: string;
  graph_match_id: string;
  graph_pool_id: string | null;
  graph_purpose: string | null;
  state: string;
  home_entry_id: string | null;
  away_entry_id: string | null;
};

type BracketSnapshot = {
  matches: Array<{
    matchId: string;
    homeEntryId: string | null;
    awayEntryId: string | null;
    winnerEntryId: string | null;
    loserEntryId: string | null;
  }>;
  qualifiedEntryIds: string[];
  championEntryId: string | null;
  runnerUpEntryId: string | null;
};

type Strategy = "championship-focus" | "full-placement" | "compact-knockout";

/** Snapshot JSON is written through a jsonb parameter, so it may arrive as a JSON string. */
const jsonValue = <T>(value: T | string): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

/** Creates a published 8-entry event on one default V1 template. */
async function createEvent(strategy: Strategy, sport: "basketball" | "badminton" = sportId) {
  const actor = { accountId };
  const competition = await runtime.createCompetition(
    actor,
    {
      organisationId,
      name: `V1 ${strategy} Cup`,
      slug: `v1-${strategy}-${randomUUID()}`,
      timezone: "Asia/Singapore",
      startsOn: "2027-03-01",
      endsOn: "2027-03-01",
    },
    randomUUID(),
  );
  await sql`UPDATE competitions SET sport_code=${sport} WHERE id=${competition.id}`;
  await sql`UPDATE competition_sport_settings SET
    sport_code=${sport},pack_version=${SPORT_PACKS[sport].version},
    recommended_snapshot=${sql.json(SPORT_PACKS[sport].recommendedSettings)},settings_override='{}'::jsonb
    WHERE competition_id=${competition.id}`;
  const division = await runtime.createDivision(actor, competition.id, { name: "Open", teamLimit: 8 }, randomUUID());
  await sql`UPDATE division_sport_settings SET sport_code=${sport},pack_version=${SPORT_PACKS[sport].version}
    WHERE division_id=${division.id}`;
  await runtime.replaceEntries(
    actor,
    competition.id,
    division.id,
    Array.from({ length: 8 }, (_, index) => ({ name: `Team ${index + 1}`, seed: index + 1 })),
    randomUUID(),
  );
  await runtime.replaceCapacity(
    actor,
    competition.id,
    [{ name: "Court 1", windows: [{ startsAt: "2027-03-01T00:00:00.000Z", endsAt: "2027-03-01T14:00:00.000Z" }] }],
    randomUUID(),
  );
  const template = createDefaultFormatTemplates(8).find((candidate) => candidate.graph.id.includes(strategy));
  if (!template) throw new Error(`Expected the ${strategy} default template`);
  const graph = template.graph;
  const formatId = randomUUID();
  await sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract)
    VALUES(${formatId},${competition.id},${division.id},1,${sql.json(graph)},
      phase4_sha256_json(${sql.json(graph)}::jsonb),${accountId},'phase3')`;
  await sql`SELECT phase4_materialize_format_revision(${formatId})`;
  await sql`INSERT INTO format_validation_evidence(format_revision_id,definition_hash,valid,graph_acyclic,graph_reachable,
      slots_unambiguous,deterministic_match_count,available_match_slots,required_match_slots,recommendation_fits_capacity,validated_by)
    SELECT id,definition_hash,true,true,true,true,${graph.matches.length},
      phase3_available_match_slots(competition_id),
      jsonb_array_length(definition->'matches')+phase3_selected_format_required_slots(competition_id,division_id),
      true,${accountId}
    FROM format_revisions WHERE id=${formatId}`;
  const schedule = await runtime.generateSchedule(actor, competition.id, formatId, randomUUID());
  await runtime.publishSchedule(actor, competition.id, schedule.id, randomUUID());

  const loadMatches = async () =>
    sql<MatchRow[]>`SELECT id,graph_match_id,graph_pool_id,graph_purpose,state,home_entry_id,away_entry_id
      FROM matches WHERE format_revision_id=${formatId} ORDER BY ordinal`;
  const nextPlayable = async () =>
    (await loadMatches()).find(
      (match) => match.home_entry_id && match.away_entry_id && ["pending", "ready"].includes(match.state),
    );
  const finalGraphId = graph.terminalMatchIds.find(
    (id) => graph.matches.find((match) => match.id === id)?.purpose === "championship",
  );
  const championshipFinal = async () => {
    const final = (await loadMatches()).find((match) => match.graph_match_id === finalGraphId);
    if (!final) throw new Error("Expected the championship final");
    return final;
  };
  /** The latest persisted bracket snapshot for the division. */
  const latestBracket = async () => {
    const [row] = await sql<{ bracket: BracketSnapshot | string }[]>`
      SELECT bracket FROM bracket_snapshots WHERE division_id=${division.id}
      ORDER BY result_version DESC, created_at DESC LIMIT 1`;
    if (!row) throw new Error("Expected a bracket snapshot");
    return jsonValue(row.bracket);
  };
  /** The bracket as the public projection publishes it. */
  const publicBracket = async () => {
    type Projection = { bracket: { bracket: BracketSnapshot | string } | null };
    const [row] = await sql<{ projection: Projection | string }[]>`
      SELECT projection FROM public_competition_projections WHERE competition_id=${competition.id}
      ORDER BY result_version DESC LIMIT 1`;
    const projection = row ? jsonValue(row.projection) : null;
    if (!projection?.bracket) throw new Error("Expected a public bracket projection");
    return jsonValue(projection.bracket.bracket);
  };
  return {
    actor,
    competitionId: competition.id,
    divisionId: division.id,
    graph,
    loadMatches,
    nextPlayable,
    championshipFinal,
    latestBracket,
    publicBracket,
  };
}

describeInfrastructure("V1 graph group-stage to knockout advancement", () => {
  for (const strategy of ["championship-focus", "full-placement", "compact-knockout"] as const) {
    it(`plays a default ${strategy} event to the final, fills every knockout slot and names the champion`, async () => {
      const event = await createEvent(strategy);
      const graph = event.graph;

      // Play every match whose participants are resolved until nothing is left.
      let played = 0;
      for (let next = await event.nextPlayable(); next; next = await event.nextPlayable()) {
        await playHomeWin(event.competitionId, next.id, played);
        played += 1;
      }

      const matches = await event.loadMatches();
      const byGraphId = new Map(matches.map((match) => [match.graph_match_id, match]));
      expect(played).toBe(graph.matches.length);
      expect(matches.every((match) => match.state === "final")).toBe(true);

      // Pool wins, to check rank sources: home always wins.
      const poolWins = new Map<string, Map<string, number>>();
      for (const match of matches.filter((candidate) => candidate.graph_pool_id)) {
        const wins = poolWins.get(match.graph_pool_id!) ?? new Map<string, number>();
        wins.set(match.home_entry_id!, (wins.get(match.home_entry_id!) ?? 0) + 1);
        wins.set(match.away_entry_id!, wins.get(match.away_entry_id!) ?? 0);
        poolWins.set(match.graph_pool_id!, wins);
      }
      const expectedEntry = (source: FormatParticipantSource): string | undefined => {
        if (source.type === "winner") return byGraphId.get(source.matchId)?.home_entry_id ?? undefined;
        if (source.type === "loser") return byGraphId.get(source.matchId)?.away_entry_id ?? undefined;
        return undefined;
      };
      for (const graphMatch of graph.matches.filter((candidate) => candidate.purpose !== "pool")) {
        const match = byGraphId.get(graphMatch.id)!;
        for (const slot of ["home", "away"] as const) {
          const source = graphMatch[slot];
          const entryId = match[`${slot}_entry_id`];
          expect(entryId, `${graphMatch.id}:${slot}`).not.toBeNull();
          if (source.type === "stage_rank") {
            const wins = poolWins.get(source.groupId!)!;
            expect(wins.has(entryId!)).toBe(true);
            const ranked = [...wins.values()].sort((left, right) => right - left);
            expect(wins.get(entryId!)).toBe(ranked[source.rank - 1]);
          } else if (source.type !== "entry_seed") {
            expect(entryId).toBe(expectedEntry(source));
          }
        }
      }
      const slots = await sql<{ control: string; entry_id: string | null }[]>`
        SELECT control,entry_id FROM advancement_slots WHERE division_id=${event.divisionId}`;
      const derivedSlotCount = graph.matches
        .flatMap((match) => [match.home, match.away])
        .filter((source) => source.type !== "entry_seed").length;
      expect(slots).toHaveLength(derivedSlotCount);
      expect(slots.every((slot) => slot.control === "automatic" && slot.entry_id !== null)).toBe(true);

      // The finalised championship final decides the champion and runner-up,
      // in the persisted bracket and in the public projection alike.
      const final = await event.championshipFinal();
      const knockoutEntryIds = new Set(
        matches
          .filter((match) => match.graph_purpose !== "pool")
          .flatMap((match) => [match.home_entry_id, match.away_entry_id]),
      );
      for (const bracket of [await event.latestBracket(), await event.publicBracket()]) {
        expect(bracket.championEntryId).toBe(final.home_entry_id);
        expect(bracket.runnerUpEntryId).toBe(final.away_entry_id);
        expect(bracket.matches.find((match) => match.matchId === final.id)).toMatchObject({
          homeEntryId: final.home_entry_id,
          awayEntryId: final.away_entry_id,
          winnerEntryId: final.home_entry_id,
          loserEntryId: final.away_entry_id,
        });
        expect(new Set(bracket.qualifiedEntryIds)).toEqual(knockoutEntryIds);
      }
    });
  }

  it("keeps the champion undecided until the final is played, then follows a correction of the final", async () => {
    const event = await createEvent("championship-focus");
    let played = 0;
    for (let next = await event.nextPlayable(); next; next = await event.nextPlayable()) {
      if (next.id === (await event.championshipFinal()).id) break;
      await playHomeWin(event.competitionId, next.id, played);
      played += 1;
    }
    const final = await event.championshipFinal();
    expect(final.state).toBe("ready");
    expect((await event.latestBracket()).championEntryId).toBeNull();
    expect((await event.publicBracket()).championEntryId).toBeNull();

    await playHomeWin(event.competitionId, final.id, played);
    expect((await event.latestBracket()).championEntryId).toBe(final.home_entry_id);

    // An organiser correction awards the away side two more baskets (6-3):
    // the champion and runner-up swap in the recalculated bracket.
    const audit = await runtime.matchScoringAudit(event.actor, event.competitionId, final.id);
    const score = audit.score as { current_segment: number };
    await runtime.correctCanonicalMatch(
      event.actor,
      event.competitionId,
      final.id,
      {
        clientEventId: randomUUID(),
        reason: "Scoresheet review: away baskets were missed",
        expectedAggregateVersion: audit.aggregate_version as number,
        events: [1, 2].map(() => ({
          client_event_id: randomUUID(),
          type: "three_point_score",
          occurred_at: new Date().toISOString(),
          team_slot: "away",
          participant_id: "Player 7",
          segment_number: score.current_segment,
          manual_time_seconds: 0,
        })),
      },
      randomUUID(),
    );
    for (const bracket of [await event.latestBracket(), await event.publicBracket()]) {
      expect(bracket.championEntryId).toBe(final.away_entry_id);
      expect(bracket.runnerUpEntryId).toBe(final.home_entry_id);
    }
  });

  it("crowns the declared winner of a walkover final", async () => {
    // Badminton supports the walkover command; basketball does not.
    const event = await createEvent("compact-knockout", "badminton");
    let played = 0;
    for (let next = await event.nextPlayable(); next; next = await event.nextPlayable()) {
      if (next.id === (await event.championshipFinal()).id) {
        await playWalkover(event.competitionId, next.id, played, "away");
      } else {
        await playBadmintonHomeWin(event.competitionId, next.id, played);
      }
      played += 1;
    }
    const final = await event.championshipFinal();
    expect(final.state).toBe("final");
    for (const bracket of [await event.latestBracket(), await event.publicBracket()]) {
      expect(bracket.championEntryId).toBe(final.away_entry_id);
      expect(bracket.runnerUpEntryId).toBe(final.home_entry_id);
    }
  });
});
