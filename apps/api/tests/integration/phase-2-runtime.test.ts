import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import type { PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { buildApp } from "../../src/app.js";
import { ApiError } from "../../src/errors.js";
import type { IdentityApiRuntime } from "../../src/identity-runtime.js";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../../src/phase-2-runtime.js";
import { healthyProbes, testConfig } from "../helpers.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase2_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
let client: Sql;
let runtime: Phase2Runtime;
let accountId: string;
let organisationId: string;

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  client = postgres(databaseUrl, { max: 4, onnotice: () => undefined, connection: { search_path: schema } });
  const accounts = await client<{ id: string }[]>`
    INSERT INTO accounts (primary_email,display_name,email_verified_at)
    VALUES ('organiser@phase2.test','Phase 2 Organiser',now()) RETURNING id
  `;
  accountId = accounts[0]?.id ?? "";
  await client.begin(async (transaction) => {
    const organisations = await transaction<{ id: string }[]>`
      INSERT INTO organisations (name,slug) VALUES ('Phase 2 Org','phase-2-org') RETURNING id
    `;
    organisationId = organisations[0]?.id ?? "";
    await transaction`
      INSERT INTO organisation_memberships (organisation_id,account_id,role,status)
      VALUES (${organisationId},${accountId},'owner','active')
    `;
  });
  runtime = new Phase2Runtime(client as unknown as PostgresJsSql, phase2DomainAdapter);
});

