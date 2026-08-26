import { createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import type { PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { EntitlementRuntime } from "../../src/entitlement-runtime.js";
import { ExportRuntime } from "../../src/export-runtime.js";
import { AdminRuntime } from "../../src/admin-runtime.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase6_commercial_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);

let client!: Sql;
let entitlementRuntime!: EntitlementRuntime;
let exportRuntime!: ExportRuntime;
let adminRuntime!: AdminRuntime;

let ownerAccountId = "";
let platformAdminAccountId = "";
let organisationId = "";

describeInfrastructure("Phase 6 Commercial Operations Integration", () => {
  beforeAll(async () => {
    await dropTestSchema(databaseUrl, schema);
    await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
    client = postgres(databaseUrl, {
      max: 8,
      onnotice: () => undefined,
      connection: { search_path: schema },
    });

    entitlementRuntime = new EntitlementRuntime(client as unknown as PostgresJsSql);
    exportRuntime = new ExportRuntime(client as unknown as PostgresJsSql);
    adminRuntime = new AdminRuntime(client as unknown as PostgresJsSql);

    const ownerRes = (
      await client<
        { id: string }[]
      >`INSERT INTO accounts (primary_email, display_name, email_verified_at) VALUES ('owner@example.com', 'Org Owner', now()) RETURNING id`
    )[0]!;
    ownerAccountId = ownerRes.id;

    const adminRes = (
      await client<
        { id: string }[]
      >`INSERT INTO accounts (primary_email, display_name, email_verified_at) VALUES ('admin@example.com', 'Platform Admin', now()) RETURNING id`
    )[0]!;
    platformAdminAccountId = adminRes.id;

    await client`INSERT INTO account_platform_roles (account_id, role, granted_by, reason) VALUES (${platformAdminAccountId}, 'platform_admin', ${platformAdminAccountId}, 'Integration test admin role')`;

    await client.begin(async (tx) => {
      const orgRes = (
        await tx<
          { id: string }[]
        >`INSERT INTO organisations (name, slug) VALUES ('Premier Sports Org', ${`slug-${randomUUID()}`}) RETURNING id`
      )[0]!;
      organisationId = orgRes.id;

      await tx`INSERT INTO organisation_memberships (organisation_id, account_id, role, status) VALUES (${organisationId}, ${ownerAccountId}, 'owner', 'active')`;
    });
  }, 30_000);

  afterAll(async () => {
    if (client) await client.end();
    await dropTestSchema(databaseUrl, schema);
  });

  it("BIL-001: defaults organisation to free tier and asserts entry limits", async () => {
    const summary = await entitlementRuntime.getBillingSummary(organisationId);
    expect(summary.tier).toBe("free");
    expect(summary.status).toBe("active");
    expect(summary.custom_branding_allowed).toBe(false);

    // 16 entries allowed on free tier
    await expect(
      entitlementRuntime.assertEntryLimit(client as unknown as PostgresJsSql, organisationId, 16),
    ).resolves.toBeUndefined();

    // 17 entries rejected on free tier
    await expect(
      entitlementRuntime.assertEntryLimit(client as unknown as PostgresJsSql, organisationId, 17),
    ).rejects.toThrow(/allows maximum 16 entries/i);
  });

  it("BIL-007: processes billing webhook idempotently and upgrades tier to event_pass", async () => {
    const eventId = `evt_${randomUUID()}`;
    const webhookPayload = {
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          customer: "cus_123",
          subscription: "sub_123",
          metadata: {
            organisation_id: organisationId,
            tier: "event_pass" as const,
            top_up_units: "10",
          },
          amount_total: 4900,
          currency: "usd",
        },
      },
    };

    const secret = "test_webhook_secret_key";
    const rawPayload = JSON.stringify(webhookPayload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", secret).update(`${timestamp}.${rawPayload}`).digest("hex");
    const sigHeader = `t=${timestamp},v1=${signature}`;

    const firstResult = await entitlementRuntime.processBillingWebhook(sigHeader, rawPayload, webhookPayload, secret);
    expect(firstResult.processed).toBe(true);

    // Replay should be ignored idempotently
    const replayResult = await entitlementRuntime.processBillingWebhook(sigHeader, rawPayload, webhookPayload, secret);
    expect(replayResult.processed).toBe(false);

    const updatedSummary = await entitlementRuntime.getBillingSummary(organisationId);
    expect(updatedSummary.tier).toBe("event_pass");
    expect(updatedSummary.custom_branding_allowed).toBe(true);
    expect(updatedSummary.ai_quota.limit).toBe(35); // 25 event_pass + 10 topup
  });

  it("BIL-012: saves and retrieves competition branding on upgraded tier", async () => {
    const compRes = (
      await client<
        { id: string }[]
      >`INSERT INTO competitions (organisation_id, name, slug, sport_code, status, timezone, starts_on, ends_on, venue, created_by)
         VALUES (${organisationId}, 'Summer Classic', ${`comp-${randomUUID()}`}, 'basketball', 'draft', 'Asia/Singapore', '2027-08-01', '2027-08-02', 'Arena', ${ownerAccountId})
         RETURNING id`
    )[0]!;
    const competitionId = compRes.id;

    const actor = { accountId: ownerAccountId };
    const branding = await entitlementRuntime.setBranding(actor, organisationId, competitionId, {
      primary_color: "#0d9488",
      secondary_color: "#0f172a",
      hide_platform_badge: true,
    });

    expect(branding.primary_color).toBe("#0d9488");
    expect(branding.hide_platform_badge).toBe(true);

    const retrieved = await entitlementRuntime.getBranding(competitionId);
    expect(retrieved?.primary_color).toBe("#0d9488");
  });

  it("EXP-003 & EXP-004: exports competition to CSV and JSON formats", async () => {
    const compRes = (
      await client<
        { id: string }[]
      >`INSERT INTO competitions (organisation_id, name, slug, sport_code, status, timezone, starts_on, ends_on, venue, created_by)
         VALUES (${organisationId}, 'Export Open', ${`comp-${randomUUID()}`}, 'basketball', 'draft', 'Asia/Singapore', '2027-08-01', '2027-08-02', 'Arena', ${ownerAccountId})
         RETURNING id`
    )[0]!;
    const compId = compRes.id;

    await client`INSERT INTO divisions (competition_id, name, team_limit) VALUES (${compId}, 'Open Div', 16)`;

    const actor = { accountId: ownerAccountId };
    const csv = await exportRuntime.generateCompetitionCsv(compId, actor);
    expect(csv).toContain("Division,Stage,Match,Home Team,Away Team");

    const json = await exportRuntime.generateCompetitionJson(compId, actor);
    expect(json.schema_version).toBe("1.0");
    expect(json.competition).toMatchObject({ id: compId, name: "Export Open" });
  });

  it("ADM-001 & ADM-002: lists organisations and AI summary for platform_admin", async () => {
    const adminActor = { accountId: platformAdminAccountId };
    const orgs = await adminRuntime.listOrganisations(adminActor);
    expect(orgs.length).toBeGreaterThan(0);
    expect(orgs.find((o) => o.id === organisationId)?.tier).toBe("event_pass");

    const aiSummary = await adminRuntime.getAiAccountingSummary(adminActor);
    expect(aiSummary).toHaveProperty("total_requests");
    expect(aiSummary).toHaveProperty("cache_hit_rate");
    expect(aiSummary).toHaveProperty("total_cost_usd");
  });
});
