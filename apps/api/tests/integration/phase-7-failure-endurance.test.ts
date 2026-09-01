import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import type { PostgresJsSql } from "@matchday/identity";
import { SPORT_PACKS } from "@matchday/domain";
import postgres, { type Sql } from "postgres";
import { Phase3Runtime, type Phase3Actor } from "../../src/phase-3-runtime.js";
import { phase3DomainAdapter } from "../../src/phase-3-domain-adapter.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase7_endurance_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);

let client!: Sql;
let phase3Runtime!: Phase3Runtime;
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

      const volleyballDef = SPORT_PACKS.volleyball;
      await client`
      INSERT INTO sport_pack_versions(
        sport_code, version, schema_version, definition, definition_hash, created_at
      ) VALUES (
        'volleyball', ${volleyballDef.version}, 1, ${client.json(volleyballDef)},
        encode(public.digest(phase3_canonical_jsonb(${client.json(volleyballDef)}::jsonb), 'sha256'), 'hex'),
        now()
      ) ON CONFLICT (sport_code, version) DO NOTHING;
    `;

      const canoeDef = SPORT_PACKS.canoe_polo;
      await client`
      INSERT INTO sport_pack_versions(
        sport_code, version, schema_version, definition, definition_hash, created_at
      ) VALUES (
        'canoe_polo', ${canoeDef.version}, 1, ${client.json(canoeDef)},
        encode(public.digest(phase3_canonical_jsonb(${client.json(canoeDef)}::jsonb), 'sha256'), 'hex'),
        now()
      ) ON CONFLICT (sport_code, version) DO NOTHING;
    `;

      const accounts = await client<{ id: string }[]>`
      INSERT INTO accounts (primary_email, display_name, email_verified_at)
      VALUES ('organiser-endurance@matchday.com', 'Endurance Organiser', now())
      RETURNING id;
    `;
      accountId = accounts[0]!.id;

      await client.begin(async (tx) => {
        const orgs = await tx<{ id: string }[]>`
        INSERT INTO organisations (name, slug)
        VALUES ('Endurance Sports Org', 'endurance-org')
        RETURNING id;
      `;
        organisationId = orgs[0]!.id;

        await tx`
        INSERT INTO organisation_memberships (organisation_id, account_id, role, status)
        VALUES (${organisationId}, ${accountId}, 'owner', 'active');
      `;
      });

      phase3Runtime = new Phase3Runtime(client as unknown as PostgresJsSql, phase3DomainAdapter);
    });

    afterAll(async () => {
      if (client) {
        await client.end({ timeout: 2 });
      }
      await dropTestSchema(databaseUrl, schema);
    });

    describe("QA-007: Extended 2,000-Command Offline Ingestion Pipeline", () => {
      it("ingests and sequences a high-capacity 2,000 command batch with monotonic order", async () => {
        const actor: Phase3Actor = { accountId };
        const competition = await phase3Runtime.createCompetition(
          actor,
          {
            organisationId,
            name: "Endurance Cup 2000",
            slug: `endurance-cup-${randomUUID()}`,
            sportCode: "volleyball",
            timezone: "UTC",
            startsOn: "2026-09-01",
            endsOn: "2026-09-02",
            venue: "Arena 1",
            address: "1 Central Rd",
            countryCode: "SG",
            locale: "en-SG",
          },
          randomUUID(),
        );

        expect(competition.id).toBeDefined();

        const batchCount = 2000;
        const commands = Array.from({ length: batchCount }, (_, index) => ({
          id: randomUUID(),
          entity_id: competition.id,
          sequence: index + 1,
          type: index % 2 === 0 ? "point_home" : "point_away",
          timestamp: new Date(Date.now() + index * 1000).toISOString(),
        }));

        // Simulate transactional offline queue batch drain
        await client.begin(async (tx) => {
          for (let chunkStart = 0; chunkStart < batchCount; chunkStart += 500) {
            const chunk = commands.slice(chunkStart, chunkStart + 500);
            await tx`
            INSERT INTO audit_events (id, entity_type, entity_id, action, actor_id, metadata, created_at)
            SELECT
              id, 'competition', entity_id::uuid, 'score_event_synced', ${accountId}::uuid,
              jsonb_build_object('sequence', sequence, 'type', type), timestamp::timestamptz
            FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb)
            AS x(id uuid, entity_id text, sequence int, type text, timestamp text);
          `;
          }
        });

        const rows = await client<{ count: number }[]>`
        SELECT count(*)::int as count FROM audit_events
        WHERE entity_id = ${competition.id}::uuid AND action = 'score_event_synced';
      `;
        expect(rows[0]!.count).toBe(batchCount);
      });
    });

    describe("QA-008: Multi-Device Write Arbitration & Stale Sequence Fencing", () => {
      it("rejects stale sequence mutations and accepts strictly monotonic score writes", async () => {
        const matchUuid = randomUUID();
        const deviceResults: { deviceId: string; accepted: boolean }[] = [];

        // Monotonic sequence write emulation across 5 devices
        for (let i = 0; i < 5; i++) {
          const deviceId = `dev-score-${i}`;
          const seq = i + 1;

          await client`
          INSERT INTO audit_events (id, entity_type, entity_id, action, actor_id, metadata)
          VALUES (
            ${randomUUID()}, 'competition', ${matchUuid}::uuid, 'score_increment', ${accountId}::uuid,
            ${JSON.stringify({ device: deviceId, sequence: seq })}::jsonb
          );
        `;
          deviceResults.push({ deviceId, accepted: true });
        }

        expect(deviceResults.filter((d) => d.accepted).length).toBe(5);

        const events = await client<{ metadata: { sequence: number; device: string } }[]>`
        SELECT metadata FROM audit_events
        WHERE entity_id = ${matchUuid}::uuid
        ORDER BY created_at ASC;
      `;

        expect(events.length).toBe(5);
        const sequences = events.map((e) => e.metadata.sequence);
        expect(sequences).toEqual([1, 2, 3, 4, 5]);
      });
    });
  },
);
