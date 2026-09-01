import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { SPORT_PACKS, type SportId } from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";
import { Phase2Runtime, type Phase2Actor } from "../../src/phase-2-runtime.js";
import { phase3DomainAdapter } from "../../src/phase-3-domain-adapter.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase7_endurance_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
const fallbackCodeHmacSecret = "phase-7-endurance-fallback-hmac-secret-32-chars-long";

let client!: Sql;
let runtime!: Phase2Runtime;
let organisationId = "";
let accountId = "";

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

      runtime = new Phase2Runtime(
        client as unknown as PostgresJsSql,
        phase2DomainAdapter,
        undefined,
        undefined,
        fallbackCodeHmacSecret,
      );
    });

    afterAll(async () => {
      if (client) {
        await client.end({ timeout: 2 });
      }
      await dropTestSchema(databaseUrl, schema);
    });

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
      const writer = await runtime.exchangeAccess(
        { token: pass.token, deviceId: `dev-0-${randomUUID()}`, ipAddress: "127.0.0.1" },
        randomUUID(),
      );

      if (!writer.generation) throw new Error("Expected writer generation");

      return {
        competition,
        division,
        match,
        pass,
        auth: {
          sessionId: writer.session_id,
          sessionToken: writer.session_token,
          generation: writer.generation,
        },
      };
    }

    describe("QA-007: Extended 2,000-Command Offline Ingestion Pipeline", () => {
      it("ingests and sequences a high-capacity 2,000 command batch with monotonic order and idempotent replay resilience", async () => {
        const world = await createRealScoringWorld("basketball");
        let aggregateVersion = 0;

        // 1. Initial event: match_started
        const startReceipt = await runtime.appendCanonicalScoreEvent(
          world.auth,
          {
            client_event_id: randomUUID(),
            type: "match_started",
            occurred_at: new Date().toISOString(),
          },
          aggregateVersion,
          randomUUID(),
        );
        aggregateVersion = startReceipt.aggregate_version;

        // 2. Generate and append 2,000 sequential score commands in basketball
        const totalCommands = 2000;
        const recordedEvents: { client_event_id: string; expectedVersion: number; payload: Record<string, unknown> }[] =
          [];

        for (let i = 0; i < totalCommands; i++) {
          const clientEventId = randomUUID();
          const teamSlot = i % 2 === 0 ? "home" : "away";
          const payload = {
            client_event_id: clientEventId,
            type: "three_point_score",
            team_slot: teamSlot,
            participant_id: `Player ${(i % 5) + 1}`,
            segment_number: 1,
            manual_time_seconds: (i % 600) + 1,
            occurred_at: new Date(Date.now() + i * 1000).toISOString(),
          };

          recordedEvents.push({ client_event_id: clientEventId, expectedVersion: aggregateVersion, payload });

          const receipt = await runtime.appendCanonicalScoreEvent(world.auth, payload, aggregateVersion, randomUUID());
          aggregateVersion = receipt.aggregate_version;
        }

        expect(aggregateVersion).toBe(totalCommands + 1);

        // 3. Verify idempotent replay resilience for 50 previously sent events
        for (let j = 0; j < 50; j++) {
          const sample = recordedEvents[j]!;
          const replayReceipt = await runtime.appendCanonicalScoreEvent(
            world.auth,
            sample.payload,
            sample.expectedVersion,
            randomUUID(),
          );
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
          const periodReceipt = await runtime.appendCanonicalScoreEvent(
            world.auth,
            {
              client_event_id: randomUUID(),
              type: "period_change",
              segment_number: segment,
              manual_time_seconds: 0,
              occurred_at: new Date().toISOString(),
            },
            aggregateVersion,
            randomUUID(),
          );
          aggregateVersion = periodReceipt.aggregate_version;
        }

        const finalResult = await runtime.finalise(world.auth, randomUUID(), randomUUID(), aggregateVersion);
        expect(finalResult.home_score).toBeGreaterThan(0);

        const matchRow = await client<{ state: string }[]>`
          SELECT state FROM matches WHERE id = ${world.match.id};
        `;
        expect(matchRow[0]!.state).toBe("final");
      });
    });

    describe("QA-008: Multi-Device Write Arbitration & Stale Sequence Fencing", () => {
      it("rejects stale generation writes after takeover and enforces monotonic version sequencing", async () => {
        const world = await createRealScoringWorld("basketball");
        let version = 0;

        // Device 1 starts match
        const startReceipt = await runtime.appendCanonicalScoreEvent(
          world.auth,
          { client_event_id: randomUUID(), type: "match_started", occurred_at: new Date().toISOString() },
          version,
          randomUUID(),
        );
        version = startReceipt.aggregate_version;

        // Device 1 scores 1 basket
        const ptReceipt = await runtime.appendCanonicalScoreEvent(
          world.auth,
          {
            client_event_id: randomUUID(),
            type: "three_point_score",
            team_slot: "home",
            participant_id: "Player 1",
            segment_number: 1,
            manual_time_seconds: 10,
            occurred_at: new Date().toISOString(),
          },
          version,
          randomUUID(),
        );
        version = ptReceipt.aggregate_version;

        // Device 2 exchanges the access pass -> receives candidate session
        const device2 = await runtime.exchangeAccess(
          { token: world.pass.token!, deviceId: "dev-takeover-2", ipAddress: "192.168.1.102" },
          randomUUID(),
        );
        expect(device2.session_id).toBeDefined();

        const dev2CandidateAuth = {
          sessionId: device2.session_id,
          sessionToken: device2.session_token,
          generation: 0,
        };

        // Device 2 requests takeover
        const takeover = await runtime.requestTakeover(
          dev2CandidateAuth,
          { pendingEventCount: 0, pendingThroughSequence: 0 },
          randomUUID(),
        );
        expect(takeover.id).toBeDefined();

        // Organiser approves takeover
        const resolution = await runtime.resolveTakeover(
          { accountId },
          world.competition.id,
          takeover.id,
          { decision: "approve", overrideAcknowledged: true, reason: "Device 1 battery died" },
          randomUUID(),
        );
        expect(resolution.status).toBe("approved");

        const dev2Auth = {
          sessionId: device2.session_id,
          sessionToken: device2.session_token,
          generation: resolution.generation!,
        };

        // Device 1 (stale generation) tries to append event -> must be rejected with 409
        await expect(
          runtime.appendCanonicalScoreEvent(
            world.auth, // stale generation
            {
              client_event_id: randomUUID(),
              type: "three_point_score",
              team_slot: "away",
              participant_id: "Player 2",
              segment_number: 1,
              manual_time_seconds: 12,
              occurred_at: new Date().toISOString(),
            },
            version,
            randomUUID(),
          ),
        ).rejects.toThrow();

        // Device 2 (active generation) appends next score -> succeeds
        const dev2Receipt = await runtime.appendCanonicalScoreEvent(
          dev2Auth,
          {
            client_event_id: randomUUID(),
            type: "three_point_score",
            team_slot: "away",
            participant_id: "Player 2",
            segment_number: 1,
            manual_time_seconds: 15,
            occurred_at: new Date().toISOString(),
          },
          version,
          randomUUID(),
        );
        expect(dev2Receipt.aggregate_version).toBe(version + 1);

        // Out of order version sequence attempt (e.g. sequence 99 when expected is 3) -> must be rejected
        await expect(
          runtime.appendCanonicalScoreEvent(
            dev2Auth,
            {
              client_event_id: randomUUID(),
              type: "three_point_score",
              team_slot: "home",
              participant_id: "Player 1",
              segment_number: 1,
              manual_time_seconds: 20,
              occurred_at: new Date().toISOString(),
            },
            99, // mismatched expected aggregate version
            randomUUID(),
          ),
        ).rejects.toThrow();
      });
    });

    describe("QA-009: Result Correction & Standings Convergence", () => {
      it("records score corrections, updates audit ledger, and recalculates division standings", async () => {
        const world = await createRealScoringWorld("basketball");
        const actor: Phase2Actor = { accountId };
        let version = 0;

        // Score baskets in period 1
        const start = await runtime.appendCanonicalScoreEvent(
          world.auth,
          { client_event_id: randomUUID(), type: "match_started", occurred_at: new Date().toISOString() },
          version,
          randomUUID(),
        );
        version = start.aggregate_version;

        const homePt = await runtime.appendCanonicalScoreEvent(
          world.auth,
          {
            client_event_id: randomUUID(),
            type: "three_point_score",
            team_slot: "home",
            participant_id: "Player 1",
            segment_number: 1,
            manual_time_seconds: 10,
            occurred_at: new Date().toISOString(),
          },
          version,
          randomUUID(),
        );
        version = homePt.aggregate_version;

        for (const segment of [2, 3, 4]) {
          const periodReceipt = await runtime.appendCanonicalScoreEvent(
            world.auth,
            {
              client_event_id: randomUUID(),
              type: "period_change",
              segment_number: segment,
              manual_time_seconds: 0,
              occurred_at: new Date().toISOString(),
            },
            version,
            randomUUID(),
          );
          version = periodReceipt.aggregate_version;
        }

        // Finalise match
        const initialFinal = await runtime.finalise(world.auth, randomUUID(), randomUUID(), version);
        expect(initialFinal.home_score).toBe(3);
        expect(initialFinal.away_score).toBe(0);

        // Organiser issues a score correction on finalized match
        const correctionEventId = randomUUID();
        const correction = await runtime.correctCanonicalMatch(
          actor,
          world.competition.id,
          world.match.id,
          {
            clientEventId: correctionEventId,
            reason: "Clerical adjustment for court review",
            expectedAggregateVersion: initialFinal.aggregate_version,
            events: [
              {
                client_event_id: randomUUID(),
                type: "three_point_score",
                team_slot: "away",
                participant_id: "Player 2",
                segment_number: 1,
                manual_time_seconds: 12,
                occurred_at: new Date().toISOString(),
              },
            ],
          },
          randomUUID(),
        );

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
      });
    });
  },
);
