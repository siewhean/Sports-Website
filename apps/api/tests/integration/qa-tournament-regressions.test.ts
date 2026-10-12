import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SPORT_PACKS, createDefaultFormatTemplates, type FormatGraph, type SportId } from "@matchday/domain";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import type { PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../../src/phase-2-runtime.js";
import { phase3DomainAdapter } from "../../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../../src/phase-3-runtime.js";
import { MatchReminderSweeper } from "../../src/match-notifications.js";
import {
  EmailOutboxProcessor,
  PostgresNotificationRepository,
  createNodemailerSmtpEmailProvider,
} from "@matchday/notifications";

// Regressions from the mock-tournament QA run: walkover results, mid-group
// withdrawal, manual standings recalculation of knockout slots, and 422s for
// malformed scoring commands.
const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_qa_regressions_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);

let sql!: Sql;
let runtime!: Phase2Runtime;
let phase3!: Phase3Runtime;
let accountId = "";
let organisationId = "";

type MatchRow = {
  id: string;
  graph_match_id: string;
  graph_purpose: string | null;
  state: string;
  home_entry_id: string | null;
  away_entry_id: string | null;
};

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  sql = postgres(databaseUrl, { max: 4, onnotice: () => undefined, connection: { search_path: schema } });
  accountId = (
    await sql<{ id: string }[]>`
      INSERT INTO accounts(primary_email,display_name,email_verified_at)
      VALUES(${`qa-${randomUUID()}@example.test`},'QA organiser',now()) RETURNING id`
  )[0]!.id;
  await sql.begin(async (tx) => {
    organisationId = (
      await tx<{ id: string }[]>`
        INSERT INTO organisations(name,slug) VALUES('QA organisation',${`qa-${randomUUID()}`}) RETURNING id`
    )[0]!.id;
    await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
      VALUES(${organisationId},${accountId},'owner','active')`;
  });
  for (const sportId of ["badminton", "basketball"] as const) {
    // The full pack, as the organiser bootstrap pins it: withdrawal and manual
    // recalculation resolve settings against the pinned definition.
    const pack = SPORT_PACKS[sportId];
    await sql`INSERT INTO sport_pack_versions(sport_code,version,schema_version,definition,definition_hash,status,activated_at)
      VALUES(${sportId},${pack.version},${pack.schemaVersion},${sql.json(JSON.parse(JSON.stringify(pack)))},
        ${phase3DomainAdapter.hash(pack)},'active',now())`;
  }
  runtime = new Phase2Runtime(
    sql as unknown as PostgresJsSql,
    phase2DomainAdapter,
    undefined,
    undefined,
    "qa-regressions-fallback-hmac-secret",
  );
  phase3 = new Phase3Runtime(sql as unknown as PostgresJsSql, phase3DomainAdapter);
});

afterAll(async () => {
  await sql?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

/** An 8-entry championship-focus event (two pools, then semis, final and bronze) with a published schedule. */
async function championshipEvent(sportId: SportId) {
  const actor = { accountId };
  const competition = await runtime.createCompetition(
    actor,
    {
      organisationId,
      name: `QA ${sportId}`,
      slug: `qa-${sportId}-${randomUUID()}`,
      timezone: "Asia/Singapore",
      startsOn: "2027-03-01",
      endsOn: "2027-03-01",
    },
    randomUUID(),
  );
  await sql`UPDATE competitions SET sport_code=${sportId} WHERE id=${competition.id}`;
  await sql`UPDATE competition_sport_settings SET
    sport_code=${sportId},pack_version=${SPORT_PACKS[sportId].version},
    recommended_snapshot=${sql.json(SPORT_PACKS[sportId].recommendedSettings)},settings_override='{}'::jsonb
    WHERE competition_id=${competition.id}`;
  const division = await runtime.createDivision(actor, competition.id, { name: "Open", teamLimit: 8 }, randomUUID());
  await sql`UPDATE division_sport_settings SET sport_code=${sportId},pack_version=${SPORT_PACKS[sportId].version}
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
  const template = createDefaultFormatTemplates(8).find((candidate) => candidate.graph.id.includes("championship"));
  if (!template) throw new Error("Expected the championship-focus default template");
  const graph: FormatGraph = template.graph;
  const formatId = randomUUID();
  await sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract)
    VALUES(${formatId},${competition.id},${division.id},1,${sql.json(graph as never)},
      phase4_sha256_json(${sql.json(graph as never)}::jsonb),${accountId},'phase3')`;
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
    sql<MatchRow[]>`SELECT id,graph_match_id,graph_purpose,state,home_entry_id,away_entry_id
      FROM matches WHERE format_revision_id=${formatId} ORDER BY ordinal`;
  const nextPlayable = async () =>
    (await loadMatches()).find(
      (match) => match.home_entry_id && match.away_entry_id && ["pending", "ready"].includes(match.state),
    );
  return { competitionId: competition.id, divisionId: division.id, graph, loadMatches, nextPlayable };
}

let writerIndex = 0;
/** Opens a canonical scoring writer on one match. */
async function scorer(competitionId: string, matchId: string) {
  const pass = await runtime.createAccessPass(
    { accountId },
    competitionId,
    matchId,
    {
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      role: "scorekeeper",
      idempotencyKey: `qa-${randomUUID()}`,
    },
    randomUUID(),
  );
  if (!pass.token) throw new Error("Expected one-time access token");
  writerIndex += 1;
  const writer = await runtime.exchangeAccess(
    { token: pass.token, deviceId: randomUUID(), ipAddress: `198.51.100.${(writerIndex % 250) + 1}` },
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

async function walkover(competitionId: string, matchId: string, winner: "home" | "away") {
  const writer = await scorer(competitionId, matchId);
  await writer.append({ type: "match_started" });
  await writer.append({ type: "walkover", team_slot: winner });
  return writer.finalise();
}

/** Badminton best-of-3 won 21-0, 21-0 by the home side. */
async function badmintonHomeWin(competitionId: string, matchId: string) {
  const writer = await scorer(competitionId, matchId);
  await writer.append({ type: "match_started" });
  for (const segment of [1, 2]) {
    for (let point = 0; point < 21; point += 1) {
      await writer.append({ type: "point", team_slot: "home", segment_number: segment });
    }
    await writer.append({ type: "game_completion", team_slot: "home", segment_number: segment });
  }
  return writer.finalise();
}

/** Basketball won by the home side. */
async function basketballHomeWin(competitionId: string, matchId: string) {
  const writer = await scorer(competitionId, matchId);
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

describeInfrastructure("QA mock-tournament regressions", () => {
  it("records a walkover with the sport's forfeit result and advances the declared winner", async () => {
    const event = await championshipEvent("badminton");
    const first = (await event.nextPlayable())!;
    const result = await walkover(event.competitionId, first.id, "away");
    expect(result.away_score).toBeGreaterThan(result.home_score);

    // Walk every match over until the bracket is exhausted: knockout slots must
    // fill from walkover winners for the final to become playable.
    let played = 1;
    for (let next = await event.nextPlayable(); next; next = await event.nextPlayable()) {
      await walkover(event.competitionId, next.id, "home");
      played += 1;
    }
    expect(played).toBe(event.graph.matches.length);
    const matches = await event.loadMatches();
    expect(matches.every((match) => match.state === "final")).toBe(true);

    const [standings] = await sql<{ standings: Array<Record<string, unknown>> }[]>`
      SELECT standings FROM standings_snapshots WHERE division_id=${event.divisionId}
      ORDER BY result_version DESC, created_at DESC LIMIT 1`;
    const winnerRow = standings!.standings.find((row) => row.entryId === first.away_entry_id)!;
    // The forfeit is 21-0 in each of the two awarded games.
    expect(winnerRow).toMatchObject({ scoreFor: expect.any(Number) });
    expect(Number(winnerRow.scoreFor)).toBeGreaterThanOrEqual(42);

    // A manual recalculation must read the walkover as the same forfeit.
    await sql`UPDATE competition_publications SET result_version=result_version+1
      WHERE competition_id=${event.competitionId}`;
    const recalculated = (await phase3.recalculateStandings(
      { accountId },
      event.competitionId,
      event.divisionId,
      randomUUID(),
    )) as { standings: { groups: Record<string, { rows: Array<Record<string, unknown>> }> } };
    const groupRow = Object.values(recalculated.standings.groups)
      .flatMap((group) => group.rows)
      .find((row) => row.entryId === first.away_entry_id)!;
    expect(Number(groupRow.won)).toBeGreaterThanOrEqual(1);
    expect(Number(groupRow.scoreFor)).toBeGreaterThanOrEqual(42);
  });

  it("flags walkover results and exposes per-group membership on the public projection", async () => {
    const event = await championshipEvent("badminton");
    const first = (await event.nextPlayable())!;
    const result = await walkover(event.competitionId, first.id, "away");
    const second = (await event.nextPlayable())!;
    await badmintonHomeWin(event.competitionId, second.id);

    const [competitionRow] = await sql<
      { slug: string }[]
    >`SELECT slug FROM competitions WHERE id=${event.competitionId}`;
    const slug = competitionRow!.slug;
    const projection = await runtime.publicCompetition(slug);
    const division = projection.divisions.find((item) => item.division.id === event.divisionId)!;
    const walkoverResult = division.results.find((item) => item.id === first.id)!;
    expect(walkoverResult).toMatchObject({
      walkover: { winner: "away" },
      home_score: result.home_score,
      away_score: result.away_score,
    });
    expect(division.results.find((item) => item.id === second.id)?.walkover).toBeUndefined();

    const poolIds = new Set(
      event.graph.matches.filter((match) => match.purpose === "pool").map((match) => match.poolId ?? match.stageId),
    );
    expect(poolIds.size).toBeGreaterThan(1);
    const groups = (division.standings as { groups?: Array<{ id: string; entry_ids: string[] }> }).groups;
    // Public-safety: groups are positional letters, never internal graph pool/stage ids.
    expect(groups?.map((group) => group.id)).toEqual(["A", "B"].slice(0, poolIds.size));
    const members = groups!.flatMap((group) => group.entry_ids);
    expect(new Set(members).size).toBe(members.length);
    expect(members).toEqual(expect.arrayContaining([first.home_entry_id, first.away_entry_id]));
    // Every group member is already public as a standings row entryId.
    const standingRows = (division.standings as { standings: Array<{ entryId: string }> }).standings;
    const publicEntryIds = new Set(standingRows.map((row) => row.entryId));
    expect(members.every((entryId) => publicEntryIds.has(entryId!))).toBe(true);
    // The new group field carries no internal graph pool ids as values.
    const serialisedGroups = JSON.stringify(groups);
    for (const poolId of poolIds) expect(serialisedGroups).not.toContain(`"${poolId}"`);
    const serialised = JSON.stringify(projection);
    expect(serialised).not.toContain("graph_pool_id");
    expect(serialised).not.toContain("walkover_winner");
  });

  it("withdraws an entry mid-group after a completed set-sport match", async () => {
    const event = await championshipEvent("badminton");
    const first = (await event.nextPlayable())!;
    await badmintonHomeWin(event.competitionId, first.id);
    const withdrawn = first.home_entry_id!;
    const outcome = await phase3.mutateEntry(
      { accountId },
      event.competitionId,
      event.divisionId,
      { action: "withdraw", entryId: withdrawn, reason: "Team injured" },
      randomUUID(),
      randomUUID(),
    );
    expect(outcome).toMatchObject({ id: withdrawn, status: "withdrawn" });
    // Remaining pool matches of the withdrawn entry are awarded as forfeits.
    const remaining = (await event.loadMatches()).filter(
      (match) =>
        match.graph_purpose === "pool" &&
        match.id !== first.id &&
        (match.home_entry_id === withdrawn || match.away_entry_id === withdrawn),
    );
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.every((match) => match.state === "final")).toBe(true);

    // Scoring carries on in the division after the withdrawal.
    const next = (await event.nextPlayable())!;
    expect(next).toBeDefined();
    await expect(badmintonHomeWin(event.competitionId, next.id)).resolves.toMatchObject({ home_score: 2 });
  });

  it("fills knockout winner and loser slots on a manual standings recalculation", async () => {
    const event = await championshipEvent("basketball");
    const isKnockout = (match: MatchRow) => match.graph_purpose !== "pool";
    // Play the pools and the first knockout round.
    for (let next = await event.nextPlayable(); next; next = await event.nextPlayable()) {
      const knockoutSources = event.graph.matches.find((match) => match.id === next!.graph_match_id)!;
      if (isKnockout(next) && [knockoutSources.home, knockoutSources.away].some((s) => s.type !== "stage_rank")) break;
      await basketballHomeWin(event.competitionId, next.id);
    }
    const winnerLoserMatches = event.graph.matches.filter((match) =>
      [match.home, match.away].some((source) => source.type === "winner" || source.type === "loser"),
    );
    expect(winnerLoserMatches.length).toBeGreaterThan(0);
    const before = new Map((await event.loadMatches()).map((match) => [match.graph_match_id, match]));
    const ids = winnerLoserMatches.map((match) => before.get(match.id)!.id);
    // Simulate slots that finalisation never wrote, then a competition-wide
    // result version newer than this division's standings (as when another
    // division publishes a result) so the manual recalculation runs.
    await sql`DELETE FROM advancement_slots WHERE match_id IN ${sql(ids)}`;
    await sql`UPDATE matches SET home_entry_id=NULL,away_entry_id=NULL,state='pending' WHERE id IN ${sql(ids)}`;
    await sql`UPDATE competition_publications SET result_version=result_version+1
      WHERE competition_id=${event.competitionId}`;

    await phase3.recalculateStandings({ accountId }, event.competitionId, event.divisionId, randomUUID());

    const after = new Map((await event.loadMatches()).map((match) => [match.graph_match_id, match]));
    for (const graphMatch of winnerLoserMatches) {
      const match = after.get(graphMatch.id)!;
      for (const slot of ["home", "away"] as const) {
        const source = graphMatch[slot];
        if (source.type !== "winner" && source.type !== "loser") continue;
        const sourceMatch = before.get(source.matchId)!;
        const expected = source.type === "winner" ? sourceMatch.home_entry_id : sourceMatch.away_entry_id;
        expect(match[`${slot}_entry_id`], `${graphMatch.id}:${slot}`).toBe(expected);
      }
      expect(match.state, JSON.stringify(match)).toBe("ready");
    }
    const slots = await sql<{ control: string; entry_id: string | null }[]>`
      SELECT control,entry_id FROM advancement_slots WHERE match_id IN ${sql(ids)}`;
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((slot) => slot.control === "automatic" && slot.entry_id !== null)).toBe(true);
  });

  it("rejects scoring commands that are missing a side or participant with 422", async () => {
    const badminton = await championshipEvent("badminton");
    const badmintonWriter = await scorer(badminton.competitionId, (await badminton.nextPlayable())!.id);
    await badmintonWriter.append({ type: "match_started" });
    await expect(badmintonWriter.append({ type: "game_completion", segment_number: 1 })).rejects.toMatchObject({
      statusCode: 422,
      code: "SCORE_EVENT_REJECTED",
      message: expect.stringContaining("team_slot"),
    });

    const basketball = await championshipEvent("basketball");
    const basketballWriter = await scorer(basketball.competitionId, (await basketball.nextPlayable())!.id);
    await basketballWriter.append({ type: "match_started" });
    await expect(
      basketballWriter.append({ type: "player_foul", team_slot: "home", segment_number: 1, manual_time_seconds: 5 }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "SCORE_EVENT_REJECTED",
      message: expect.stringContaining("participant_id"),
    });
  });
});

// Track R2.7: real triggers (scoring finalisation, published-schedule reminders) through the
// transactional outbox and SMTP delivery into Mailpit.
describeInfrastructure("competition-day notifications are delivered", () => {
  const mailpitApiUrl = process.env.MAILPIT_API_URL ?? "http://127.0.0.1:8025";

  /** Messages Mailpit received for this test's organiser whose subject contains `text`. */
  async function delivered(text: string): Promise<Array<{ ID: string; Subject: string }>> {
    const email = (await sql<{ primary_email: string }[]>`SELECT primary_email FROM accounts WHERE id=${accountId}`)[0]!
      .primary_email;
    // Mailpit indexes asynchronously after SMTP acceptance; poll briefly.
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${mailpitApiUrl}/api/v1/search?query=${encodeURIComponent(`subject:"${text}"`)}`);
      expect(response.ok, `Mailpit API at ${mailpitApiUrl} must be reachable`).toBe(true);
      const body = (await response.json()) as {
        messages: Array<{ ID: string; Subject: string; To: Array<{ Address: string }> }>;
      };
      const mine = body.messages.filter((message) => message.To.some((to) => to.Address === email));
      if (mine.length > 0 || attempt >= 20) return mine;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async function messageText(id: string): Promise<string> {
    const response = await fetch(`${mailpitApiUrl}/api/v1/message/${encodeURIComponent(id)}`);
    return ((await response.json()) as { Text: string }).Text;
  }

  async function deliverOutbox() {
    const processor = new EmailOutboxProcessor(
      new PostgresNotificationRepository(sql),
      createNodemailerSmtpEmailProvider({
        host: process.env.SMTP_HOST ?? "127.0.0.1",
        port: Number(process.env.SMTP_PORT ?? 1025),
        secure: false,
        from: "Matchday <no-reply@matchday.test>",
      }),
      // Reminders are enqueued at a simulated pre-match instant in 2027; deliver as of after it.
      { now: () => new Date("2028-01-01T00:00:00Z"), createLeaseToken: randomUUID },
    );
    // Drain every due item: earlier tests in this file queue results for the same organiser.
    let delivered = 0;
    for (;;) {
      const batch = await processor.processDue(50);
      delivered += batch.delivered;
      if (batch.claimed === 0) return { delivered };
    }
  }

  it("emails the organiser a W/O result when a walkover is finalised", async () => {
    const event = await championshipEvent("badminton");
    const match = (await event.nextPlayable())!;
    const competitionName = `Notify ${randomUUID().slice(0, 8)}`;
    await sql`UPDATE competitions SET name=${competitionName} WHERE id=${event.competitionId}`;
    await walkover(event.competitionId, match.id, "away");
    const queued = await sql<{ type: string }[]>`
      SELECT type FROM notifications WHERE account_id=${accountId} AND (payload #>> '{}')::jsonb->>'match_id'=${match.id}`;
    expect(queued.map((row) => row.type)).toEqual(["result-published"]);
    expect((await deliverOutbox()).delivered).toBeGreaterThanOrEqual(1);
    const code = (await sql<{ code: string }[]>`SELECT code FROM matches WHERE id=${match.id}`)[0]!.code;
    const result = (await delivered(competitionName)).find(
      (message) => message.Subject === `Final result for ${code} in ${competitionName}`,
    );
    expect(result, "result-published email delivered").toBeDefined();
    expect(await messageText(result!.ID)).toContain("W/O (Forfeit score:");
  });

  it("sends match reminders ahead of the published start once, honouring the match_reminder preference", async () => {
    const event = await championshipEvent("basketball");
    const [first] = await sql<{ match_id: string; starts_at: Date }[]>`
      SELECT scheduled.match_id,scheduled.starts_at
      FROM competition_publications publication
      JOIN scheduled_matches scheduled ON scheduled.schedule_revision_id=publication.published_schedule_revision_id
      WHERE publication.competition_id=${event.competitionId}
      ORDER BY scheduled.starts_at LIMIT 1`;
    const now = () => new Date(first!.starts_at.getTime() - 10 * 60_000);
    const logger = { info: () => undefined, error: () => undefined };
    const sweeper = new MatchReminderSweeper(
      sql as unknown as PostgresJsSql,
      { enabled: true, intervalMs: 60_000, leadMinutes: 30 },
      logger,
      now,
    );
    expect(await sweeper.sweep()).toBeGreaterThan(0);
    await sweeper.sweep();
    const reminders = await sql<{ count: number }[]>`
      SELECT count(*)::int count FROM notifications
      WHERE account_id=${accountId} AND type='match_reminder' AND (payload #>> '{}')::jsonb->>'match_id'=${first!.match_id}`;
    expect(reminders[0]!.count).toBe(1);
    expect((await deliverOutbox()).delivered).toBeGreaterThanOrEqual(1);
    expect((await delivered("Match reminder for")).length).toBeGreaterThan(0);

    // Opting out of the match_reminder category suppresses both channels for later matches.
    await sql`INSERT INTO notification_preferences(account_id,notification_type,in_app_enabled,email_enabled)
      VALUES(${accountId},'match_reminder',false,false)
      ON CONFLICT (account_id,notification_type) DO UPDATE SET in_app_enabled=false,email_enabled=false`;
    const later = new MatchReminderSweeper(
      sql as unknown as PostgresJsSql,
      { enabled: true, intervalMs: 60_000, leadMinutes: 600 },
      logger,
      now,
    );
    expect(await later.sweep()).toBe(0);
  });
});
