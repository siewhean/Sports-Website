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
    const thirdMatch = format.matches[2];
    const fourthMatch = format.matches[3];
    const fifthMatch = format.matches[4];
    expect(firstMatch?.homeEntryId).toBeTruthy();
    expect(firstMatch?.awayEntryId).toBeTruthy();
    if (!firstMatch || !secondMatch || !thirdMatch || !fourthMatch || !fifthMatch) {
      throw new Error("Expected generated matches");
    }
    const pass = await runtime.createAccessPass(actor, competition.id, firstMatch.id, accessExpiry, randomUUID());
    const hashes = await client<{ secret_hash: Buffer; short_code_hash: Buffer }[]>`
      SELECT secret_hash,short_code_hash FROM scoring_access_passes WHERE id=${pass.id}
    `;
    expect(hashes[0]?.secret_hash.toString("utf8")).not.toContain(pass.token);
    expect(pass.short_code).toMatch(/^\d{12}$/);
    const idempotencyKey = `idempotent-${randomUUID()}`;
    const idempotentPass = await runtime.createAccessPass(
      actor,
      competition.id,
      firstMatch.id,
      { expiresAt: accessExpiry, role: "viewer", idempotencyKey },
      randomUUID(),
    );
    const idempotentReplay = await runtime.createAccessPass(
      actor,
      competition.id,
      firstMatch.id,
      { expiresAt: accessExpiry, role: "viewer", idempotencyKey },
      randomUUID(),
    );
    expect(idempotentReplay).toMatchObject({
      id: idempotentPass.id,
      duplicate: true,
      token: null,
      short_code: null,
      qr_path: null,
    });
    await expect(
      runtime.createAccessPass(
        actor,
        competition.id,
        firstMatch.id,
        { expiresAt: accessExpiry, role: "scorekeeper", idempotencyKey },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "ACCESS_IDEMPOTENCY_CONFLICT" });
    await runtime.revokeAccessPass(actor, competition.id, idempotentPass.id, randomUUID(), "Fixture revocation");
    if (!idempotentPass.token) throw new Error("Expected one-time idempotent access secret");
    await expect(
      runtime.exchangeAccess(
        { token: idempotentPass.token, deviceId: randomUUID(), ipAddress: "192.0.2.20" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "ACCESS_REVOKED" });
    const expiringPass = await runtime.createAccessPass(
      actor,
      competition.id,
      firstMatch.id,
      {
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        role: "viewer",
        idempotencyKey: `expires-${randomUUID()}`,
      },
      randomUUID(),
    );
    if (!expiringPass.token) throw new Error("Expected one-time expiring access secret");
    const expiringSession = await runtime.exchangeAccess(
      {
        token: expiringPass.token,
        deviceId: randomUUID(),
        ipAddress: "192.0.2.22",
      },
      randomUUID(),
    );
    const futureRuntime = new Phase2Runtime(
      client as unknown as PostgresJsSql,
      phase2DomainAdapter,
      () => new Date(Date.now() + 120_000),
    );
    await expect(
      futureRuntime.exchangeAccess(
        { token: expiringPass.token, deviceId: randomUUID(), ipAddress: "192.0.2.21" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "ACCESS_EXPIRED" });
    await expect(
      futureRuntime.scoringSessionState({
        sessionId: expiringSession.session_id,
        sessionToken: expiringSession.session_token,
        generation: null,
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "SCORING_SESSION_EXPIRED" });
    const deniedAttempts = await client<
      {
        outcome: string;
        competition_id: string | null;
        match_id: string | null;
        access_pass_id: string | null;
      }[]
    >`
      SELECT outcome,competition_id,match_id,access_pass_id
      FROM scoring_access_attempts WHERE outcome IN ('revoked','expired') ORDER BY attempted_at
    `;
    expect(deniedAttempts.map((attempt) => attempt.outcome)).toEqual(["revoked", "expired"]);
    expect(deniedAttempts.every((attempt) => attempt.competition_id === competition.id)).toBe(true);
    expect(deniedAttempts.every((attempt) => attempt.match_id === firstMatch.id)).toBe(true);
    expect(deniedAttempts.every((attempt) => attempt.access_pass_id !== null)).toBe(true);

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
    const viewerPass = await runtime.createAccessPass(
      actor,
      competition.id,
      firstMatch.id,
      { expiresAt: accessExpiry, role: "viewer", idempotencyKey: `viewer-${randomUUID()}` },
      randomUUID(),
    );
    if (!viewerPass.token) throw new Error("Expected one-time viewer access secret");
    const viewer = await runtime.exchangeAccess(
      {
        token: viewerPass.token,
        deviceId: randomUUID(),
        deviceLabel: "Read-only official",
        ipAddress: "192.0.2.14",
      },
      randomUUID(),
    );
    expect(viewer).toMatchObject({
      mode: "viewer",
      generation: null,
      permissions: ["score:read"],
      lease_expires_at: null,
    });
    expect(
      await runtime.scoringSessionState({
        sessionId: viewer.session_id,
        sessionToken: viewer.session_token,
        generation: null,
      }),
    ).toMatchObject({ access: { mode: "viewer" }, writer: { generation: null, read_only: true } });
    const staleSubmissionId = randomUUID();
    const staleSubmissionRequestId = randomUUID();
    await expect(
      runtime.appendScoreEvent(
        { sessionId: viewer.session_id, sessionToken: viewer.session_token, generation: null },
        {
          clientEventId: staleSubmissionId,
          type: "goal_added",
          teamSlot: "home",
          scorer: "Viewer cannot score",
          manualPeriod: 1,
          manualEventSeconds: 100,
          payload: {},
          correctionReason: null,
          occurredAt: new Date(),
        },
        staleSubmissionRequestId,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "STALE_WRITER_GENERATION" });
    const retainedStaleSubmission = await client<
      {
        after_state: string;
        metadata: string | Record<string, unknown>;
      }[]
    >`
      SELECT after_state,metadata FROM audit_events
      WHERE request_id=${staleSubmissionRequestId}
        AND action='scoring_event.stale_submission_rejected'
    `;
    expect({
      after_state: JSON.parse(retainedStaleSubmission[0]?.after_state ?? "{}"),
      metadata:
        typeof retainedStaleSubmission[0]?.metadata === "string"
          ? JSON.parse(retainedStaleSubmission[0].metadata)
          : retainedStaleSubmission[0]?.metadata,
    }).toMatchObject({
      after_state: { client_event_id: staleSubmissionId, event_type: "goal_added" },
      metadata: { submitted_generation: null, retained_for_review: true },
    });
    const rejectedScoreEvent = await client<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM score_events
      WHERE match_id=${firstMatch.id} AND client_event_id=${staleSubmissionId}
    `;
    expect(rejectedScoreEvent[0]?.count).toBe(0);
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
    const candidatePass = await runtime.createAccessPass(
      actor,
      competition.id,
      secondMatch.id,
      {
        expiresAt: accessExpiry,
        role: "scorekeeper",
        idempotencyKey: `candidate-${randomUUID()}`,
      },
      randomUUID(),
    );
    if (!candidatePass.token) throw new Error("Expected one-time candidate access secret");
    const candidate = await runtime.exchangeAccess(
      {
        token: candidatePass.token,
        deviceId: randomUUID(),
        deviceLabel: "Replacement tablet",
        ipAddress: "203.0.113.10",
      },
      randomUUID(),
    );
    expect(candidate).toMatchObject({ mode: "candidate", generation: null, lease_expires_at: null });
    await runtime.heartbeatScoringSession(
      {
        sessionId: secondWriter.session_id,
        sessionToken: secondWriter.session_token,
        generation: secondWriter.generation,
      },
      { lastAcknowledgedSequence: 0, pendingEventCount: 0, pendingThroughSequence: 0 },
      randomUUID(),
    );
    const takeover = await runtime.requestTakeover(
      { sessionId: candidate.session_id, sessionToken: candidate.session_token, generation: null },
      { pendingEventCount: 0, pendingThroughSequence: 0 },
      randomUUID(),
    );
    expect(takeover).toMatchObject({ status: "pending", incumbent_pending_state: "none" });
    const approved = await runtime.resolveTakeover(
      actor,
      competition.id,
      takeover.id,
      {
        decision: "approve",
        overrideAcknowledged: false,
        reason: "Approved replacement tablet",
      },
      randomUUID(),
    );
    expect(approved).toMatchObject({ status: "approved", generation: 2, conflict_id: null });
    if (approved.status !== "approved" || approved.generation === undefined) {
      throw new Error("Expected an approved takeover generation");
    }
    await expect(
      runtime.scoringSessionState({
        sessionId: secondWriter.session_id,
        sessionToken: secondWriter.session_token,
        generation: secondWriter.generation,
      }),
    ).resolves.toMatchObject({
      access: { mode: "transferred" },
      writer: { generation: secondWriter.generation, expires_at: null, read_only: true },
    });
    await expect(
      runtime.appendScoreEvent(
        {
          sessionId: candidate.session_id,
          sessionToken: candidate.session_token,
          generation: approved.generation,
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
    ).resolves.toMatchObject({ duplicate: false, sequence: 1 });
    await expect(
      runtime.transferWriter(
        {
          sessionId: secondWriter.session_id,
          sessionToken: secondWriter.session_token,
          generation: secondWriter.generation,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "SELF_TRANSFER_FORBIDDEN" });
    const transferredStaleEventId = randomUUID();
    const transferredStaleRequestId = randomUUID();
    await expect(
      runtime.appendScoreEvent(
        {
          sessionId: secondWriter.session_id,
          sessionToken: secondWriter.session_token,
          generation: secondWriter.generation,
        },
        {
          clientEventId: transferredStaleEventId,
          type: "match_started",
          teamSlot: null,
          scorer: null,
          manualPeriod: 1,
          manualEventSeconds: 0,
          payload: {},
          correctionReason: null,
          occurredAt: new Date(),
        },
        transferredStaleRequestId,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "STALE_WRITER_GENERATION" });
    const transferredStaleEvidence = await client<
      {
        after_state: string;
        metadata: string | Record<string, unknown>;
      }[]
    >`
      SELECT after_state,metadata FROM audit_events
      WHERE request_id=${transferredStaleRequestId}
        AND action='scoring_event.stale_submission_rejected'
    `;
    expect({
      after_state: JSON.parse(transferredStaleEvidence[0]?.after_state ?? "{}"),
      metadata:
        typeof transferredStaleEvidence[0]?.metadata === "string"
          ? JSON.parse(transferredStaleEvidence[0].metadata)
          : transferredStaleEvidence[0]?.metadata,
    }).toMatchObject({
      after_state: { client_event_id: transferredStaleEventId },
      metadata: { submitted_generation: secondWriter.generation, retained_for_review: true },
    });
    const transferredStaleScoreEvent = await client<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM score_events
      WHERE match_id=${secondMatch.id} AND client_event_id=${transferredStaleEventId}
    `;
    expect(transferredStaleScoreEvent[0]?.count).toBe(0);

    const concurrentIssueKey = `concurrent-issue-${randomUUID()}`;
    const concurrentIssueResults = await Promise.all(
      [randomUUID(), randomUUID()].map((requestId) =>
        runtime.createAccessPass(
          actor,
          competition.id,
          thirdMatch.id,
          {
            expiresAt: accessExpiry,
            role: "viewer",
            idempotencyKey: concurrentIssueKey,
          },
          requestId,
        ),
      ),
    );
    expect(new Set(concurrentIssueResults.map((result) => result.id)).size).toBe(1);
    expect(concurrentIssueResults.filter((result) => result.token !== null)).toHaveLength(1);

    const concurrentPasses = await Promise.all(
      ["one", "two"].map((label) =>
        runtime.createAccessPass(
          actor,
          competition.id,
          thirdMatch.id,
          {
            expiresAt: accessExpiry,
            role: "scorekeeper",
            idempotencyKey: `concurrent-${label}-${randomUUID()}`,
          },
          randomUUID(),
        ),
      ),
    );
    const concurrentSessions = await Promise.all(
      concurrentPasses.map((accessPass, index) => {
        if (!accessPass.token) throw new Error("Expected one-time concurrent access secret");
        return runtime.exchangeAccess(
          {
            token: accessPass.token,
            deviceId: randomUUID(),
            deviceLabel: `Concurrent device ${index + 1}`,
            ipAddress: `198.51.100.${index + 1}`,
          },
          randomUUID(),
        );
      }),
    );
    expect(concurrentSessions.map((session) => session.mode).sort()).toEqual(["candidate", "writer"]);
    expect(concurrentSessions.filter((session) => session.generation !== null)).toHaveLength(1);
    const expiringWriter = concurrentSessions.find((session) => session.mode === "writer");
    if (!expiringWriter?.generation) throw new Error("Expected concurrent active writer");
    await client`DELETE FROM match_writer_leases WHERE access_session_id=${expiringWriter.session_id}`;
    const deniedHeartbeatRequestId = randomUUID();
    await expect(
      runtime.heartbeatScoringSession(
        {
          sessionId: expiringWriter.session_id,
          sessionToken: expiringWriter.session_token,
          generation: expiringWriter.generation,
        },
        { lastAcknowledgedSequence: 0, pendingEventCount: 0, pendingThroughSequence: 0 },
        deniedHeartbeatRequestId,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "STALE_WRITER_GENERATION" });
    const heartbeatDenials = await client<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM audit_events
      WHERE request_id=${deniedHeartbeatRequestId} AND action='scoring_session.heartbeat_denied'
    `;
    const heartbeatDenialOutbox = await client<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM outbox_events
      WHERE event_type='scoring_session.heartbeat_denied'
    `;
    expect(heartbeatDenials[0]?.count).toBe(1);
    expect(heartbeatDenialOutbox[0]?.count).toBe(0);

    const [unknownWriterPass, unknownCandidatePass] = await Promise.all(
      ["writer", "candidate"].map((label) =>
        runtime.createAccessPass(
          actor,
          competition.id,
          fourthMatch.id,
          {
            expiresAt: accessExpiry,
            role: "scorekeeper",
            idempotencyKey: `unknown-${label}-${randomUUID()}`,
          },
          randomUUID(),
        ),
      ),
    );
    if (!unknownWriterPass?.token || !unknownCandidatePass?.token) {
      throw new Error("Expected one-time unknown-state access secrets");
    }
    const unknownWriter = await runtime.exchangeAccess(
      {
        token: unknownWriterPass.token,
        deviceId: randomUUID(),
        ipAddress: "203.0.113.31",
      },
      randomUUID(),
    );
    const unknownCandidate = await runtime.exchangeAccess(
      {
        token: unknownCandidatePass.token,
        deviceId: randomUUID(),
        ipAddress: "203.0.113.32",
      },
      randomUUID(),
    );
    await runtime.heartbeatScoringSession(
      {
        sessionId: unknownWriter.session_id,
        sessionToken: unknownWriter.session_token,
        generation: unknownWriter.generation,
      },
      { lastAcknowledgedSequence: 0, pendingEventCount: 0, pendingThroughSequence: 0 },
      randomUUID(),
    );
    const unknownTakeover = await runtime.requestTakeover(
      {
        sessionId: unknownCandidate.session_id,
        sessionToken: unknownCandidate.session_token,
        generation: null,
      },
      { pendingEventCount: 0, pendingThroughSequence: 0 },
      randomUUID(),
    );
    expect(unknownTakeover).toMatchObject({ incumbent_pending_state: "none", duplicate: false });
    expect(
      await runtime.requestTakeover(
        {
          sessionId: unknownCandidate.session_id,
          sessionToken: unknownCandidate.session_token,
          generation: null,
        },
        { pendingEventCount: 0, pendingThroughSequence: 0 },
        randomUUID(),
      ),
    ).toMatchObject({ id: unknownTakeover.id, duplicate: true });
    await runtime.heartbeatScoringSession(
      {
        sessionId: unknownWriter.session_id,
        sessionToken: unknownWriter.session_token,
        generation: unknownWriter.generation,
      },
      { lastAcknowledgedSequence: 0, pendingEventCount: 2, pendingThroughSequence: 2 },
      randomUUID(),
    );
    await expect(
      runtime.resolveTakeover(
        actor,
        competition.id,
        unknownTakeover.id,
        {
          decision: "approve",
          overrideAcknowledged: false,
          reason: "Unsafe without acknowledgement",
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "TAKEOVER_OVERRIDE_ACKNOWLEDGEMENT_REQUIRED" });
    const forcedTakeover = await runtime.resolveTakeover(
      actor,
      competition.id,
      unknownTakeover.id,
      {
        decision: "approve",
        overrideAcknowledged: true,
        reason: "New incumbent pending events were reviewed",
      },
      randomUUID(),
    );
    expect(forcedTakeover).toMatchObject({ status: "approved", generation: 2 });
    expect(forcedTakeover.conflict_id).toMatch(/^[0-9a-f-]{36}$/);
    if (forcedTakeover.status !== "approved" || !forcedTakeover.conflict_id) {
      throw new Error("Expected an approved takeover conflict");
    }
    const conflictId = forcedTakeover.conflict_id;
    const conflict = await client<{ pending_event_count: number; pending_through_sequence: number; status: string }[]>`
      SELECT pending_event_count,pending_through_sequence,status
      FROM scoring_transfer_conflicts WHERE id=${conflictId}
    `;
    expect(conflict[0]).toEqual({ pending_event_count: 2, pending_through_sequence: 2, status: "open" });
    await expect(
      runtime.appendScoreEvent(
        {
          sessionId: unknownWriter.session_id,
          sessionToken: unknownWriter.session_token,
          generation: unknownWriter.generation,
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

    const [revocationWriterPass, revocationCandidatePass] = await Promise.all(
      ["writer", "candidate"].map((label) =>
        runtime.createAccessPass(
          actor,
          competition.id,
          fifthMatch.id,
          {
            expiresAt: accessExpiry,
            role: "scorekeeper",
            idempotencyKey: `approval-revocation-${label}-${randomUUID()}`,
          },
          randomUUID(),
        ),
      ),
    );
    if (!revocationWriterPass?.token || !revocationCandidatePass?.token) {
      throw new Error("Expected one-time approval-revocation access secrets");
    }
    const revocationWriter = await runtime.exchangeAccess(
      {
        token: revocationWriterPass.token,
        deviceId: randomUUID(),
        ipAddress: "203.0.113.41",
      },
      randomUUID(),
    );
    const revocationCandidate = await runtime.exchangeAccess(
      {
        token: revocationCandidatePass.token,
        deviceId: randomUUID(),
        ipAddress: "203.0.113.42",
      },
      randomUUID(),
    );
    await runtime.heartbeatScoringSession(
      {
        sessionId: revocationWriter.session_id,
        sessionToken: revocationWriter.session_token,
        generation: revocationWriter.generation,
      },
      { lastAcknowledgedSequence: 0, pendingEventCount: 0, pendingThroughSequence: 0 },
      randomUUID(),
    );
    const revocationTakeover = await runtime.requestTakeover(
      {
        sessionId: revocationCandidate.session_id,
        sessionToken: revocationCandidate.session_token,
        generation: null,
      },
      { pendingEventCount: 0, pendingThroughSequence: 0 },
      randomUUID(),
    );
    const [revocationResult, approvalResult] = await Promise.allSettled([
      runtime.revokeAccessPass(
        actor,
        competition.id,
        revocationCandidatePass.id,
        randomUUID(),
        "Candidate authorization withdrawn",
      ),
      runtime.resolveTakeover(
        actor,
        competition.id,
        revocationTakeover.id,
        {
          decision: "approve",
          overrideAcknowledged: false,
          reason: "Must not approve revoked candidate",
        },
        randomUUID(),
      ),
    ]);
    expect(revocationResult.status).toBe("fulfilled");
    if (approvalResult.status === "rejected") {
      expect(approvalResult.reason).toMatchObject({
        statusCode: 409,
        code: "TAKEOVER_CANDIDATE_INACTIVE",
      });
    }
    const revokedCandidateState = await client<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM scoring_access_sessions WHERE id=${revocationCandidate.session_id}
    `;
    expect(revokedCandidateState[0]?.revoked_at).not.toBeNull();
    const retainedWriterLease = await client<{ access_session_id: string }[]>`
      SELECT access_session_id FROM match_writer_leases WHERE match_id=${fifthMatch.id}
    `;
    expect(
      retainedWriterLease[0]?.access_session_id === undefined ||
        retainedWriterLease[0]?.access_session_id === revocationWriter.session_id,
    ).toBe(true);

    const workspace = await runtime.competitionWorkspace(actor, competition.id);
    expect(workspace).toMatchObject({
      competition: { id: competition.id, organisation_id: organisationId },
      publication: { schedule_version: 1, result_version: 2 },
    });
    expect(JSON.stringify(workspace.access_passes)).not.toContain(pass.token);
    const scoringAuditMetadata = await client<
      { action: string; metadata: string; metadata_type: string; competition_id: string | null }[]
    >`
      SELECT action,metadata::text, jsonb_typeof(metadata) AS metadata_type,
             metadata->>'competition_id' AS competition_id
      FROM audit_events
      WHERE action IN (
        'scoring_access.created','scoring_access.exchanged','scoring_session.heartbeat',
        'scoring_takeover.requested','scoring_takeover.approved'
      )
      ORDER BY occurred_at
    `;
    expect(scoringAuditMetadata).not.toHaveLength(0);
    expect(scoringAuditMetadata.every((event) => event.metadata_type === "object")).toBe(true);
    expect(scoringAuditMetadata.every((event) => event.competition_id === competition.id)).toBe(true);
    const organiserAudit = await runtime.audit(actor, competition.id);
    const organiserAuditActions = new Set(organiserAudit.map((event) => event.action));
    expect([...organiserAuditActions]).toEqual(
      expect.arrayContaining([
        "scoring_access.created",
        "scoring_access.exchanged",
        "scoring_session.heartbeat",
        "scoring_takeover.requested",
        "scoring_takeover.approved",
      ]),
    );

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
    await expect(runtime.scoringSessionState(writerAuth)).rejects.toMatchObject({
      statusCode: 403,
      code: "SCORING_SESSION_REVOKED",
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
