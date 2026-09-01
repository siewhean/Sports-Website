import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "@matchday/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { SPORT_PACKS, type SportId } from "@matchday/domain";
import { hashSessionSecret, systemClock, type PostgresJsSql } from "@matchday/identity";
import { Redis } from "ioredis";
import postgres, { type Sql } from "postgres";
import { buildApp } from "../../src/app.js";
import { IdentityApiRuntime, UnavailableIdentityProvider } from "../../src/identity-runtime.js";
import { PostgresIdentityUnitOfWork } from "../../src/identity-postgres.js";
import { GateCC4LifecycleOperations } from "../../src/gate-c-c4-lifecycle.js";
import { GateCC4Operations } from "../../src/gate-c-c4-operations.js";
import { GateCC4PostgresPublisher } from "../../src/gate-c-c4-postgres-publisher.js";
import { GateCC4PublicTruthRuntime } from "../../src/gate-c-c4-public-truth.js";
import { GateCC4Runtime } from "../../src/gate-c-c4-runtime.js";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";
import { Phase2Runtime, type Phase2Actor } from "../../src/phase-2-runtime.js";
import { phase3DomainAdapter } from "../../src/phase-3-domain-adapter.js";
import { reconcileScoringAccessHmacKeyring } from "../../src/scoring-access-hmac-keyring.js";
import { RedisScoringAccessRateLimiter } from "../../src/scoring-access-rate-limit.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const redisUrl = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379/15";
const schema = `test_phase7_endurance_${randomUUID().replaceAll("-", "")}`;
const redisNamespace = `matchday:test:phase7-endurance:${randomUUID()}:`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
const fallbackCodeHmacSecret = "phase-7-endurance-fallback-hmac-secret-32-chars-long";
const rateLimitHmacSecret = "phase-7-endurance-rate-limit-secret";
const rateLimitLegacyCommitment = createHash("sha256")
  .update("matchday:scoring-access-hmac-key-material:v1:\u0000", "utf8")
  .update(rateLimitHmacSecret, "utf8")
  .digest("hex");

let client!: Sql;
let runtime!: Phase2Runtime;
let redis!: Redis;
let app!: Awaited<ReturnType<typeof buildApp>>;
let apiOrigin = "";
let organisationId = "";
let accountId = "";
let organiserCookie = "";
let webOrigin = "";

