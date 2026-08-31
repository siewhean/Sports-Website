import { createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { createDefaultFormatTemplates } from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { EntitlementRuntime } from "../../src/entitlement-runtime.js";
import { ExportRuntime } from "../../src/export-runtime.js";
import { AdminRuntime } from "../../src/admin-runtime.js";
import { phase3DomainAdapter } from "../../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../../src/phase-3-runtime.js";
import { Phase4Runtime } from "../../src/phase-4-runtime.js";
import { DeterministicPhase4AiStub } from "../../src/phase-4-ai-provider.js";

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
let phase4Runtime!: Phase4Runtime;

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
    const phase3Runtime = new Phase3Runtime(client as unknown as PostgresJsSql, phase3DomainAdapter);
    phase4Runtime = new Phase4Runtime(
      client as unknown as PostgresJsSql,
      phase3Runtime,
      { enqueueSchedule: async () => ({ id: "ignored", name: "schedule.optimize", duplicate: false }) },
      {
        mode: "stub",
        provider: new DeterministicPhase4AiStub(),
        timeoutMs: 2_000,
        maximumAttempts: 1,
        cacheTtlSeconds: 3_600,
      },
    );

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

  it("BIL-007: scopes an Event Pass webhook to its purchased competition", async () => {
    const competitionA = (
      await client<{ id: string }[]>`
        INSERT INTO competitions (organisation_id, name, slug, sport_code, status, timezone, starts_on, ends_on, venue, created_by)
        VALUES (${organisationId}, 'Pass Competition A', ${`pass-a-${randomUUID()}`}, 'basketball', 'draft', 'Asia/Singapore', '2027-08-01', '2027-08-02', 'Arena', ${ownerAccountId})
        RETURNING id
      `
    )[0]!.id;
    const competitionB = (
      await client<{ id: string }[]>`
        INSERT INTO competitions (organisation_id, name, slug, sport_code, status, timezone, starts_on, ends_on, venue, created_by)
        VALUES (${organisationId}, 'Pass Competition B', ${`pass-b-${randomUUID()}`}, 'basketball', 'draft', 'Asia/Singapore', '2027-08-01', '2027-08-02', 'Arena', ${ownerAccountId})
        RETURNING id
      `
    )[0]!.id;
    const eventId = `evt_${randomUUID()}`;
    const webhookPayload = {
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          customer: "cus_123",
          metadata: {
            organisation_id: organisationId,
            competition_id: competitionA,
            tier: "event_pass" as const,
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

    const [tierA, tierB] = await client<{ tier: string }[]>`
      SELECT matchday_effective_plan_tier(id) AS tier
      FROM competitions
      WHERE id IN (${competitionA}, ${competitionB})
      ORDER BY id
    `;
    expect([tierA?.tier, tierB?.tier].sort()).toEqual(["event_pass", "free"]);
    await expect(
      entitlementRuntime.setBranding({ accountId: ownerAccountId }, organisationId, competitionA, {
        primary_color: "#0d9488",
      }),
    ).resolves.toMatchObject({ competition_id: competitionA });
    await expect(
      entitlementRuntime.setBranding({ accountId: ownerAccountId }, organisationId, competitionB, {
        primary_color: "#0d9488",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("BIL-012: saves and retrieves competition branding on upgraded tier", async () => {
    await client`
      INSERT INTO organisation_subscriptions (organisation_id, tier, status, current_period_start, current_period_end)
      VALUES (${organisationId}, 'organiser_pro', 'active', now(), now() + interval '30 days')
      ON CONFLICT (organisation_id) DO UPDATE SET tier='organiser_pro', status='active', current_period_end=now() + interval '30 days'
    `;
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

  it("EXP-006: permits only active platform administrators to export unpublished competitions and import archives", async () => {
    const draftCompetitionId = (
      await client<{ id: string }[]>`
        INSERT INTO competitions (organisation_id, name, slug, sport_code, status, timezone, starts_on, ends_on, venue, created_by)
        VALUES (${organisationId}, 'Admin Export Draft', ${`comp-${randomUUID()}`}, 'basketball', 'draft', 'Asia/Singapore', '2027-08-01', '2027-08-02', 'Arena', ${ownerAccountId})
        RETURNING id
      `
    )[0]!.id;
    const revokedAccountId = randomUUID();
    const expiredAccountId = randomUUID();
    await client`
      INSERT INTO accounts (id, primary_email, display_name) VALUES
        (${revokedAccountId}, ${`${revokedAccountId}@example.test`}, 'Revoked export admin'),
        (${expiredAccountId}, ${`${expiredAccountId}@example.test`}, 'Expired export admin')
    `;
    await client`
      INSERT INTO account_platform_roles (account_id, role, granted_at, revoked_at, reason) VALUES
        (${revokedAccountId}, 'platform_admin', now() - interval '2 days', now() - interval '1 day', 'Revoked export test')
    `;
    await client`
      INSERT INTO account_platform_roles (account_id, role, granted_at, expires_at, reason) VALUES
        (${expiredAccountId}, 'platform_admin', now() - interval '2 days', now() - interval '1 day', 'Expired export test')
    `;
    const archive = {
      schema_version: "1.0",
      competition: { id: "archived-source", name: "Admin Import", sport_code: "basketball" },
      divisions: [],
    };

    await expect(
      exportRuntime.generateCompetitionCsv(draftCompetitionId, { accountId: platformAdminAccountId }),
    ).resolves.toContain("Division,Stage");
    await expect(
      exportRuntime.importCompetitionArchive({ accountId: platformAdminAccountId }, organisationId, archive),
    ).resolves.toMatchObject({
      divisions_count: 0,
      entries_count: 0,
      matches_count: 0,
    });
    for (const accountId of [revokedAccountId, expiredAccountId]) {
      await expect(exportRuntime.generateCompetitionCsv(draftCompetitionId, { accountId })).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(
        exportRuntime.importCompetitionArchive({ accountId }, organisationId, archive),
      ).rejects.toMatchObject({
        statusCode: 403,
      });
    }
  });

  it("EXP-005: keeps audit history private while published fixture exports remain public", async () => {
    const publishedCompetitionId = randomUUID();
    const publishedDivisionId = randomUUID();
    const formatRevisionId = randomUUID();
    const scheduleRevisionId = randomUUID();
    const graph = structuredClone(createDefaultFormatTemplates(8)[0]!.graph);

    await client`
      INSERT INTO competitions (id, organisation_id, name, slug, sport_code, status, timezone, starts_on, ends_on, venue, created_by)
      VALUES (${publishedCompetitionId}, ${organisationId}, 'Published Audit Export', ${`published-audit-${randomUUID()}`}, 'basketball', 'published', 'Asia/Singapore', '2027-08-01', '2027-08-02', 'Arena', ${ownerAccountId})
    `;
    await client`INSERT INTO divisions (id, competition_id, name, team_limit) VALUES (${publishedDivisionId}, ${publishedCompetitionId}, 'Open', 8)`;
    await client`
      INSERT INTO division_entries (division_id, name, seed, status, entry_type)
      SELECT ${publishedDivisionId}, 'Team ' || seed, seed, 'active', 'team'
      FROM generate_series(1, 8) seed
    `;
    await client`
      INSERT INTO format_revisions (id, competition_id, division_id, revision, definition, definition_hash, created_by, validation_contract)
      VALUES (${formatRevisionId}, ${publishedCompetitionId}, ${publishedDivisionId}, 1, ${client.json(graph)}, phase4_sha256_json(${client.json(graph)}::jsonb), ${ownerAccountId}, 'phase3')
    `;
    await client`
      INSERT INTO schedule_revisions (id, competition_id, format_revision_id, revision, input_hash, status, created_by, quality)
      VALUES (${scheduleRevisionId}, ${publishedCompetitionId}, ${formatRevisionId}, 1, phase4_sha256_json(jsonb_build_object('audit_export', ${scheduleRevisionId}::uuid)), 'draft', ${ownerAccountId}, '{}'::jsonb)
    `;
    await client`
      INSERT INTO competition_publications (competition_id, published_schedule_revision_id, schedule_version, schedule_published_at)
      VALUES (${publishedCompetitionId}, ${scheduleRevisionId}, 1, now())
    `;
    await client`
      INSERT INTO audit_events (request_id, actor_account_id, actor_type, organisation_id, action, target_type, target_id)
      VALUES (${`audit-export-${randomUUID()}`}, ${ownerAccountId}, 'account', ${organisationId}, 'competition.updated', 'competition', ${publishedCompetitionId})
    `;

    const organiserAccountId = randomUUID();
    const unrelatedAccountId = randomUUID();
    const revokedAccountId = randomUUID();
    const expiredAccountId = randomUUID();
    await client`
      INSERT INTO accounts (id, primary_email, display_name) VALUES
        (${organiserAccountId}, ${`${organiserAccountId}@example.test`}, 'Audit organiser'),
        (${unrelatedAccountId}, ${`${unrelatedAccountId}@example.test`}, 'Audit unrelated'),
        (${revokedAccountId}, ${`${revokedAccountId}@example.test`}, 'Audit revoked admin'),
        (${expiredAccountId}, ${`${expiredAccountId}@example.test`}, 'Audit expired admin')
    `;
    await client`INSERT INTO organisation_memberships (organisation_id, account_id, role, status) VALUES (${organisationId}, ${organiserAccountId}, 'organiser', 'active')`;
    await client`
      INSERT INTO account_platform_roles (account_id, role, granted_at, revoked_at, reason) VALUES
        (${revokedAccountId}, 'platform_admin', now() - interval '2 days', now() - interval '1 day', 'Revoked audit export test')
    `;
    await client`
      INSERT INTO account_platform_roles (account_id, role, granted_at, expires_at, reason) VALUES
        (${expiredAccountId}, 'platform_admin', now() - interval '2 days', now() - interval '1 day', 'Expired audit export test')
    `;

    await expect(
      exportRuntime.generateAuditHistoryExport({ accountId: organiserAccountId }, publishedCompetitionId),
    ).resolves.toContain("competition.updated");
    await expect(
      exportRuntime.generateAuditHistoryExport({ accountId: platformAdminAccountId }, publishedCompetitionId),
    ).resolves.toContain("competition.updated");
    await expect(exportRuntime.generateCompetitionCsv(publishedCompetitionId)).resolves.toContain(
      "Division,Stage,Match",
    );

    for (const accountId of [unrelatedAccountId, revokedAccountId, expiredAccountId]) {
      await expect(
        exportRuntime.generateAuditHistoryExport({ accountId }, publishedCompetitionId),
      ).rejects.toMatchObject({ statusCode: 403, code: "ORGANISATION_ACCESS_DENIED" });
    }

    const draftCompetitionId = (
      await client<{ id: string }[]>`
        INSERT INTO competitions (organisation_id, name, slug, sport_code, status, timezone, starts_on, ends_on, venue, created_by)
        VALUES (${organisationId}, 'Draft Audit Export', ${`draft-audit-${randomUUID()}`}, 'basketball', 'draft', 'Asia/Singapore', '2027-08-01', '2027-08-02', 'Arena', ${ownerAccountId})
        RETURNING id
      `
    )[0]!.id;
    await expect(
      exportRuntime.generateAuditHistoryExport({ accountId: unrelatedAccountId }, draftCompetitionId),
    ).rejects.toMatchObject({ statusCode: 403, code: "ORGANISATION_ACCESS_DENIED" });
  });

  it("ADM-001 & ADM-002: lists organisations and AI summary for platform_admin", async () => {
    const adminActor = { accountId: platformAdminAccountId };
    const orgs = await adminRuntime.listOrganisations(adminActor);
    expect(orgs.length).toBeGreaterThan(0);
    expect(orgs.find((o) => o.id === organisationId)?.tier).toBe("organiser_pro");

    const aiSummary = await adminRuntime.getAiAccountingSummary(adminActor);
    expect(aiSummary).toHaveProperty("total_requests");
    expect(aiSummary).toHaveProperty("cache_hit_rate");
    expect(aiSummary).toHaveProperty("total_cost_usd");
  });

  it("BIL-002: enforces entry limits on effective subscription tier across free, upgrade, and lapsed states", async () => {
    const freeOrgId = randomUUID();
    await client.begin(async (tx) => {
      await tx`INSERT INTO organisations (id, name, slug) VALUES (${freeOrgId}, 'Free Org', ${`slug-${randomUUID()}`})`;
      await tx`INSERT INTO organisation_memberships (organisation_id, account_id, role, status) VALUES (${freeOrgId}, ${ownerAccountId}, 'owner', 'active')`;
    });

    const compRes = (
      await client<
        { id: string }[]
      >`INSERT INTO competitions (organisation_id, name, slug, sport_code, status, timezone, starts_on, ends_on, venue, created_by)
         VALUES (${freeOrgId}, 'Entitlement Cup', ${`comp-${randomUUID()}`}, 'basketball', 'draft', 'Asia/Singapore', '2027-08-01', '2027-08-02', 'Arena', ${ownerAccountId})
         RETURNING id`
    )[0]!;
    const compId = compRes.id;

    const divRes = (
      await client<
        { id: string }[]
      >`INSERT INTO divisions (competition_id, name, team_limit) VALUES (${compId}, 'Main Division', 48) RETURNING id`
    )[0]!;
    const divId = divRes.id;

    // 1. Insert 16 entries on free tier -> all 16 succeed
    for (let i = 1; i <= 16; i++) {
      await client`INSERT INTO division_entries (division_id, name, seed, status) VALUES (${divId}, ${`Team ${i}`}, ${i}, 'confirmed')`;
    }

    // 2. 17th entry on free tier -> rejected by DB trigger
    await expect(
      client`INSERT INTO division_entries (division_id, name, seed, status) VALUES (${divId}, 'Team 17', 17, 'confirmed')`,
    ).rejects.toThrow(/free plan permits at most 16 active entries/i);

    // 3. Upgrade organisation to active Organiser Pro tier
    await client`INSERT INTO organisation_subscriptions (organisation_id, tier, status, current_period_start, current_period_end)
                 VALUES (${freeOrgId}, 'organiser_pro', 'active', now(), now() + interval '30 days')
                 ON CONFLICT (organisation_id) DO UPDATE SET tier='organiser_pro', status='active', current_period_end=now() + interval '30 days'`;

    // 4. Now 17th and 18th entries succeed on paid tier
    await client`INSERT INTO division_entries (division_id, name, seed, status) VALUES (${divId}, 'Team 17', 17, 'confirmed')`;
    await client`INSERT INTO division_entries (division_id, name, seed, status) VALUES (${divId}, 'Team 18', 18, 'confirmed')`;

    const countAfterPaid = (
      await client<
        { count: number }[]
      >`SELECT count(*)::int as count FROM division_entries WHERE division_id=${divId} AND status='confirmed'`
    )[0]!.count;
    expect(countAfterPaid).toBe(18);

    // 5. Subscription lapses / cancels -> existing entries remain intact, but new entries beyond 16 are rejected
    await client`UPDATE organisation_subscriptions SET tier='free', status='canceled', updated_at=now() WHERE organisation_id=${freeOrgId}`;

    const countAfterLapse = (
      await client<
        { count: number }[]
      >`SELECT count(*)::int as count FROM division_entries WHERE division_id=${divId} AND status='confirmed'`
    )[0]!.count;
    expect(countAfterLapse).toBe(18); // Non-destructive: existing 18 entries preserved

    const tierAfterLapse = await client<{ plan_tier: string }[]>`
      SELECT matchday_effective_plan_tier(${compId}) AS plan_tier
    `;
    const subscriptionAfterLapse = await client<{ tier: string; status: string }[]>`
      SELECT tier, status FROM organisation_subscriptions WHERE organisation_id=${freeOrgId}
    `;
    expect(subscriptionAfterLapse[0]).toMatchObject({ tier: "free", status: "canceled" });
    expect(tierAfterLapse[0]?.plan_tier).toBe("free");

    // Attempting to add a 19th entry now that tier is free -> rejected
    await expect(
      client`INSERT INTO division_entries (division_id, name, seed, status) VALUES (${divId}, 'Team 19', 19, 'confirmed')`,
    ).rejects.toThrow(/free plan permits at most 16 active entries/i);
  });

  it("BIL-005 & AI-017: consumes all purchased AI credits sequentially and rejects request N+1", async () => {
    const topUpOrgId = randomUUID();
    const memberAccountId = (
      await client<
        { id: string }[]
      >`INSERT INTO accounts (primary_email, display_name, email_verified_at) VALUES (${`member-${randomUUID()}@example.com`}, 'AI Member', now()) RETURNING id`
    )[0]!.id;

    await client.begin(async (tx) => {
      await tx`INSERT INTO organisations (id, name, slug) VALUES (${topUpOrgId}, 'AI TopUp Org', ${`slug-${randomUUID()}`})`;
      await tx`INSERT INTO organisation_memberships (organisation_id, account_id, role, status) VALUES (${topUpOrgId}, ${memberAccountId}, 'owner', 'active')`;
    });

    // Grant 10 top-up units to this organisation
    await client`INSERT INTO entitlement_grants (organisation_id, tier, feature, source, quantity, idempotency_key)
                 VALUES (${topUpOrgId}, 'event_pass', 'ai_actions', 'top_up', 10, ${`grant-${randomUUID()}`})`;

    // Verify allowance is seeded with 10 top-up credits
    const initialCredits = await client<
      { remaining: number }[]
    >`SELECT phase6_shared_ai_credits_remaining(${topUpOrgId}) as remaining`;
    expect(initialCredits[0]!.remaining).toBe(10);

    // Consume all 10 purchased credits sequentially
    for (let i = 1; i <= 10; i++) {
      const res = await phase4Runtime.textToBrief(
        { accountId: memberAccountId },
        topUpOrgId,
        {
          idempotency_key: `ai-topup-${i}-${randomUUID()}`,
          text: `Tournament draft prompt number ${i} with 8 teams and 2 courts`,
        },
        randomUUID(),
      );
      expect(res.status).toBe("success");
      expect(res.charged_units).toBe(1);
    }

    // Verify all 10 consumptions are recorded and remaining is 0
    const consumptions = await client<
      { count: number }[]
    >`SELECT count(*)::int as count FROM ai_credit_consumptions WHERE organisation_id=${topUpOrgId}`;
    expect(consumptions[0]!.count).toBe(10);

    const postCredits = await client<
      { remaining: number }[]
    >`SELECT phase6_shared_ai_credits_remaining(${topUpOrgId}) as remaining`;
    expect(postCredits[0]!.remaining).toBe(0);

    // The 11th request MUST fail with quota_exhausted
    const overflowRes = await phase4Runtime.textToBrief(
      { accountId: memberAccountId },
      topUpOrgId,
      {
        idempotency_key: `ai-topup-11-${randomUUID()}`,
        text: "Tournament draft prompt number 11 overflow attempt",
      },
      randomUUID(),
    );
    expect(overflowRes.status).toBe("quota_exhausted");
    expect(overflowRes.charged_units).toBe(0);
  });

  it("AI-017: handles concurrent organisation-wide shared credit consumption across multiple actors without overspending", async () => {
    const concurrentOrgId = randomUUID();
    const actor1 = (
      await client<
        { id: string }[]
      >`INSERT INTO accounts (primary_email, display_name, email_verified_at) VALUES (${`actor1-${randomUUID()}@example.com`}, 'Actor One', now()) RETURNING id`
    )[0]!.id;
    const actor2 = (
      await client<
        { id: string }[]
      >`INSERT INTO accounts (primary_email, display_name, email_verified_at) VALUES (${`actor2-${randomUUID()}@example.com`}, 'Actor Two', now()) RETURNING id`
    )[0]!.id;
    const actor3 = (
      await client<
        { id: string }[]
      >`INSERT INTO accounts (primary_email, display_name, email_verified_at) VALUES (${`actor3-${randomUUID()}@example.com`}, 'Actor Three', now()) RETURNING id`
    )[0]!.id;

    await client.begin(async (tx) => {
      await tx`INSERT INTO organisations (id, name, slug) VALUES (${concurrentOrgId}, 'Concurrent AI Org', ${`slug-${randomUUID()}`})`;
      await tx`INSERT INTO organisation_memberships (organisation_id, account_id, role, status) VALUES (${concurrentOrgId}, ${actor1}, 'owner', 'active')`;
      await tx`INSERT INTO organisation_memberships (organisation_id, account_id, role, status) VALUES (${concurrentOrgId}, ${actor2}, 'organiser', 'active')`;
      await tx`INSERT INTO organisation_memberships (organisation_id, account_id, role, status) VALUES (${concurrentOrgId}, ${actor3}, 'organiser', 'active')`;
    });

    // Grant exactly 5 top-up units to this organisation
    await client`INSERT INTO entitlement_grants (organisation_id, tier, feature, source, quantity, idempotency_key)
                 VALUES (${concurrentOrgId}, 'event_pass', 'ai_actions', 'top_up', 5, ${`grant-${randomUUID()}`})`;

    // Launch 12 concurrent requests across the 3 actors
    const actors = [actor1, actor2, actor3];
    const concurrentRequests = Array.from({ length: 12 }, (_, i) => {
      const actorId = actors[i % actors.length]!;
      return phase4Runtime.textToBrief(
        { accountId: actorId },
        concurrentOrgId,
        {
          idempotency_key: `ai-concurrent-${i}-${randomUUID()}`,
          text: `Concurrent tournament prompt ${i} with 8 teams`,
        },
        randomUUID(),
      );
    });

    const results = await Promise.all(concurrentRequests);
    const successCount = results.filter((r) => r.status === "success").length;
    const quotaExhaustedCount = results.filter((r) => r.status === "quota_exhausted").length;

    // Exactly 5 succeeded, exactly 7 failed with quota_exhausted
    expect(successCount).toBe(5);
    expect(quotaExhaustedCount).toBe(7);

    // Exactly 5 consumptions recorded
    const consumptions = await client<
      { count: number }[]
    >`SELECT count(*)::int as count FROM ai_credit_consumptions WHERE organisation_id=${concurrentOrgId}`;
    expect(consumptions[0]!.count).toBe(5);

    const remainingCredits = await client<
      { remaining: number }[]
    >`SELECT phase6_shared_ai_credits_remaining(${concurrentOrgId}) as remaining`;
    expect(remainingCredits[0]!.remaining).toBe(0);
  });
});
