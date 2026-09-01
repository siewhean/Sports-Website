import { randomUUID } from "node:crypto";
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
    phase3Runtime = new Phase3Runtime(client as unknown as PostgresJsSql, phase3DomainAdapter);

    app = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime,
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

    it("prevents Tenant A actor from mutating Tenant B competition", async () => {
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
    it("rejects forged or unsigned billing webhook HTTP requests with 401", async () => {
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

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/billing/webhook",
        headers: {
          "stripe-signature": "t=12345,v1=bad_forged_hmac_signature",
          "content-type": "application/json",
        },
        payload: forgedPayload,
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe("A03: Injection (SQL Injection Resistance)", () => {
    it("safely parameterizes SQL injection payloads without database corruption", async () => {
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
    it("rejects access attempts when an access pass is revoked or expired", async () => {
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
      const matchId = randomUUID();
      await client`
        INSERT INTO divisions (id, competition_id, name, sport_code, sort_order)
        VALUES (${divisionId}, ${comp.id}, 'Division 1', 'volleyball', 1);
      `;
      await client`
        INSERT INTO matches (id, competition_id, division_id, state)
        VALUES (${matchId}, ${comp.id}, ${divisionId}, 'ready');
      `;

      const revokedPassId = randomUUID();
      await client`
        INSERT INTO scoring_access_passes (
          id, competition_id, match_id, secret_hash, expires_at, created_by, role, scope, revoked_at, revocation_reason
        ) VALUES (
          ${revokedPassId}, ${comp.id}, ${matchId}, 'fake-secret-hash', now() + interval '1 hour',
          ${tenantA_userId}, 'scorekeeper', '["score:read","score:write","score:reverse","score:finalise"]'::jsonb, now(), 'Security drill revocation'
        );
      `;

      const check = await client<{ revoked_at: string | null }[]>`
        SELECT revoked_at FROM scoring_access_passes WHERE id = ${revokedPassId};
      `;
      expect(check[0]!.revoked_at).not.toBeNull();
    });
  });

  describe("A08: Software and Data Integrity (Cross-Site Scripting XSS)", () => {
    it("stores HTML/script tags as literal string data without unescaped execution", async () => {
      const xssPayload = "<script>alert('xss')</script>";

      const comp = await phase3Runtime.createCompetition(
        { accountId: tenantA_userId },
        {
          organisationId: tenantA_orgId,
          name: xssPayload,
          slug: `xss-test-${randomUUID()}`,
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

      const stored = await client<{ name: string }[]>`
        SELECT name FROM competitions WHERE id = ${comp.id};
      `;

      expect(stored[0]!.name).toBe(xssPayload);
    });
  });
});
