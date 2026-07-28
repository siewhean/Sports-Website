import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SPORT_PACKS, type SportId } from "@matchday/domain";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import type { PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../../src/phase-2-runtime.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_gate_c_c2_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
const fallbackSecret = "gate-c-c2-runtime-fallback-hmac-secret";

let sql!: Sql;
let runtime!: Phase2Runtime;
let accountId = "";
let organisationId = "";

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  sql = postgres(databaseUrl, { max: 4, onnotice: () => undefined, connection: { search_path: schema } });
  const accounts = await sql<{ id: string }[]>`
    INSERT INTO accounts(primary_email,display_name,email_verified_at)
    VALUES(${`c2-${randomUUID()}@example.test`},'C2 organiser',now()) RETURNING id
  `;
  accountId = accounts[0]?.id ?? "";
  await sql.begin(async (tx) => {
    const organisations = await tx<{ id: string }[]>`
      INSERT INTO organisations(name,slug)
      VALUES('C2 organisation',${`c2-${randomUUID()}`}) RETURNING id
    `;
    organisationId = organisations[0]?.id ?? "";
    await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
      VALUES(${organisationId},${accountId},'owner','active')`;
  });
  for (const [sportId, pack] of Object.entries(SPORT_PACKS)) {
    const definition = {
      recommendedSettings: pack.recommendedSettings,
      recommendedSlotMinutes: Number(pack.recommendedSettings.slotMinutes ?? 30),
    };
    const [hash] = await sql<{ value: string }[]>`
      SELECT phase4_sha256_json(${sql.json(definition)}) value
    `;
    await sql`INSERT INTO sport_pack_versions(
      sport_code,version,schema_version,definition,definition_hash,status,activated_at
    ) VALUES(
      ${sportId},${pack.version},1,${sql.json(definition)},${hash!.value},'active',now()
    )`;
  }
  runtime = new Phase2Runtime(
    sql as unknown as PostgresJsSql,
    phase2DomainAdapter,
    undefined,
    undefined,
    fallbackSecret,
  );
});

afterAll(async () => {
  await sql?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

async function createScoringWorld(sportId: SportId) {
  const actor = { accountId };
  const competition = await runtime.createCompetition(
    actor,
    {
      organisationId,
      name: `${SPORT_PACKS[sportId].displayName} C2 Cup`,
      slug: `${sportId.replaceAll("_", "-")}-${randomUUID()}`,
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
  await runtime.replaceEntries(
    actor,
    competition.id,
    division.id,
    Array.from({ length: 8 }, (_, index) => ({ name: `${sportId} ${index + 1}`, seed: index + 1 })),
    randomUUID(),
  );
  await runtime.replaceCapacity(
    actor,
    competition.id,
    [
      {
        name: "Area 1",
        windows: [{ startsAt: "2027-03-01T00:00:00.000Z", endsAt: "2027-03-01T12:00:00.000Z" }],
      },
    ],
    randomUUID(),
  );
  const format = await runtime.generateFormat(actor, competition.id, division.id, randomUUID());
  const schedule = await runtime.generateSchedule(actor, competition.id, format.id, randomUUID());
  await runtime.publishSchedule(actor, competition.id, schedule.id, randomUUID());
  const match = format.matches[0]!;
  const pass = await runtime.createAccessPass(
    actor,
    competition.id,
    match.id,
    {
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      role: "scorekeeper",
      idempotencyKey: `${sportId}-${randomUUID()}`,
    },
    randomUUID(),
  );
  if (!pass.token) throw new Error("Expected one-time access token");
  const writer = await runtime.exchangeAccess(
    { token: pass.token, deviceId: randomUUID(), ipAddress: "203.0.113.55" },
    randomUUID(),
  );
  if (!writer.generation) throw new Error("Expected writer generation");
  return {
    competition,
    division,
    match,
    auth: {
      sessionId: writer.session_id,
      sessionToken: writer.session_token,
      generation: writer.generation,
    },
  };
}

describeInfrastructure("Gate C C2 canonical scoring runtime", () => {
  it.each([
    ["badminton", 21, 0],
    ["table_tennis", 11, 0],
    ["volleyball", 2, 0],
    ["basketball", 3, 0],
  ] as const)("persists and finalises the %s canonical stream", async (sportId, expectedHome, expectedAway) => {
    const world = await createScoringWorld(sportId);
    let version = 0;
    const append = async (command: Record<string, unknown>) => {
      const receipt = await runtime.appendCanonicalScoreEvent(
        world.auth,
        {
          client_event_id: randomUUID(),
          occurred_at: new Date().toISOString(),
          ...command,
        },
        version,
        randomUUID(),
      );
      version = receipt.aggregate_version;
    };
    await append({ type: "match_started" });
    if (sportId === "badminton" || sportId === "table_tennis") {
      await append({ type: "walkover", team_slot: "home", segment_number: 1 });
    } else if (sportId === "volleyball") {
      for (const segment of [1, 2]) {
        for (let point = 0; point < 25; point += 1) {
          await append({ type: "point", team_slot: "home", segment_number: segment });
        }
        await append({ type: "set_completion", team_slot: "home", segment_number: segment });
      }
    } else {
      await append({
        type: "three_point_score",
        team_slot: "home",
        participant_id: "Player 3",
        segment_number: 1,
        manual_time_seconds: 25,
      });
      for (const segment of [2, 3, 4]) {
        await append({ type: "period_change", segment_number: segment, manual_time_seconds: 0 });
      }
    }
    const result = await runtime.finalise(world.auth, randomUUID(), randomUUID(), version);
    expect(result).toMatchObject({ home_score: expectedHome, away_score: expectedAway });
    const [stream] = await sql<
      {
        sport_code: string;
        current_version: number;
        event_count: number;
      }[]
    >`
      SELECT stream.sport_code,stream.current_version,count(event.id)::integer event_count
      FROM match_score_streams stream
      JOIN canonical_score_events event ON event.match_id=stream.match_id
      WHERE stream.match_id=${world.match.id}
      GROUP BY stream.match_id,stream.sport_code,stream.current_version
    `;
    expect(stream).toMatchObject({
      sport_code: sportId,
      current_version: version + 1,
      event_count: version + 1,
    });
  });

  it("preserves retirement play and applies frozen custom standings and walkover settings", async () => {
    const retirement = await createScoringWorld("badminton");
    await sql`UPDATE competition_sport_settings SET settings_override=${sql.json({
      standingsOrder: ["point_difference", "match_wins"],
      forfeitWinnerScore: 17,
      forfeitLoserScore: 0,
    })} WHERE competition_id=${retirement.competition.id}`;
    let retirementVersion = 0;
    for (const command of [
      { type: "match_started" },
      { type: "point", team_slot: "home", segment_number: 1 },
      { type: "retirement", team_slot: "home", segment_number: 1 },
    ]) {
      const receipt = await runtime.appendCanonicalScoreEvent(
        retirement.auth,
        { client_event_id: randomUUID(), occurred_at: new Date().toISOString(), ...command },
        retirementVersion,
        randomUUID(),
      );
      retirementVersion = receipt.aggregate_version;
    }
    await expect(
      runtime.finalise(retirement.auth, randomUUID(), randomUUID(), retirementVersion),
    ).resolves.toMatchObject({ home_score: 0, away_score: 0 });
    const [retirementStandings] = await sql<
      {
        settings_version: string;
        standings: string | Array<{ entryId: string; scoreFor: number; resolvedBy: string }>;
      }[]
    >`
      SELECT settings_version,standings
      FROM standings_snapshots
      WHERE competition_id=${retirement.competition.id}
      ORDER BY result_version DESC LIMIT 1
    `;
    const retirementRows =
      typeof retirementStandings?.standings === "string"
        ? (JSON.parse(retirementStandings.standings) as Array<{
            entryId: string;
            scoreFor: number;
            resolvedBy: string;
          }>)
        : retirementStandings?.standings;
    expect(retirementStandings?.settings_version).toMatch(/^badminton-standings-v1:[a-f0-9]{16}$/);
    expect(retirementRows?.[0]).toMatchObject({
      scoreFor: 1,
      resolvedBy: "score_difference",
    });

    const walkover = await createScoringWorld("badminton");
    await sql`UPDATE competition_sport_settings SET settings_override=${sql.json({
      standingsOrder: ["match_wins", "point_difference"],
      forfeitWinnerScore: 17,
      forfeitLoserScore: 0,
    })} WHERE competition_id=${walkover.competition.id}`;
    let walkoverVersion = 0;
    for (const command of [{ type: "match_started" }, { type: "walkover", team_slot: "home", segment_number: 1 }]) {
      const receipt = await runtime.appendCanonicalScoreEvent(
        walkover.auth,
        { client_event_id: randomUUID(), occurred_at: new Date().toISOString(), ...command },
        walkoverVersion,
        randomUUID(),
      );
      walkoverVersion = receipt.aggregate_version;
    }
    await expect(runtime.finalise(walkover.auth, randomUUID(), randomUUID(), walkoverVersion)).resolves.toMatchObject({
      home_score: 17,
      away_score: 0,
    });
    const [walkoverStandings] = await sql<
      {
        standings: string | Array<{ entryId: string; scoreFor: number }>;
      }[]
    >`
      SELECT standings FROM standings_snapshots
      WHERE competition_id=${walkover.competition.id}
      ORDER BY result_version DESC LIMIT 1
    `;
    const walkoverRows =
      typeof walkoverStandings?.standings === "string"
        ? (JSON.parse(walkoverStandings.standings) as Array<{ entryId: string; scoreFor: number }>)
        : walkoverStandings?.standings;
    expect(walkoverRows?.[0]?.scoreFor).toBe(34);
  });

  it("fences versions, publishes from the canonical reducer, and corrects through append-only events", async () => {
    const actor = { accountId };
    const competitionSlug = `c2-cup-${randomUUID()}`;
    const competition = await runtime.createCompetition(
      actor,
      {
        organisationId,
        name: "C2 Cup",
        slug: competitionSlug,
        timezone: "Asia/Singapore",
        startsOn: "2027-02-01",
        endsOn: "2027-02-01",
      },
      randomUUID(),
    );
    await sql`UPDATE competition_sport_settings SET
      pack_version=${SPORT_PACKS.canoe_polo.version},
      recommended_snapshot=${sql.json(SPORT_PACKS.canoe_polo.recommendedSettings)},
      settings_override='{}'::jsonb
      WHERE competition_id=${competition.id}`;
    const division = await runtime.createDivision(actor, competition.id, { name: "Open", teamLimit: 8 }, randomUUID());
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
      [
        {
          name: "Court 1",
          windows: [
            {
              startsAt: "2027-02-01T00:00:00.000Z",
              endsAt: "2027-02-01T12:00:00.000Z",
            },
          ],
        },
      ],
      randomUUID(),
    );
    const format = await runtime.generateFormat(actor, competition.id, division.id, randomUUID());
    const dependencyFixture = format.matches
      .flatMap((candidate) =>
        candidate.dependencies.map((dependency) => ({ downstreamMatchId: candidate.id, ...dependency })),
      )
      .find((dependency) => {
        const source = format.matches.find((candidate) => candidate.id === dependency.sourceMatchId);
        return source?.homeEntryId && source.awayEntryId;
      });
    const match = format.matches.find((candidate) => candidate.id === dependencyFixture?.sourceMatchId);
    if (!match || !dependencyFixture) throw new Error("Expected a source match with a downstream dependency");
    const schedule = await runtime.generateSchedule(actor, competition.id, format.id, randomUUID());
    await runtime.publishSchedule(actor, competition.id, schedule.id, randomUUID());
    const pass = await runtime.createAccessPass(
      actor,
      competition.id,
      match.id,
      {
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        role: "scorekeeper",
        idempotencyKey: `c2-pass-${randomUUID()}`,
      },
      randomUUID(),
    );
    if (!pass.token) throw new Error("Expected one-time access token");
    const writer = await runtime.exchangeAccess(
      { token: pass.token, deviceId: randomUUID(), ipAddress: "198.51.100.42" },
      randomUUID(),
    );
    if (!writer.generation) throw new Error("Expected writer generation");
    const auth = {
      sessionId: writer.session_id,
      sessionToken: writer.session_token,
      generation: writer.generation,
    };
    const startedId = randomUUID();
    await expect(
      runtime.appendCanonicalScoreEvent(
        auth,
        { client_event_id: startedId, type: "match_started", occurred_at: new Date().toISOString() },
        0,
        randomUUID(),
      ),
    ).resolves.toMatchObject({ duplicate: false, aggregate_version: 1 });
    const concurrentGoalIds = [randomUUID(), randomUUID()];
    const concurrentGoals = await Promise.allSettled(
      concurrentGoalIds.map((clientEventId, index) =>
        runtime.appendCanonicalScoreEvent(
          auth,
          {
            client_event_id: clientEventId,
            type: "goal",
            occurred_at: new Date().toISOString(),
            team_slot: "home",
            participant_id: `Player ${index + 1}`,
            segment_number: 1,
            manual_time_seconds: 25,
          },
          1,
          randomUUID(),
        ),
      ),
    );
    const fulfilledGoal = concurrentGoals.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof runtime.appendCanonicalScoreEvent>>> =>
        result.status === "fulfilled",
    );
    const rejectedGoal = concurrentGoals.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (!fulfilledGoal || !rejectedGoal) throw new Error("Expected one accepted and one fenced concurrent event");
    expect(rejectedGoal.reason).toMatchObject({ statusCode: 409, code: "SCORE_VERSION_CONFLICT" });
    const goal = fulfilledGoal.value;
    const goalId = concurrentGoalIds[concurrentGoals.indexOf(fulfilledGoal)]!;
    await expect(
      runtime.appendCanonicalScoreEvent(
        auth,
        {
          client_event_id: goalId,
          type: "goal",
          occurred_at: new Date().toISOString(),
          team_slot: "away",
          participant_id: "Changed retry",
          segment_number: 1,
          manual_time_seconds: 25,
        },
        2,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_KEY_REUSED" });
    await runtime.appendCanonicalScoreEvent(
      auth,
      {
        client_event_id: randomUUID(),
        type: "period_change",
        occurred_at: new Date().toISOString(),
        segment_number: 2,
        manual_time_seconds: 0,
      },
      2,
      randomUUID(),
    );
    await expect(
      runtime.appendCanonicalScoreEvent(
        auth,
        {
          client_event_id: randomUUID(),
          type: "goal",
          occurred_at: new Date().toISOString(),
          team_slot: "away",
          participant_id: "Stale",
          segment_number: 2,
          manual_time_seconds: 10,
        },
        1,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "SCORE_VERSION_CONFLICT" });
    await expect(runtime.finalise(auth, goalId, randomUUID(), 3)).rejects.toMatchObject({
      statusCode: 409,
      code: "IDEMPOTENCY_KEY_REUSED",
    });
    const finalisationId = randomUUID();
    const finalised = await runtime.finalise(auth, finalisationId, randomUUID(), 3);
    expect(finalised).toMatchObject({ home_score: 1, away_score: 0, aggregate_version: 4 });
    const publicScheduleBeforeCorrection = (await runtime.publicCompetition(competitionSlug)).schedule;
    const reopenId = randomUUID();
    const reopened = await runtime.reopenCanonicalMatch(
      actor,
      competition.id,
      match.id,
      {
        clientEventId: reopenId,
        reason: "Reviewing an authorised scorer correction",
        expectedAggregateVersion: 4,
      },
      randomUUID(),
    );
    expect(Object.keys(reopened).sort()).toEqual(
      [
        "aggregate_version",
        "conflicts",
        "duplicate",
        "match_id",
        "publication_version",
        "result_version",
        "through_sequence",
      ].sort(),
    );
    expect(reopened).toMatchObject({ match_id: match.id, aggregate_version: 5, through_sequence: 5 });
    await expect(
      runtime.reopenCanonicalMatch(
        actor,
        competition.id,
        match.id,
        {
          clientEventId: reopenId,
          reason: "Reviewing an authorised scorer correction",
          expectedAggregateVersion: 4 + 1,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_KEY_REUSED" });
    const [downstreamBefore] = await sql<
      {
        id: string;
        slot: "home" | "away";
        home_entry_id: string | null;
        away_entry_id: string | null;
      }[]
    >`
      SELECT downstream.id,COALESCE(dependency.slot,'home') AS slot,
             downstream.home_entry_id,downstream.away_entry_id
      FROM match_dependencies dependency
      JOIN matches downstream ON downstream.id=dependency.match_id
      WHERE dependency.source_match_id=${match.id}
      ORDER BY downstream.ordinal LIMIT 1
    `;
    if (!downstreamBefore) throw new Error("Expected a downstream match dependency");
    const protectedEntry =
      downstreamBefore.slot === "home" ? downstreamBefore.home_entry_id : downstreamBefore.away_entry_id;
    await sql`INSERT INTO advancement_slots(
      competition_id,division_id,match_id,slot,entry_id,control,result_version
    ) VALUES(
      ${competition.id},${division.id},${downstreamBefore.id},${downstreamBefore.slot},
      ${protectedEntry},'manual',1
    )
    ON CONFLICT (match_id,slot) DO UPDATE SET
      entry_id=EXCLUDED.entry_id,control='manual',controlled_by_rule_id=NULL,
      source_snapshot_id=NULL,source_fingerprint=NULL`;
    await sql`UPDATE matches SET state='in_progress' WHERE id=${downstreamBefore.id}`;
    const correctionInput = {
      clientEventId: randomUUID(),
      reason: "Goal was awarded to the wrong side",
      expectedAggregateVersion: 5,
      events: [
        {
          client_event_id: randomUUID(),
          type: "reversal",
          occurred_at: new Date().toISOString(),
          reversal_target_event_id: goal.event_id,
          reason: "Wrong side",
        },
        {
          client_event_id: randomUUID(),
          type: "goal",
          occurred_at: new Date().toISOString(),
          team_slot: "away",
          participant_id: "Player 2",
          segment_number: 2,
          manual_time_seconds: 15,
        },
      ],
    };
    const collidingCorrectionId = randomUUID();
    await expect(
      runtime.correctCanonicalMatch(
        actor,
        competition.id,
        match.id,
        {
          clientEventId: collidingCorrectionId,
          reason: "Reject colliding correction identifiers",
          expectedAggregateVersion: 5,
          events: [
            {
              client_event_id: collidingCorrectionId,
              type: "incident",
              occurred_at: new Date().toISOString(),
              segment_number: 2,
              manual_time_seconds: 0,
              reason: "Collision test",
            },
          ],
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_KEY_REUSED" });
    const corrected = await runtime.correctCanonicalMatch(
      actor,
      competition.id,
      match.id,
      correctionInput,
      randomUUID(),
    );
    expect(Object.keys(corrected).sort()).toEqual(
      [
        "aggregate_version",
        "conflicts",
        "duplicate",
        "match_id",
        "publication_version",
        "result_version",
        "through_sequence",
      ].sort(),
    );
    expect(corrected).toMatchObject({
      match_id: match.id,
      aggregate_version: 8,
      through_sequence: 8,
      conflicts: [
        {
          downstream_match_id: downstreamBefore.id,
          reason: "downstream_match_started",
          status: "open",
        },
      ],
    });
    await expect(
      runtime.correctCanonicalMatch(actor, competition.id, match.id, correctionInput, randomUUID()),
    ).resolves.toMatchObject({ duplicate: true, aggregate_version: 8 });
    expect(await sql`SELECT home_entry_id,away_entry_id,state FROM matches WHERE id=${downstreamBefore.id}`).toEqual([
      {
        home_entry_id: downstreamBefore.home_entry_id,
        away_entry_id: downstreamBefore.away_entry_id,
        state: "in_progress",
      },
    ]);
    expect(
      await sql`SELECT entry_id,control FROM advancement_slots
        WHERE match_id=${downstreamBefore.id} AND slot=${downstreamBefore.slot}`,
    ).toEqual([
      {
        entry_id: protectedEntry,
        control: "manual",
      },
    ]);
    const conflict = corrected.conflicts[0]!;
    const acknowledgementId = randomUUID();
    await expect(
      runtime.acknowledgeResultConflict(
        actor,
        competition.id,
        String(conflict.id),
        {
          clientEventId: acknowledgementId,
          reason: "Organiser has reviewed the protected downstream match",
          expectedRevision: corrected.result_version,
        },
        randomUUID(),
      ),
    ).resolves.toMatchObject({ status: "acknowledged" });
    await expect(
      runtime.acknowledgeResultConflict(
        actor,
        competition.id,
        String(conflict.id),
        {
          clientEventId: acknowledgementId,
          reason: "Organiser has reviewed the protected downstream match",
          expectedRevision: corrected.result_version,
        },
        randomUUID(),
      ),
    ).resolves.toMatchObject({ status: "acknowledged", acknowledgement_client_event_id: acknowledgementId });
    await expect(runtime.finalise(auth, finalisationId, randomUUID(), 3)).resolves.toMatchObject({
      duplicate: true,
      aggregate_version: 4,
      home_score: 1,
      away_score: 0,
      result_version: 1,
    });
    await expect(
      runtime.reopenCanonicalMatch(
        actor,
        competition.id,
        match.id,
        {
          clientEventId: reopenId,
          reason: "Reviewing an authorised scorer correction",
          expectedAggregateVersion: 4,
        },
        randomUUID(),
      ),
    ).resolves.toMatchObject({
      duplicate: true,
      aggregate_version: 5,
      result_version: 1,
      publication_version: 1,
    });
    await expect(
      runtime.correctCanonicalMatch(actor, competition.id, match.id, correctionInput, randomUUID()),
    ).resolves.toMatchObject({
      duplicate: true,
      aggregate_version: 8,
      result_version: corrected.result_version,
      conflicts: [
        {
          id: conflict.id,
          status: "open",
          acknowledged_at: null,
          acknowledged_by_account_id: null,
          acknowledgement_reason: null,
        },
      ],
    });
    expect((await runtime.publicCompetition(competitionSlug)).schedule).toEqual(publicScheduleBeforeCorrection);
    await expect(
      runtime.acknowledgeResultConflict(
        actor,
        competition.id,
        String(conflict.id),
        {
          clientEventId: acknowledgementId,
          reason: "A changed retry must be rejected",
          expectedRevision: corrected.result_version,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_KEY_REUSED" });
    const secondConflict = await sql<{ id: string }[]>`
      INSERT INTO result_conflicts(
        competition_id,division_id,corrected_match_id,downstream_match_id,
        result_version,reason,detail
      ) VALUES(
        ${competition.id},${division.id},${match.id},${downstreamBefore.id},
        ${corrected.result_version},'manual_slot_preserved','{}'::jsonb
      ) RETURNING id
    `;
    await expect(
      runtime.acknowledgeResultConflict(
        actor,
        competition.id,
        secondConflict[0]!.id,
        {
          clientEventId: acknowledgementId,
          reason: "A different conflict cannot share an acknowledgement receipt",
          expectedRevision: corrected.result_version,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_KEY_REUSED" });
    const history = await sql<{ event_type: string; aggregate_version: number }[]>`
      SELECT event_type,aggregate_version FROM canonical_score_events
      WHERE match_id=${match.id} ORDER BY aggregate_version
    `;
    expect(history.map((event) => event.event_type)).toEqual([
      "match_started",
      "goal",
      "period_change",
      "finalisation",
      "match_reopened",
      "reversal",
      "goal",
      "finalisation",
    ]);
    expect(history.map((event) => event.aggregate_version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const [unreversedTarget] = await sql<{ id: string }[]>`
      SELECT id FROM canonical_score_events
      WHERE match_id=${match.id} AND event_type='goal'
        AND NOT EXISTS (
          SELECT 1 FROM canonical_score_events reversal
          WHERE reversal.match_id=${match.id}
            AND reversal.reversal_target_event_id=canonical_score_events.id
        )
      ORDER BY aggregate_version DESC LIMIT 1
    `;
    await expect(
      sql`INSERT INTO canonical_score_events(
        id,competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
        command,command_fingerprint,actor_account_id,device_timestamp
      ) VALUES(
        ${randomUUID()},${competition.id},${division.id},${match.id},${randomUUID()},99,98,'incident',
        ${sql.json({
          client_event_id: randomUUID(),
          type: "incident",
          occurred_at: new Date().toISOString(),
          reason: "Invalid sequence",
        })},
        ${"0".repeat(64)},${accountId},now()
      )`,
    ).rejects.toThrow(/check constraint|sequence/i);
    await expect(
      sql`INSERT INTO canonical_score_events(
        id,competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
        command,command_fingerprint,actor_account_id,device_timestamp,reversal_target_event_id,reason
      ) VALUES(
        ${randomUUID()},${competition.id},${division.id},${match.id},${randomUUID()},99,99,'reversal',
        ${sql.json({
          client_event_id: randomUUID(),
          type: "reversal",
          occurred_at: new Date().toISOString(),
          reversal_target_event_id: unreversedTarget!.id,
        })},
        ${"b".repeat(64)},${accountId},now(),${unreversedTarget!.id},NULL
      )`,
    ).rejects.toThrow(/reversal_reason_required|check constraint/i);
    const wrongDivisionId = randomUUID();
    await sql`INSERT INTO divisions(id,competition_id,name,team_limit)
      VALUES(${wrongDivisionId},${competition.id},'Wrong division',8)`;
    await expect(
      sql`INSERT INTO result_conflicts(
        competition_id,division_id,corrected_match_id,downstream_match_id,
        result_version,reason,detail
      ) VALUES(
        ${competition.id},${wrongDivisionId},${match.id},${downstreamBefore.id},
        999,'manual_slot_preserved','{}'::jsonb
      )`,
    ).rejects.toThrow(/corrected_match_division_fk|foreign key/i);
    const audit = await runtime.matchScoringAudit(actor, competition.id, match.id);
    expect(audit).toMatchObject({
      aggregate_version: 8,
      permission: "write",
      competition: { sport_code: "canoe_polo" },
      score: { home: 0, away: 1, lifecycle: "finalised" },
    });
    expect(createHash("sha256").update(JSON.stringify(audit.sport.settings)).digest("hex")).toHaveLength(64);
    const outsider = await sql<{ id: string }[]>`
      INSERT INTO accounts(primary_email,display_name,email_verified_at)
      VALUES(${`outsider-${randomUUID()}@example.test`},'Outside tenant',now())
      RETURNING id
    `;
    await expect(
      runtime.matchScoringAudit({ accountId: outsider[0]!.id }, competition.id, match.id),
    ).rejects.toMatchObject({ statusCode: 403, code: "COMPETITION_ACCESS_DENIED" });
    const organisationViewer = await sql<{ id: string }[]>`
      INSERT INTO accounts(primary_email,display_name,email_verified_at)
      VALUES(${`viewer-${randomUUID()}@example.test`},'Organisation viewer',now())
      RETURNING id
    `;
    await sql`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
      VALUES(${organisationId},${organisationViewer[0]!.id},'viewer','active')`;
    await expect(
      runtime.matchScoringAudit({ accountId: organisationViewer[0]!.id }, competition.id, match.id),
    ).rejects.toMatchObject({ statusCode: 403, code: "COMPETITION_ACCESS_DENIED" });
    await expect(
      runtime.listResultConflicts({ accountId: organisationViewer[0]!.id }, competition.id, null),
    ).rejects.toMatchObject({ statusCode: 403, code: "COMPETITION_ACCESS_DENIED" });
    const otherMatch = format.matches.find((candidate) => candidate.id !== match.id);
    if (!otherMatch) throw new Error("Expected a second match for object-scope fencing");
    await expect(runtime.matchScoringAudit(actor, competition.id, otherMatch.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(runtime.matchScoringAudit(actor, randomUUID(), match.id)).rejects.toMatchObject({
      statusCode: 403,
      code: "COMPETITION_ACCESS_DENIED",
    });
    const workspace = await runtime.competitionWorkspace(actor, competition.id);
    expect(workspace.private_schedule).toMatchObject({
      matches: expect.arrayContaining([
        expect.objectContaining({
          match_id: match.id,
          state: "corrected",
          home_score: 0,
          away_score: 1,
          result_version: corrected.result_version,
        }),
      ]),
    });
    expect(
      await sql`
        SELECT action,count(*)::integer count FROM audit_events
        WHERE target_id=${match.id}
          AND action IN ('scoring_event.appended','result.finalised','result.reopened','result.corrected')
        GROUP BY action ORDER BY action
      `,
    ).toEqual([
      { action: "result.corrected", count: 1 },
      { action: "result.finalised", count: 1 },
      { action: "result.reopened", count: 1 },
      { action: "scoring_event.appended", count: 3 },
    ]);
    expect(
      await sql`
        SELECT event_type,count(*)::integer count FROM outbox_events
        WHERE aggregate_id=${match.id}
          AND event_type IN ('scoring_event.appended','result.finalised','result.reopened','result.corrected')
        GROUP BY event_type ORDER BY event_type
      `,
    ).toEqual([
      { event_type: "result.corrected", count: 1 },
      { event_type: "result.finalised", count: 1 },
      { event_type: "result.reopened", count: 1 },
      { event_type: "scoring_event.appended", count: 3 },
    ]);
    expect(
      await sql`SELECT schedule_version,result_version FROM competition_publications
        WHERE competition_id=${competition.id}`,
    ).toEqual([{ schedule_version: 1, result_version: 2 }]);
    expect(
      await sql`SELECT schedule_version,result_version FROM public_competition_projections
        WHERE competition_id=${competition.id} ORDER BY result_version DESC LIMIT 1`,
    ).toEqual([{ schedule_version: 1, result_version: 2 }]);
    const legacyCorrectionId = randomUUID();
    const legacyClientId = randomUUID();
    await sql`INSERT INTO canonical_score_events(
      id,competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
      command,command_fingerprint,actor_account_id,device_timestamp,legacy_score_event_id
    ) VALUES(
      ${legacyCorrectionId},${competition.id},${division.id},${match.id},${legacyClientId},9,9,
      'legacy_correction',
      ${sql.json({
        client_event_id: legacyClientId,
        type: "legacy_correction",
        occurred_at: new Date().toISOString(),
      })},
      ${"a".repeat(64)},${accountId},now(),NULL
    )`;
    await sql`UPDATE match_score_streams SET current_version=9 WHERE match_id=${match.id}`;
    await sql`INSERT INTO match_result_snapshots(
      match_id,result_version,through_sequence,home_score,away_score,state,snapshot
    ) VALUES(${match.id},999,9,7,6,'corrected','{"legacy":true}'::jsonb)`;
    await expect(runtime.matchScoringAudit(actor, competition.id, match.id)).resolves.toMatchObject({
      aggregate_version: 9,
      score: { home: 7, away: 6 },
    });
    await expect(
      runtime.reopenCanonicalMatch(
        actor,
        competition.id,
        match.id,
        {
          clientEventId: randomUUID(),
          reason: "Attempt canonical review",
          expectedAggregateVersion: 9,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "LEGACY_CORRECTION_REQUIRES_REVIEW" });
  });

  it("refuses to replay a stream whose frozen sport pack has no matching reducer", async () => {
    const world = await createScoringWorld("basketball");
    const unsupportedVersion = `unsupported-${randomUUID()}`;
    const definition = { ...SPORT_PACKS.basketball, reducerCompatibilityTest: true };
    await sql`INSERT INTO sport_pack_versions(
      sport_code,version,schema_version,definition,definition_hash,created_at
    ) VALUES(
      'basketball',${unsupportedVersion},1,${sql.json(definition)},
      encode(public.digest(phase3_canonical_jsonb(${sql.json(definition)}::jsonb),'sha256'),'hex'),
      now()
    )`;
    await sql`UPDATE competition_sport_settings SET pack_version=${unsupportedVersion}
      WHERE competition_id=${world.competition.id}`;
    await sql`UPDATE division_sport_settings SET pack_version=${unsupportedVersion}
      WHERE division_id=${world.division.id}`;
    await expect(
      runtime.appendCanonicalScoreEvent(
        world.auth,
        {
          client_event_id: randomUUID(),
          type: "match_started",
          occurred_at: new Date().toISOString(),
        },
        0,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "SPORT_PACK_VERSION_UNSUPPORTED" });
    expect(await sql`SELECT match_id FROM match_score_streams WHERE match_id=${world.match.id}`).toEqual([]);
  });
});
