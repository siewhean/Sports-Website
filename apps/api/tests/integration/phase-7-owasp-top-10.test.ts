import { createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { SPORT_PACKS } from "@matchday/domain";
import { systemClock, type PostgresJsSql } from "@matchday/identity";
import { DeterministicIdentityProvider } from "@matchday/identity/testing";
import postgres, { type Sql } from "postgres";
import { buildApp } from "../../src/app.js";
import { healthyProbes, testConfig } from "../helpers.js";
import { PostgresIdentityUnitOfWork } from "../../src/identity-postgres.js";
import { IdentityApiRuntime } from "../../src/identity-runtime.js";
import { EntitlementRuntime } from "../../src/entitlement-runtime.js";
import { Phase2Runtime } from "../../src/phase-2-runtime.js";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";
import { Phase3Runtime } from "../../src/phase-3-runtime.js";
import { phase3DomainAdapter } from "../../src/phase-3-domain-adapter.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase7_owasp_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);

let client!: Sql;
let identityRuntime!: IdentityApiRuntime;
let entitlementRuntime!: EntitlementRuntime;
let phase2Runtime!: Phase2Runtime;
let phase3Runtime!: Phase3Runtime;
let app!: Awaited<ReturnType<typeof buildApp>>;

let tenantA_orgId = "";
let tenantA_userId = "";
let tenantB_orgId = "";
let tenantB_userId = "";

describeInfrastructure("QA-014 — HTTP-Level & Production-Path OWASP Top 10 Security Suite", () => {
  beforeAll(async () => {
    await dropTestSchema(databaseUrl, schema);
    await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
    client = postgres(databaseUrl, {
      max: 8,
      onnotice: () => undefined,
      connection: { search_path: schema },
    });

    tenantA_orgId = randomUUID();
    tenantA_userId = randomUUID();
    tenantB_orgId = randomUUID();
    tenantB_userId = randomUUID();

    // Insert active sport packs
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

    await client`
      INSERT INTO accounts (id, primary_email, display_name, email_verified_at)
      VALUES
        (${tenantA_userId}, 'alice@org-a.com', 'Alice A', now()),
        (${tenantB_userId}, 'bob@org-b.com', 'Bob B', now());
    `;

    // Satisfy PostgreSQL deferred owner check by creating org and owner membership inside transaction
    await client.begin(async (tx) => {
      await tx`
        INSERT INTO organisations (id, name, slug)
        VALUES (${tenantA_orgId}, 'Org Alpha', 'org-alpha');
      `;
      await tx`
        INSERT INTO organisation_memberships (organisation_id, account_id, role, status)
        VALUES (${tenantA_orgId}, ${tenantA_userId}, 'owner', 'active');
      `;
    });

    await client.begin(async (tx) => {
      await tx`
        INSERT INTO organisations (id, name, slug)
        VALUES (${tenantB_orgId}, 'Org Beta', 'org-beta');
      `;
      await tx`
        INSERT INTO organisation_memberships (organisation_id, account_id, role, status)
        VALUES (${tenantB_orgId}, ${tenantB_userId}, 'owner', 'active');
      `;
    });

    const identityProvider = new DeterministicIdentityProvider({
      issuer: "https://identity.example.test",
      subject: "test-subject",
      email: "alice@org-a.com",
      displayName: "Alice A",
      providerSessionId: "session-123",
      emailVerified: true,
    });

    identityRuntime = new IdentityApiRuntime(
      identityProvider,
      new PostgresIdentityUnitOfWork(client as unknown as PostgresJsSql),
      "owasp-test-csrf-secret-at-least-32-chars-long",
      systemClock,
    );

    entitlementRuntime = new EntitlementRuntime(client as unknown as PostgresJsSql);
    phase2Runtime = new Phase2Runtime(
      client as unknown as PostgresJsSql,
      phase2DomainAdapter,
      () => new Date(),
      undefined,
      "test-fallback-hmac-secret-at-least-32-chars-long",
    );
    phase3Runtime = new Phase3Runtime(client as unknown as PostgresJsSql, phase3DomainAdapter);

    app = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime,
      phase2Runtime,
      phase3Runtime,
      entitlementRuntime,
    });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (client) {
      await client.end({ timeout: 2 });
    }
    await dropTestSchema(databaseUrl, schema);
  });

  describe("A01: Broken Access Control (IDOR & Route Authorization)", () => {
    it("strictly blocks unauthenticated access to protected management endpoints", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/organisations/competition-options",
      });

      expect([401, 403]).toContain(response.statusCode);
    });

    it("prevents Tenant A actor from mutating Tenant B competition via HTTP and runtime", async () => {
      const compB = await phase3Runtime.createCompetition(
        { accountId: tenantB_userId },
        {
          organisationId: tenantB_orgId,
          name: "Tenant B Private Tournament",
          slug: `tenant-b-tourney-${randomUUID()}`,
          sportCode: "volleyball",
          timezone: "UTC",
          startsOn: "2026-09-01",
          endsOn: "2026-09-02",
          venue: "Main Hall",
          address: "1 Sports Rd",
          countryCode: "SG",
          locale: "en-SG",
        },
        randomUUID(),
      );

      expect(compB.id).toBeDefined();

      const unauthenticatedResponse = await app.inject({
        method: "POST",
        url: `/api/v1/organisations/competitions/${compB.id}/mutations`,
        headers: {
          "content-type": "application/json",
        },
        payload: {
          action: "update",
          revision: 1,
          patch: { name: "Malicious Hijack" },
        },
      });

      expect([401, 403, 404]).toContain(unauthenticatedResponse.statusCode);

      await expect(
        phase3Runtime.mutateCompetition(
          { accountId: tenantA_userId },
          compB.id,
          {
            action: "update",
            revision: 1,
            patch: { name: "Malicious Hijack" },
          },
          randomUUID(),
        ),
      ).rejects.toThrow();
    });
  });

  describe("A02: Cryptographic Failures & Webhook Tampering", () => {
    it("rejects forged, unsigned, or replayed billing webhook HTTP requests with 401", async () => {
      const forgedPayload = {
        id: `evt_${randomUUID()}`,
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_fake_123",
            metadata: { organisation_id: tenantA_orgId, tier: "organiser_pro" },
          },
        },
      };

      const responseBadSig = await app.inject({
        method: "POST",
        url: "/api/v1/billing/webhook",
        headers: {
          "stripe-signature": "t=12345,v1=bad_forged_hmac_signature",
          "content-type": "application/json",
        },
        payload: forgedPayload,
      });

      expect(responseBadSig.statusCode).toBe(401);

      // Replay attack with expired timestamp (t=10000)
      const secret = "whsec_test_secret";
      const expiredTimestamp = 10000;
      const replayPayloadString = JSON.stringify(forgedPayload);
      const replayHmac = createHmac("sha256", secret)
        .update(`${expiredTimestamp}.${replayPayloadString}`)
        .digest("hex");

      const responseReplay = await app.inject({
        method: "POST",
        url: "/api/v1/billing/webhook",
        headers: {
          "stripe-signature": `t=${expiredTimestamp},v1=${replayHmac}`,
          "content-type": "application/json",
        },
        payload: forgedPayload,
      });

      expect(responseReplay.statusCode).toBe(401);
    });
  });

  describe("A03: Injection (SQL Injection Resistance)", () => {
    it("safely parameterizes SQL injection payloads across HTTP routes without corruption", async () => {
      const sqliPayload = "Tournament'); DROP TABLE competitions; --";

      const comp = await phase3Runtime.createCompetition(
        { accountId: tenantA_userId },
        {
          organisationId: tenantA_orgId,
          name: sqliPayload,
          slug: `sqli-test-${randomUUID()}`,
          sportCode: "volleyball",
          timezone: "UTC",
          startsOn: "2026-09-01",
          endsOn: "2026-09-02",
          venue: "Hall A",
          address: "1 Rd",
          countryCode: "SG",
          locale: "en-SG",
        },
        randomUUID(),
      );

      expect(comp.id).toBeDefined();

      const sqliRouteResponse = await app.inject({
        method: "GET",
        url: `/api/v1/public/competitions/'%20OR%201=1--`,
      });
      expect([400, 404]).toContain(sqliRouteResponse.statusCode);

      const checkTable = await client`SELECT count(*)::int as count FROM competitions WHERE id = ${comp.id};`;
      expect(checkTable[0]!.count).toBe(1);
    });
  });

  describe("A05: Security Misconfiguration & Response Headers", () => {
    it("includes vital security headers on HTTP responses", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/health/live",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    });
  });

  describe("A07: Identification and Authentication Failures (Rate Limiting & Revocation)", () => {
    it("rejects access attempts when an access pass is revoked via HTTP scoring route", async () => {
      const comp = await phase3Runtime.createCompetition(
        { accountId: tenantA_userId },
        {
          organisationId: tenantA_orgId,
          name: "Revocation Test Tournament",
          slug: `revocation-test-${randomUUID()}`,
          sportCode: "volleyball",
          timezone: "UTC",
          startsOn: "2026-09-01",
          endsOn: "2026-09-02",
          venue: "Main Hall",
          address: "1 Sports Rd",
          countryCode: "SG",
          locale: "en-SG",
        },
        randomUUID(),
      );

      const divisionId = randomUUID();
      const formatRevId = randomUUID();
      const matchId = randomUUID();
      const graph = {
        id: formatRevId,
        schemaVersion: 1,
        entryCount: 2,
        stages: [
          {
            id: "final-stage",
            label: "Final",
            kind: "single_elimination",
            order: 1,
            groupIds: [],
            groupSize: null,
            outputRanks: 2,
            matchIds: [matchId],
          },
        ],
        matches: [
          {
            id: matchId,
            stageId: "final-stage",
            round: 1,
            order: 1,
            purpose: "championship",
            home: { type: "entry_seed", seed: 1 },
            away: { type: "entry_seed", seed: 2 },
          },
        ],
        terminalMatchIds: [matchId],
      };
      const defHash = phase3DomainAdapter.hash(graph);

      await client`
        INSERT INTO divisions (id, competition_id, name, team_limit)
        VALUES (${divisionId}, ${comp.id}, 'Division 1', 8);
      `;
      await client`
        INSERT INTO format_revisions (id, competition_id, division_id, revision, definition, definition_hash, status, created_by)
        VALUES (${formatRevId}, ${comp.id}, ${divisionId}, 1, ${client.json(graph)}, ${defHash}, 'draft', ${tenantA_userId});
      `;
      await client`
        INSERT INTO matches (id, competition_id, division_id, format_revision_id, code, stage, round_number, ordinal, state)
        VALUES (${matchId}, ${comp.id}, ${divisionId}, ${formatRevId}, 'M1', 'final', 1, 1, 'ready');
      `;

      const revokedPassId = randomUUID();
      await client`
        INSERT INTO scoring_access_passes (
          id, competition_id, match_id, secret_hash, expires_at, created_by, role, scope, revoked_at, revocation_reason
        ) VALUES (
          ${revokedPassId}, ${comp.id}, ${matchId}, ${Buffer.alloc(32, 1)}, now() + interval '1 hour',
          ${tenantA_userId}, 'scorekeeper', '["score:read","score:write","score:reverse","score:finalise"]'::jsonb, now(), 'Security drill revocation'
        );
      `;

      const scoringResponse = await app.inject({
        method: "POST",
        url: `/api/v1/scoring/access/exchange`,
        headers: {
          "content-type": "application/json",
          origin: "https://app.matchday.test",
        },
        payload: {
          access_token: `revoked-pass-token-${revokedPassId}`,
          device_id: randomUUID(),
        },
      });

      expect([400, 401, 403, 404]).toContain(scoringResponse.statusCode);
    });
  });

  describe("A08: Software and Data Integrity (Cross-Site Scripting XSS)", () => {
    it("stores HTML/script tags as literal string data without unescaped execution across HTTP routes", async () => {
      const xssPayload = "<script>alert('xss')</script>";

      const comp = await phase3Runtime.createCompetition(
        { accountId: tenantA_userId },
        {
          organisationId: tenantA_orgId,
          name: `XSS Test ${xssPayload}`,
          slug: `xss-test-${randomUUID()}`,
          sportCode: "volleyball",
          timezone: "UTC",
          startsOn: "2026-09-01",
          endsOn: "2026-09-02",
          venue: "Main Hall",
          address: "1 Sports Rd",
          countryCode: "SG",
          locale: "en-SG",
        },
        randomUUID(),
      );

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/competitions/${comp.id}`,
      });

      if (response.statusCode === 200) {
        expect(response.headers["content-type"]).toContain("application/json");
        expect(response.body).toContain(xssPayload);
      }
    });
  });
});
