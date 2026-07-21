import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAuditRepository, AuditWriter } from "../../src/audit.js";
import { OrganisationService } from "../../src/membership.js";
import {
  PostgresAccountRepository,
  PostgresJsQueryAdapter,
  PostgresOrganisationRepository,
  PostgresOrganisationUnitOfWork,
  PostgresPrincipalRepository,
  PostgresRecoveryRequestRepository,
  PostgresSessionRepository,
  type PostgresJsSql,
} from "../../src/postgres.js";
import { authorize } from "../../src/rbac.js";
import { SessionService } from "../../src/session.js";
import { hashSessionSecret } from "../../src/session.js";
import { dropTestSchema, migrateDatabase } from "../../../database/src/migrations.js";

type TestSql = PostgresJsSql & {
  begin<T>(callback: (transaction: PostgresJsSql) => Promise<T>): PromiseLike<T>;
  end(options?: { timeout?: number }): Promise<void>;
};
type PostgresFactory = (url: string, options: Record<string, unknown>) => TestSql;

const requireFromDatabase = createRequire(new URL("../../../database/package.json", import.meta.url));
const postgres = requireFromDatabase("postgres") as PostgresFactory;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_identity_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../database/migrations");

let sql: TestSql;
let accounts: PostgresAccountRepository;
let sessions: PostgresSessionRepository;
let organisations: PostgresOrganisationRepository;

