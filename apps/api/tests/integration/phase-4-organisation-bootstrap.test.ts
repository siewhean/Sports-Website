import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import type { PostgresJsSql } from "@matchday/identity";
import type { ScheduleEnqueuePort } from "@matchday/scheduler";
import postgres, { type Sql } from "postgres";
import type { Phase3Runtime } from "../../src/phase-3-runtime.js";
import { ReliableGateBPhase4Runtime } from "../../src/phase-4-reliable-runtime.js";
import type { Phase4AiOptions } from "../../src/phase-4-runtime.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase4_organisation_bootstrap_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);

const disabledAi: Phase4AiOptions = {
  mode: "disabled",
  provider: null,
  timeoutMs: 1_000,
  maximumAttempts: 1,
  cacheTtlSeconds: 60,
};

function required<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (!row) throw new Error("Expected a database row");
  return row;
}

describeInfrastructure("organiser workspace bootstrap", () => {
  let client!: Sql;
  let runtime!: ReliableGateBPhase4Runtime;

  beforeAll(async () => {
    await dropTestSchema(databaseUrl, schema);
    await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
    client = postgres(databaseUrl, {
      max: 6,
      onnotice: () => undefined,
      connection: { search_path: schema },
    });
    runtime = new ReliableGateBPhase4Runtime(
      client as unknown as PostgresJsSql,
      {} as unknown as Phase3Runtime,
      {} as unknown as ScheduleEnqueuePort,
      disabledAi,
    );
  });

  afterAll(async () => {
    await client?.end({ timeout: 2 });
    await dropTestSchema(databaseUrl, schema);
  });

  it("creates one owner workspace under concurrent first-use requests and replays safely", async () => {
    const accountId = required(
      await client<{ id: string }[]>`
        INSERT INTO accounts(primary_email,display_name,email_verified_at)
        VALUES(${`first-${randomUUID()}@example.test`},'First Organiser',now())
        RETURNING id
      `,
    ).id;

    const results = await Promise.all([
      runtime.ensureWritableOrganisation({ accountId }, "bootstrap-request-a"),
      runtime.ensureWritableOrganisation({ accountId }, "bootstrap-request-b"),
    ]);

    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(new Set(results.map((result) => result.id))).toHaveSize(1);
    expect(results.every((result) => result.role === "owner")).toBe(true);

    const replay = await runtime.ensureWritableOrganisation({ accountId }, "bootstrap-request-c");
    expect(replay).toMatchObject({ id: results[0]!.id, role: "owner", created: false });

    const counts = required(
      await client<{
        organisation_count: number;
        membership_count: number;
        audit_count: number;
        outbox_count: number;
      }[]>`
        SELECT
          (SELECT count(*)::int
             FROM organisations organisation
             JOIN organisation_memberships membership ON membership.organisation_id=organisation.id
            WHERE membership.account_id=${accountId}
              AND membership.role='owner'
              AND membership.status='active') AS organisation_count,
          (SELECT count(*)::int FROM organisation_memberships
            WHERE account_id=${accountId} AND role='owner' AND status='active') AS membership_count,
          (SELECT count(*)::int FROM audit_events
            WHERE actor_account_id=${accountId} AND action='organisation.created') AS audit_count,
          (SELECT count(*)::int FROM outbox_events
            WHERE event_type='organisation.created'
              AND payload->>'owner_account_id'=${accountId}) AS outbox_count
      `,
    );
    expect(counts).toEqual({
      organisation_count: 1,
      membership_count: 1,
      audit_count: 1,
      outbox_count: 1,
    });
  });

  it("does not let a viewer-only membership strand the create-competition journey", async () => {
    const viewerId = required(
      await client<{ id: string }[]>`
        INSERT INTO accounts(primary_email,display_name,email_verified_at)
        VALUES(${`viewer-${randomUUID()}@example.test`},'Viewer Organiser',now())
        RETURNING id
      `,
    ).id;
    const ownerId = required(
      await client<{ id: string }[]>`
        INSERT INTO accounts(primary_email,display_name,email_verified_at)
        VALUES(${`owner-${randomUUID()}@example.test`},'Existing Owner',now())
        RETURNING id
      `,
    ).id;
    const existingOrganisationId = await client.begin(async (tx) => {
      const organisationId = required(
        await tx<{ id: string }[]>`
          INSERT INTO organisations(name,slug)
          VALUES('Viewer only organisation',${`viewer-only-${randomUUID()}`})
          RETURNING id
        `,
      ).id;
      await tx`
        INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
        VALUES
          (${organisationId},${ownerId},'owner','active'),
          (${organisationId},${viewerId},'viewer','active')
      `;
      return organisationId;
    });

    const receipt = await runtime.ensureWritableOrganisation({ accountId: viewerId }, "viewer-bootstrap");

    expect(receipt).toMatchObject({ role: "owner", created: true });
    expect(receipt.id).not.toBe(existingOrganisationId);
    expect(
      required(
        await client<{ count: number }[]>`
          SELECT count(*)::int AS count FROM organisation_memberships
          WHERE account_id=${viewerId} AND role='owner' AND status='active'
        `,
      ).count,
    ).toBe(1);
  });

  it("rolls back organisation, membership and audit rows when outbox evidence cannot be appended", async () => {
    const accountId = required(
      await client<{ id: string }[]>`
        INSERT INTO accounts(primary_email,display_name,email_verified_at)
        VALUES(${`rollback-${randomUUID()}@example.test`},'Rollback Organiser',now())
        RETURNING id
      `,
    ).id;
    await client.unsafe(`
      CREATE FUNCTION gate_c_test_reject_bootstrap_outbox() RETURNS trigger AS $$
      BEGIN
        IF NEW.event_type='organisation.created' THEN
          RAISE EXCEPTION 'test bootstrap outbox rejection';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.unsafe(`
      CREATE TRIGGER gate_c_test_reject_bootstrap_outbox
      BEFORE INSERT ON outbox_events
      FOR EACH ROW EXECUTE FUNCTION gate_c_test_reject_bootstrap_outbox()
    `);
    try {
      await expect(runtime.ensureWritableOrganisation({ accountId }, "bootstrap-rollback")).rejects.toThrow(
        /test bootstrap outbox rejection/i,
      );
    } finally {
      await client.unsafe(`DROP TRIGGER gate_c_test_reject_bootstrap_outbox ON outbox_events`);
      await client.unsafe(`DROP FUNCTION gate_c_test_reject_bootstrap_outbox()`);
    }

    const counts = required(
      await client<{ organisation_count: number; membership_count: number; audit_count: number }[]>`
        SELECT
          (SELECT count(*)::int
             FROM organisations organisation
             JOIN organisation_memberships membership ON membership.organisation_id=organisation.id
            WHERE membership.account_id=${accountId}) AS organisation_count,
          (SELECT count(*)::int FROM organisation_memberships WHERE account_id=${accountId}) AS membership_count,
          (SELECT count(*)::int FROM audit_events
            WHERE actor_account_id=${accountId} AND action='organisation.created') AS audit_count
      `,
    );
    expect(counts).toEqual({ organisation_count: 0, membership_count: 0, audit_count: 0 });
  });
});
