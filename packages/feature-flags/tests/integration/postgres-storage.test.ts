import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dropTestSchema, migrateDatabase } from "@matchday/database";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FeatureFlagEvaluator,
  PostgresFeatureFlagStorage,
  featureFlags,
  type FeatureFlagQueryExecutor,
  type FeatureFlagQueryPort,
  type FeatureFlagWriteContext,
} from "../../src/index.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_flags_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../database/migrations");
const sql = postgres(databaseUrl, {
  max: 2,
  connection: { search_path: schema },
  onnotice: () => undefined,
});
let writeContext: FeatureFlagWriteContext;
let actorId: string;

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  actorId = randomUUID();
  await sql.unsafe(
    `INSERT INTO accounts (id, primary_email, display_name)
     VALUES ($1::uuid, $2, 'Flag Admin')`,
    [actorId, `flag-admin-${actorId}@example.test`],
  );
  writeContext = {
    actor: { type: "platform_admin", accountId: actorId },
    requestId: "request-set",
    reason: "Enable controlled rollout",
  };
});

afterAll(async () => {
  await sql.end();
  await dropTestSchema(databaseUrl, schema);
});

describe("PostgresFeatureFlagStorage", () => {
  it("persists scoped values and evaluator precedence", async () => {
    const storage = makeStorage();
    const evaluator = new FeatureFlagEvaluator({ registry: featureFlags, storage });
    const organizationId = randomUUID();
    const competitionId = randomUUID();
    await sql.begin(async (transaction) => {
      await transaction.unsafe(
        `INSERT INTO organisations (id, name, slug)
         VALUES ($1::uuid, 'Flag Test Org', $2)`,
        [organizationId, `flag-test-${organizationId}`],
      );
      await transaction.unsafe(
        `INSERT INTO organisation_memberships
           (organisation_id, account_id, role, status)
         VALUES ($1::uuid, $2::uuid, 'owner', 'active')`,
        [organizationId, actorId],
      );
    });

    await storage.setOverride("registration.self-service", { kind: "global" }, true);
    await storage.setOverride("registration.self-service", { kind: "organization", id: organizationId }, false);
    await storage.setOverride("registration.self-service", { kind: "competition", id: competitionId }, true);

    await expect(
      evaluator.evaluate("registration.self-service", {
        organizationId,
        competitionId,
      }),
    ).resolves.toMatchObject({ value: true, source: "competition" });
  });

  it("writes immutable before/after audit records for set and delete", async () => {
    const storage = makeStorage();
    const scope = { kind: "global" } as const;
    await storage.setOverride("maintenance.global", scope, true);
    writeContext = {
      ...writeContext,
      requestId: "request-update",
      reason: "Roll back maintenance",
    };
    await storage.setOverride("maintenance.global", scope, false);
    writeContext = {
      ...writeContext,
      requestId: "request-delete",
      reason: "Return to registry default",
    };
    await storage.deleteOverride("maintenance.global", scope);

    const events = await sql.unsafe<
      {
        action: string;
        actor_account_id: string;
        after_state: { enabled: boolean } | null;
        before_state: { enabled: boolean } | null;
        reason: string;
        request_id: string;
      }[]
    >(
      `SELECT action, actor_account_id, before_state, after_state, reason, request_id
         FROM audit_events
        WHERE target_type = 'feature_flag'
          AND target_id = 'maintenance.global:platform:platform'
        ORDER BY occurred_at, request_id`,
    );

    expect(events).toHaveLength(3);
    expect(events.map((event) => event.request_id)).toEqual(["request-set", "request-update", "request-delete"]);
    expect(events[0]).toMatchObject({
      actor_account_id: actorId,
      before_state: null,
      after_state: { enabled: true },
    });
    expect(events[1]).toMatchObject({
      before_state: { enabled: true },
      after_state: { enabled: false },
    });
    expect(events[2]).toMatchObject({
      action: "feature_flag.override_deleted",
      before_state: { enabled: false },
      after_state: null,
    });
  });

  it("serializes concurrent writers into a complete audit chain", async () => {
    const competitionId = randomUUID();
    const scope = { kind: "competition", id: competitionId } as const;
    const first = makeStorage({
      actor: { type: "platform_admin", accountId: actorId },
      requestId: "request-concurrent-a",
      reason: "Concurrent rollout A",
    });
    const second = makeStorage({
      actor: { type: "platform_admin", accountId: actorId },
      requestId: "request-concurrent-b",
      reason: "Concurrent rollout B",
    });

    await Promise.all([
      first.setOverride("public.results", scope, true),
      second.setOverride("public.results", scope, false),
    ]);

    const events = await sql.unsafe<
      {
        after_state: { enabled: boolean };
        before_state: { enabled: boolean } | null;
      }[]
    >(
      `SELECT before_state, after_state
         FROM audit_events
        WHERE target_type = 'feature_flag'
          AND target_id = $1`,
      [`public.results:competition:${competitionId}`],
    );
    expect(events).toHaveLength(2);
    expect(events.filter((event) => event.before_state === null)).toHaveLength(1);
    expect(events.filter((event) => event.before_state !== null)).toHaveLength(1);
  });

  it("rolls back the override when its audit append fails", async () => {
    const basePort = postgresQueryPort(sql);
    const failingPort: FeatureFlagQueryPort = {
      query: basePort.query,
      transaction: (operation) =>
        basePort.transaction((transaction) =>
          operation({
            query: (text, parameters) => {
              if (text.includes("INSERT INTO audit_events")) {
                throw new Error("forced audit failure");
              }
              return transaction.query(text, parameters);
            },
          }),
        ),
    };
    const storage = makeStorage(
      {
        actor: { type: "platform_admin", accountId: actorId },
        requestId: "request-rollback",
        reason: "Verify atomic rollback",
      },
      failingPort,
    );

    await expect(storage.setOverride("scoring.unknown-scorer", { kind: "global" }, true)).rejects.toThrow(
      "forced audit failure",
    );
    await expect(makeStorage().getOverride("scoring.unknown-scorer", { kind: "global" })).resolves.toBeUndefined();
  });
});

function makeStorage(context?: FeatureFlagWriteContext, queryPort: FeatureFlagQueryPort = postgresQueryPort(sql)) {
  return new PostgresFeatureFlagStorage({
    registry: featureFlags,
    queryPort,
    getWriteContext: () => context ?? writeContext,
  });
}

function postgresQueryPort(client: Sql): FeatureFlagQueryPort {
  return {
    query: (text, parameters) => client.unsafe(text, parameters as never[]),
    transaction: async <Result>(
      operation: (transaction: FeatureFlagQueryExecutor) => Promise<Result>,
    ): Promise<Result> =>
      (await client.begin((transaction) =>
        operation({
          query: (text, parameters) => transaction.unsafe(text, parameters as never[]),
        } satisfies FeatureFlagQueryExecutor),
      )) as Result,
  };
}