async function createAccount(sequence: string) {
  return accounts.createWithProvider({
    primaryEmail: `${sequence}@example.test`,
    displayName: `Account ${sequence}`,
    issuer: "https://identity.example.test",
    subject: `subject-${sequence}`,
    emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  sql = postgres(databaseUrl, {
    max: 10,
    onnotice: () => undefined,
    connection: { search_path: schema },
  });
  accounts = new PostgresAccountRepository(sql);
  sessions = new PostgresSessionRepository(sql, 2);
  organisations = new PostgresOrganisationRepository(sql);
});

afterAll(async () => {
  if (sql) await sql.end();
  await dropTestSchema(databaseUrl, schema);
});

describe("identity PostgreSQL persistence", () => {
  it("isolates provider subjects and organisation memberships", async () => {
    const firstKey = `isolation-a-${randomUUID()}`;
    const secondKey = `isolation-b-${randomUUID()}`;
    const first = await createAccount(firstKey);
    const second = await createAccount(secondKey);
    const firstOrganisation = await organisations.createWithOwner({
      name: "First Organisation",
      slug: `first-${randomUUID()}`,
      ownerAccountId: first.id,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const secondOrganisation = await organisations.createWithOwner({
      name: "Second Organisation",
      slug: `second-${randomUUID()}`,
      ownerAccountId: second.id,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    await expect(
      accounts.findByProvider("https://identity.example.test", `subject-${firstKey}`),
    ).resolves.toMatchObject({
      id: first.id,
    });
    await expect(
      accounts.findByProvider("https://identity.example.test", `subject-${secondKey}`),
    ).resolves.toMatchObject({ id: second.id });
    await expect(
      accounts.findByProvider("https://identity.example.test", `subject-isolation-a-missing`),
    ).resolves.toBeNull();
    await expect(organisations.findMembership(firstOrganisation.organisation.id, second.id)).resolves.toBeNull();
    await expect(organisations.findMembership(secondOrganisation.organisation.id, first.id)).resolves.toBeNull();
  });

  it("expires sessions, atomically rejects renewal after revocation, and limits concurrent sessions", async () => {
    const account = await createAccount(`sessions-${randomUUID()}`);
    let now = new Date("2026-01-01T01:00:00.000Z");
    const service = new SessionService(sessions, accounts, { now: () => now });
    const expired = await service.issue(account);
    now = new Date("2026-01-01T01:31:00.000Z");
    await expect(service.authenticate(expired.sessionToken)).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
    });
    expect((await sessions.findById(expired.sessionId))?.revokedAt).toBeInstanceOf(Date);

    now = new Date("2026-01-02T00:00:00.000Z");
    const revoked = await service.issue(account);
    await sessions.revoke(revoked.sessionId, now);
    await expect(service.authenticate(revoked.sessionToken)).rejects.toMatchObject({ code: "SESSION_REVOKED" });
    await Promise.all([service.issue(account), service.issue(account), service.issue(account)]);
    const active = await sql.unsafe<{ count: string }>(
      `SELECT count(*)::text AS count FROM identity_sessions
       WHERE account_id = $1 AND revoked_at IS NULL AND idle_expires_at > $2 AND absolute_expires_at > $2`,
      [account.id, now],
    );
    expect(active[0]?.count).toBe("2");

    const monotonic = await service.issue(account);
    now = new Date("2026-01-02T00:10:00.000Z");
    await service.authenticate(monotonic.sessionToken);
    await sessions.touch({
      sessionId: monotonic.sessionId,
      lastSeenAt: new Date("2026-01-02T00:05:00.000Z"),
      idleExpiresAt: new Date("2026-01-02T00:35:00.000Z"),
    });
    const monotonicRecord = await sessions.findById(monotonic.sessionId);
    expect(monotonicRecord?.lastSeenAt.toISOString()).toBe("2026-01-02T00:10:00.000Z");
    expect(monotonicRecord?.idleExpiresAt.toISOString()).toBe("2026-01-02T00:40:00.000Z");
  });

  it("prevents deleting, updating, or demoting the final active owner", async () => {
    const owner = await createAccount(`owner-${randomUUID()}`);
    const otherOwner = await createAccount(`other-owner-${randomUUID()}`);
    const created = await organisations.createWithOwner({
      name: "Owner Invariant",
      slug: `owner-invariant-${randomUUID()}`,
      ownerAccountId: owner.id,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await expect(
      sql.unsafe(`UPDATE organisation_memberships SET role = 'viewer' WHERE id = $1`, [created.membership.id]),
    ).rejects.toThrow("retain an active owner");
    await expect(
      sql.unsafe(`DELETE FROM organisation_memberships WHERE id = $1`, [created.membership.id]),
    ).rejects.toThrow("retain an active owner");
    const otherOrganisation = await organisations.createWithOwner({
      name: "Other Owner Invariant",
      slug: `other-owner-invariant-${randomUUID()}`,
      ownerAccountId: otherOwner.id,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await expect(
      sql.unsafe(`UPDATE organisation_memberships SET organisation_id = $2 WHERE id = $1`, [
        created.membership.id,
        otherOrganisation.organisation.id,
      ]),
    ).rejects.toThrow("membership organisation and account are immutable");
    const retainedOwner = await sql.unsafe<{ count: string }>(
      `SELECT count(*)::text AS count FROM organisation_memberships
       WHERE organisation_id = $1 AND role = 'owner' AND status = 'active'`,
      [created.organisation.id],
    );
    expect(retainedOwner[0]?.count).toBe("1");
    await expect(
      sql.begin(async (transaction) => {
        await transaction.unsafe(`INSERT INTO organisations (name, slug) VALUES ('No Owner', $1)`, [
          `no-owner-${randomUUID()}`,
        ]);
      }),
    ).rejects.toThrow("must have an active owner");
  });

  it("serializes concurrent owner demotions and retains one active owner", async () => {
    const first = await createAccount(`concurrent-owner-a-${randomUUID()}`);
    const second = await createAccount(`concurrent-owner-b-${randomUUID()}`);
    const created = await organisations.createWithOwner({
      name: "Concurrent Owner Invariant",
      slug: `concurrent-owner-${randomUUID()}`,
      ownerAccountId: first.id,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const secondMembership = await organisations.upsertMembership({
      organisationId: created.organisation.id,
      accountId: second.id,
      role: "owner",
      status: "active",
      updatedAt: new Date("2026-01-01T00:01:00.000Z"),
    });
    const firstClient = postgres(databaseUrl, {
      max: 1,
      connection: { search_path: schema, application_name: "identity_owner_first" },
    });
    const secondClient = postgres(databaseUrl, {
      max: 1,
      connection: { search_path: schema, application_name: "identity_owner_second" },
    });
    let markFirstLocked!: () => void;
    let releaseFirst!: () => void;
    const firstLocked = new Promise<void>((resolve) => (markFirstLocked = resolve));
    const firstMayContinue = new Promise<void>((resolve) => (releaseFirst = resolve));
    const firstUpdate = firstClient.begin(async (transaction) => {
      await transaction.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 684721))`, [created.organisation.id]);
      markFirstLocked();
      await firstMayContinue;
      await transaction.unsafe(`UPDATE organisation_memberships SET role = 'viewer' WHERE id = $1`, [
        created.membership.id,
      ]);
    });
    await firstLocked;
    const secondUpdate = secondClient.begin(async (transaction) => {
      await transaction.unsafe(`UPDATE organisation_memberships SET role = 'viewer' WHERE id = $1`, [
        secondMembership.id,
      ]);
    });
    let secondWasWaiting = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const rows = await sql.unsafe<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
           WHERE application_name = 'identity_owner_second'
             AND wait_event_type = 'Lock'
             AND wait_event = 'advisory'
         ) AS waiting`,
      );
      if (rows[0]?.waiting) {
        secondWasWaiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    releaseFirst();
    const results = await Promise.allSettled([firstUpdate, secondUpdate]);
    await Promise.all([firstClient.end(), secondClient.end()]);
    expect(secondWasWaiting).toBe(true);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const owners = await sql.unsafe<{ count: string }>(
      `SELECT count(*)::text AS count FROM organisation_memberships
       WHERE organisation_id = $1 AND role = 'owner' AND status = 'active'`,
      [created.organisation.id],
    );
    expect(owners[0]?.count).toBe("1");
  });

  it("commits organisation mutation and audit atomically", async () => {
    const owner = await createAccount(`atomic-owner-${randomUUID()}`);
    const service = new OrganisationService(
      new PostgresOrganisationUnitOfWork(sql),
      () => new Date("2026-01-01T00:00:00.000Z"),
    );
    const created = await service.create({
      requestId: "request-atomic-success",
      name: "Atomic Organisation",
      slug: `atomic-${randomUUID()}`,
      ownerAccountId: owner.id,
    });
    const auditRows = await sql.unsafe<{ request_id: string }>(
      `SELECT request_id FROM audit_events
       WHERE organisation_id = $1 AND action = 'organisation.created'`,
      [created.organisation.id],
    );
    expect(auditRows).toEqual([{ request_id: "request-atomic-success" }]);

    const rollbackSlug = `atomic-rollback-${randomUUID()}`;
    await expect(
      service.create({
        requestId: "invalid\u0000request",
        name: "Must Roll Back",
        slug: rollbackSlug,
        ownerAccountId: owner.id,
      }),
    ).rejects.toThrow("requestId is invalid");
    const rolledBack = await sql.unsafe<{ count: string }>(
      `SELECT count(*)::text AS count FROM organisations WHERE slug = $1`,
      [rollbackSlug],
    );
    expect(rolledBack[0]?.count).toBe("0");
  });

  it("loads only account-scoped, unexpired RBAC grants and platform roles", async () => {
    const official = await createAccount(`official-${randomUUID()}`);
    const other = await createAccount(`other-${randomUUID()}`);
    const owner = await createAccount(`grant-owner-${randomUUID()}`);
    const created = await organisations.createWithOwner({
      name: "Grant Organisation",
      slug: `grant-${randomUUID()}`,
      ownerAccountId: owner.id,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const now = new Date("2026-01-02T00:00:00.000Z");
    await sql.unsafe(
      `INSERT INTO official_grants (
        account_id, organisation_id, resource_type, resource_id, granted_at, expires_at, granted_by
      ) VALUES
        ($1, $3, 'match', 'match-live', $4, $5, $6),
        ($1, $3, 'match', 'match-expired', $4, $7, $6),
        ($2, $3, 'match', 'match-other', $4, $5, $6)`,
      [
        official.id,
        other.id,
        created.organisation.id,
        new Date("2026-01-01T00:00:00.000Z"),
        new Date("2026-01-03T00:00:00.000Z"),
        owner.id,
        new Date("2026-01-01T12:00:00.000Z"),
      ],
    );
    await sql.unsafe(
      `INSERT INTO account_platform_roles (account_id, role, granted_at, expires_at, granted_by, reason)
       VALUES
         ($1, 'platform_admin', $3, $4, $2, 'active support role'),
         ($2, 'platform_admin', $3, $5, $2, 'expired support role')`,
      [
        official.id,
        owner.id,
        new Date("2026-01-01T00:00:00.000Z"),
        new Date("2026-01-03T00:00:00.000Z"),
        new Date("2026-01-01T12:00:00.000Z"),
      ],
    );
    await sql.unsafe(
      `INSERT INTO official_grants (
        account_id, organisation_id, resource_type, resource_id, granted_at, expires_at, revoked_at, granted_by
      ) VALUES ($1, $2, 'match', 'match-revoked', $3, $4, $5, $6)`,
      [
        official.id,
        created.organisation.id,
        new Date("2026-01-01T00:00:00.000Z"),
        new Date("2026-01-03T00:00:00.000Z"),
        new Date("2026-01-01T12:00:00.000Z"),
        owner.id,
      ],
    );

    const principal = await new PostgresPrincipalRepository(sql).load(official.id, now);
    expect(principal?.officialGrants).toEqual([
      {
        kind: "match",
        resourceId: "match-live",
        organisationId: created.organisation.id,
        status: "active",
      },
    ]);
    expect(principal?.platformRoles).toEqual(["platform_admin"]);
    expect(
      authorize(principal!, "match.score", {
        kind: "match",
        id: "match-live",
        organisationId: created.organisation.id,
        competitionId: "competition-1",
        isPublished: false,
      }).allowed,
    ).toBe(true);
    expect((await new PostgresPrincipalRepository(sql).load(other.id, now))?.platformRoles).toEqual([]);
  });

  it("persists recovery hashes and consumes a live request only once", async () => {
    const recovery = new PostgresRecoveryRequestRepository(sql);
    const id = randomUUID();
    await recovery.create({
      id,
      identifierHash: hashSessionSecret("server-peppered-identifier"),
      providerIssuer: "https://identity.example.test",
      requestedAt: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt: new Date("2026-01-01T00:15:00.000Z"),
      consumedAt: null,
      revokedAt: null,
    });
    await expect(recovery.consume(id, new Date("2026-01-01T00:05:00.000Z"))).resolves.toBe(true);
    await expect(recovery.consume(id, new Date("2026-01-01T00:06:00.000Z"))).resolves.toBe(false);
    const expiredId = randomUUID();
    await recovery.create({
      id: expiredId,
      identifierHash: hashSessionSecret("another-server-peppered-identifier"),
      providerIssuer: "https://identity.example.test",
      requestedAt: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt: new Date("2026-01-01T00:02:00.000Z"),
      consumedAt: null,
      revokedAt: null,
    });
    await expect(recovery.consume(expiredId, new Date("2026-01-01T00:03:00.000Z"))).resolves.toBe(false);
  });

  it("persists audit events and database triggers reject update and delete", async () => {
    const actor = await createAccount(`audit-${randomUUID()}`);
    const repository = new PostgresAuditRepository(new PostgresJsQueryAdapter(sql));
    const writer = new AuditWriter(repository, () => new Date("2026-01-01T00:00:00.000Z"), randomUUID);
    const event = await writer.write({
      requestId: "request-integration-1",
      actorAccountId: actor.id,
      actorType: "account",
      organisationId: null,
      action: "account.profile.updated",
      targetType: "account",
      targetId: actor.id,
      reason: null,
      beforeState: { displayName: "Before" },
      afterState: { displayName: "After" },
      metadata: {},
    });
    await expect(sql.unsafe(`UPDATE audit_events SET action = 'tampered' WHERE id = $1`, [event.id])).rejects.toThrow(
      "append-only",
    );
    await expect(sql.unsafe(`DELETE FROM audit_events WHERE id = $1`, [event.id])).rejects.toThrow("append-only");
    await expect(repository.list({ organisationId: null, targetId: actor.id, limit: 10 })).resolves.toHaveLength(1);
  });
});
