import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "@matchday/config";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import type { PostgresJsSql } from "@matchday/identity";
import { ApiError, ErrorCode } from "../../src/errors.js";
import { DeterministicPhase4AiStub } from "../../src/phase-4-ai-provider.js";
import { phase3DomainAdapter } from "../../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../../src/phase-3-runtime.js";
import { Phase4Runtime } from "../../src/phase-4-runtime.js";

const config = parseConfig(process.env);
const schema = `test_official_names_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
let sql!: Sql;

beforeAll(async () => {
  await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory, schema });
  sql = postgres(config.databaseUrl, { max: 5, connection: { search_path: schema } });
}, 30_000);

afterAll(async () => {
  await sql?.end({ timeout: 2 });
  await dropTestSchema(config.databaseUrl, schema);
});

function runtime(client: PostgresJsSql) {
  const phase3 = new Phase3Runtime(client, phase3DomainAdapter);
  return new Phase4Runtime(
    client,
    phase3,
    { enqueueSchedule: async () => ({ id: "unused", name: "schedule.optimize", duplicate: false }) },
    {
      mode: "stub",
      provider: new DeterministicPhase4AiStub(),
      timeoutMs: 2000,
      maximumAttempts: 1,
      cacheTtlSeconds: 3600,
    },
  );
}

async function fixture() {
  const accountId = randomUUID();
  const organisationId = randomUUID();
  const competitionId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO accounts (id, primary_email, display_name)
      VALUES (${accountId}, ${`${accountId}@example.com`}, 'Name Race Owner')`;
    await tx`INSERT INTO organisations (id, name, slug)
      VALUES (${organisationId}, 'Name Race Org', ${`org-${organisationId}`})`;
    await tx`INSERT INTO organisation_memberships (organisation_id, account_id, role, status)
      VALUES (${organisationId}, ${accountId}, 'owner', 'active')`;
    await tx`INSERT INTO competitions (id, organisation_id, created_by, name, slug, sport_code, timezone, starts_on, ends_on)
      VALUES (${competitionId}, ${organisationId}, ${accountId}, 'Name Race Cup', ${`comp-${competitionId}`},
        'canoe_polo', 'UTC', '2027-08-01', '2027-08-02')`;
  });
  return { actor: { accountId }, competitionId };
}

// Hold both real transactions after their duplicate preflight SELECTs. Neither can
// write until both saw no duplicate, so only the PostgreSQL unique index can decide.
function competingRuntime() {
  const client = sql as unknown as PostgresJsSql;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrivals = 0;
  const backendPids = new Set<number>();
  const constrainedClient: PostgresJsSql = {
    unsafe: (query, parameters) => client.unsafe(query, parameters),
    begin: async (operation) =>
      client.begin!(async (tx) => {
        const constrainedTx: PostgresJsSql = {
          unsafe: async <T>(query: string, parameters?: readonly unknown[]) => {
            const rows = await tx.unsafe<T>(query, parameters);
            if (query.includes("lower(trim(name)) = lower($2)")) {
              expect(rows).toHaveLength(0);
              const [backend] = await tx.unsafe<{ pid: number }>("SELECT pg_backend_pid() AS pid");
              backendPids.add(backend!.pid);
              arrivals += 1;
              if (arrivals === 2) release();
              await ready;
            }
            return rows;
          },
        };
        return operation(constrainedTx);
      }),
  };
  return { phase4: runtime(constrainedClient), backendPids };
}

async function assertRace(operations: readonly Promise<unknown>[], backendPids: Set<number>, competitionId: string) {
  const results = await Promise.allSettled(operations);
  expect(backendPids.size).toBe(2);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const loser = results.find((result) => result.status === "rejected");
  expect(loser?.status).toBe("rejected");
  if (loser?.status === "rejected") {
    expect(loser.reason).toBeInstanceOf(ApiError);
    expect(loser.reason).toMatchObject({ statusCode: 409, code: ErrorCode.OFFICIAL_NAME_CONFLICT });
  }
  const [count] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM competition_officials
    WHERE competition_id = ${competitionId} AND lower(trim(name)) = 'alex referee' AND archived_at IS NULL`;
  expect(count?.count).toBe(1);
}

describe("active official name uniqueness (PostgreSQL)", () => {
  it("migrates a partial unique normalized-name index", async () => {
    const [index] = await sql<{ indisunique: boolean; expression: string; predicate: string }[]>`
      SELECT i.indisunique, pg_get_expr(i.indexprs, i.indrelid) AS expression,
        pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema} AND c.relname = 'competition_officials_active_name_uidx'`;
    expect(index?.indisunique).toBe(true);
    expect(index?.expression).toBe("lower(TRIM(BOTH FROM name))");
    expect(index?.predicate).toBe("(archived_at IS NULL)");
  });

  it("maps the database loser of concurrent normalized create/create to 409", async () => {
    const { actor, competitionId } = await fixture();
    const { phase4, backendPids } = competingRuntime();
    await assertRace(
      [
        phase4.createOfficial(actor, competitionId, { name: "Alex Referee" }, randomUUID()),
        phase4.createOfficial(actor, competitionId, { name: "  alex referee  " }, randomUUID()),
      ],
      backendPids,
      competitionId,
    );
  });

  it("maps the database loser of concurrent restore/create to 409", async () => {
    const { actor, competitionId } = await fixture();
    const setup = runtime(sql as unknown as PostgresJsSql);
    const archived = await setup.createOfficial(actor, competitionId, { name: "Alex Referee" }, randomUUID());
    await setup.archiveOfficial(actor, competitionId, archived.id, randomUUID());
    const { phase4, backendPids } = competingRuntime();
    await assertRace(
      [
        phase4.restoreOfficial(actor, competitionId, archived.id, randomUUID()),
        phase4.createOfficial(actor, competitionId, { name: "  alex referee  " }, randomUUID()),
      ],
      backendPids,
      competitionId,
    );
  });

  it("rejects a normal update collision and concurrent updates atomically", async () => {
    const { actor, competitionId } = await fixture();
    const setup = runtime(sql as unknown as PostgresJsSql);
    const first = await setup.createOfficial(actor, competitionId, { name: "First Referee" }, randomUUID());
    const second = await setup.createOfficial(actor, competitionId, { name: "Second Referee" }, randomUUID());
    await expect(
      setup.updateOfficial(actor, competitionId, second.id, { name: "  FIRST referee  " }, randomUUID()),
    ).rejects.toMatchObject({ statusCode: 409, code: ErrorCode.OFFICIAL_NAME_CONFLICT });
    const { phase4, backendPids } = competingRuntime();
    await assertRace(
      [
        phase4.updateOfficial(actor, competitionId, first.id, { name: "Alex Referee" }, randomUUID()),
        phase4.updateOfficial(actor, competitionId, second.id, { name: "  alex referee  " }, randomUUID()),
      ],
      backendPids,
      competitionId,
    );
  });
});
