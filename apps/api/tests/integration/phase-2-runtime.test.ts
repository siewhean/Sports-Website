import { createHash, createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { SPORT_PACKS } from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { buildApp } from "../../src/app.js";
import { ApiError } from "../../src/errors.js";
import type { IdentityApiRuntime } from "../../src/identity-runtime.js";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";
import {
  Phase2Runtime,
  type PersistedScoreEvent,
  type Phase2Actor,
  type ScoringSessionAuth,
} from "../../src/phase-2-runtime.js";
import { NoopScoringAccessRateLimiter } from "../../src/scoring-access-rate-limit.js";
import { healthyProbes, testConfig } from "../helpers.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase2_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
let client: Sql;

async function appendCanonicalCanoeEvent(
  runtime: Phase2Runtime,
  auth: ScoringSessionAuth,
  input: Omit<PersistedScoreEvent, "sequence">,
  requestId: string,
) {
  await client`UPDATE competition_sport_settings competition_settings SET
      pack_version=${SPORT_PACKS.canoe_polo.version},
      recommended_snapshot=${client.json(SPORT_PACKS.canoe_polo.recommendedSettings)}
      FROM scoring_access_sessions session
      WHERE session.id=${auth.sessionId}
        AND competition_settings.competition_id=session.competition_id`;
  await client`DELETE FROM division_sport_settings division_settings
      USING scoring_access_sessions session
      JOIN matches match ON match.id=session.match_id
      WHERE session.id=${auth.sessionId}
        AND division_settings.division_id=match.division_id`;
  const state = await runtime.scoringSessionState(auth);
  const common = {
    client_event_id: input.clientEventId,
    occurred_at: input.occurredAt.toISOString(),
    segment_number: input.manualPeriod ?? undefined,
    manual_time_seconds: input.manualEventSeconds,
  };
  const command =
    input.type === "match_started"
      ? { ...common, type: "match_started" }
      : input.type === "period_changed"
        ? { ...common, type: "period_change" }
        : input.type === "goal_added"
          ? {
              ...common,
              type: "goal",
              team_slot: input.teamSlot,
              participant_id: input.scorer,
            }
          : input.type === "incident_added"
            ? { ...common, type: "incident", reason: String(input.payload.note ?? "") }
            : null;
  if (!command) throw new Error(`Canonical Canoe Polo test helper does not support ${input.type}`);
  return runtime.appendCanonicalScoreEvent(auth, command, state.through_sequence, requestId);
}

async function correctCanonicalCanoeResult(
  runtime: Phase2Runtime,
  actor: Phase2Actor,
  competitionId: string,
  matchId: string,
  input: { clientEventId: string; reason: string; homeScore: number; awayScore: number },
  requestId: string,
) {
  const audit = await runtime.matchScoringAudit(actor, competitionId, matchId);
  const score = audit.score as { home: number; away: number; current_segment: number };
  const events = [];
  for (let index = score.home; index < input.homeScore; index += 1) {
    events.push({
      client_event_id: randomUUID(),
      type: "goal",
      occurred_at: new Date().toISOString(),
      team_slot: "home",
      participant_id: "Verified correction",
      segment_number: score.current_segment,
      manual_time_seconds: 0,
    });
  }
  for (let index = score.away; index < input.awayScore; index += 1) {
    events.push({
      client_event_id: randomUUID(),
      type: "goal",
      occurred_at: new Date().toISOString(),
      team_slot: "away",
      participant_id: "Verified correction",
      segment_number: score.current_segment,
      manual_time_seconds: 0,
    });
  }
  if (events.length === 0) {
    events.push({
      client_event_id: randomUUID(),
      type: "incident",
      occurred_at: new Date().toISOString(),
      segment_number: score.current_segment,
      manual_time_seconds: 0,
      reason: "Permission preflight",
    });
  }
  return runtime.correctCanonicalMatch(
    actor,
    competitionId,
    matchId,
    {
      clientEventId: input.clientEventId,
      reason: input.reason,
      expectedAggregateVersion: audit.aggregate_version as number,
      events,
    },
    requestId,
  );
}

let runtime: Phase2Runtime;
let accountId: string;
let organisationId: string;
const fallbackCodeHmacSecret = "phase-2-runtime-fallback-hmac-secret";

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  client = postgres(databaseUrl, { max: 4, onnotice: () => undefined, connection: { search_path: schema } });
  const canoePoloDefinition = SPORT_PACKS.canoe_polo;
  await client`INSERT INTO sport_pack_versions(
    sport_code,version,schema_version,definition,definition_hash,created_at
  ) VALUES(
    'canoe_polo',${canoePoloDefinition.version},1,${client.json(canoePoloDefinition)},
    encode(public.digest(phase3_canonical_jsonb(${client.json(canoePoloDefinition)}::jsonb),'sha256'),'hex'),
    now()
  ) ON CONFLICT (sport_code,version) DO NOTHING`;
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
  runtime = new Phase2Runtime(
    client as unknown as PostgresJsSql,
    phase2DomainAdapter,
    undefined,
    undefined,
    fallbackCodeHmacSecret,
  );
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
    await client`UPDATE division_sport_settings division_settings SET
      pack_version=competition_settings.pack_version,
      settings_override='{}'::jsonb
      FROM competition_sport_settings competition_settings
      WHERE division_settings.division_id=${division.id}
        AND competition_settings.competition_id=${competition.id}`;
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
    const sixthMatch = format.matches[5];
    const seventhMatch = format.matches[6];
    const eighthMatch = format.matches[7];
    const takeoverContentionMatches = format.matches.slice(8, 14);
    const transferFirstMatch = seventhMatch;
    expect(firstMatch?.homeEntryId).toBeTruthy();
    expect(firstMatch?.awayEntryId).toBeTruthy();
    if (
      !firstMatch ||
      !secondMatch ||
      !thirdMatch ||
      !fourthMatch ||
      !fifthMatch ||
      !sixthMatch ||
      !seventhMatch ||
      !eighthMatch ||
      takeoverContentionMatches.length !== 6 ||
      !transferFirstMatch
    ) {
      throw new Error("Expected generated matches");
    }
    const pass = await runtime.createAccessPass(actor, competition.id, firstMatch.id, accessExpiry, randomUUID());
    const hashes = await client<{ secret_hash: Buffer; short_code_hash: Buffer }[]>`
      SELECT secret_hash,short_code_hash FROM scoring_access_passes WHERE id=${pass.id}
    `;
    expect(hashes[0]?.secret_hash.toString("utf8")).not.toContain(pass.token);
    expect(pass.short_code).toMatch(/^\d{12}$/);
    expect(hashes[0]?.short_code_hash).toEqual(
      createHmac("sha256", fallbackCodeHmacSecret).update(`scoring-fallback-code:${pass.short_code}`, "utf8").digest(),
    );
    expect(hashes[0]?.short_code_hash).not.toEqual(createHash("sha256").update(pass.short_code, "utf8").digest());
    const legacyFallbackCode = "012345678901";
    const legacyFallbackPass = await runtime.createAccessPass(
      actor,
      competition.id,
      firstMatch.id,
      {
        expiresAt: accessExpiry,
        role: "viewer",
        idempotencyKey: `legacy-fallback-${randomUUID()}`,
      },
      randomUUID(),
    );
    if (!legacyFallbackPass.token) throw new Error("Expected legacy fallback token");
    await client`
      UPDATE scoring_access_passes
      SET short_code_hash=NULL,fallback_code_hash_version='rotation_required'
      WHERE id=${legacyFallbackPass.id}
    `;
    expect(
      (await runtime.listAccessPasses(actor, competition.id)).find((entry) => entry.id === legacyFallbackPass.id),
    ).toMatchObject({ fallback_code_status: "rotation_required", status: "active" });
    await expect(
      runtime.exchangeAccess(
        {
          token: legacyFallbackPass.token,
          expectedMatchId: firstMatch.id,
          deviceId: randomUUID(),
          ipAddress: "192.0.2.31",
        },
        randomUUID(),
      ),
    ).resolves.toMatchObject({ mode: "viewer", match_id: firstMatch.id });
    await expect(
      runtime.exchangeAccess(
        {
          shortCode: legacyFallbackCode,
          expectedMatchId: firstMatch.id,
          deviceId: randomUUID(),
          ipAddress: "192.0.2.32",
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "ACCESS_FALLBACK_ROTATION_REQUIRED" });
    await expect(
      runtime.exchangeAccess(
        {
          shortCode: legacyFallbackCode,
          deviceId: randomUUID(),
          ipAddress: "192.0.2.35",
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "ACCESS_DENIED" });
    const rotatedLegacyFallback = await runtime.rotateFallbackCode(
      actor,
      competition.id,
      legacyFallbackPass.id,
      randomUUID(),
      randomUUID(),
    );
    expect(rotatedLegacyFallback).toMatchObject({ duplicate: false });
    expect(rotatedLegacyFallback.short_code).toMatch(/^\d{12}$/);
    if (!rotatedLegacyFallback.short_code) throw new Error("Expected rotated fallback code");
    await expect(
      runtime.exchangeAccess(
        {
          shortCode: rotatedLegacyFallback.short_code,
          expectedMatchId: firstMatch.id,
          deviceId: randomUUID(),
          ipAddress: "192.0.2.33",
        },
        randomUUID(),
      ),
    ).resolves.toMatchObject({ mode: "viewer", match_id: firstMatch.id });
    await expect(
      runtime.exchangeAccess(
        {
          shortCode: legacyFallbackCode,
          expectedMatchId: firstMatch.id,
          deviceId: randomUUID(),
          ipAddress: "192.0.2.34",
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "ACCESS_DENIED" });
    const legacyFallbackEvidence = JSON.stringify(
      await client`
        SELECT action,metadata,after_state FROM audit_events WHERE target_id=${legacyFallbackPass.id}::text
        UNION ALL
        SELECT event_type,payload,NULL::jsonb FROM outbox_events WHERE aggregate_id=${legacyFallbackPass.id}::text
      `,
    );
    expect(legacyFallbackEvidence).not.toContain(legacyFallbackCode);
    expect(legacyFallbackEvidence).not.toContain(rotatedLegacyFallback.short_code);
    const collisionTarget = await runtime.createAccessPass(
      actor,
      competition.id,
      firstMatch.id,
      {
        expiresAt: accessExpiry,
        role: "viewer",
        idempotencyKey: `rotation-collision-${randomUUID()}`,
      },
      randomUUID(),
    );
    const generatedCollisionCodes = [pass.short_code, "987654321012"];
    const collisionRuntime = new Phase2Runtime(
      client as unknown as PostgresJsSql,
      phase2DomainAdapter,
      undefined,
      undefined,
      fallbackCodeHmacSecret,
      () => generatedCollisionCodes.shift() ?? "123456789012",
    );
    expect(
      await collisionRuntime.rotateFallbackCode(actor, competition.id, collisionTarget.id, randomUUID(), randomUUID()),
    ).toMatchObject({ short_code: "987654321012", duplicate: false });
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
    await expect(
      runtime.scoringSessionRateLimitSubject(expiringSession.session_id, expiringSession.session_token),
    ).resolves.toBe(expiringPass.id);
    await expect(
      runtime.scoringSessionRateLimitSubject(expiringSession.session_id, "wrong".repeat(10)),
    ).resolves.toBeNull();
    await expect(
      runtime.scoringSessionRateLimitSubject("not-a-uuid", expiringSession.session_token),
    ).resolves.toBeNull();
    const futureRuntime = new Phase2Runtime(
      client as unknown as PostgresJsSql,
      phase2DomainAdapter,
      () => new Date(Date.now() + 120_000),
      undefined,
      fallbackCodeHmacSecret,
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
    await expect(
      futureRuntime.scoringSessionRateLimitSubject(expiringSession.session_id, expiringSession.session_token),
    ).resolves.toBeNull();
    await client`
      UPDATE scoring_access_sessions SET revoked_at=now() WHERE id=${expiringSession.session_id}
    `;
    await expect(
      runtime.scoringSessionRateLimitSubject(expiringSession.session_id, expiringSession.session_token),
    ).resolves.toBeNull();
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
    const baseLimiter = new NoopScoringAccessRateLimiter();
    let failSuccessAccounting = true;
    const failureInjectingRuntime = new Phase2Runtime(
      client as unknown as PostgresJsSql,
      phase2DomainAdapter,
      undefined,
      {
        fingerprints: (...args) => baseLimiter.fingerprints(...args),
        assertAllowed: () => baseLimiter.assertAllowed(),
        recordInvalid: () => baseLimiter.recordInvalid(),
        recordSuccess: async () => {
          if (failSuccessAccounting) {
            failSuccessAccounting = false;
            throw new Error("injected Redis success-accounting failure");
          }
          await baseLimiter.recordSuccess();
        },
      },
      fallbackCodeHmacSecret,
    );
    const retryableExchangeRequestId = randomUUID();
    await expect(
      failureInjectingRuntime.exchangeAccess(
        { shortCode: pass.short_code, expectedMatchId: firstMatch.id, deviceId: randomUUID() },
        retryableExchangeRequestId,
      ),
    ).rejects.toThrow("injected Redis success-accounting failure");
    expect(
      await client<{ sessions: number; leases: number; accepted_attempts: number }[]>`
        SELECT
          (SELECT count(*)::integer FROM scoring_access_sessions WHERE access_pass_id=${pass.id}) AS sessions,
          (SELECT count(*)::integer FROM match_writer_leases WHERE match_id=${firstMatch.id}) AS leases,
          (SELECT count(*)::integer FROM scoring_access_attempts
             WHERE access_pass_id=${pass.id} AND outcome='accepted') AS accepted_attempts
      `,
    ).toEqual([{ sessions: 0, leases: 0, accepted_attempts: 0 }]);
    const writerDeviceId = randomUUID();
    const writerClientIp = "198.51.100.202";
    const writer = await runtime.exchangeAccess(
      {
        shortCode: pass.short_code,
        expectedMatchId: firstMatch.id,
        deviceId: writerDeviceId,
        ipAddress: writerClientIp,
      },
      retryableExchangeRequestId,
    );
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
      await appendCanonicalCanoeEvent(
        runtime,
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
    const goalRequestId = randomUUID();
    const goalReceipt = await appendCanonicalCanoeEvent(
      runtime,
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
      goalRequestId,
    );
    expect(goalReceipt).toMatchObject({ duplicate: false, sequence: 2 });
    expect(
      await client<
        {
          audit_count: number;
          audit_metadata_type: string;
          audit_competition_id: string;
          audit_after_state_type: string;
          audit_after_event_type: string;
          audit_before_state_is_null: boolean;
          outbox_count: number;
          outbox_payload_type: string;
          outbox_competition_id: string;
          outbox_match_id: string;
        }[]
      >`
        SELECT
          (SELECT count(*)::integer FROM audit_events
             WHERE request_id=${goalRequestId}
               AND action='scoring_event.appended'
               AND target_type='match'
               AND target_id=${firstMatch.id}) AS audit_count,
          (SELECT jsonb_typeof(metadata) FROM audit_events
             WHERE request_id=${goalRequestId}
               AND action='scoring_event.appended') AS audit_metadata_type,
          (SELECT metadata->>'competition_id' FROM audit_events
             WHERE request_id=${goalRequestId}
               AND action='scoring_event.appended') AS audit_competition_id,
          (SELECT jsonb_typeof(after_state) FROM audit_events
             WHERE request_id=${goalRequestId}
               AND action='scoring_event.appended') AS audit_after_state_type,
          (SELECT after_state->>'event_type' FROM audit_events
             WHERE request_id=${goalRequestId}
               AND action='scoring_event.appended') AS audit_after_event_type,
          (SELECT before_state IS NULL FROM audit_events
             WHERE request_id=${goalRequestId}
               AND action='scoring_event.appended') AS audit_before_state_is_null,
          (SELECT count(*)::integer FROM outbox_events
             WHERE idempotency_key=${`${goalRequestId}:scoring_event.appended:${firstMatch.id}`}
               AND event_type='scoring_event.appended'
               AND aggregate_type='match'
               AND aggregate_id=${firstMatch.id}) AS outbox_count,
          (SELECT jsonb_typeof(payload) FROM outbox_events
             WHERE idempotency_key=${`${goalRequestId}:scoring_event.appended:${firstMatch.id}`}) AS outbox_payload_type,
          (SELECT payload->>'competition_id' FROM outbox_events
             WHERE idempotency_key=${`${goalRequestId}:scoring_event.appended:${firstMatch.id}`}) AS outbox_competition_id,
          (SELECT payload->>'match_id' FROM outbox_events
             WHERE idempotency_key=${`${goalRequestId}:scoring_event.appended:${firstMatch.id}`}) AS outbox_match_id
      `,
    ).toEqual([
      {
        audit_count: 1,
        audit_metadata_type: "object",
        audit_competition_id: competition.id,
        audit_after_state_type: "object",
        audit_after_event_type: "goal",
        audit_before_state_is_null: true,
        outbox_count: 1,
        outbox_payload_type: "object",
        outbox_competition_id: competition.id,
        outbox_match_id: firstMatch.id,
      },
    ]);
    expect(
      await appendCanonicalCanoeEvent(
        runtime,
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
      canonical_events: [
        {
          event_id: expect.any(String),
          sequence: 1,
          command: {
            kind: "event",
            client_event_id: startId,
            expected_sequence: 0,
            type: "match_started",
          },
        },
        {
          event_id: expect.any(String),
          sequence: 2,
          command: {
            kind: "event",
            client_event_id: goalId,
            expected_sequence: 1,
            type: "goal",
          },
        },
      ],
    });
    let offlineAuthority = await runtime.issueOfflineAuthorization(
      writerAuth,
      {
        deviceId: writerDeviceId,
        lastAcknowledgedSequence: state.through_sequence,
        pendingEventCount: 0,
        pendingThroughSequence: state.through_sequence,
        lastReportedLocalSequence: 0,
        queueFingerprint: null,
        indexeddbSchemaVersion: 1,
        serviceWorkerVersion: "gate-c-c3-v5",
      },
      randomUUID(),
    );
    expect(offlineAuthority).toMatchObject({
      generation: writer.generation,
      match_id: firstMatch.id,
    });
    await expect(
      runtime.issueOfflineAuthorization(
        writerAuth,
        {
          deviceId: writerDeviceId,
          resumeSecret: offlineAuthority.resume_secret,
          lastAcknowledgedSequence: state.through_sequence,
          pendingEventCount: 1,
          pendingThroughSequence: state.through_sequence,
          lastReportedLocalSequence: 1,
          queueFingerprint: "a".repeat(64),
          indexeddbSchemaVersion: 1,
          serviceWorkerVersion: "gate-c-c3-v4",
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "OFFLINE_QUEUE_SUMMARY_INVALID" });
    await expect(
      runtime.issueOfflineAuthorization(
        writerAuth,
        {
          deviceId: writerDeviceId,
          resumeSecret: offlineAuthority.resume_secret,
          lastAcknowledgedSequence: state.through_sequence,
          pendingEventCount: 2,
          pendingThroughSequence: state.through_sequence + 2,
          lastReportedLocalSequence: 1,
          queueFingerprint: "b".repeat(64),
          indexeddbSchemaVersion: 1,
          serviceWorkerVersion: "gate-c-c3-v4",
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "OFFLINE_QUEUE_SUMMARY_INVALID" });
    const storedOfflineSecret = await client<{ resume_secret_hash: Buffer; hash_bytes: number }[]>`
      SELECT resume_secret_hash,octet_length(resume_secret_hash)::integer AS hash_bytes
      FROM scoring_offline_authorizations WHERE id=${offlineAuthority.authorization_id}
    `;
    expect(storedOfflineSecret).toMatchObject([{ hash_bytes: 32 }]);
    expect(storedOfflineSecret[0]?.resume_secret_hash.toString("utf8")).not.toContain(offlineAuthority.resume_secret);
    const expiredAuthorizationId = offlineAuthority.authorization_id;
    const expiryRuntime = new Phase2Runtime(
      client as unknown as PostgresJsSql,
      phase2DomainAdapter,
      () => new Date(new Date(offlineAuthority.replay_expires_at).getTime() + 1),
      undefined,
      fallbackCodeHmacSecret,
    );
    await expect(
      expiryRuntime.resumeOfflineAuthorization(
        offlineAuthority.authorization_id,
        {
          resumeSecret: offlineAuthority.resume_secret,
          deviceId: writerDeviceId,
          lastAcknowledgedSequence: state.through_sequence,
          pendingEventCount: 0,
          pendingThroughSequence: state.through_sequence,
          lastReportedLocalSequence: 0,
          queueFingerprint: null,
          indexeddbSchemaVersion: 1,
          serviceWorkerVersion: "gate-c-c3-v4",
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "OFFLINE_AUTHORIZATION_EXPIRED" });
    expect(
      await client`
        SELECT
          (SELECT status FROM scoring_offline_authorizations
           WHERE id=${expiredAuthorizationId}) AS status,
          (SELECT count(*)::integer FROM audit_events
           WHERE target_id=${expiredAuthorizationId}
             AND action='scoring_offline_authorization.expired') AS expired_audits,
          (SELECT count(*)::integer FROM outbox_events
           WHERE aggregate_id=${expiredAuthorizationId}
             AND event_type='scoring_offline_authorization.expired') AS expired_outbox
      `,
    ).toEqual([{ status: "expired", expired_audits: 1, expired_outbox: 1 }]);
    offlineAuthority = await runtime.issueOfflineAuthorization(
      writerAuth,
      {
        deviceId: writerDeviceId,
        lastAcknowledgedSequence: state.through_sequence,
        pendingEventCount: 0,
        pendingThroughSequence: state.through_sequence,
        lastReportedLocalSequence: 0,
        queueFingerprint: null,
        indexeddbSchemaVersion: 1,
        serviceWorkerVersion: "gate-c-c3-v4",
      },
      randomUUID(),
    );
    expect(offlineAuthority.authorization_id).not.toBe(expiredAuthorizationId);
    await expect(
      runtime.issueOfflineAuthorization(
        writerAuth,
        {
          deviceId: writerDeviceId,
          lastAcknowledgedSequence: state.through_sequence,
          pendingEventCount: 0,
          pendingThroughSequence: state.through_sequence,
          lastReportedLocalSequence: 0,
          queueFingerprint: null,
          indexeddbSchemaVersion: 1,
          serviceWorkerVersion: "gate-c-c3-v4",
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "OFFLINE_AUTHORIZATION_DENIED" });
    const renewedOffline = await runtime.issueOfflineAuthorization(
      writerAuth,
      {
        deviceId: writerDeviceId,
        resumeSecret: offlineAuthority.resume_secret,
        lastAcknowledgedSequence: state.through_sequence,
        pendingEventCount: 0,
        pendingThroughSequence: state.through_sequence,
        lastReportedLocalSequence: 0,
        queueFingerprint: null,
        indexeddbSchemaVersion: 1,
        serviceWorkerVersion: "gate-c-c3-v4",
      },
      randomUUID(),
    );
    expect(renewedOffline).toMatchObject({
      authorization_id: offlineAuthority.authorization_id,
      resume_secret: offlineAuthority.resume_secret,
    });
    await client`UPDATE match_writer_leases SET expires_at=acquired_at+interval '1 millisecond'
      WHERE match_id=${firstMatch.id}`;
    const reservedCandidate = await runtime.exchangeAccess(
      {
        token: pass.token,
        expectedMatchId: firstMatch.id,
        deviceId: randomUUID(),
        ipAddress: "198.51.100.203",
      },
      randomUUID(),
    );
    expect(reservedCandidate).toMatchObject({ mode: "candidate", generation: null });
    const reservedTakeover = await runtime.requestTakeover(
      {
        sessionId: reservedCandidate.session_id,
        sessionToken: reservedCandidate.session_token,
        generation: null,
      },
      { pendingEventCount: 0, pendingThroughSequence: state.through_sequence },
      randomUUID(),
    );
    expect(reservedTakeover).toMatchObject({ status: "pending", incumbent_pending_state: "unknown" });
    await expect(
      runtime.resolveTakeover(
        actor,
        competition.id,
        reservedTakeover.id,
        {
          decision: "approve",
          overrideAcknowledged: false,
          reason: "Attempt without pending work acknowledgement",
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      code: "TAKEOVER_OVERRIDE_ACKNOWLEDGEMENT_REQUIRED",
    });
    const resumeInput = {
      resumeSecret: offlineAuthority.resume_secret,
      deviceId: writerDeviceId,
      lastAcknowledgedSequence: state.through_sequence,
      pendingEventCount: 0,
      pendingThroughSequence: state.through_sequence,
      lastReportedLocalSequence: 0,
      queueFingerprint: null,
      indexeddbSchemaVersion: 1,
      serviceWorkerVersion: "gate-c-c3-v4",
    } as const;
    const resumedOffline = await runtime.resumeOfflineAuthorization(
      offlineAuthority.authorization_id,
      resumeInput,
      randomUUID(),
    );
    expect(resumedOffline).toMatchObject({
      session: { session_id: writer.session_id, generation: writer.generation },
      offline: { authorization_id: offlineAuthority.authorization_id, generation: writer.generation },
    });
    expect(resumedOffline.offline.resume_secret).toBe(offlineAuthority.resume_secret);
    const lostResponseRecovery = await runtime.resumeOfflineAuthorization(
      offlineAuthority.authorization_id,
      resumeInput,
      randomUUID(),
    );
    expect(lostResponseRecovery.offline.resume_secret).toBe(offlineAuthority.resume_secret);
    const secondApiRuntime = new Phase2Runtime(
      client as unknown as PostgresJsSql,
      phase2DomainAdapter,
      undefined,
      undefined,
      fallbackCodeHmacSecret,
    );
    const concurrentResumes = await Promise.all([
      runtime.resumeOfflineAuthorization(offlineAuthority.authorization_id, resumeInput, randomUUID()),
      secondApiRuntime.resumeOfflineAuthorization(offlineAuthority.authorization_id, resumeInput, randomUUID()),
    ]);
    expect(new Set(concurrentResumes.map((result) => result.offline.resume_secret))).toEqual(
      new Set([offlineAuthority.resume_secret]),
    );
    const repeatedRecovery = await runtime.resumeOfflineAuthorization(
      offlineAuthority.authorization_id,
      resumeInput,
      randomUUID(),
    );
    expect(repeatedRecovery.offline.resume_secret).toBe(offlineAuthority.resume_secret);
    writerAuth.sessionToken = repeatedRecovery.session.session_token;
    await expect(
      runtime.appendCanonicalScoreEvent(
        writerAuth,
        {
          client_event_id: randomUUID(),
          type: "incident",
          occurred_at: "2000-01-01T00:00:00.000Z",
          segment_number: 1,
          manual_time_seconds: 0,
          reason: "Must be rejected before the authority window",
        },
        state.through_sequence,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "OFFLINE_RECORDING_EXPIRED" });
    await expect(
      runtime.appendCanonicalScoreEvent(
        writerAuth,
        {
          client_event_id: randomUUID(),
          type: "incident",
          occurred_at: offlineAuthority.recording_expires_at,
          segment_number: 1,
          manual_time_seconds: 0,
          reason: "Must be rejected at the recording boundary",
        },
        state.through_sequence,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "OFFLINE_RECORDING_EXPIRED" });
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
      appendCanonicalCanoeEvent(
        runtime,
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
        after_state: string | Record<string, unknown>;
        metadata: string | Record<string, unknown>;
      }[]
    >`
      SELECT after_state,metadata FROM audit_events
      WHERE request_id=${staleSubmissionRequestId}
        AND action='scoring_event.stale_submission_rejected'
    `;
    expect({
      after_state:
        typeof retainedStaleSubmission[0]?.after_state === "string"
          ? JSON.parse(retainedStaleSubmission[0].after_state)
          : retainedStaleSubmission[0]?.after_state,
      metadata:
        typeof retainedStaleSubmission[0]?.metadata === "string"
          ? JSON.parse(retainedStaleSubmission[0].metadata)
          : retainedStaleSubmission[0]?.metadata,
    }).toMatchObject({
      after_state: { client_event_id: staleSubmissionId, type: "goal" },
      metadata: { submitted_generation: null, retained_for_review: true },
    });
    const rejectedScoreEvent = await client<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM canonical_score_events
      WHERE match_id=${firstMatch.id} AND client_event_id=${staleSubmissionId}
    `;
    expect(rejectedScoreEvent[0]?.count).toBe(0);
    await appendCanonicalCanoeEvent(
      runtime,
      writerAuth,
      {
        clientEventId: randomUUID(),
        type: "period_changed",
        teamSlot: null,
        scorer: null,
        manualPeriod: 2,
        manualEventSeconds: 0,
        payload: {},
        correctionReason: null,
        occurredAt: new Date(),
      },
      randomUUID(),
    );
    const finalEventId = randomUUID();
    const final = await runtime.finalise(writerAuth, finalEventId, randomUUID());
    expect(Object.keys(final).sort()).toEqual(
      [
        "aggregate_version",
        "away_score",
        "client_event_id",
        "command_fingerprint",
        "duplicate",
        "event_id",
        "home_score",
        "match_id",
        "outcome",
        "publication_version",
        "published_at",
        "result_version",
        "sequence",
        "server_received_at",
      ].sort(),
    );
    expect(final).toMatchObject({ home_score: 1, away_score: 0, result_version: 1 });
    const duplicateFinal = await runtime.finalise(writerAuth, finalEventId, randomUUID());
    expect(Object.keys(duplicateFinal).sort()).toEqual(
      [
        "aggregate_version",
        "away_score",
        "client_event_id",
        "command_fingerprint",
        "duplicate",
        "event_id",
        "home_score",
        "match_id",
        "outcome",
        "publication_version",
        "published_at",
        "result_version",
        "sequence",
        "server_received_at",
      ].sort(),
    );
    expect(duplicateFinal).toMatchObject({
      duplicate: true,
      aggregate_version: final.aggregate_version,
      home_score: 1,
      away_score: 0,
      result_version: 1,
    });
    await expect(
      runtime.finalise(writerAuth, finalEventId, randomUUID(), final.aggregate_version),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "IDEMPOTENCY_KEY_REUSED",
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
      VALUES (${firstMatch.id},99,99,99,99,'corrected',${client.json({ future: true })})`;
    const correction = await correctCanonicalCanoeResult(
      runtime,
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
    await expect(
      client`UPDATE canonical_score_events SET command='{}'::jsonb WHERE match_id=${firstMatch.id}`,
    ).rejects.toThrow("canonical score events are append-only");
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
      correctCanonicalCanoeResult(
        runtime,
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
    ).resolves.toMatchObject({
      conflicts: [expect.objectContaining({ downstream_match_id: downstreamId, status: "open" })],
    });
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
      appendCanonicalCanoeEvent(
        runtime,
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
      appendCanonicalCanoeEvent(
        runtime,
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
        after_state: string | Record<string, unknown>;
        metadata: string | Record<string, unknown>;
      }[]
    >`
      SELECT after_state,metadata FROM audit_events
      WHERE request_id=${transferredStaleRequestId}
        AND action='scoring_event.stale_submission_rejected'
    `;
    expect({
      after_state:
        typeof transferredStaleEvidence[0]?.after_state === "string"
          ? JSON.parse(transferredStaleEvidence[0].after_state)
          : transferredStaleEvidence[0]?.after_state,
      metadata:
        typeof transferredStaleEvidence[0]?.metadata === "string"
          ? JSON.parse(transferredStaleEvidence[0].metadata)
          : transferredStaleEvidence[0]?.metadata,
    }).toMatchObject({
      after_state: { client_event_id: transferredStaleEventId },
      metadata: { submitted_generation: secondWriter.generation, retained_for_review: true },
    });
    const transferredStaleScoreEvent = await client<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM canonical_score_events
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
    const reacquisitionPass = await runtime.createAccessPass(
      actor,
      competition.id,
      thirdMatch.id,
      {
        expiresAt: accessExpiry,
        role: "scorekeeper",
        idempotencyKey: `generation-reacquisition-${randomUUID()}`,
      },
      randomUUID(),
    );
    if (!reacquisitionPass.token) throw new Error("Expected reacquisition access secret");
    const reacquiredWriter = await runtime.exchangeAccess(
      {
        token: reacquisitionPass.token,
        deviceId: randomUUID(),
        ipAddress: "198.51.100.3",
      },
      randomUUID(),
    );
    expect(reacquiredWriter).toMatchObject({
      mode: "writer",
      generation: expiringWriter.generation + 1,
    });
    expect(
      await client<{ generation: number; access_session_id: string }[]>`
        SELECT generation,access_session_id FROM match_writer_leases WHERE match_id=${thirdMatch.id}
      `,
    ).toEqual([{ generation: expiringWriter.generation + 1, access_session_id: reacquiredWriter.session_id }]);
    expect(
      await client<{ generations: number[] }[]>`
        SELECT array_agg(generation ORDER BY generation) FILTER (WHERE generation IS NOT NULL) AS generations
        FROM scoring_access_sessions WHERE match_id=${thirdMatch.id}
      `,
    ).toEqual([{ generations: [expiringWriter.generation, expiringWriter.generation + 1] }]);

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
      appendCanonicalCanoeEvent(
        runtime,
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

    const [expiryWriterPass, expiryCandidatePass] = await Promise.all(
      ["writer", "candidate"].map((label) =>
        runtime.createAccessPass(
          actor,
          competition.id,
          sixthMatch.id,
          {
            expiresAt: accessExpiry,
            role: "scorekeeper",
            idempotencyKey: `takeover-expiry-${label}-${randomUUID()}`,
          },
          randomUUID(),
        ),
      ),
    );
    if (!expiryWriterPass?.token || !expiryCandidatePass?.token) {
      throw new Error("Expected takeover-expiry pass secrets");
    }
    const expiryWriter = await runtime.exchangeAccess(
      { token: expiryWriterPass.token, deviceId: randomUUID(), ipAddress: "203.0.113.51" },
      randomUUID(),
    );
    const expiryCandidate = await runtime.exchangeAccess(
      { token: expiryCandidatePass.token, deviceId: randomUUID(), ipAddress: "203.0.113.52" },
      randomUUID(),
    );
    await runtime.heartbeatScoringSession(
      {
        sessionId: expiryWriter.session_id,
        sessionToken: expiryWriter.session_token,
        generation: expiryWriter.generation,
      },
      { lastAcknowledgedSequence: 0, pendingEventCount: 0, pendingThroughSequence: 0 },
      randomUUID(),
    );
    const expiringTakeover = await runtime.requestTakeover(
      { sessionId: expiryCandidate.session_id, sessionToken: expiryCandidate.session_token, generation: null },
      { pendingEventCount: 0, pendingThroughSequence: 0 },
      randomUUID(),
    );
    const futureTakeoverRuntime = new Phase2Runtime(
      client as unknown as PostgresJsSql,
      phase2DomainAdapter,
      () => new Date(Date.now() + 6 * 60_000),
      undefined,
      fallbackCodeHmacSecret,
    );
    const derivedTakeoverQueue = await futureTakeoverRuntime.listTakeoverRequests(actor, competition.id);
    expect(derivedTakeoverQueue.find((entry) => entry.id === expiringTakeover.id)).toMatchObject({
      status: "expired",
    });
    expect(
      await client<{ status: string; audit_count: number; outbox_count: number }[]>`
        SELECT status,
          (SELECT count(*)::integer FROM audit_events
            WHERE target_id=${expiringTakeover.id} AND action='scoring_takeover.expired') audit_count,
          (SELECT count(*)::integer FROM outbox_events
            WHERE aggregate_id=${expiringTakeover.id} AND event_type='scoring_takeover.expired') outbox_count
        FROM scoring_takeover_requests WHERE id=${expiringTakeover.id}
      `,
    ).toEqual([{ status: "pending", audit_count: 0, outbox_count: 0 }]);
    expect(
      (await futureTakeoverRuntime.expireTakeoverRequests(actor, competition.id, randomUUID())).expired_count,
    ).toBeGreaterThanOrEqual(1);
    const takeoverQueue = await runtime.listTakeoverRequests(actor, competition.id);
    expect(takeoverQueue.find((entry) => entry.id === expiringTakeover.id)).toMatchObject({
      status: "expired",
      resolution_reason: "Takeover request expired before review",
    });
    expect(
      await client<{ action: string; competition_id: string | null }[]>`
        SELECT action,metadata->>'competition_id' AS competition_id
        FROM audit_events
        WHERE target_id=${expiringTakeover.id} AND action='scoring_takeover.expired'
      `,
    ).toEqual([{ action: "scoring_takeover.expired", competition_id: competition.id }]);
    expect(
      await client<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM outbox_events
        WHERE aggregate_id=${expiringTakeover.id} AND event_type='scoring_takeover.expired'
      `,
    ).toEqual([{ count: 1 }]);

    let contentionNow = new Date();
    const contentionRuntime = new Phase2Runtime(
      client as unknown as PostgresJsSql,
      phase2DomainAdapter,
      () => new Date(contentionNow),
      undefined,
      fallbackCodeHmacSecret,
      undefined,
      1,
    );
    for (const [index, contentionMatch] of takeoverContentionMatches.entries()) {
      if (!contentionMatch) throw new Error("Expected takeover contention match");
      const [contentionWriterPass, contentionCandidatePass] = await Promise.all(
        ["writer", "candidate"].map((label) =>
          contentionRuntime.createAccessPass(
            actor,
            competition.id,
            contentionMatch.id,
            {
              expiresAt: accessExpiry,
              role: "scorekeeper",
              idempotencyKey: `expired-rerequest-${index}-${label}-${randomUUID()}`,
            },
            randomUUID(),
          ),
        ),
      );
      if (!contentionWriterPass?.token || !contentionCandidatePass?.token) {
        throw new Error("Expected contention pass secrets");
      }
      const contentionWriter = await contentionRuntime.exchangeAccess(
        {
          token: contentionWriterPass.token,
          deviceId: randomUUID(),
          ipAddress: `203.0.113.${80 + index * 2}`,
        },
        randomUUID(),
      );
      const contentionCandidate = await contentionRuntime.exchangeAccess(
        {
          token: contentionCandidatePass.token,
          deviceId: randomUUID(),
          ipAddress: `203.0.113.${81 + index * 2}`,
        },
        randomUUID(),
      );
      await contentionRuntime.heartbeatScoringSession(
        {
          sessionId: contentionWriter.session_id,
          sessionToken: contentionWriter.session_token,
          generation: contentionWriter.generation,
        },
        { lastAcknowledgedSequence: 0, pendingEventCount: 0, pendingThroughSequence: 0 },
        randomUUID(),
      );
      const elapsedTakeover = await contentionRuntime.requestTakeover(
        {
          sessionId: contentionCandidate.session_id,
          sessionToken: contentionCandidate.session_token,
          generation: null,
        },
        { pendingEventCount: 0, pendingThroughSequence: 0 },
        randomUUID(),
      );
      contentionNow = new Date(contentionNow.getTime() + 2);
      const decision = index % 2 === 0 ? "approve" : "deny";
      const [rerequestResult, resolutionResult] = await Promise.allSettled([
        contentionRuntime.requestTakeover(
          {
            sessionId: contentionCandidate.session_id,
            sessionToken: contentionCandidate.session_token,
            generation: null,
          },
          { pendingEventCount: 0, pendingThroughSequence: 0 },
          randomUUID(),
        ),
        contentionRuntime.resolveTakeover(
          actor,
          competition.id,
          elapsedTakeover.id,
          {
            decision,
            overrideAcknowledged: false,
            reason: `Expired ${decision} contention`,
          },
          randomUUID(),
        ),
      ]);
      expect(rerequestResult.status).toBe("fulfilled");
      if (rerequestResult.status !== "fulfilled") throw rerequestResult.reason;
      expect(rerequestResult.value).toMatchObject({ status: "pending", duplicate: false });
      if (resolutionResult.status === "fulfilled") {
        expect(resolutionResult.value).toEqual({ id: elapsedTakeover.id, status: "expired" });
      } else {
        expect(resolutionResult.reason).toMatchObject({ code: "TAKEOVER_ALREADY_RESOLVED" });
      }
      expect(
        await client<{ id: string; status: string }[]>`
          SELECT id,status FROM scoring_takeover_requests
          WHERE id IN (${elapsedTakeover.id},${rerequestResult.value.id})
          ORDER BY requested_at,id
        `,
      ).toEqual([
        { id: elapsedTakeover.id, status: "expired" },
        { id: rerequestResult.value.id, status: "pending" },
      ]);
      expect(
        await client<{ expired_audits: number; expired_outbox: number; forbidden_resolutions: number }[]>`
          SELECT
            (SELECT count(*)::integer FROM audit_events
              WHERE target_id=${elapsedTakeover.id} AND action='scoring_takeover.expired') expired_audits,
            (SELECT count(*)::integer FROM outbox_events
              WHERE aggregate_id=${elapsedTakeover.id} AND event_type='scoring_takeover.expired') expired_outbox,
            (SELECT count(*)::integer FROM audit_events
              WHERE target_id=${elapsedTakeover.id}
                AND action IN ('scoring_takeover.approved','scoring_takeover.denied')) forbidden_resolutions
        `,
      ).toEqual([{ expired_audits: 1, expired_outbox: 1, forbidden_resolutions: 0 }]);
    }

    await runtime.heartbeatScoringSession(
      {
        sessionId: expiryWriter.session_id,
        sessionToken: expiryWriter.session_token,
        generation: expiryWriter.generation,
      },
      { lastAcknowledgedSequence: 0, pendingEventCount: 0, pendingThroughSequence: 0 },
      randomUUID(),
    );
    const replacementTakeover = await runtime.requestTakeover(
      { sessionId: expiryCandidate.session_id, sessionToken: expiryCandidate.session_token, generation: null },
      { pendingEventCount: 0, pendingThroughSequence: 0 },
      randomUUID(),
    );
    expect(replacementTakeover.id).not.toBe(expiringTakeover.id);
    const racingOldEventId = randomUUID();
    const racingOldRequestId = randomUUID();
    const [heartbeatRace, eventRace, transferRace] = await Promise.allSettled([
      runtime.heartbeatScoringSession(
        {
          sessionId: expiryWriter.session_id,
          sessionToken: expiryWriter.session_token,
          generation: expiryWriter.generation,
        },
        { lastAcknowledgedSequence: 0, pendingEventCount: 0, pendingThroughSequence: 0 },
        randomUUID(),
      ),
      appendCanonicalCanoeEvent(
        runtime,
        {
          sessionId: expiryWriter.session_id,
          sessionToken: expiryWriter.session_token,
          generation: expiryWriter.generation,
        },
        {
          clientEventId: racingOldEventId,
          type: "match_started",
          teamSlot: null,
          scorer: null,
          manualPeriod: 1,
          manualEventSeconds: 0,
          payload: {},
          correctionReason: null,
          occurredAt: new Date(),
        },
        racingOldRequestId,
      ),
      runtime.resolveTakeover(
        actor,
        competition.id,
        replacementTakeover.id,
        {
          decision: "approve",
          overrideAcknowledged: false,
          reason: "Concurrent transfer race",
        },
        randomUUID(),
      ),
    ]);
    expect(transferRace.status).toBe("fulfilled");
    if (transferRace.status !== "fulfilled" || transferRace.value.status !== "approved") {
      throw new Error("Concurrent transfer must produce the next writer generation");
    }
    expect(transferRace.value).toMatchObject({ generation: 2, conflict_id: null });
    if (heartbeatRace.status === "rejected") {
      expect(heartbeatRace.reason).toMatchObject({ code: "STALE_WRITER_GENERATION" });
    }
    if (eventRace.status === "rejected") {
      expect(eventRace.reason).toMatchObject({ code: "STALE_WRITER_GENERATION" });
    }
    const newWriterEvent = await appendCanonicalCanoeEvent(
      runtime,
      {
        sessionId: expiryCandidate.session_id,
        sessionToken: expiryCandidate.session_token,
        generation: transferRace.value.generation,
      },
      {
        clientEventId: randomUUID(),
        type: "match_started",
        teamSlot: null,
        scorer: null,
        manualPeriod: 1,
        manualEventSeconds: 1,
        payload: {},
        correctionReason: null,
        occurredAt: new Date(),
      },
      randomUUID(),
    );
    await expect(
      appendCanonicalCanoeEvent(
        runtime,
        {
          sessionId: expiryWriter.session_id,
          sessionToken: expiryWriter.session_token,
          generation: expiryWriter.generation,
        },
        {
          clientEventId: randomUUID(),
          type: "match_started",
          teamSlot: null,
          scorer: null,
          manualPeriod: 1,
          manualEventSeconds: 2,
          payload: {},
          correctionReason: null,
          occurredAt: new Date(),
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "STALE_WRITER_GENERATION" });
    const racedEvents = await client<{ sequence: number; writer_generation: number }[]>`
      SELECT sequence,writer_generation FROM canonical_score_events
      WHERE match_id=${sixthMatch.id} ORDER BY sequence
    `;
    expect(racedEvents.map((event) => event.sequence)).toEqual(
      Array.from({ length: racedEvents.length }, (_, index) => index + 1),
    );
    expect(racedEvents.at(-1)).toEqual({
      sequence: newWriterEvent.sequence,
      writer_generation: transferRace.value.generation,
    });
    expect(
      racedEvents.every(
        (event, index) => index === 0 || event.writer_generation >= racedEvents[index - 1]!.writer_generation,
      ),
    ).toBe(true);
    expect(
      await client<{ generation: number; access_session_id: string }[]>`
        SELECT generation,access_session_id FROM match_writer_leases WHERE match_id=${sixthMatch.id}
      `,
    ).toEqual([{ generation: 2, access_session_id: expiryCandidate.session_id }]);

    const exchangeRevocationPass = await runtime.createAccessPass(
      actor,
      competition.id,
      seventhMatch.id,
      {
        expiresAt: accessExpiry,
        role: "scorekeeper",
        idempotencyKey: `exchange-revoke-${randomUUID()}`,
      },
      randomUUID(),
    );
    if (!exchangeRevocationPass.token) throw new Error("Expected exchange-revocation access secret");
    const [exchangeRace, revokeRace] = await Promise.allSettled([
      runtime.exchangeAccess(
        {
          token: exchangeRevocationPass.token,
          deviceId: randomUUID(),
          ipAddress: "203.0.113.61",
        },
        randomUUID(),
      ),
      runtime.revokeAccessPass(
        actor,
        competition.id,
        exchangeRevocationPass.id,
        randomUUID(),
        "Concurrent exchange authorization withdrawal",
      ),
    ]);
    expect(revokeRace.status).toBe("fulfilled");
    if (exchangeRace.status === "rejected") {
      expect(exchangeRace.reason).toMatchObject({ code: "ACCESS_REVOKED" });
    }
    expect(
      await client<{ revoked: boolean; live_sessions: number; leases: number }[]>`
        SELECT
          revoked_at IS NOT NULL AS revoked,
          (SELECT count(*)::integer FROM scoring_access_sessions
             WHERE access_pass_id=${exchangeRevocationPass.id} AND revoked_at IS NULL) AS live_sessions,
          (SELECT count(*)::integer FROM match_writer_leases WHERE match_id=${seventhMatch.id}) AS leases
        FROM scoring_access_passes WHERE id=${exchangeRevocationPass.id}
      `,
    ).toEqual([{ revoked: true, live_sessions: 0, leases: 0 }]);

    const [finaliseWriterPass, finaliseCandidatePass] = await Promise.all(
      ["writer", "candidate"].map((label) =>
        runtime.createAccessPass(
          actor,
          competition.id,
          eighthMatch.id,
          {
            expiresAt: accessExpiry,
            role: "scorekeeper",
            idempotencyKey: `finalise-transfer-${label}-${randomUUID()}`,
          },
          randomUUID(),
        ),
      ),
    );
    if (!finaliseWriterPass?.token || !finaliseCandidatePass?.token) {
      throw new Error("Expected finalise-transfer access secrets");
    }
    const finaliseWriter = await runtime.exchangeAccess(
      { token: finaliseWriterPass.token, deviceId: randomUUID(), ipAddress: "203.0.113.71" },
      randomUUID(),
    );
    const finaliseWriterAuth = {
      sessionId: finaliseWriter.session_id,
      sessionToken: finaliseWriter.session_token,
      generation: finaliseWriter.generation,
    };
    await appendCanonicalCanoeEvent(
      runtime,
      finaliseWriterAuth,
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
    );
    await appendCanonicalCanoeEvent(
      runtime,
      finaliseWriterAuth,
      {
        clientEventId: randomUUID(),
        type: "period_changed",
        teamSlot: null,
        scorer: null,
        manualPeriod: 2,
        manualEventSeconds: 0,
        payload: {},
        correctionReason: null,
        occurredAt: new Date(),
      },
      randomUUID(),
    );
    const finaliseCandidate = await runtime.exchangeAccess(
      { token: finaliseCandidatePass.token, deviceId: randomUUID(), ipAddress: "203.0.113.72" },
      randomUUID(),
    );
    await runtime.heartbeatScoringSession(
      finaliseWriterAuth,
      { lastAcknowledgedSequence: 2, pendingEventCount: 0, pendingThroughSequence: 2 },
      randomUUID(),
    );
    const finaliseTakeover = await runtime.requestTakeover(
      {
        sessionId: finaliseCandidate.session_id,
        sessionToken: finaliseCandidate.session_token,
        generation: null,
      },
      { pendingEventCount: 0, pendingThroughSequence: 0 },
      randomUUID(),
    );
    const finaliseRequestId = randomUUID();
    const finaliseResult = await runtime.finalise(finaliseWriterAuth, randomUUID(), finaliseRequestId);
    expect(finaliseResult).toMatchObject({ duplicate: false, result_version: 4 });
    expect(
      await client<{ status: string; resolution_reason: string | null }[]>`
        SELECT status,resolution_reason FROM scoring_takeover_requests WHERE id=${finaliseTakeover.id}
      `,
    ).toEqual([{ status: "expired", resolution_reason: "Match finalised before takeover approval" }]);
    const postFinalTakeoverRequestId = randomUUID();
    await expect(
      runtime.requestTakeover(
        {
          sessionId: finaliseCandidate.session_id,
          sessionToken: finaliseCandidate.session_token,
          generation: null,
        },
        { pendingEventCount: 0, pendingThroughSequence: 0 },
        postFinalTakeoverRequestId,
      ),
    ).rejects.toMatchObject({ code: "MATCH_FINALISED_READ_ONLY" });
    expect(
      await client<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM audit_events
        WHERE request_id=${postFinalTakeoverRequestId}
          AND action='scoring_takeover.request_denied'
          AND metadata->>'error_code'='MATCH_FINALISED_READ_ONLY'
      `,
    ).toEqual([{ count: 1 }]);
    const finaliseProjectionBeforeRejectedMutations = await client<
      {
        result_count: number;
        finalise_event_count: number;
        score_event_count: number;
        result_version: number;
      }[]
    >`
      SELECT
        (SELECT count(*)::integer FROM match_result_snapshots WHERE match_id=${eighthMatch.id}) AS result_count,
        (SELECT count(*)::integer FROM canonical_score_events
           WHERE match_id=${eighthMatch.id} AND event_type='finalisation') AS finalise_event_count,
        (SELECT count(*)::integer FROM canonical_score_events WHERE match_id=${eighthMatch.id}) AS score_event_count,
        (SELECT result_version FROM competition_publications WHERE competition_id=${competition.id}) AS result_version
    `;
    const finalisePublicBeforeRejectedMutations = await runtime.publicCompetition("singapore-open-phase-2");
    await expect(
      runtime.resolveTakeover(
        actor,
        competition.id,
        finaliseTakeover.id,
        {
          decision: "approve",
          overrideAcknowledged: false,
          reason: "Finalisation already won",
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "TAKEOVER_ALREADY_RESOLVED" });
    await expect(
      appendCanonicalCanoeEvent(
        runtime,
        finaliseWriterAuth,
        {
          clientEventId: randomUUID(),
          type: "incident_added",
          teamSlot: null,
          scorer: null,
          manualPeriod: 1,
          manualEventSeconds: 1,
          payload: { note: "Must not append after finalisation" },
          correctionReason: null,
          occurredAt: new Date(),
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "MATCH_FINALISED_READ_ONLY" });
    expect(
      await client<{ generation: number; access_session_id: string }[]>`
        SELECT generation,access_session_id FROM match_writer_leases WHERE match_id=${eighthMatch.id}
      `,
    ).toEqual([{ generation: 1, access_session_id: finaliseWriter.session_id }]);
    expect(
      await client<{ mode: string }[]>`
        SELECT mode FROM scoring_access_sessions WHERE id=${finaliseCandidate.session_id}
      `,
    ).toEqual([{ mode: "candidate" }]);
    const finaliseProjection = await client<{ result_count: number; finalise_event_count: number }[]>`
      SELECT
        (SELECT count(*)::integer FROM match_result_snapshots WHERE match_id=${eighthMatch.id}) AS result_count,
        (SELECT count(*)::integer FROM canonical_score_events
           WHERE match_id=${eighthMatch.id} AND event_type='finalisation') AS finalise_event_count
    `;
    expect(finaliseProjection).toEqual([{ result_count: 1, finalise_event_count: 1 }]);
    expect(
      await client`
        SELECT
          (SELECT count(*)::integer FROM match_result_snapshots WHERE match_id=${eighthMatch.id}) AS result_count,
          (SELECT count(*)::integer FROM canonical_score_events
             WHERE match_id=${eighthMatch.id} AND event_type='finalisation') AS finalise_event_count,
          (SELECT count(*)::integer FROM canonical_score_events WHERE match_id=${eighthMatch.id}) AS score_event_count,
          (SELECT result_version FROM competition_publications WHERE competition_id=${competition.id}) AS result_version
      `,
    ).toEqual(finaliseProjectionBeforeRejectedMutations);
    const finalisePublicAfterRejectedMutations = await runtime.publicCompetition("singapore-open-phase-2");
    expect(finalisePublicAfterRejectedMutations.publication).toEqual(finalisePublicBeforeRejectedMutations.publication);
    expect(finalisePublicAfterRejectedMutations.results.find((result) => result.id === eighthMatch.id)).toEqual(
      finalisePublicBeforeRejectedMutations.results.find((result) => result.id === eighthMatch.id),
    );
    expect(
      await client<{ finalised: number; expired: number; expired_outbox: number; approved: number }[]>`
        SELECT
          count(*) FILTER (
            WHERE action='result.finalised'
              AND target_id=${eighthMatch.id}
          )::integer AS finalised,
          count(*) FILTER (
            WHERE action='scoring_takeover.expired'
              AND target_id=${finaliseTakeover.id}
          )::integer AS expired,
          count(*) FILTER (
            WHERE action='scoring_takeover.approved'
              AND target_id=${finaliseTakeover.id}
          )::integer AS approved,
          (SELECT count(*)::integer FROM outbox_events
             WHERE aggregate_id=${finaliseTakeover.id}
               AND event_type='scoring_takeover.expired') AS expired_outbox
        FROM audit_events
        WHERE metadata->>'competition_id'=${competition.id}
      `,
    ).toEqual([{ finalised: 1, expired: 1, expired_outbox: 1, approved: 0 }]);

    const [transferFirstWriterPass, transferFirstCandidatePass] = await Promise.all(
      ["writer", "candidate"].map((label) =>
        runtime.createAccessPass(
          actor,
          competition.id,
          transferFirstMatch.id,
          {
            expiresAt: accessExpiry,
            role: "scorekeeper",
            idempotencyKey: `transfer-first-${label}-${randomUUID()}`,
          },
          randomUUID(),
        ),
      ),
    );
    if (!transferFirstWriterPass?.token || !transferFirstCandidatePass?.token) {
      throw new Error("Expected transfer-first access secrets");
    }
    const transferFirstDeviceId = randomUUID();
    const transferFirstWriter = await runtime.exchangeAccess(
      { token: transferFirstWriterPass.token, deviceId: transferFirstDeviceId, ipAddress: "203.0.113.73" },
      randomUUID(),
    );
    const transferFirstWriterAuth = {
      sessionId: transferFirstWriter.session_id,
      sessionToken: transferFirstWriter.session_token,
      generation: transferFirstWriter.generation,
    };
    const transferFirstReplacementGeneration = (transferFirstWriter.generation ?? 0) + 1;
    await appendCanonicalCanoeEvent(
      runtime,
      transferFirstWriterAuth,
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
    );
    const transferFirstCandidate = await runtime.exchangeAccess(
      { token: transferFirstCandidatePass.token, deviceId: randomUUID(), ipAddress: "203.0.113.74" },
      randomUUID(),
    );
    await runtime.heartbeatScoringSession(
      transferFirstWriterAuth,
      { lastAcknowledgedSequence: 1, pendingEventCount: 0, pendingThroughSequence: 1 },
      randomUUID(),
    );
    const transferFirstOffline = await runtime.issueOfflineAuthorization(
      transferFirstWriterAuth,
      {
        deviceId: transferFirstDeviceId,
        lastAcknowledgedSequence: 1,
        pendingEventCount: 0,
        pendingThroughSequence: 1,
        lastReportedLocalSequence: 0,
        queueFingerprint: null,
        indexeddbSchemaVersion: 1,
        serviceWorkerVersion: "gate-c-c3-v4",
      },
      randomUUID(),
    );
    const transferFirstTakeover = await runtime.requestTakeover(
      {
        sessionId: transferFirstCandidate.session_id,
        sessionToken: transferFirstCandidate.session_token,
        generation: null,
      },
      { pendingEventCount: 0, pendingThroughSequence: 0 },
      randomUUID(),
    );
    expect(transferFirstTakeover).toMatchObject({ incumbent_pending_state: "unknown" });
    const resumeTakeoverRace = await Promise.allSettled([
      runtime.resolveTakeover(
        actor,
        competition.id,
        transferFirstTakeover.id,
        {
          decision: "approve",
          overrideAcknowledged: true,
          reason: "Offline state acknowledged before transfer wins",
        },
        randomUUID(),
      ),
      runtime.resumeOfflineAuthorization(
        transferFirstOffline.authorization_id,
        {
          resumeSecret: transferFirstOffline.resume_secret,
          deviceId: transferFirstDeviceId,
          lastAcknowledgedSequence: 1,
          pendingEventCount: 0,
          pendingThroughSequence: 1,
          lastReportedLocalSequence: 0,
          queueFingerprint: null,
          indexeddbSchemaVersion: 1,
          serviceWorkerVersion: "gate-c-c3-v4",
        },
        randomUUID(),
      ),
    ]);
    expect(resumeTakeoverRace[0]).toMatchObject({
      status: "fulfilled",
      value: { status: "approved", generation: transferFirstReplacementGeneration },
    });
    if (resumeTakeoverRace[1].status === "rejected") {
      expect(resumeTakeoverRace[1].reason).toMatchObject({
        code: expect.stringMatching(/OFFLINE_AUTHORIZATION_(TRANSFERRED|DENIED)/),
      });
    } else {
      transferFirstWriterAuth.sessionToken = resumeTakeoverRace[1].value.session.session_token;
    }
    expect(
      await client`
        SELECT
          (SELECT status FROM scoring_offline_authorizations
           WHERE id=${transferFirstOffline.authorization_id}) AS authorization_status,
          (SELECT count(*)::integer FROM audit_events
           WHERE target_id=${transferFirstOffline.authorization_id}
             AND action='scoring_offline_authorization.transferred') AS transferred_audits,
          (SELECT count(*)::integer FROM outbox_events
           WHERE aggregate_id=${transferFirstOffline.authorization_id}
             AND event_type='scoring_offline_authorization.transferred') AS transferred_outbox
      `,
    ).toEqual([{ authorization_status: "transferred", transferred_audits: 1, transferred_outbox: 1 }]);
    const staleFinaliseRequestId = randomUUID();
    await expect(runtime.finalise(transferFirstWriterAuth, randomUUID(), staleFinaliseRequestId)).rejects.toMatchObject(
      { code: "STALE_WRITER_GENERATION" },
    );
    expect(
      await client<{ generation: number; access_session_id: string }[]>`
        SELECT generation,access_session_id
        FROM match_writer_leases WHERE match_id=${transferFirstMatch.id}
      `,
    ).toEqual([
      { generation: transferFirstReplacementGeneration, access_session_id: transferFirstCandidate.session_id },
    ]);
    expect(
      await client<{ result_count: number; finalise_event_count: number; result_version: number }[]>`
        SELECT
          (SELECT count(*)::integer FROM match_result_snapshots
             WHERE match_id=${transferFirstMatch.id}) AS result_count,
          (SELECT count(*)::integer FROM canonical_score_events
             WHERE match_id=${transferFirstMatch.id} AND event_type='finalisation') AS finalise_event_count,
          (SELECT result_version FROM competition_publications
             WHERE competition_id=${competition.id}) AS result_version
      `,
    ).toEqual([{ result_count: 0, finalise_event_count: 0, result_version: 4 }]);
    expect(
      await client<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM audit_events
        WHERE request_id=${staleFinaliseRequestId}
          AND action='scoring_result.finalise_denied'
          AND metadata->>'competition_id'=${competition.id}
          AND metadata->>'error_code'='STALE_WRITER_GENERATION'
      `,
    ).toEqual([{ count: 1 }]);

    const workspace = await runtime.competitionWorkspace(actor, competition.id);
    expect(workspace).toMatchObject({
      competition: { id: competition.id, organisation_id: organisationId },
      publication: { schedule_version: 1, result_version: 4 },
    });
    expect(workspace.access_passes.find((entry) => entry.id === legacyFallbackPass.id)).toMatchObject({
      fallback_code_status: "available",
    });
    expect(JSON.stringify(workspace.access_passes)).not.toContain(pass.token);
    const retainedDomainEvidence = JSON.stringify(
      await client`
        SELECT action,metadata,before_state,after_state,NULL::jsonb AS payload
        FROM audit_events
        WHERE metadata->>'competition_id'=${competition.id}
        UNION ALL
        SELECT event_type,NULL::jsonb,NULL::jsonb,NULL::jsonb,payload
        FROM outbox_events
        WHERE payload->>'competition_id'=${competition.id}
      `,
    );
    for (const secret of [pass.token, pass.short_code, writer.session_token, writerDeviceId, writerClientIp]) {
      expect(retainedDomainEvidence).not.toContain(secret);
    }
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
      correctCanonicalCanoeResult(
        runtime,
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
      client`UPDATE canonical_score_events SET command=command WHERE match_id=${firstMatch.id}`,
      client`UPDATE match_result_snapshots SET snapshot=snapshot WHERE match_id=${firstMatch.id}`,
      client`UPDATE bracket_snapshots SET bracket=bracket WHERE competition_id=${competition.id}`,
      client`UPDATE public_competition_projections SET projection=projection WHERE competition_id=${competition.id}`,
      client`UPDATE advancement_slots SET updated_at=updated_at WHERE competition_id=${competition.id}`,
      client`UPDATE advancement_conflicts SET reason=reason WHERE competition_id=${competition.id}`,
    ];
    for (const write of archivedWrites) {
      await expect(write).rejects.toThrow(
        /archived competitions are immutable|canonical score events are append-only/i,
      );
    }

    await client`UPDATE competitions
      SET status=archived_from_status,archived_from_status=NULL
      WHERE id=${competition.id}`;
    const revokeResumeRace = await Promise.allSettled([
      runtime.revokeAccessPass(actor, competition.id, pass.id, randomUUID()),
      secondApiRuntime.resumeOfflineAuthorization(offlineAuthority.authorization_id, resumeInput, randomUUID()),
    ]);
    expect(revokeResumeRace[0]).toMatchObject({ status: "fulfilled", value: { id: pass.id, revoked: true } });
    if (revokeResumeRace[1].status === "rejected") {
      expect(revokeResumeRace[1].reason).toMatchObject({
        code: expect.stringMatching(/OFFLINE_AUTHORIZATION_(REVOKED|DENIED)/),
      });
    } else {
      writerAuth.sessionToken = revokeResumeRace[1].value.session.session_token;
    }
    expect(
      await client`SELECT status FROM scoring_offline_authorizations
        WHERE id=${offlineAuthority.authorization_id}`,
    ).toEqual([{ status: "revoked" }]);
    expect(
      await client`
        SELECT
          (SELECT count(*)::integer FROM audit_events
           WHERE target_id=${offlineAuthority.authorization_id}
             AND action='scoring_offline_authorization.issued') AS issued_audits,
          (SELECT count(*)::integer FROM outbox_events
           WHERE aggregate_id=${offlineAuthority.authorization_id}
             AND event_type='scoring_offline_authorization.issued') AS issued_outbox,
          (SELECT count(*)::integer FROM audit_events
           WHERE target_id=${offlineAuthority.authorization_id}
             AND action='scoring_offline_authorization.renewed') AS renewed_audits,
          (SELECT count(*)::integer FROM outbox_events
           WHERE aggregate_id=${offlineAuthority.authorization_id}
             AND event_type='scoring_offline_authorization.renewed') AS renewed_outbox,
          (SELECT count(*)::integer FROM audit_events
           WHERE target_id=${offlineAuthority.authorization_id}
             AND action='scoring_offline_authorization.resumed') AS resumed_audits,
          (SELECT count(*)::integer FROM outbox_events
           WHERE aggregate_id=${offlineAuthority.authorization_id}
             AND event_type='scoring_offline_authorization.resumed') AS resumed_outbox,
          (SELECT count(*)::integer FROM audit_events
           WHERE target_id=${offlineAuthority.authorization_id}
             AND action='scoring_offline_authorization.revoked') AS revoked_audits,
          (SELECT count(*)::integer FROM outbox_events
           WHERE aggregate_id=${offlineAuthority.authorization_id}
             AND event_type='scoring_offline_authorization.revoked') AS revoked_outbox
      `,
    ).toEqual([
      {
        issued_audits: 1,
        issued_outbox: 1,
        renewed_audits: 1,
        renewed_outbox: 1,
        resumed_audits: revokeResumeRace[1].status === "fulfilled" ? 6 : 5,
        resumed_outbox: 0,
        revoked_audits: 1,
        revoked_outbox: 1,
      },
    ]);
    await expect(
      runtime.revokeOfflineAuthorization(
        offlineAuthority.authorization_id,
        { resumeSecret: offlineAuthority.resume_secret, deviceId: writerDeviceId },
        randomUUID(),
      ),
    ).resolves.toMatchObject({ status: "revoked", duplicate: true });
    await expect(runtime.scoringSessionState(writerAuth)).rejects.toMatchObject({
      statusCode: 403,
      code: "SCORING_SESSION_REVOKED",
    });

    await expect(client`DELETE FROM competitions WHERE id=${competition.id}`).rejects.toThrow(
      /result_conflicts is append-only|canonical score events are append-only|Gate C4 result repair facts are append-only/i,
    );
    expect(await client`SELECT count(*)::integer AS count FROM competitions WHERE id=${competition.id}`).toEqual([
      { count: 1 },
    ]);
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