describeInfrastructure(
  "QA-004 / QA-007 / QA-008 / QA-009 — Real Matchday Scoring Runtime Endurance & Concurrency",
  () => {
    beforeAll(async () => {
      await dropTestSchema(databaseUrl, schema);
      await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
      client = postgres(databaseUrl, {
        max: 8,
        onnotice: () => undefined,
        connection: { search_path: schema },
      });

      // Seed all 5 active sport packs with valid definition hashes
      for (const [sportId, pack] of Object.entries(SPORT_PACKS)) {
        const hash = phase3DomainAdapter.hash(pack);
        await client`
          INSERT INTO sport_pack_versions (
            sport_code, version, schema_version, definition, definition_hash, status, revision, activated_at
          ) VALUES (
            ${sportId}, ${pack.version}, 1, ${client.json(pack)}, ${hash}, 'active', 1, now()
          ) ON CONFLICT (sport_code, version) DO UPDATE SET
            status = 'active',
            activated_at = now();
        `;
      }

      const accounts = await client<{ id: string }[]>`
        INSERT INTO accounts (primary_email, display_name, email_verified_at)
        VALUES ('organiser-endurance@matchday.com', 'Endurance Organiser', now())
        RETURNING id;
      `;
      accountId = accounts[0]!.id;

      await client.begin(async (tx) => {
        const orgs = await tx<{ id: string }[]>`
          INSERT INTO organisations (name, slug)
          VALUES ('Endurance Sports Org', ${`endurance-org-${randomUUID()}`})
          RETURNING id;
        `;
        organisationId = orgs[0]!.id;

        await tx`
          INSERT INTO organisation_memberships (organisation_id, account_id, role, status)
          VALUES (${organisationId}, ${accountId}, 'owner', 'active');
        `;
      });

      const sessionId = randomUUID();
      const sessionSecret = randomBytes(32).toString("base64url");
      const now = new Date();
      await client`
        INSERT INTO identity_sessions (
          id, account_id, secret_hash, created_at, last_seen_at, idle_expires_at, absolute_expires_at
        ) VALUES (
          ${sessionId}, ${accountId}, ${hashSessionSecret(sessionSecret)}, ${now}, ${now},
          ${new Date(now.getTime() + 60 * 60_000)}, ${new Date(now.getTime() + 12 * 60 * 60_000)}
        )
      `;
      organiserCookie = `matchday_session=${sessionId}.${sessionSecret}`;

      redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
      const csrfSecret = "phase-7-endurance-csrf-secret-at-least-32-chars";
      const config = parseConfig({
        APP_ENV: "test",
        LOG_LEVEL: "silent",
        API_HOST: "127.0.0.1",
        API_PORT: "4199",
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        MATCHDAY_PUBLIC_ORIGIN: "http://127.0.0.1:4199",
        API_ALLOWED_ORIGINS: "http://127.0.0.1:4199",
        IDENTITY_CSRF_HMAC_SECRET: csrfSecret,
        SCORING_ACCESS_RATE_LIMIT_HMAC_SECRET: rateLimitHmacSecret,
        SCORING_ACCESS_RATE_LIMIT_LEGACY_V1_MATERIAL_COMMITMENT: rateLimitLegacyCommitment,
        SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET: fallbackCodeHmacSecret,
      });
      await reconcileScoringAccessHmacKeyring(
        client as unknown as PostgresJsSql,
        config.scoringAccess.rateLimitHmacKeyring,
      );
      runtime = new Phase2Runtime(
        client as unknown as PostgresJsSql,
        phase2DomainAdapter,
        undefined,
        new RedisScoringAccessRateLimiter(
          redis,
          config.scoringAccess.rateLimitHmacKeyring,
          `${redisNamespace}scoring-access:`,
        ),
        fallbackCodeHmacSecret,
      );
      const identityRuntime = new IdentityApiRuntime(
        new UnavailableIdentityProvider(),
        new PostgresIdentityUnitOfWork(client as unknown as PostgresJsSql),
        csrfSecret,
        systemClock,
      );
      const c4Publisher = new GateCC4PostgresPublisher(runtime);
      app = await buildApp({
        config,
        probes: {
          database: async () => (await client<{ ok: number }[]>`SELECT 1 AS ok`)[0]?.ok === 1,
          queue: async () => true,
          redis: async () => (await redis.ping()) === "PONG",
        },
        rateLimitRedis: redis,
        rateLimitNameSpace: `${redisNamespace}http:`,
        authenticatedRateLimitMax: 10_000,
        identityRuntime,
        phase2Runtime: runtime,
        gateCC4Runtime: new GateCC4Runtime(client as unknown as PostgresJsSql, c4Publisher),
        gateCC4Operations: new GateCC4Operations(client as unknown as PostgresJsSql, "http://127.0.0.1:4199"),
        gateCC4Lifecycle: new GateCC4LifecycleOperations(client as unknown as PostgresJsSql),
        gateCC4PublicTruthRuntime: new GateCC4PublicTruthRuntime(client as unknown as PostgresJsSql),
        scoringAccessHmacKeySql: client as unknown as PostgresJsSql,
      });
      apiOrigin = (await app.listen({ host: "127.0.0.1", port: 4199 })).replace("[::1]", "127.0.0.1");
      webOrigin = "http://127.0.0.1:4199";
    });

    afterAll(async () => {
      if (app) await app.close();
      if (client) {
        await client.end({ timeout: 2 });
      }
      await dropTestSchema(databaseUrl, schema);
    });

    function scoringHeaders(auth: { sessionId: string; sessionToken: string; generation: number | null }) {
      return {
        "content-type": "application/json",
        "x-scoring-session-id": auth.sessionId,
        "x-scoring-session-token": auth.sessionToken,
        ...(auth.generation === null ? {} : { "x-writer-generation": String(auth.generation) }),
      };
    }

    async function exchangeAccess(
      token: string,
      matchId: string,
      deviceId = randomUUID().repeat(2),
      expectedMode: "writer" | "candidate" = "writer",
    ) {
      const response = await fetch(`${apiOrigin}/api/v1/scoring/access/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          expected_match_id: matchId,
          device_id: deviceId,
          device_label: "Phase 7 endurance",
        }),
      });
      const responseBody = await response.text();
      expect(response.status, responseBody).toBe(200);
      const payload = JSON.parse(responseBody) as {
        session_id: string;
        session_token: string;
        generation: number | null;
        mode: string;
      };
      expect(payload.mode).toBe(expectedMode);
      return {
        auth: { sessionId: payload.session_id, sessionToken: payload.session_token, generation: payload.generation },
        deviceId,
      };
    }

    async function appendScoreEvent(
      auth: { sessionId: string; sessionToken: string; generation: number | null },
      expectedSequence: number,
      event: Record<string, unknown>,
    ) {
      const response = await fetch(`${apiOrigin}/api/v1/scoring/events`, {
        method: "POST",
        headers: scoringHeaders(auth),
        body: JSON.stringify({ client_event_id: randomUUID(), expected_sequence: expectedSequence, ...event }),
      });
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      expect(response.status, JSON.stringify(payload)).toBe(200);
      expect(payload).toMatchObject({ outcome: "accepted", sequence: expectedSequence + 1 });
      return payload as { aggregate_version: number; sequence: number; client_event_id: string };
    }

    async function csrfToken() {
      const response = await fetch(`${apiOrigin}/api/v1/identity/me`, { headers: { cookie: organiserCookie } });
      const responseBody = await response.text();
      expect(response.status, responseBody).toBe(200);
      const payload = JSON.parse(responseBody) as { csrf_token: string };
      return payload.csrf_token;
    }

    async function finalise(
      auth: { sessionId: string; sessionToken: string; generation: number | null },
      expectedSequence: number,
    ) {
      const response = await fetch(`${apiOrigin}/api/v1/scoring/finalise`, {
        method: "POST",
        headers: scoringHeaders(auth),
        body: JSON.stringify({ client_event_id: randomUUID(), expected_sequence: expectedSequence }),
      });
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      expect(response.status, JSON.stringify(payload)).toBe(200);
      return payload as { aggregate_version: number; home_score: number; away_score: number };
    }

    async function createRealScoringWorld(sportId: SportId = "basketball") {
      const actor: Phase2Actor = { accountId };
      const competition = await runtime.createCompetition(
        actor,
        {
          organisationId,
          name: `${SPORT_PACKS[sportId].displayName} Endurance Cup`,
          slug: `${sportId.replaceAll("_", "-")}-${randomUUID()}`,
          timezone: "Asia/Singapore",
          startsOn: "2027-03-01",
          endsOn: "2027-03-01",
        },
        randomUUID(),
      );

      await client`UPDATE competitions SET sport_code=${sportId} WHERE id=${competition.id}`;
      await client`UPDATE competition_sport_settings SET
        sport_code=${sportId}, pack_version=${SPORT_PACKS[sportId].version},
        recommended_snapshot=${client.json(SPORT_PACKS[sportId].recommendedSettings)}, settings_override='{}'::jsonb
        WHERE competition_id=${competition.id}`;

      const division = await runtime.createDivision(
        actor,
        competition.id,
        { name: "Division 1", teamLimit: 8 },
        randomUUID(),
      );
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
          idempotencyKey: `pass-${sportId}-${randomUUID()}`,
        },
        randomUUID(),
      );

      if (!pass.token) throw new Error("Expected access pass token");
      const exchanged = await exchangeAccess(pass.token, match.id);

      return {
        competition,
        division,
        match,
        pass,
        auth: exchanged.auth,
        deviceId: exchanged.deviceId,
      };
    }

    describe("QA-007: Extended 2,000-Command Offline Ingestion Pipeline", () => {
      it("ingests and sequences a high-capacity 2,000 command batch with monotonic order and idempotent replay resilience", async () => {
        const world = await createRealScoringWorld("basketball");
        let aggregateVersion = 0;

        // 1. Initial event: match_started
        const startReceipt = await appendScoreEvent(world.auth, aggregateVersion, {
          type: "match_started",
          segment_number: 1,
          manual_time_seconds: 0,
          occurred_at: new Date().toISOString(),
        });
        aggregateVersion = startReceipt.aggregate_version;

        // The queue is authorised before a simulated field-network loss. The
        // following resume rotates the server session before remaining queued
        // commands replay through the same HTTP scoring endpoint.
        const issued = await fetch(`${apiOrigin}/api/v1/scoring/offline-authorizations`, {
          method: "POST",
          headers: scoringHeaders(world.auth),
          body: JSON.stringify({
            device_id: world.deviceId,
            last_acknowledged_sequence: aggregateVersion,
            pending_event_count: 2000,
            pending_through_sequence: aggregateVersion + 2000,
            last_reported_local_sequence: 2000,
            queue_fingerprint: "a".repeat(64),
            indexeddb_schema_version: 1,
            service_worker_version: "gate-c-c3-v6",
          }),
        });
        const issuedBody = await issued.text();
        expect(issued.status, issuedBody).toBe(200);
        const offline = JSON.parse(issuedBody) as { authorization_id: string; resume_secret: string };

        // 2. Generate and append 2,000 sequential score commands in basketball
        const totalCommands = 2000;
        const recordedEvents: { expectedVersion: number; payload: Record<string, unknown> }[] = [];

        for (let i = 0; i < totalCommands; i++) {
          const clientEventId = randomUUID();
          // Preserve a valid decisive basketball result while retaining the agreed
          // 2,000-command workload.
          const teamSlot = i === totalCommands - 1 || i % 2 === 0 ? "home" : "away";
          const payload = {
            client_event_id: clientEventId,
            type: "three_point_score",
            team_slot: teamSlot,
            participant_id: `Player ${(i % 5) + 1}`,
            segment_number: 1,
            manual_time_seconds: (i % 600) + 1,
            occurred_at: new Date(Date.now() + i * 1000).toISOString(),
          };

          recordedEvents.push({ expectedVersion: aggregateVersion, payload });

          const receipt = await appendScoreEvent(world.auth, aggregateVersion, payload);
          aggregateVersion = receipt.aggregate_version;

          if (i === 999) {
            const staleAuth = { ...world.auth };
            const resumed = await fetch(
              `${apiOrigin}/api/v1/scoring/offline-authorizations/${offline.authorization_id}/resume`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  resume_secret: offline.resume_secret,
                  device_id: world.deviceId,
                  last_acknowledged_sequence: aggregateVersion,
                  pending_event_count: 1000,
                  pending_through_sequence: aggregateVersion + 1000,
                  last_reported_local_sequence: 2000,
                  queue_fingerprint: "b".repeat(64),
                  indexeddb_schema_version: 1,
                  service_worker_version: "gate-c-c3-v6",
                }),
              },
            );
            const resumedBody = await resumed.text();
            expect(resumed.status, resumedBody).toBe(200);
            const resumePayload = JSON.parse(resumedBody) as { session: { session_token: string; generation: number } };
            world.auth.sessionToken = resumePayload.session.session_token;
            world.auth.generation = resumePayload.session.generation;

            const staleReplay = await fetch(`${apiOrigin}/api/v1/scoring/events`, {
              method: "POST",
              headers: scoringHeaders(staleAuth),
              body: JSON.stringify({
                client_event_id: randomUUID(),
                expected_sequence: aggregateVersion,
                type: "three_point_score",
                team_slot: "away",
                participant_id: "Player stale",
                segment_number: 1,
                manual_time_seconds: 0,
                occurred_at: new Date().toISOString(),
              }),
            });
            expect(staleReplay.status).toBe(403);
          }
        }

        expect(aggregateVersion).toBe(totalCommands + 1);

        // 3. Verify idempotent replay resilience for 50 previously sent events
        for (let j = 0; j < 50; j++) {
          const sample = recordedEvents[j]!;
          const response = await fetch(`${apiOrigin}/api/v1/scoring/events`, {
            method: "POST",
            headers: scoringHeaders(world.auth),
            body: JSON.stringify({ expected_sequence: sample.expectedVersion, ...sample.payload }),
          });
          const replayReceipt = (await response.json()) as { outcome?: string; aggregate_version?: number };
          expect(response.status, JSON.stringify(replayReceipt)).toBe(200);
          expect(replayReceipt.outcome).toBe("duplicate");
          expect(replayReceipt.aggregate_version).toBeDefined();
        }

        // 4. Verify canonical events persisted in PostgreSQL
        const events = await client<{ count: number }[]>`
          SELECT count(*)::int as count
          FROM canonical_score_events
          WHERE match_id = ${world.match.id};
        `;
        expect(events[0]!.count).toBe(totalCommands + 1);

        // 5. Advance periods and finalise match
        for (const segment of [2, 3, 4]) {
          const periodReceipt = await appendScoreEvent(world.auth, aggregateVersion, {
            type: "period_change",
            segment_number: segment,
            manual_time_seconds: 0,
            occurred_at: new Date().toISOString(),
          });
          aggregateVersion = periodReceipt.aggregate_version;
        }

        const finalResult = await finalise(world.auth, aggregateVersion);
        expect(finalResult.home_score).toBeGreaterThan(0);

        const matchRow = await client<{ state: string }[]>`
          SELECT state FROM matches WHERE id = ${world.match.id};
        `;
        expect(matchRow[0]!.state).toBe("final");
      }, 120_000);
    });

    describe("QA-008: Multi-Device Write Arbitration & Stale Sequence Fencing", () => {
      it("rejects stale generation writes after takeover and enforces monotonic version sequencing", async () => {
        const world = await createRealScoringWorld("basketball");
        let version = 0;

        // Device 1 starts match
        const startReceipt = await appendScoreEvent(world.auth, version, {
          type: "match_started",
          segment_number: 1,
          manual_time_seconds: 0,
          occurred_at: new Date().toISOString(),
        });
        version = startReceipt.aggregate_version;

        // Device 1 scores 1 basket
        const ptReceipt = await appendScoreEvent(world.auth, version, {
          type: "three_point_score",
          team_slot: "home",
          participant_id: "Player 1",
          segment_number: 1,
          manual_time_seconds: 10,
          occurred_at: new Date().toISOString(),
        });
        version = ptReceipt.aggregate_version;

        // Device 2 exchanges the access pass -> receives candidate session
        const device2 = await exchangeAccess(world.pass.token!, world.match.id, randomUUID().repeat(2), "candidate");
        const dev2CandidateAuth = device2.auth;

        // Device 2 requests takeover
        const takeoverResponse = await fetch(`${apiOrigin}/api/v1/scoring/takeover-requests`, {
          method: "POST",
          headers: scoringHeaders(dev2CandidateAuth),
          body: JSON.stringify({ pending_event_count: 0, pending_through_sequence: version }),
        });
        const takeoverBody = await takeoverResponse.text();
        expect(takeoverResponse.status, takeoverBody).toBe(201);
        const takeover = JSON.parse(takeoverBody) as { id: string };

        // Organiser approves takeover
        const resolutionResponse = await fetch(
          `${apiOrigin}/api/v1/competitions/${world.competition.id}/takeover-requests/${takeover.id}/approve`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: organiserCookie,
              origin: webOrigin,
              "x-csrf-token": await csrfToken(),
            },
            body: JSON.stringify({ override_acknowledged: true, reason: "Device 1 battery died" }),
          },
        );
        const resolutionBody = await resolutionResponse.text();
        expect(resolutionResponse.status, resolutionBody).toBe(200);
        const resolution = JSON.parse(resolutionBody) as { status: string; generation: number };
        expect(resolution.status).toBe("approved");

        const dev2Auth: { sessionId: string; sessionToken: string; generation: number } = {
          ...device2.auth,
          generation: resolution.generation,
        };

        // Device 1 (stale generation) tries to append event -> must be rejected with 409
        const stale = await fetch(`${apiOrigin}/api/v1/scoring/events`, {
          method: "POST",
          headers: scoringHeaders(world.auth),
          body: JSON.stringify({
            client_event_id: randomUUID(),
            expected_sequence: version,
            type: "three_point_score",
            team_slot: "away",
            participant_id: "Player 2",
            segment_number: 1,
            manual_time_seconds: 12,
            occurred_at: new Date().toISOString(),
          }),
        });
        expect(stale.status).toBe(409);
        expect((await stale.json()) as { error: { code: string } }).toMatchObject({
          error: { code: "STALE_WRITER_GENERATION" },
        });

        // Device 2 (active generation) appends next score -> succeeds
        const dev2Receipt = await appendScoreEvent(dev2Auth, version, {
          type: "three_point_score",
          team_slot: "away",
          participant_id: "Player 2",
          segment_number: 1,
          manual_time_seconds: 15,
          occurred_at: new Date().toISOString(),
        });
        expect(dev2Receipt.aggregate_version).toBe(version + 1);

        // Out of order version sequence attempt (e.g. sequence 99 when expected is 3) -> must be rejected
        const staleSequence = await fetch(`${apiOrigin}/api/v1/scoring/events`, {
          method: "POST",
          headers: scoringHeaders(dev2Auth),
          body: JSON.stringify({
            client_event_id: randomUUID(),
            expected_sequence: 99,
            type: "three_point_score",
            team_slot: "home",
            participant_id: "Player 1",
            segment_number: 1,
            manual_time_seconds: 20,
            occurred_at: new Date().toISOString(),
          }),
        });
        expect(staleSequence.status).toBe(409);
      });

      it("keeps five simultaneously exchanged devices fenced to one organiser-approved writer", async () => {
        const world = await createRealScoringWorld("basketball");
        const candidates = await Promise.all(
          Array.from({ length: 4 }, async (_, index) => {
            const pass = await runtime.createAccessPass(
              { accountId },
              world.competition.id,
              world.match.id,
              {
                expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
                role: "scorekeeper",
                idempotencyKey: `five-device-${index}-${randomUUID()}`,
              },
              randomUUID(),
            );
            if (!pass.token) throw new Error("Expected five-device access pass token");
            return exchangeAccess(pass.token, world.match.id, randomUUID().repeat(2), "candidate");
          }),
        );

        const requests = await Promise.all(
          candidates.map(async (candidate) => {
            const response = await fetch(`${apiOrigin}/api/v1/scoring/takeover-requests`, {
              method: "POST",
              headers: scoringHeaders(candidate.auth),
              body: JSON.stringify({ pending_event_count: 0, pending_through_sequence: 0 }),
            });
            const body = await response.text();
            expect(response.status, body).toBe(201);
            return JSON.parse(body) as { id: string };
          }),
        );

        const resolution = await fetch(
          `${apiOrigin}/api/v1/competitions/${world.competition.id}/takeover-requests/${requests[0]!.id}/approve`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: organiserCookie,
              origin: webOrigin,
              "x-csrf-token": await csrfToken(),
            },
            body: JSON.stringify({ override_acknowledged: true, reason: "Five-device contention drill" }),
          },
        );
        expect(resolution.status, await resolution.text()).toBe(200);

        const active = await client<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM match_writer_leases
          WHERE match_id = ${world.match.id} AND expires_at > now()
        `;
        expect(active[0]!.count).toBe(1);
      });
    });

    describe("QA-009: Result Correction & Standings Convergence", () => {
      it("records score corrections, updates audit ledger, and recalculates division standings", async () => {
        const world = await createRealScoringWorld("basketball");
        let version = 0;

        // Score baskets in period 1
        const start = await appendScoreEvent(world.auth, version, {
          type: "match_started",
          segment_number: 1,
          manual_time_seconds: 0,
          occurred_at: new Date().toISOString(),
        });
        version = start.aggregate_version;

        const homePt = await appendScoreEvent(world.auth, version, {
          type: "three_point_score",
          team_slot: "home",
          participant_id: "Player 1",
          segment_number: 1,
          manual_time_seconds: 10,
          occurred_at: new Date().toISOString(),
        });
        version = homePt.aggregate_version;

        for (const segment of [2, 3, 4]) {
          const periodReceipt = await appendScoreEvent(world.auth, version, {
            type: "period_change",
            segment_number: segment,
            manual_time_seconds: 0,
            occurred_at: new Date().toISOString(),
          });
          version = periodReceipt.aggregate_version;
        }

        // Finalise match
        const initialFinal = await finalise(world.auth, version);
        expect(initialFinal.home_score).toBe(3);
        expect(initialFinal.away_score).toBe(0);

        // Organiser issues a score correction on finalized match
        const correctionResponse = await fetch(
          `${apiOrigin}/api/v1/competitions/${world.competition.id}/matches/${world.match.id}/corrections`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: organiserCookie,
              origin: webOrigin,
              "x-csrf-token": await csrfToken(),
            },
            body: JSON.stringify({
              client_event_id: randomUUID(),
              reason: "Clerical adjustment for court review",
              expected_aggregate_version: initialFinal.aggregate_version,
              events: [
                {
                  client_event_id: randomUUID(),
                  type: "three_point_score",
                  team_slot: "home",
                  participant_id: "Player 2",
                  segment_number: 4,
                  manual_time_seconds: 12,
                  occurred_at: new Date().toISOString(),
                },
              ],
            }),
          },
        );
        const correctionBody = await correctionResponse.text();
        expect(correctionResponse.status, correctionBody).toBe(200);
        const correction = JSON.parse(correctionBody) as { result_version: number };

        expect(correction.result_version).toBeGreaterThan(0);

        const correctedMatchRow = await client<{ state: string }[]>`
          SELECT state FROM matches WHERE id = ${world.match.id};
        `;
        expect(correctedMatchRow[0]!.state).toBe("corrected");

        // Verify correction transaction in database
        const correctionTx = await client<{ count: number }[]>`
          SELECT count(*)::int as count
          FROM score_correction_transactions
          WHERE match_id = ${world.match.id};
        `;
        expect(correctionTx[0]!.count).toBeGreaterThanOrEqual(1);

        const correctionAudit = await client<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM audit_events
          WHERE organisation_id = ${organisationId}
            AND action = 'result.corrected'
        `;
        expect(correctionAudit[0]!.count).toBeGreaterThan(0);

        const standings = await client<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM standings_snapshots
          WHERE division_id = ${world.division.id}
        `;
        expect(standings[0]!.count).toBeGreaterThan(0);

        // The scoring mutation writes the public projection in the same
        // transaction as the corrected result. C4's independently published
        // public-current route is intentionally not a substitute for this
        // canonical Phase 2 projection receipt.
        const publicProjection = await client<{ result_version: number }[]>`
          SELECT result_version
          FROM public_competition_projections
          WHERE competition_id = ${world.competition.id}
          ORDER BY generated_at DESC
          LIMIT 1
        `;
        expect(publicProjection[0]?.result_version).toBe(correction.result_version);
      });
    });
  },
);
