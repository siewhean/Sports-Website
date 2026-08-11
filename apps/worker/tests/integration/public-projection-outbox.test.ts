import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dropTestSchema, migrateDatabase } from "@matchday/database";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createPublicProjectionOutboxDispatcher } from "../../src/public-projection-outbox.js";
import { WorkerRuntime } from "../../src/index.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_worker_public_projection_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
const competitionId = "10000000-0000-4000-a000-000000000001";
let sql: Sql;

function event(idempotencyKey: string) {
  return {
    competition_id: competitionId,
    projection: "schedule",
    previous_published_version: 2,
    published_version: 3,
    publication_state: "published",
    correlation_id: `edge-purge:${competitionId}:schedule:2:${idempotencyKey}`,
  };
}

async function insertPending(idempotencyKey: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
    VALUES ('competition',${competitionId},'public_projection.published',${sql.json(event(idempotencyKey))},${idempotencyKey})
    RETURNING id
  `;
  return rows[0]!.id;
}

describeInfrastructure("public projection outbox dispatcher", () => {
  beforeAll(async () => {
    await dropTestSchema(databaseUrl, schema);
    await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
    sql = postgres(databaseUrl, { max: 4, onnotice: () => undefined, connection: { search_path: schema } });
  });

  beforeEach(async () => {
    await sql`TRUNCATE outbox_events`;
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await dropTestSchema(databaseUrl, schema);
  });

  it("cannot observe a public-projection record before the publication transaction commits", async () => {
    const enqueuer = { enqueueEdgePurge: vi.fn(async () => undefined) };
    const dispatcher = createPublicProjectionOutboxDispatcher({ databaseUrl, enqueuer, sql });
    const tx = await sql.reserve();
    try {
      await tx`BEGIN`;
      await tx`
        INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
        VALUES ('competition',${competitionId},'public_projection.published',${tx.json(event("uncommitted"))},'uncommitted')
      `;

      expect(await dispatcher.drainOnce()).toBe(0);
      expect(enqueuer.enqueueEdgePurge).not.toHaveBeenCalled();
      await tx`COMMIT`;
    } finally {
      await tx.release();
    }

    expect(await dispatcher.drainOnce()).toBe(1);
    expect(enqueuer.enqueueEdgePurge).toHaveBeenCalledOnce();
  });

  it("commits one durable claim across concurrent dispatchers and releases it after enqueue failure", async () => {
    const id = await insertPending("concurrent-claim");
    let enteredFirst: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = createPublicProjectionOutboxDispatcher({
      databaseUrl,
      sql: postgres(databaseUrl, { max: 1, connection: { search_path: schema } }),
      enqueuer: {
        enqueueEdgePurge: async () => {
          enteredFirst?.();
          await blocked;
        },
      },
    });
    const secondEnqueue = vi.fn(async () => undefined);
    const second = createPublicProjectionOutboxDispatcher({
      databaseUrl,
      sql: postgres(databaseUrl, { max: 1, connection: { search_path: schema } }),
      enqueuer: { enqueueEdgePurge: secondEnqueue },
    });

    // The first claim is committed before its deliberately stalled enqueue;
    // a second worker must see no eligible row rather than duplicate it.
    const firstDrain = first.drainOnce();
    await firstEntered;
    expect(await second.drainOnce()).toBe(0);
    // Release the controlled enqueue and verify acknowledgement is durable.
    releaseFirst!();
    await firstDrain;
    expect(secondEnqueue).not.toHaveBeenCalled();
    expect(
      await sql<{ published_at: Date | null; attempts: number }[]>`
      SELECT published_at,attempts FROM outbox_events WHERE id=${id}
    `,
    ).toEqual([expect.objectContaining({ published_at: expect.any(Date), attempts: 1 })]);
    await Promise.all([first.close(), second.close()]);

    const failedId = await insertPending("enqueue-failure");
    const failing = createPublicProjectionOutboxDispatcher({
      databaseUrl,
      sql,
      enqueuer: { enqueueEdgePurge: async () => Promise.reject(new Error("edge unavailable")) },
    });
    await expect(failing.drainOnce()).rejects.toThrow("edge unavailable");
    expect(
      await sql<{ dispatch_claim_id: string | null; published_at: Date | null }[]>`
      SELECT dispatch_claim_id,published_at FROM outbox_events WHERE id=${failedId}
    `,
    ).toEqual([{ dispatch_claim_id: null, published_at: null }]);
  });

  it("reclaims an expired durable lease without accepting a stale acknowledgement", async () => {
    const id = await insertPending("expired-lease");
    await sql`
      UPDATE outbox_events
      SET dispatch_claim_id=${randomUUID()},dispatch_claimed_at=now()-interval '2 minutes',
          dispatch_claim_expires_at=now()-interval '1 minute'
      WHERE id=${id}
    `;
    const enqueuer = { enqueueEdgePurge: vi.fn(async () => undefined) };
    const dispatcher = createPublicProjectionOutboxDispatcher({ databaseUrl, enqueuer, sql });
    expect(await dispatcher.drainOnce()).toBe(1);
    expect(enqueuer.enqueueEdgePurge).toHaveBeenCalledOnce();
    expect(
      await sql<{ published_at: Date | null; dispatch_claim_id: string | null; attempts: number }[]>`
      SELECT published_at,dispatch_claim_id,attempts FROM outbox_events WHERE id=${id}
    `,
    ).toEqual([expect.objectContaining({ published_at: expect.any(Date), dispatch_claim_id: null, attempts: 1 })]);
  });

  it("uses one durable claim to enqueue exactly one real Redis purge across two dispatchers", async () => {
    await insertPending("real-redis-claim");
    const handled = vi.fn(async () => ({ purgedAt: new Date().toISOString() }));
    const runtime = new WorkerRuntime({
      queueName: `matchday-c5-outbox-${randomUUID()}`,
      queuePrefix: `matchday-c5-outbox-${randomUUID()}`,
      redisUrl: process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379/14",
      concurrency: 1,
      handleEdgePurge: handled,
    });
    const first = createPublicProjectionOutboxDispatcher({
      databaseUrl,
      sql: postgres(databaseUrl, { max: 1, connection: { search_path: schema } }),
      enqueuer: runtime,
    });
    const second = createPublicProjectionOutboxDispatcher({
      databaseUrl,
      sql: postgres(databaseUrl, { max: 1, connection: { search_path: schema } }),
      enqueuer: runtime,
    });
    try {
      await runtime.start();
      expect((await Promise.all([first.drainOnce(), second.drainOnce()])).sort()).toEqual([0, 1]);
      await waitUntil(() => handled.mock.calls.length === 1);
      expect(handled).toHaveBeenCalledOnce();
    } finally {
      await Promise.all([first.close(), second.close(), runtime.stop()]);
    }
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for Redis edge purge");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