afterAll(async () => {
  await client?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

describe("Phase 2 transactional Canoe Polo runtime", () => {
  it("executes the 14-step slice with deterministic revisions, fenced scoring, and isolated publication versions", async () => {
    const actor = { accountId };
    const accessExpiry = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const competition = await runtime.createCompetition(
      actor,
      {
        organisationId,
        name: "Singapore Open",
        slug: "singapore-open-phase-2",
        timezone: "Asia/Singapore",
        startsOn: "2026-08-01",
        endsOn: "2026-08-01",
      },
      randomUUID(),
    );
    await runtime.updateSettings(actor, competition.id, { periodMinutes: 10 }, randomUUID());
    const division = await runtime.createDivision(actor, competition.id, { name: "Open", teamLimit: 8 }, randomUUID());
    const entries = Array.from({ length: 8 }, (_, index) => ({ name: `Team ${index + 1}`, seed: index + 1 }));
    await runtime.replaceEntries(actor, competition.id, division.id, entries, randomUUID());
    await runtime.replaceCapacity(
      actor,
      competition.id,
      [
        { name: "Court 1", windows: [{ startsAt: "2026-08-01T00:00:00.000Z", endsAt: "2026-08-01T12:00:00.000Z" }] },
        { name: "Court 2", windows: [{ startsAt: "2026-08-01T00:00:00.000Z", endsAt: "2026-08-01T12:00:00.000Z" }] },
      ],
      randomUUID(),
    );

    const format = await runtime.generateFormat(actor, competition.id, division.id, randomUUID());
    expect(format.matches).toHaveLength(16);
    expect(new Set(format.matches.map((match) => match.id)).size).toBe(16);
    const repeatedFormat = await runtime.generateFormat(actor, competition.id, division.id, randomUUID());
    expect(repeatedFormat).toMatchObject({ id: format.id, duplicate: true, definition_hash: format.definition_hash });

    const schedule = await runtime.generateSchedule(actor, competition.id, format.id, randomUUID());
    expect(schedule.matches).toHaveLength(16);
    const publishedSchedule = await runtime.publishSchedule(actor, competition.id, schedule.id, randomUUID());
    expect(publishedSchedule.schedule_version).toBe(1);
    const publishedCompetition = await client<{ status: string }[]>`
      SELECT status FROM competitions WHERE id=${competition.id}
    `;
    expect(publishedCompetition[0]?.status).toBe("active");
    const draftRetry = await runtime.generateSchedule(actor, competition.id, format.id, randomUUID());
    expect(draftRetry).toMatchObject({ id: schedule.id, duplicate: true });

    const firstMatch = format.matches[0];
    const secondMatch = format.matches[1];
    expect(firstMatch?.homeEntryId).toBeTruthy();
    expect(firstMatch?.awayEntryId).toBeTruthy();
    if (!firstMatch || !secondMatch) throw new Error("Expected generated matches");
    const pass = await runtime.createAccessPass(actor, competition.id, firstMatch.id, accessExpiry, randomUUID());
    const hashes = await client<{ secret_hash: Buffer; short_code_hash: Buffer }[]>`
      SELECT secret_hash,short_code_hash FROM scoring_access_passes WHERE id=${pass.id}
    `;
    expect(hashes[0]?.secret_hash.toString("utf8")).not.toContain(pass.token);
    expect(pass.short_code).toMatch(/^\d{12}$/);

    await expect(
      runtime.exchangeAccess({ token: pass.token, expectedMatchId: secondMatch.id }, randomUUID()),
    ).rejects.toMatchObject({ statusCode: 403, code: "ACCESS_WRONG_MATCH" });
    const writer = await runtime.exchangeAccess({ token: pass.token, expectedMatchId: firstMatch.id }, randomUUID());
    await expect(runtime.exchangeAccess({ token: pass.token }, randomUUID())).rejects.toMatchObject({
      statusCode: 409,
      code: "WRITER_ACTIVE",
    });
    const writerAuth = {
      sessionId: writer.session_id,
      sessionToken: writer.session_token,
      generation: writer.generation,
    };
    const startId = randomUUID();
    expect(
      await runtime.appendScoreEvent(
        writerAuth,
        {
          clientEventId: startId,
          type: "match_started",
          teamSlot: null,
          scorer: null,
          manualPeriod: 1,
          manualEventSeconds: 0,
          payload: {},
          correctionReason: null,
          occurredAt: new Date("2026-08-01T01:00:00.000Z"),
        },
        randomUUID(),
      ),
    ).toMatchObject({ duplicate: false, sequence: 1 });
    const goalId = randomUUID();
    await runtime.appendScoreEvent(
      writerAuth,
      {
        clientEventId: goalId,
        type: "goal_added",
        teamSlot: "home",
        scorer: "Player 7",
        manualPeriod: 1,
        manualEventSeconds: 92,
        payload: {},
        correctionReason: null,
        occurredAt: new Date("2026-08-01T01:01:32.000Z"),
      },
      randomUUID(),
    );
    expect(
      await runtime.appendScoreEvent(
        writerAuth,
        {
          clientEventId: goalId,
          type: "goal_added",
          teamSlot: "home",
          scorer: "Player 7",
          manualPeriod: 1,
          manualEventSeconds: 92,
          payload: {},
          correctionReason: null,
          occurredAt: new Date("2026-08-01T01:01:32.000Z"),
        },
        randomUUID(),
      ),
    ).toMatchObject({ duplicate: true, sequence: 2 });

    const state = await runtime.scoringSessionState(writerAuth);
    expect(state).toMatchObject({
      competition: { slug: "singapore-open-phase-2" },
      score: { home: 1, away: 0 },
      through_sequence: 2,
      writer: { generation: 1 },
    });
    const finalEventId = randomUUID();
    const final = await runtime.finalise(writerAuth, finalEventId, randomUUID());
    expect(final).toMatchObject({ home_score: 1, away_score: 0, result_version: 1 });
    expect(await runtime.finalise(writerAuth, finalEventId, randomUUID())).toMatchObject({
      duplicate: true,
      home_score: 1,
      away_score: 0,
      result_version: 1,
    });
    const publicResult = await runtime.publicCompetition("singapore-open-phase-2");
    expect(publicResult.publication).toEqual({ schedule_version: 1, result_version: 1 });
    expect(publicResult.competition).toMatchObject({ name: "Singapore Open", status: "active" });
    expect(publicResult.division).toMatchObject({ id: division.id, name: "Open" });
    expect(publicResult.schedule[0]).toMatchObject({
      home: { name: expect.stringMatching(/^Team /) },
      away: { name: expect.stringMatching(/^Team /) },
      area: { name: expect.stringMatching(/^Court /) },
    });
    expect(publicResult.results[0]).toMatchObject({
      home: { name: expect.stringMatching(/^Team /) },
      away: { name: expect.stringMatching(/^Team /) },
      home_score: 1,
      away_score: 0,
    });
    expect(JSON.stringify(publicResult)).not.toMatch(/primary_email|session_token|short_code|secret_hash|"draft"/);
    const publicApp = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime: {
        authenticate: async () => {
          throw new Error("Public route must not authenticate");
        },
        verifyCsrfToken: () => false,
      } as unknown as IdentityApiRuntime,
      phase2Runtime: runtime,
    });
    try {
      const publicResponse = await publicApp.inject({
        method: "GET",
        url: "/api/v1/public/competitions/singapore-open-phase-2",
      });
      expect(publicResponse.statusCode).toBe(200);
      expect(publicResponse.json()).toMatchObject({
        competition: { status: "active", name: "Singapore Open" },
        division: { name: "Open" },
        results: [{ home: { name: expect.stringMatching(/^Team /) }, away: { name: expect.stringMatching(/^Team /) } }],
      });
      expect(publicResponse.body).not.toMatch(/primary_email|session_token|short_code|secret_hash|"draft"/);
    } finally {
      await publicApp.close();
    }

    await client`INSERT INTO match_result_snapshots
      (match_id,result_version,through_sequence,home_score,away_score,state,snapshot)
      VALUES (${firstMatch.id},3,99,99,99,'corrected',${client.json({ future: true })})`;
    const correction = await runtime.correct(
      actor,
      competition.id,
      firstMatch.id,
      {
        clientEventId: randomUUID(),
        reason: "Official score sheet correction",
        homeScore: 1,
        awayScore: 1,
      },
      randomUUID(),
    );
    expect(correction).toMatchObject({ duplicate: false, result_version: 2 });
    const correctedPublicResult = await runtime.publicCompetition("singapore-open-phase-2");
    expect(correctedPublicResult.results.find((result) => result.id === firstMatch.id)).toMatchObject({
      home_score: 1,
      away_score: 1,
    });
    const publicationRows = await client<{ schedule_version: number; result_version: number }[]>`
      SELECT schedule_version,result_version FROM competition_publications WHERE competition_id=${competition.id}
    `;
    expect(publicationRows[0]).toEqual({ schedule_version: 1, result_version: 2 });
    await expect(client`UPDATE score_events SET payload='{}'::jsonb WHERE match_id=${firstMatch.id}`).rejects.toThrow(
      "score_events are append-only",
    );
    await expect(client`
      UPDATE scheduled_matches SET starts_at=starts_at + interval '1 minute'
      WHERE schedule_revision_id=${schedule.id}
    `).rejects.toThrow("published schedule assignments are immutable");

    const downstream = await client<{ match_id: string }[]>`
      SELECT match_id FROM match_dependencies WHERE source_match_id=${firstMatch.id} ORDER BY match_id LIMIT 1
    `;
    const downstreamId = downstream[0]?.match_id;
    if (!downstreamId) throw new Error("Expected a downstream knockout match");
    await client`UPDATE matches SET state='in_progress' WHERE id=${downstreamId}`;
    await expect(
      runtime.correct(
        actor,
        competition.id,
        firstMatch.id,
        {
          clientEventId: randomUUID(),
          reason: "Late conflicting correction",
          homeScore: 2,
          awayScore: 1,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "CORRECTION_DOWNSTREAM_CONFLICT" });
    await client`UPDATE matches SET state='pending' WHERE id=${downstreamId}`;

    const secondPass = await runtime.createAccessPass(
      actor,
      competition.id,
      secondMatch.id,
      accessExpiry,
      randomUUID(),
    );
    const secondWriter = await runtime.exchangeAccess({ token: secondPass.token }, randomUUID());
    const replacement = await runtime.transferWriter(
      {
        sessionId: secondWriter.session_id,
        sessionToken: secondWriter.session_token,
        generation: secondWriter.generation,
      },
      randomUUID(),
    );
    expect(replacement.generation).toBe(2);
    await expect(
      runtime.appendScoreEvent(
        {
          sessionId: secondWriter.session_id,
          sessionToken: secondWriter.session_token,
          generation: secondWriter.generation,
        },
        {
          clientEventId: randomUUID(),
          type: "match_started",
          teamSlot: null,
          scorer: null,
          manualPeriod: 1,
          manualEventSeconds: 0,
          payload: {},
          correctionReason: null,
          occurredAt: new Date(),
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "STALE_WRITER_GENERATION" });

    const workspace = await runtime.competitionWorkspace(actor, competition.id);
    expect(workspace).toMatchObject({
      competition: { id: competition.id, organisation_id: organisationId },
      publication: { schedule_version: 1, result_version: 2 },
    });
    expect(JSON.stringify(workspace.access_passes)).not.toContain(pass.token);
    expect(await runtime.audit(actor, competition.id)).not.toHaveLength(0);

    await client`INSERT INTO advancement_conflicts
      (competition_id,division_id,result_version,rule_id,target_slot_id,reason)
      VALUES (${competition.id},${division.id},2,'archive-test','home','Archive regression fixture')`;
    await client`INSERT INTO advancement_slots
      (competition_id,division_id,match_id,slot,entry_id,control,result_version)
      VALUES (${competition.id},${division.id},${downstreamId},'home',NULL,'manual',2)
      ON CONFLICT (match_id,slot) DO NOTHING`;
    await client`UPDATE competitions
      SET archived_from_status=status,status='archived',archived_at=now()
      WHERE id=${competition.id}`;

    await expect(
      runtime.updateSettings(actor, competition.id, { periodMinutes: 9 }, randomUUID()),
    ).rejects.toMatchObject({ statusCode: 409, code: "COMPETITION_ARCHIVED" });
    await expect(runtime.publishSchedule(actor, competition.id, schedule.id, randomUUID())).rejects.toMatchObject({
      statusCode: 409,
      code: "COMPETITION_ARCHIVED",
    });
    await expect(runtime.exchangeAccess({ token: pass.token }, randomUUID())).rejects.toMatchObject({
      statusCode: 409,
      code: "COMPETITION_ARCHIVED",
    });
    await expect(runtime.transferWriter(writerAuth, randomUUID())).rejects.toMatchObject({
      statusCode: 409,
      code: "COMPETITION_ARCHIVED",
    });
    await expect(
      runtime.correct(
        actor,
        competition.id,
        firstMatch.id,
        { clientEventId: randomUUID(), reason: "Archived correction", homeScore: 0, awayScore: 0 },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "COMPETITION_ARCHIVED" });

    const archivedWrites = [
      client`UPDATE matches SET state=state WHERE id=${firstMatch.id}`,
      client`UPDATE match_dependencies SET outcome=outcome WHERE source_match_id=${firstMatch.id}`,
      client`UPDATE schedule_revisions SET warnings=warnings WHERE id=${schedule.id}`,
      client`UPDATE scheduled_matches SET starts_at=starts_at WHERE schedule_revision_id=${schedule.id}`,
      client`UPDATE competition_publications SET updated_at=updated_at WHERE competition_id=${competition.id}`,
      client`UPDATE scoring_access_passes SET revoked_at=revoked_at WHERE id=${pass.id}`,
      client`UPDATE scoring_access_sessions SET revoked_at=revoked_at WHERE id=${writer.session_id}`,
      client`UPDATE match_writer_leases SET expires_at=expires_at WHERE match_id=${firstMatch.id}`,
      client`UPDATE score_events SET payload=payload WHERE match_id=${firstMatch.id}`,
      client`UPDATE match_result_snapshots SET snapshot=snapshot WHERE match_id=${firstMatch.id}`,
      client`UPDATE bracket_snapshots SET bracket=bracket WHERE competition_id=${competition.id}`,
      client`UPDATE public_competition_projections SET projection=projection WHERE competition_id=${competition.id}`,
      client`UPDATE advancement_slots SET updated_at=updated_at WHERE competition_id=${competition.id}`,
      client`UPDATE advancement_conflicts SET reason=reason WHERE competition_id=${competition.id}`,
    ];
    for (const write of archivedWrites) {
      await expect(write).rejects.toThrow(/archived competitions are immutable/i);
    }

    await client`UPDATE competitions
      SET status=archived_from_status,archived_from_status=NULL
      WHERE id=${competition.id}`;
    await expect(runtime.revokeAccessPass(actor, competition.id, pass.id, randomUUID())).resolves.toMatchObject({
      id: pass.id,
      revoked: true,
    });

    await client`DELETE FROM competitions WHERE id=${competition.id}`;
    const residue = await client<{ count: number }[]>`
      SELECT (
        (SELECT count(*) FROM matches WHERE competition_id=${competition.id})
        + (SELECT count(*) FROM schedule_revisions WHERE competition_id=${competition.id})
        + (SELECT count(*) FROM score_events e JOIN matches m ON m.id=e.match_id WHERE m.competition_id=${competition.id})
        + (SELECT count(*) FROM standings_snapshots WHERE competition_id=${competition.id})
        + (SELECT count(*) FROM advancement_conflicts WHERE competition_id=${competition.id})
      )::integer AS count`;
    expect(residue[0]?.count).toBe(0);
  }, 30_000);

  it("uses opaque namespaced match UUIDs and rejects non-finalisable score streams", () => {
    const entriesA = Array.from({ length: 8 }, (_, index) => ({
      id: randomUUID(),
      name: `A${index}`,
      seed: index + 1,
    }));
    const entriesB = Array.from({ length: 8 }, (_, index) => ({
      id: randomUUID(),
      name: `B${index}`,
      seed: index + 1,
    }));
    const formatA = phase2DomainAdapter.generateFormat(entriesA);
    const formatB = phase2DomainAdapter.generateFormat(entriesB);
    expect(formatA.matches[0]?.id).not.toBe(formatB.matches[0]?.id);
    expect(formatA.matches.every((match) => /^[0-9a-f-]{36}$/.test(match.id))).toBe(true);
    expect(() =>
      phase2DomainAdapter.reduceScore([], {
        matchId: randomUUID(),
        homeEntryId: entriesA[0]?.id ?? "",
        awayEntryId: entriesA[1]?.id ?? "",
      }),
    ).toThrow("Match has not started");
    expect(new ApiError(409, "STALE_WRITER_GENERATION", "stale").statusCode).toBe(409);
  });
});
