import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultRetentionPolicy } from "@matchday/config/retention";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import type { PostgresJsSql } from "@matchday/identity";
import { buildApp } from "../../src/app.js";
import { AccountDataRightsRuntime, accountDeletionConfirmationPhrase } from "../../src/account-data-rights-runtime.js";
import { ApiError, ErrorCode } from "../../src/errors.js";
import type { IdentityApiRuntime } from "../../src/identity-runtime.js";
import { PdpaRetentionJob } from "../../src/pdpa-retention.js";
import { healthyProbes, testConfig } from "../helpers.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "";
const schema = `test_pdpa_${randomUUID().replaceAll("-", "")}`;
const origin = "http://localhost:3000";
type ExportBody = {
  subject_account_id: string;
  account: { id: string };
  sign_in_identities: unknown[];
  organisation_memberships: unknown[];
  notification_preferences: unknown[];
  notifications: { id: string; emails: unknown[] }[];
  casual: { presets: unknown[]; friend_requests: unknown[] };
  sessions: unknown[];
  billing: { subscriptions: unknown[]; webhook_receipts: unknown[] };
  competitions_created: { id: string; export_paths: string[] }[];
};
const day = 86_400_000;

let sql: Sql;
let app: Awaited<ReturnType<typeof buildApp>>;
const accountByToken = new Map<string, string>();

const headers = (token: string) => ({ cookie: `matchday_session=${token}`, "x-csrf-token": `csrf-${token}`, origin });

async function makeAccount(label: string, token = label): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO accounts(primary_email, display_name, email_verified_at)
    VALUES (${`${label}-${randomUUID()}@matchday.test`}, ${`Person ${label}`}, now()) RETURNING id`;
  accountByToken.set(token, row!.id);
  await sql`INSERT INTO provider_identities(account_id, issuer, subject)
            VALUES (${row!.id}, 'https://idp.test/', ${`sub-${row!.id}`})`;
  return row!.id;
}

async function makeOrganisation(owners: string[], role: "owner" | "organiser" = "owner"): Promise<string> {
  return sql.begin(async (tx) => {
    const [org] = await tx<{ id: string }[]>`
      INSERT INTO organisations(name, slug) VALUES (${`Org ${randomUUID().slice(0, 6)}`}, ${`org-${randomUUID()}`})
      RETURNING id`;
    for (const [index, accountId] of owners.entries()) {
      await tx`INSERT INTO organisation_memberships(organisation_id, account_id, role, status)
               VALUES (${org!.id}, ${accountId}, ${index === 0 ? "owner" : role}, 'active')`;
    }
    return org!.id;
  });
}

async function makeCompetition(organisationId: string, createdBy: string, status: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO competitions(organisation_id, name, slug, sport_code, status, timezone, starts_on, ends_on, venue, created_by)
    VALUES (${organisationId}, 'Comp', ${`comp-${randomUUID()}`}, 'basketball', ${status}, 'Asia/Singapore',
            '2027-08-01', '2027-08-02', 'Arena', ${createdBy}) RETURNING id`;
  return row!.id;
}

