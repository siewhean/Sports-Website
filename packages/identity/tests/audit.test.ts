import { describe, expect, it } from "vitest";
import { AuditViewer, AuditWriter, PostgresAuditRepository, type PostgresQueryPort } from "../src/audit.js";
import { AuthorizationError, UnsafeAuditPayloadError } from "../src/errors.js";
import { InMemoryAuditRepository } from "../src/testing.js";
import type { Principal } from "../src/rbac.js";

const organiser: Principal = {
  accountId: "account-1",
  platformRoles: [],
  memberships: [{ organisationId: "organisation-1", role: "organiser", status: "active" }],
  officialGrants: [],
};

const eventInput = {
  requestId: "request-1",
  actorAccountId: "account-1",
  actorType: "account" as const,
  organisationId: "organisation-1",
  action: "competition.published",
  targetType: "competition",
  targetId: "competition-1",
  reason: null,
  beforeState: { published: false },
  afterState: { published: true },
  metadata: { source: "organiser_console" },
};

describe("audit foundation", () => {
  it("stamps and appends immutable event values", async () => {
    const repository = new InMemoryAuditRepository();
    const writer = new AuditWriter(
      repository,
      () => new Date("2026-01-01T00:00:00.000Z"),
      () => "audit-1",
    );
    const event = await writer.write(eventInput);
    expect(event).toMatchObject({ id: "audit-1", occurredAt: new Date("2026-01-01T00:00:00.000Z") });
    expect(repository.events).toEqual([event]);
  });

  it.each(["password", "access_token", "sessionToken", "Authorization", "cookie", "secretHash", "api_key"])(
    "rejects sensitive audit payload key %s",
    async (key) => {
      const writer = new AuditWriter(new InMemoryAuditRepository());
      await expect(writer.write({ ...eventInput, metadata: { [key]: "must-not-persist" } })).rejects.toBeInstanceOf(
        UnsafeAuditPayloadError,
      );
    },
  );

  it("requires account attribution for account actors", async () => {
    const writer = new AuditWriter(new InMemoryAuditRepository());
    await expect(writer.write({ ...eventInput, actorAccountId: null })).rejects.toThrow(
      "Account actors require an actorAccountId",
    );
  });

  it("authorizes organisation audit viewing and caps page size", async () => {
    const repository = new InMemoryAuditRepository();
    const writer = new AuditWriter(
      repository,
      () => new Date("2026-01-01T00:00:00.000Z"),
      () => "audit-1",
    );
    await writer.write(eventInput);
    const viewer = new AuditViewer(repository);
    await expect(viewer.list(organiser, { organisationId: "organisation-1" })).resolves.toHaveLength(1);
    await expect(viewer.list(organiser, { organisationId: "organisation-2" })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(viewer.list(organiser, { organisationId: "organisation-1", limit: 101 })).rejects.toThrow(
      "between 1 and 100",
    );
  });

  it("uses parameterized PostgreSQL inserts and keyset queries", async () => {
    const calls: { text: string; values: readonly unknown[] }[] = [];
    const database: PostgresQueryPort = {
      async query<T>(text: string, values: readonly unknown[]) {
        calls.push({ text, values });
        return { rows: [] as T[] };
      },
    };
    const repository = new PostgresAuditRepository(database);
    const writer = new AuditWriter(
      repository,
      () => new Date("2026-01-01T00:00:00.000Z"),
      () => "audit-1",
    );
    await writer.write(eventInput);
    await repository.list({
      organisationId: "organisation-1",
      targetType: "competition' OR true --",
      before: { occurredAt: new Date("2026-01-01T00:00:00.000Z"), id: "audit-1" },
      limit: 25,
    });

    expect(calls[0]?.text).toContain("INSERT INTO audit_events");
    expect(calls[0]?.text).not.toContain("competition.published");
    expect(calls[1]?.text).toContain("(occurred_at, id) <");
    expect(calls[1]?.text).not.toContain("OR true");
    expect(calls[1]?.values).toContain("competition' OR true --");
  });
});