async function makeSession(
  accountId: string,
  options: { ageDays?: number; revokedAgeDays?: number; expiresInDays?: number } = {},
) {
  const base = new Date(Date.now() - (options.ageDays ?? 0) * day);
  const idleMs = options.expiresInDays === undefined ? 1_000 : options.expiresInDays * day;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO identity_sessions(id, account_id, secret_hash, created_at, last_seen_at, idle_expires_at,
      absolute_expires_at, revoked_at, provider_issuer, provider_subject, provider_session_id)
    VALUES (${randomUUID()}, ${accountId}, ${"a".repeat(64)}, ${base}, ${base}, ${new Date(base.getTime() + idleMs)},
      ${new Date(base.getTime() + idleMs + 1_000)},
      ${options.revokedAgeDays === undefined ? null : new Date(Date.now() - options.revokedAgeDays * day)},
      'https://idp.test/', 'sub', 'sid-secret') RETURNING id`;
  return row!.id;
}

async function makeAttempt(ageDays: number, windowOpen = false) {
  const attemptedAt = new Date(Date.now() - ageDays * day);
  const expires = windowOpen ? new Date(Date.now() + 60_000) : new Date(attemptedAt.getTime() + 900_000);
  await sql`INSERT INTO scoring_access_attempts(credential_kind, outcome, credential_hmac, ip_hmac, request_id,
              attempted_at, rate_limit_state_expires_at, hmac_key_version)
            VALUES ('token', 'invalid', decode(repeat('aa', 32), 'hex'), decode(repeat('bb', 32), 'hex'),
              ${randomUUID()}, ${attemptedAt}, ${expires}, 'v1')`;
}

describeInfrastructure("PDPA account data rights and retention", () => {
  beforeAll(async () => {
    await migrateDatabase({
      databaseUrl,
      schema,
      migrationsDirectory: fileURLToPath(new URL("../../../../packages/database/migrations", import.meta.url)),
    });
    sql = postgres(databaseUrl, { max: 10, onnotice: () => undefined, connection: { search_path: schema } });
    const identity = {
      authenticate: vi.fn(async (token: string) => {
        const id = accountByToken.get(token);
        if (!id) throw new ApiError(401, ErrorCode.AUTHENTICATION_REQUIRED, "Sign in required");
        const [row] = await sql<{ status: string }[]>`SELECT status FROM accounts WHERE id = ${id}`;
        if (row?.status !== "active") throw new ApiError(401, ErrorCode.AUTHENTICATION_REQUIRED, "Sign in required");
        return {
          account: {
            id,
            primaryEmail: "x@matchday.test",
            displayName: token,
            status: "active",
            emailVerifiedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          sessionId: randomUUID(),
          sessionToken: token,
          csrfToken: `csrf-${token}`,
          idleExpiresAt: new Date(Date.now() + 60_000),
          absoluteExpiresAt: new Date(Date.now() + 60_000),
        };
      }),
      verifyCsrfToken: vi.fn((token: string, csrf: string) => csrf === `csrf-${token}`),
    } as unknown as IdentityApiRuntime;
    app = await buildApp({
      config: testConfig({ DATABASE_URL: databaseUrl, API_ALLOWED_ORIGINS: origin, MATCHDAY_PUBLIC_ORIGIN: origin }),
      probes: healthyProbes,
      identityRuntime: identity,
      accountDataRightsRuntime: new AccountDataRightsRuntime(sql as unknown as PostgresJsSql),
      rateLimitMax: 10_000,
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await dropTestSchema(databaseUrl, schema);
  });

  describe("data export", () => {
    it("returns the caller's personal data without secrets and requires authentication", async () => {
      const accountId = await makeAccount("export");
      const friendId = await makeAccount("export-friend");
      const orgId = await makeOrganisation([accountId]);
      const competitionId = await makeCompetition(orgId, accountId, "draft");
      await makeSession(accountId);
      await sql`INSERT INTO notification_preferences(account_id, notification_type, in_app_enabled, email_enabled)
                VALUES (${accountId}, 'schedule_update', true, false)`;
      const [notification] = await sql<{ id: string }[]>`
        INSERT INTO notifications(account_id, type, payload, idempotency_key)
        VALUES (${accountId}, 'schedule_update', '{"note":"hello"}'::jsonb, ${randomUUID()}) RETURNING id`;
      await sql`INSERT INTO notification_email_outbox(id, notification_id, to_address, template_id, template_version,
                  subject, text_body, html_body, idempotency_key, created_at, available_at)
                VALUES (${randomUUID()}, ${notification!.id}, 'export@matchday.test', 'schedule', 1, 'Subject',
                  'text', '<p>html</p>', ${randomUUID()}, now(), now())`;
      await sql`INSERT INTO casual_game_presets(owner_account_id, name, settings) VALUES (${accountId}, 'Mine', '{}'::jsonb)`;
      await sql`INSERT INTO casual_friend_requests(sender_id, recipient_id, status) VALUES (${accountId}, ${friendId}, 'accepted')`;
      await sql`INSERT INTO organisation_subscriptions(organisation_id, tier, provider_customer_id)
                VALUES (${orgId}, 'organiser_pro', 'cus_123')`;
      await sql`INSERT INTO billing_webhook_receipts(organisation_id, provider_event_id, event_type, payload, status)
                VALUES (${orgId}, ${`evt_${randomUUID()}`}, 'invoice.paid', '{"card":"secret-payload"}'::jsonb, 'processed')`;

      expect((await app.inject({ method: "GET", url: "/api/v1/account/data-export" })).statusCode).toBe(401);
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/account/data-export",
        headers: headers("export"),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["content-disposition"]).toContain("attachment");
      expect(response.headers["cache-control"]).toContain("no-store");
      const body = response.json<ExportBody>();
      expect(body.subject_account_id).toBe(accountId);
      expect(body.account.id).toBe(accountId);
      expect(body.sign_in_identities).toHaveLength(1);
      expect(body.organisation_memberships).toEqual([
        expect.objectContaining({ organisation_id: orgId, role: "owner" }),
      ]);
      expect(body.notification_preferences).toHaveLength(1);
      expect(body.notifications).toEqual([expect.objectContaining({ id: notification!.id })]);
      expect(body.notifications[0]!.emails).toHaveLength(1);
      expect(body.casual.presets).toHaveLength(1);
      expect(body.casual.friend_requests).toEqual([
        expect.objectContaining({ direction: "sent", other_account_id: friendId }),
      ]);
      expect(body.sessions).toHaveLength(1);
      expect(body.billing.subscriptions).toHaveLength(1);
      expect(body.billing.webhook_receipts).toHaveLength(1);
      expect(body.competitions_created[0]!.id).toBe(competitionId);
      expect(body.competitions_created[0]!.export_paths[0]).toContain(competitionId);
      const raw = response.body;
      for (const secret of ["secret_hash", "a".repeat(64), "sid-secret", "secret-payload", "export@matchday.test"]) {
        expect(raw).not.toContain(secret);
      }
      const audit =
        await sql`SELECT 1 FROM audit_events WHERE actor_account_id = ${accountId} AND action = 'account.data_export_requested'`;
      expect(audit).toHaveLength(1);
    });
  });

  describe("account deletion", () => {
    const confirm = { confirmation: accountDeletionConfirmationPhrase };

    it("rejects missing CSRF, bad origin and the wrong phrase", async () => {
      await makeAccount("guard");
      const url = "/api/v1/account/deletion";
      const noCsrf = await app.inject({
        method: "POST",
        url,
        headers: { cookie: "matchday_session=guard", origin },
        payload: confirm,
      });
      expect(noCsrf.statusCode).toBe(403);
      const badOrigin = await app.inject({
        method: "POST",
        url,
        headers: { ...headers("guard"), origin: "https://evil.example" },
        payload: confirm,
      });
      expect(badOrigin.statusCode).toBe(403);
      const wrongPhrase = await app.inject({
        method: "POST",
        url,
        headers: headers("guard"),
        payload: { confirmation: "delete" },
      });
      expect(wrongPhrase.statusCode).toBe(400);
      const [row] = await sql`SELECT status FROM accounts WHERE id = ${accountByToken.get("guard")!}`;
      expect(row!.status).toBe("active");
    });

    it("refuses when the caller is the sole owner of an organisation with live competitions", async () => {
      const accountId = await makeAccount("sole");
      const orgId = await makeOrganisation([accountId]);
      await makeCompetition(orgId, accountId, "live");
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/account/deletion",
        headers: headers("sole"),
        payload: confirm,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toMatch(/Ownership transfer and owner invitations are not available yet/);
      const [row] = await sql`SELECT status, deleted_at FROM accounts WHERE id = ${accountId}`;
      expect(row).toMatchObject({ status: "active", deleted_at: null });
    });

    it("allows deletion once the live competitions are finished", async () => {
      const accountId = await makeAccount("done");
      const orgId = await makeOrganisation([accountId]);
      await makeCompetition(orgId, accountId, "completed");
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/account/deletion",
        headers: headers("done"),
        payload: confirm,
      });
      expect(response.statusCode, response.body).toBe(200);
      // The organisation keeps its (anonymised) owner so the database invariant holds.
      const [membership] = await sql`SELECT status, role FROM organisation_memberships WHERE account_id = ${accountId}`;
      expect(membership).toMatchObject({ status: "active", role: "owner" });
    });

    it("anonymises the account, revokes sessions, removes personal rows and keeps audit/history intact", async () => {
      const accountId = await makeAccount("victim");
      const coOwnerId = await makeAccount("coowner");
      const friendId = await makeAccount("victim-friend");
      const orgId = await makeOrganisation([accountId, coOwnerId]);
      const competitionId = await makeCompetition(orgId, accountId, "live");
      await makeSession(accountId);
      await makeSession(accountId);
      await sql`INSERT INTO notification_preferences(account_id, notification_type) VALUES (${accountId}, 'schedule_update')`;
      await sql`INSERT INTO notifications(account_id, type, payload, idempotency_key)
                VALUES (${accountId}, 'schedule_update', '{}'::jsonb, ${randomUUID()})`;
      await sql`INSERT INTO casual_game_presets(owner_account_id, name, settings) VALUES (${accountId}, 'p', '{}'::jsonb)`;
      await sql`INSERT INTO casual_friend_requests(sender_id, recipient_id) VALUES (${friendId}, ${accountId})`;
      await sql`INSERT INTO audit_events(request_id, actor_account_id, actor_type, organisation_id, action, target_type, target_id)
                VALUES ('req-before', ${accountId}, 'account', ${orgId}, 'competition.created', 'competition', ${competitionId})`;
      const auditBefore = await sql`SELECT count(*)::int AS n FROM audit_events WHERE actor_account_id = ${accountId}`;

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/account/deletion",
        headers: headers("victim"),
        payload: confirm,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["set-cookie"]).toContain("Max-Age=0");
      expect(response.json()).toMatchObject({ revoked_sessions: 2, suspended_memberships: 1 });

      const [account] =
        await sql`SELECT primary_email, display_name, status, email_verified_at, deleted_at FROM accounts WHERE id = ${accountId}`;
      expect(account).toMatchObject({
        primary_email: `deleted-${accountId}@invalid`,
        display_name: "Deleted user",
        status: "deleted",
        email_verified_at: null,
      });
      expect(account!.deleted_at).toBeInstanceOf(Date);
      const sessions =
        await sql`SELECT revoked_at, provider_subject, provider_session_id FROM identity_sessions WHERE account_id = ${accountId}`;
      expect(sessions).toHaveLength(2);
      for (const session of sessions) {
        expect(session.revoked_at).not.toBeNull();
        expect(session.provider_subject).toBeNull();
        expect(session.provider_session_id).toBeNull();
      }
      expect(await sql`SELECT 1 FROM provider_identities WHERE account_id = ${accountId}`).toHaveLength(0);
      expect(await sql`SELECT 1 FROM notifications WHERE account_id = ${accountId}`).toHaveLength(0);
      expect(await sql`SELECT 1 FROM notification_preferences WHERE account_id = ${accountId}`).toHaveLength(0);
      expect(await sql`SELECT 1 FROM casual_game_presets WHERE owner_account_id = ${accountId}`).toHaveLength(0);
      expect(
        await sql`SELECT 1 FROM casual_friend_requests WHERE sender_id = ${accountId} OR recipient_id = ${accountId}`,
      ).toHaveLength(0);
      const [membership] = await sql`SELECT status FROM organisation_memberships WHERE account_id = ${accountId}`;
      expect(membership!.status).toBe("suspended");
      // Competition history still resolves to the (now anonymous) account id.
      const [competition] = await sql`SELECT created_by FROM competitions WHERE id = ${competitionId}`;
      expect(competition!.created_by).toBe(accountId);
      // Audit trail untouched, plus the deletion event; and still append-only.
      const auditAfter = await sql`SELECT count(*)::int AS n FROM audit_events WHERE actor_account_id = ${accountId}`;
      expect(auditAfter[0]!.n).toBe(auditBefore[0]!.n + 1);
      expect(
        await sql`SELECT 1 FROM audit_events WHERE actor_account_id = ${accountId} AND action = 'account.deleted'`,
      ).toHaveLength(1);
      await expect(sql`DELETE FROM audit_events WHERE actor_account_id = ${accountId}`).rejects.toThrow(/append-only/);

      // Session is dead for further use and the person can register again with the same identity + email.
      const again = await app.inject({ method: "GET", url: "/api/v1/account/data-export", headers: headers("victim") });
      expect(again.statusCode).toBe(401);
      await expect(
        sql.begin(async (tx) => {
          const [fresh] = await tx<{ id: string }[]>`
            INSERT INTO accounts(primary_email, display_name) VALUES (${`victim@matchday.test`}, 'Returning') RETURNING id`;
          await tx`INSERT INTO provider_identities(account_id, issuer, subject)
                   VALUES (${fresh!.id}, 'https://idp.test/', ${`sub-${accountId}`})`;
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("retention purge", () => {
    const runtimeSql = () => sql as unknown as PostgresJsSql;
    const policy = { ...defaultRetentionPolicy, batchSize: 10 };

    it("deletes only rows past their window, is idempotent, and never touches audit_events", async () => {
      const accountId = await makeAccount("purge");
      const oldExpired = await makeSession(accountId, { ageDays: 90 });
      const oldRevoked = await makeSession(accountId, { ageDays: 60, revokedAgeDays: 45, expiresInDays: 90 });
      const recentRevoked = await makeSession(accountId, { ageDays: 5, revokedAgeDays: 2, expiresInDays: 90 });
      const active = await makeSession(accountId);
      await sql`UPDATE identity_sessions SET idle_expires_at = now() + interval '1 hour', absolute_expires_at = now() + interval '1 day' WHERE id = ${active}`;

      await makeAttempt(45);
      await makeAttempt(5);
      await makeAttempt(45, true); // rate-limit window still open: must be kept

      const oldNotification = randomUUID();
      const newNotification = randomUUID();
      await sql`INSERT INTO notifications(id, account_id, type, payload, idempotency_key, created_at)
                VALUES (${oldNotification}, ${accountId}, 't', '{}'::jsonb, ${randomUUID()}, now() - interval '200 days'),
                       (${newNotification}, ${accountId}, 't', '{}'::jsonb, ${randomUUID()}, now() - interval '20 days')`;
      await sql`INSERT INTO notification_email_outbox(id, notification_id, to_address, template_id, template_version,
                  subject, text_body, html_body, idempotency_key, created_at, available_at)
                VALUES (${randomUUID()}, ${oldNotification}, 'old@matchday.test', 't', 1, 's', 't', 'h', ${randomUUID()}, now(), now())`;

      const oldReceipt = `evt_old_${randomUUID()}`;
      const newReceipt = `evt_new_${randomUUID()}`;
      await sql`INSERT INTO billing_webhook_receipts(provider_event_id, event_type, payload, status, created_at)
                VALUES (${oldReceipt}, 'x', '{}'::jsonb, 'processed', now() - interval '500 days'),
                       (${newReceipt}, 'x', '{}'::jsonb, 'processed', now() - interval '100 days')`;
      await sql`INSERT INTO identity_provider_events(event_id, provider_issuer, provider_subject, occurred_at, received_at)
                VALUES (${randomUUID()}, 'https://idp.test/', 's', now(), now() - interval '120 days'),
                       (${randomUUID()}, 'https://idp.test/', 's', now(), now() - interval '10 days')`;
      await sql`INSERT INTO audit_events(request_id, actor_type, action, target_type, target_id, occurred_at)
                VALUES ('ancient', 'system', 'old.event', 'thing', 'x', now() - interval '3000 days')`;

      const casual = vi.fn(async () => 3);
      const job = new PdpaRetentionJob({ sql: runtimeSql(), policy, purgeAnonymousCasualGames: casual });
      const attemptsBefore = (await sql`SELECT count(*)::int AS n FROM scoring_access_attempts`)[0]!.n as number;
      const report = await job.runOnce();
      expect(report.lockAcquired).toBe(true);
      if (!report.lockAcquired) return;

      const sessions = await sql<{ id: string }[]>`SELECT id FROM identity_sessions WHERE account_id = ${accountId}`;
      expect(sessions.map((s) => s.id).sort()).toEqual([recentRevoked, active].sort());
      expect(sessions.map((s) => s.id)).not.toContain(oldExpired);
      expect(sessions.map((s) => s.id)).not.toContain(oldRevoked);
      expect(report.deleted.sessions).toBeGreaterThanOrEqual(2);

      // 45-day-old closed-window attempt purged; the 5-day-old and open-window rows survive.
      expect(report.deleted.scoring_access_attempts).toBe(1);
      expect(
        ((await sql`SELECT count(*)::int AS n FROM scoring_access_attempts`)[0]!.n as number) - attemptsBefore,
      ).toBe(-1);

      expect(await sql`SELECT 1 FROM notifications WHERE id = ${oldNotification}`).toHaveLength(0);
      expect(
        await sql`SELECT 1 FROM notification_email_outbox WHERE notification_id = ${oldNotification}`,
      ).toHaveLength(0);
      expect(await sql`SELECT 1 FROM notifications WHERE id = ${newNotification}`).toHaveLength(1);
      expect(await sql`SELECT 1 FROM billing_webhook_receipts WHERE provider_event_id = ${oldReceipt}`).toHaveLength(0);
      expect(await sql`SELECT 1 FROM billing_webhook_receipts WHERE provider_event_id = ${newReceipt}`).toHaveLength(1);
      expect(report.deleted.provider_events).toBe(1);
      expect(await sql`SELECT 1 FROM audit_events WHERE request_id = 'ancient'`).toHaveLength(1);
      expect(report.deleted.anonymous_casual_games).toBe(3);
      expect(casual).toHaveBeenCalledWith(expect.any(Date));

      const second = await job.runOnce();
      expect(second).toMatchObject({ lockAcquired: true });
      if (second.lockAcquired) {
        expect(second.deleted.sessions + second.deleted.notifications + second.deleted.scoring_access_attempts).toBe(0);
        expect(second.deleted.billing_webhook_receipts).toBe(0);
      }
    });

    it("removes unclaimed casual games past the window by default and keeps claimed or recent ones", async () => {
      const ownerId = await makeAccount("casual-owner");
      const insert = (owner: string | null, ageDays: number) =>
        sql<{ id: string }[]>`
          INSERT INTO casual_games(owner_account_id, sport_id, home_name, away_name, host_token_hash, viewer_token_hash, created_at)
          VALUES (${owner}, 'badminton', 'H', 'A', ${randomUUID()}, ${randomUUID()}, now() - ${ageDays} * interval '1 day')
          RETURNING id`;
      const [oldUnclaimed] = await insert(null, 40);
      const [recentUnclaimed] = await insert(null, 5);
      const [oldClaimed] = await insert(ownerId, 40);
      const report = await new PdpaRetentionJob({ sql: runtimeSql(), policy }).runOnce();
      expect(report.lockAcquired && report.deleted.anonymous_casual_games).toBeGreaterThanOrEqual(1);
      const remaining = (await sql<{ id: string }[]>`SELECT id FROM casual_games`).map((row) => row.id);
      expect(remaining).not.toContain(oldUnclaimed!.id);
      expect(remaining).toContain(recentUnclaimed!.id);
      expect(remaining).toContain(oldClaimed!.id);
    });

    it("works through a backlog in batches", async () => {
      const accountId = await makeAccount("backlog");
      await sql`INSERT INTO notifications(account_id, type, payload, idempotency_key, created_at)
                SELECT ${accountId}, 't', '{}'::jsonb, gen_random_uuid()::text, now() - interval '400 days'
                FROM generate_series(1, 35)`;
      const report = await new PdpaRetentionJob({ sql: runtimeSql(), policy }).runOnce();
      expect(report.lockAcquired && report.deleted.notifications).toBe(35);
    });

    it("skips the run when another instance holds the advisory lock", async () => {
      const holder = postgres(databaseUrl, { max: 1, onnotice: () => undefined, connection: { search_path: schema } });
      try {
        await holder.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(${0x50445041})`;
          const report = await new PdpaRetentionJob({ sql: runtimeSql(), policy }).runOnce();
          expect(report).toEqual({ lockAcquired: false });
        });
      } finally {
        await holder.end();
      }
    });

    it("keeps scoring_access_attempts protected outside the purge path", async () => {
      await makeAttempt(45);
      await expect(sql`DELETE FROM scoring_access_attempts`).rejects.toThrow(/append-only/);
      await expect(sql`UPDATE scoring_access_attempts SET outcome = 'accepted'`).rejects.toThrow(/append-only/);
      // Even with the opt-in flag, rows inside the 7-day floor cannot be deleted.
      await makeAttempt(2);
      await expect(
        sql.begin(async (tx) => {
          await tx`SELECT set_config('matchday.pdpa_purge', 'on', true)`;
          await tx`DELETE FROM scoring_access_attempts WHERE attempted_at > now() - interval '3 days'`;
        }),
      ).rejects.toThrow(/append-only/);
    });
  });
});
