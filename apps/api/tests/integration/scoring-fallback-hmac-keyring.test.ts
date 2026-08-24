import { createHash, createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import type { PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import {
  promoteScoringFallbackHmacKeyVersion,
  reconcileScoringFallbackHmacKeyring,
  retireScoringFallbackHmacKeyVersion,
} from "../../src/scoring-fallback-hmac-keyring.js";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";
import { FallbackKeyringPhase2Runtime } from "../../src/phase-2-fallback-keyring-runtime.js";
import type { IdentityApiRuntime } from "../../src/identity-runtime.js";
import { healthyProbes, testConfig } from "../helpers.js";

const describeInfra = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_scoring_fallback_hmac_keyring_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
let sql: Sql;

function canonicalHash(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(item);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}

async function seedResolvedMatch(admin: string) {
  const organisationId = randomUUID();
  const competitionId = randomUUID();
  const divisionId = randomUUID();
  const revisionId = randomUUID();
  const matchId = randomUUID();
  const homeEntryId = randomUUID();
  const awayEntryId = randomUUID();
  const graph = {
    id: revisionId,
    schemaVersion: 1,
    entryCount: 2,
    stages: [
      {
        id: "final-stage",
        label: "Final",
        kind: "single_elimination",
        order: 1,
        groupIds: [],
        groupSize: null,
        outputRanks: 2,
        matchIds: [matchId],
      },
    ],
    matches: [
      {
        id: matchId,
        stageId: "final-stage",
        round: 1,
        order: 1,
        purpose: "championship",
        home: { type: "entry_seed", seed: 1 },
        away: { type: "entry_seed", seed: 2 },
      },
    ],
    terminalMatchIds: [matchId],
  };
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organisations(id,name,slug) VALUES(${organisationId},'Fallback transaction organisation',${`fallback-transaction-${randomUUID()}`})`;
    await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status) VALUES(${organisationId},${admin},'owner','active')`;
  });
  await sql`INSERT INTO competitions(id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on)
    VALUES(${competitionId},${organisationId},${admin},'Fallback transaction competition',${`fallback-transaction-${randomUUID()}`},'canoe_polo','UTC','2030-01-01','2030-01-01')`;
  await sql`INSERT INTO divisions(id,competition_id,name,team_limit) VALUES(${divisionId},${competitionId},'Open',8)`;
  await sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,status,created_by,validation_contract)
    VALUES(${revisionId},${competitionId},${divisionId},1,${sql.json(graph)},${canonicalHash(graph)},'draft',${admin},'phase3')`;
  await sql`INSERT INTO division_entries(id,division_id,name,seed)
    VALUES(${homeEntryId},${divisionId},'Home',1),(${awayEntryId},${divisionId},'Away',2)`;
  await sql`INSERT INTO matches(id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal,home_entry_id,away_entry_id)
    VALUES(${matchId},${competitionId},${divisionId},${revisionId},'M1','group',1,1,${homeEntryId},${awayEntryId})`;
  return { competitionId, matchId };
}

async function waitForAdvisoryLock(lockId: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = (await sql.unsafe<{ acquired: boolean }[]>("SELECT pg_try_advisory_lock($1) AS acquired", [lockId]))[0];
    if (!row?.acquired) return;
    await sql.unsafe("SELECT pg_advisory_unlock($1)", [lockId]);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for test transaction to acquire its advisory lock");
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 8_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${timeoutMs}ms; possible PostgreSQL deadlock`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describeInfra("fallback-code HMAC durable lifecycle", () => {
  beforeAll(async () => {
    await dropTestSchema(databaseUrl, schema);
    await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
    sql = postgres(databaseUrl, { max: 2, onnotice: () => undefined, connection: { search_path: schema } });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    await dropTestSchema(databaseUrl, schema);
  });

  it("requires explicit promotion, retains overlap, blocks reactivation, and writes sanitized durable audits", async () => {
    const now = new Date();
    const admin = randomUUID();
    const legacy = "fallback-hmac-legacy-a-material-32-bytes-minimum";
    const replacement = "fallback-hmac-replacement-b-material-32-bytes";
    await sql`INSERT INTO accounts(id,primary_email,display_name) VALUES(${admin},${`${admin}@example.test`},'Fallback key admin')`;
    await sql`INSERT INTO account_platform_roles(account_id,role,granted_at,reason) VALUES(${admin},'platform_admin',${now},'test')`;
    const initial = { primary: { version: "v1", secret: legacy }, verificationOnly: [] };
    await expect(
      reconcileScoringFallbackHmacKeyring(sql as unknown as PostgresJsSql, initial, now),
    ).resolves.toMatchObject({ primaryVersion: "v1" });
    const introduce = {
      primary: { version: "v1", secret: legacy },
      verificationOnly: [{ version: "v2", secret: replacement }],
    };
    await reconcileScoringFallbackHmacKeyring(sql as unknown as PostgresJsSql, introduce, now);
    await expect(
      reconcileScoringFallbackHmacKeyring(
        sql as unknown as PostgresJsSql,
        { primary: { version: "v2", secret: replacement }, verificationOnly: [{ version: "v1", secret: legacy }] },
        now,
      ),
    ).rejects.toThrow(/not durably promoted/i);
    const identityRuntime = {
      authenticate: vi.fn(async (sessionToken: string) => ({
        account: {
          id: admin,
          primaryEmail: `${admin}@example.test`,
          displayName: "Fallback key admin",
          status: "active",
          emailVerifiedAt: now,
          createdAt: now,
          updatedAt: now,
        },
        sessionId: randomUUID(),
        sessionToken,
        csrfToken: "fallback-hmac-csrf",
        idleExpiresAt: new Date(now.getTime() + 60_000),
        absoluteExpiresAt: new Date(now.getTime() + 60_000),
      })),
      verifyCsrfToken: vi.fn(
        (sessionToken: string, csrf: string) => sessionToken === "session" && csrf === "fallback-hmac-csrf",
      ),
    } as unknown as IdentityApiRuntime;
    const app = await buildApp({
      config: testConfig({ DATABASE_URL: databaseUrl }),
      probes: healthyProbes,
      identityRuntime,
      scoringFallbackHmacKeySql: sql as unknown as PostgresJsSql,
      scoringFallbackHmacKeyring: introduce,
    });
    const promotedResponse = await app.inject({
      method: "POST",
      url: "/api/v1/admin/scoring-fallback-hmac-key-versions/v2/promote",
      headers: {
        cookie: "matchday_session=session",
        origin: "http://127.0.0.1:3000",
        "x-csrf-token": "fallback-hmac-csrf",
      },
      payload: { reason: "Rotate to v2" },
    });
    expect(promotedResponse.statusCode, promotedResponse.body).toBe(204);
    const promoted = {
      primary: { version: "v2", secret: replacement },
      verificationOnly: [{ version: "v1", secret: legacy }],
    };
    await expect(
      reconcileScoringFallbackHmacKeyring(sql as unknown as PostgresJsSql, promoted, now),
    ).resolves.toMatchObject({ primaryVersion: "v2", verificationOnlyVersions: ["v1"] });
    // This process deliberately keeps the configuration it had before the
    // durable promotion. It must neither mint with v1 nor keep accepting it
    // after a later durable retirement.
    const staleRuntime = new FallbackKeyringPhase2Runtime(
      sql as unknown as PostgresJsSql,
      phase2DomainAdapter,
      introduce,
    );
    const organisationId = randomUUID();
    const competitionId = randomUUID();
    const divisionId = randomUUID();
    const revisionId = randomUUID();
    const matchId = randomUUID();
    const passId = randomUUID();
    const graph = {
      id: revisionId,
      schemaVersion: 1,
      entryCount: 2,
      stages: [
        {
          id: "final-stage",
          label: "Final",
          kind: "single_elimination",
          order: 1,
          groupIds: [],
          groupSize: null,
          outputRanks: 2,
          matchIds: [matchId],
        },
      ],
      matches: [
        {
          id: matchId,
          stageId: "final-stage",
          round: 1,
          order: 1,
          purpose: "championship",
          home: { type: "entry_seed", seed: 1 },
          away: { type: "entry_seed", seed: 2 },
        },
      ],
      terminalMatchIds: [matchId],
    };
    await sql.begin(async (tx) => {
      await tx`INSERT INTO organisations(id,name,slug) VALUES(${organisationId},'Fallback oracle organisation',${`fallback-oracle-${randomUUID()}`})`;
      await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status) VALUES(${organisationId},${admin},'owner','active')`;
    });
    await sql`INSERT INTO competitions(id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on)
      VALUES(${competitionId},${organisationId},${admin},'Fallback oracle competition',${`fallback-oracle-${randomUUID()}`},'canoe_polo','UTC','2030-01-01','2030-01-01')`;
    await sql`INSERT INTO divisions(id,competition_id,name,team_limit) VALUES(${divisionId},${competitionId},'Open',8)`;
    await sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,status,created_by,validation_contract)
      VALUES(${revisionId},${competitionId},${divisionId},1,${sql.json(graph)},${canonicalHash(graph)},'draft',${admin},'phase3')`;
    const homeEntryId = randomUUID();
    const awayEntryId = randomUUID();
    await sql`INSERT INTO division_entries(id,division_id,name,seed)
      VALUES(${homeEntryId},${divisionId},'Home',1),(${awayEntryId},${divisionId},'Away',2)`;
    await sql`INSERT INTO matches(id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal)
      VALUES(${matchId},${competitionId},${divisionId},${revisionId},'M1','group',1,1)`;
    await sql`UPDATE matches SET home_entry_id=${homeEntryId},away_entry_id=${awayEntryId} WHERE id=${matchId}`;
    await sql`INSERT INTO scoring_access_passes(
      id,competition_id,match_id,secret_hash,short_code_hash,expires_at,created_by,role,scope,fallback_code_hash_version,fallback_code_hmac_key_version
    ) VALUES(${passId},${competitionId},${matchId},${Buffer.alloc(32, 1)},${Buffer.alloc(32, 2)},'2030-01-02T00:00:00Z',${admin},'scorekeeper',
      '["score:read","score:write","score:reverse","score:finalise"]','hmac_sha256_v1','v1')`;
    await expect(
      retireScoringFallbackHmacKeyVersion(
        sql as unknown as PostgresJsSql,
        { keyVersion: "v1", accountId: admin, requestId: `blocked-${randomUUID()}`, reason: "Must retain active code" },
        now,
      ),
    ).rejects.toMatchObject({ code: "FALLBACK_HMAC_KEY_RETIREMENT_BLOCKED", statusCode: 409 });
    const overlapCode = "123456789012";
    await sql`UPDATE scoring_access_passes
      SET short_code_hash=${createHmac("sha256", legacy).update(`scoring-fallback-code:${overlapCode}`, "utf8").digest()}
      WHERE id=${passId}`;
    await expect(
      staleRuntime.exchangeAccess(
        { shortCode: overlapCode, deviceId: randomUUID(), ipAddress: "198.51.100.60" },
        randomUUID(),
      ),
    ).resolves.toMatchObject({ mode: "writer", match_id: matchId });
    await expect(
      staleRuntime.createAccessPass(
        { accountId: admin },
        competitionId,
        matchId,
        {
          expiresAt: "2030-01-02T00:00:00.000Z",
          role: "scorekeeper",
          idempotencyKey: `stale-primary-${randomUUID()}`,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "FALLBACK_HMAC_KEY_VERSION_ACTIVE_STATE", statusCode: 409 });
    await expect(
      staleRuntime.rotateFallbackCode(
        { accountId: admin },
        competitionId,
        passId,
        `stale-primary-rotate-${randomUUID()}`,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "FALLBACK_HMAC_KEY_VERSION_ACTIVE_STATE", statusCode: 409 });
    const restartedRuntime = new FallbackKeyringPhase2Runtime(
      sql as unknown as PostgresJsSql,
      phase2DomainAdapter,
      promoted,
    );
    // This process has B configured as primary and retains A only as a
    // verification delegate. The delegate must use the same durable status
    // guard as the primary runtime, not merely trust its cached A secret.
    await expect(
      restartedRuntime.exchangeAccess(
        { shortCode: overlapCode, deviceId: randomUUID(), ipAddress: "198.51.100.62" },
        randomUUID(),
      ),
    ).resolves.toMatchObject({ match_id: matchId });
    const idempotencyKey = `restarted-primary-${randomUUID()}`;
    const issueInput = {
      expiresAt: "2030-01-02T00:00:00.000Z",
      role: "scorekeeper" as const,
      idempotencyKey,
    };
    const [firstIssue, concurrentReplay] = await Promise.all([
      restartedRuntime.createAccessPass({ accountId: admin }, competitionId, matchId, issueInput, randomUUID()),
      restartedRuntime.createAccessPass({ accountId: admin }, competitionId, matchId, issueInput, randomUUID()),
    ]);
    expect(firstIssue.id).toBe(concurrentReplay.id);
    expect([firstIssue.duplicate, concurrentReplay.duplicate]).toContain(false);
    expect([firstIssue.token, concurrentReplay.token]).toContain(null);
    expect([firstIssue.short_code, concurrentReplay.short_code]).toContain(null);
    const retiredCode = overlapCode;
    await sql`UPDATE scoring_access_passes
      SET short_code_hash=${createHmac("sha256", legacy).update(`scoring-fallback-code:${retiredCode}`, "utf8").digest()}
      WHERE id=${passId}`;
    await sql`UPDATE scoring_access_passes SET revoked_at=${now},revoked_by=${admin} WHERE id=${passId}`;
    const retiredResponse = await app.inject({
      method: "POST",
      url: "/api/v1/admin/scoring-fallback-hmac-key-versions/v1/retire",
      headers: {
        cookie: "matchday_session=session",
        origin: "http://127.0.0.1:3000",
        "x-csrf-token": "fallback-hmac-csrf",
      },
      payload: { reason: "No active fallback passes" },
    });
    expect(retiredResponse.statusCode, retiredResponse.body).toBe(204);
    await expect(
      sql<{ status: string }[]>`SELECT status FROM scoring_fallback_code_hmac_key_versions WHERE key_version='v1'`,
    ).resolves.toEqual([{ status: "retired" }]);
    await expect(
      restartedRuntime.exchangeAccess(
        { shortCode: retiredCode, deviceId: randomUUID(), ipAddress: "198.51.100.61" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "FALLBACK_HMAC_KEY_VERSION_RETIRED", statusCode: 403 });
    await app.close();
    await expect(reconcileScoringFallbackHmacKeyring(sql as unknown as PostgresJsSql, initial, now)).rejects.toThrow(
      /retired/i,
    );
    const audits = await sql<
      { action: string; metadata: unknown }[]
    >`SELECT action,metadata FROM audit_events WHERE target_type='scoring_fallback_code_hmac_key_version' ORDER BY occurred_at`;
    expect(audits.map((audit) => audit.action)).toEqual(
      expect.arrayContaining([
        "scoring_fallback_hmac_key.introduced",
        "scoring_fallback_hmac_key.promoted",
        "scoring_fallback_hmac_key.verification_only",
        "scoring_fallback_hmac_key.retirement_attempted",
        "scoring_fallback_hmac_key.retirement_blocked",
        "scoring_fallback_hmac_key.retired",
      ]),
    );
    expect(JSON.stringify(audits)).not.toContain(legacy);
    expect(JSON.stringify(audits)).not.toContain(replacement);
  });

  it("linearizes stale-runtime issuance and verification against durable promotion and retirement without partial credentials", async () => {
    const now = new Date();
    const admin = randomUUID();
    // The preceding lifecycle test leaves its explicitly promoted v2 primary
    // in this shared migrated schema. Reuse that known material so this test
    // exercises a real long-running-process transition instead of resetting
    // durable lifecycle state outside the implementation under test.
    const v2 = "fallback-hmac-replacement-b-material-32-bytes";
    const txv1 = "fallback-hmac-transaction-v1-material-32-bytes";
    const v3 = "fallback-hmac-transaction-v3-material-32-bytes";
    const initial = {
      primary: { version: "v2", secret: v2 },
      verificationOnly: [
        { version: "txv1", secret: txv1 },
        { version: "txv3", secret: v3 },
      ],
    };
    await sql`INSERT INTO accounts(id,primary_email,display_name) VALUES(${admin},${`${admin}@example.test`},'Fallback transaction admin')`;
    await sql`INSERT INTO account_platform_roles(account_id,role,granted_at,reason) VALUES(${admin},'platform_admin',${now},'test')`;
    await reconcileScoringFallbackHmacKeyring(sql as unknown as PostgresJsSql, initial, now);
    const { competitionId, matchId } = await seedResolvedMatch(admin);
    const staleRuntime = new FallbackKeyringPhase2Runtime(
      sql as unknown as PostgresJsSql,
      phase2DomainAdapter,
      initial,
    );
    const lockId = 717_533_091;
    await sql.unsafe(`
      CREATE FUNCTION test_fallback_hmac_issue_pause() RETURNS trigger AS $$
      BEGIN
        IF NEW.issuance_idempotency_key LIKE 'linearized-%' THEN
          PERFORM pg_advisory_xact_lock(${lockId});
          PERFORM pg_sleep(0.35);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fallback_hmac_issue_pause
      BEFORE INSERT ON scoring_access_passes
      FOR EACH ROW EXECUTE FUNCTION test_fallback_hmac_issue_pause();
    `);
    const linearizedIssue = staleRuntime.createAccessPass(
      { accountId: admin },
      competitionId,
      matchId,
      { expiresAt: "2030-01-02T00:00:00.000Z", role: "scorekeeper", idempotencyKey: `linearized-${randomUUID()}` },
      randomUUID(),
    );
    await waitForAdvisoryLock(lockId);
    let promotionFinished = false;
    const promotion = promoteScoringFallbackHmacKeyVersion(
      sql as unknown as PostgresJsSql,
      {
        keyVersion: "txv1",
        accountId: admin,
        requestId: `promote-v2-${randomUUID()}`,
        reason: "Linearization test",
        configuredKeyring: initial,
      },
      now,
    ).then(() => {
      promotionFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(promotionFinished).toBe(false);
    const issuedUnderV1 = await linearizedIssue;
    await promotion;
    await sql.unsafe(
      "DROP TRIGGER test_fallback_hmac_issue_pause ON scoring_access_passes; DROP FUNCTION test_fallback_hmac_issue_pause()",
      [],
    );
    await expect(
      sql<
        { fallback_code_hmac_key_version: string }[]
      >`SELECT fallback_code_hmac_key_version FROM scoring_access_passes WHERE id=${issuedUnderV1.id}`,
    ).resolves.toEqual([{ fallback_code_hmac_key_version: "v2" }]);
    await expect(
      staleRuntime.createAccessPass(
        { accountId: admin },
        competitionId,
        matchId,
        {
          expiresAt: "2030-01-02T00:00:00.000Z",
          role: "scorekeeper",
          idempotencyKey: `after-promotion-${randomUUID()}`,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "FALLBACK_HMAC_KEY_VERSION_ACTIVE_STATE", statusCode: 409 });

    // A process restarted with B can issue B codes while retaining A only for
    // verification. The old A code remains valid until retirement commits.
    const v2Primary = {
      primary: { version: "txv1", secret: txv1 },
      verificationOnly: [
        { version: "v2", secret: v2 },
        { version: "txv3", secret: v3 },
      ],
    };
    await reconcileScoringFallbackHmacKeyring(sql as unknown as PostgresJsSql, v2Primary, now);
    const restartedRuntime = new FallbackKeyringPhase2Runtime(
      sql as unknown as PostgresJsSql,
      phase2DomainAdapter,
      v2Primary,
    );
    const issuedUnderTxv1 = await restartedRuntime.createAccessPass(
      { accountId: admin },
      competitionId,
      matchId,
      {
        expiresAt: "2030-01-02T00:00:00.000Z",
        role: "scorekeeper",
        idempotencyKey: `issued-under-txv1-${randomUUID()}`,
      },
      randomUUID(),
    );
    await expect(
      restartedRuntime.exchangeAccess(
        { shortCode: issuedUnderTxv1.short_code!, deviceId: randomUUID(), ipAddress: "198.51.100.70" },
        randomUUID(),
      ),
    ).resolves.toMatchObject({ match_id: matchId });

    // A transaction that reaches the guarded verification path before a
    // retirement request holds the registry lock through session creation;
    // retirement must wait and then refuse because this key is still primary.
    await sql.unsafe(`
      CREATE FUNCTION test_fallback_hmac_exchange_pause() RETURNS trigger AS $$
      BEGIN
        IF NEW.access_pass_id='${issuedUnderTxv1.id}' THEN
          PERFORM pg_advisory_xact_lock(${lockId});
          PERFORM pg_sleep(0.35);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fallback_hmac_exchange_pause
      BEFORE INSERT ON scoring_access_sessions
      FOR EACH ROW EXECUTE FUNCTION test_fallback_hmac_exchange_pause();
    `);
    const exchangeBeforeRetirement = restartedRuntime.exchangeAccess(
      { shortCode: issuedUnderTxv1.short_code!, deviceId: randomUUID(), ipAddress: "198.51.100.71" },
      randomUUID(),
    );
    await waitForAdvisoryLock(lockId);
    let retirementFinished = false;
    const blockedRetirement = retireScoringFallbackHmacKeyVersion(
      sql as unknown as PostgresJsSql,
      { keyVersion: "txv1", accountId: admin, requestId: `retire-wait-${randomUUID()}`, reason: "Linearization test" },
      now,
    ).finally(() => {
      retirementFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(retirementFinished).toBe(false);
    await expect(exchangeBeforeRetirement).resolves.toMatchObject({ match_id: matchId });
    await expect(blockedRetirement).rejects.toMatchObject({
      code: "FALLBACK_HMAC_KEY_VERSION_PRIMARY",
      statusCode: 409,
    });
    await sql.unsafe(
      "DROP TRIGGER test_fallback_hmac_exchange_pause ON scoring_access_sessions; DROP FUNCTION test_fallback_hmac_exchange_pause()",
      [],
    );

    // A failed credential insertion or exchange must roll back all mutations.
    await sql.unsafe(`
      CREATE FUNCTION test_fallback_hmac_force_rollback() RETURNS trigger AS $$
      BEGIN
        IF NEW.issuance_idempotency_key LIKE 'rollback-%' THEN
          RAISE EXCEPTION 'test fallback credential rollback';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fallback_hmac_force_rollback
      BEFORE INSERT ON scoring_access_passes
      FOR EACH ROW EXECUTE FUNCTION test_fallback_hmac_force_rollback();
    `);
    const rollbackKey = `rollback-${randomUUID()}`;
    await expect(
      restartedRuntime.createAccessPass(
        { accountId: admin },
        competitionId,
        matchId,
        { expiresAt: "2030-01-02T00:00:00.000Z", role: "scorekeeper", idempotencyKey: rollbackKey },
        randomUUID(),
      ),
    ).rejects.toThrow(/test fallback credential rollback/i);
    await expect(
      sql<
        { count: string }[]
      >`SELECT count(*)::text AS count FROM scoring_access_passes WHERE issuance_idempotency_key=${rollbackKey}`,
    ).resolves.toEqual([{ count: "0" }]);
    await sql.unsafe(
      "DROP TRIGGER test_fallback_hmac_force_rollback ON scoring_access_passes; DROP FUNCTION test_fallback_hmac_force_rollback()",
      [],
    );

    await sql.unsafe(`
      CREATE FUNCTION test_fallback_hmac_session_rollback() RETURNS trigger AS $$
      BEGIN
        IF NEW.access_pass_id='${issuedUnderTxv1.id}' THEN
          RAISE EXCEPTION 'test fallback session rollback';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fallback_hmac_session_rollback
      BEFORE INSERT ON scoring_access_sessions
      FOR EACH ROW EXECUTE FUNCTION test_fallback_hmac_session_rollback();
    `);
    const sessionCountBeforeRollback = await sql<
      { count: string }[]
    >`SELECT count(*)::text AS count FROM scoring_access_sessions WHERE access_pass_id=${issuedUnderTxv1.id}`;
    await expect(
      restartedRuntime.exchangeAccess(
        { shortCode: issuedUnderTxv1.short_code!, deviceId: randomUUID(), ipAddress: "198.51.100.72" },
        randomUUID(),
      ),
    ).rejects.toThrow(/test fallback session rollback/i);
    await expect(
      sql<
        { count: string }[]
      >`SELECT count(*)::text AS count FROM scoring_access_sessions WHERE access_pass_id=${issuedUnderTxv1.id}`,
    ).resolves.toEqual(sessionCountBeforeRollback);
    await sql.unsafe(
      "DROP TRIGGER test_fallback_hmac_session_rollback ON scoring_access_sessions; DROP FUNCTION test_fallback_hmac_session_rollback()",
      [],
    );

    // Lifecycle operations serialize under the same durable lock. One duplicate
    // promotion and one duplicate retirement must fail deterministically rather
    // than deadlock; a process with A retained in memory then rejects A once it
    // is durably retired.
    const concurrentPromotions = await Promise.allSettled([
      promoteScoringFallbackHmacKeyVersion(
        sql as unknown as PostgresJsSql,
        {
          keyVersion: "txv3",
          accountId: admin,
          requestId: `promote-v3-a-${randomUUID()}`,
          reason: "Concurrency test",
          configuredKeyring: v2Primary,
        },
        now,
      ),
      promoteScoringFallbackHmacKeyVersion(
        sql as unknown as PostgresJsSql,
        {
          keyVersion: "txv3",
          accountId: admin,
          requestId: `promote-v3-b-${randomUUID()}`,
          reason: "Concurrency test",
          configuredKeyring: v2Primary,
        },
        now,
      ),
    ]);
    expect(concurrentPromotions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrentPromotions.filter((result) => result.status === "rejected")).toHaveLength(1);
    await sql`UPDATE scoring_access_passes SET revoked_at=${now},revoked_by=${admin} WHERE id=${issuedUnderTxv1.id}`;
    const concurrentRetirements = await Promise.allSettled([
      retireScoringFallbackHmacKeyVersion(
        sql as unknown as PostgresJsSql,
        { keyVersion: "txv1", accountId: admin, requestId: `retire-a-${randomUUID()}`, reason: "Concurrency test" },
        now,
      ),
      retireScoringFallbackHmacKeyVersion(
        sql as unknown as PostgresJsSql,
        { keyVersion: "txv1", accountId: admin, requestId: `retire-b-${randomUUID()}`, reason: "Concurrency test" },
        now,
      ),
    ]);
    expect(concurrentRetirements.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrentRetirements.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(
      restartedRuntime.exchangeAccess(
        { shortCode: issuedUnderTxv1.short_code!, deviceId: randomUUID(), ipAddress: "198.51.100.73" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "FALLBACK_HMAC_KEY_VERSION_RETIRED", statusCode: 403 });
  });

  it("waits for a verification-only exchange before retiring its durable key, then rejects that key without restart", async () => {
    const now = new Date();
    const admin = randomUUID();
    const current = { version: "txv3", secret: "fallback-hmac-transaction-v3-material-32-bytes" };
    const prior = { version: "v2", secret: "fallback-hmac-replacement-b-material-32-bytes" };
    const retiring = { version: "wait-a", secret: "fallback-hmac-wait-a-material-32-bytes" };
    const replacement = { version: "wait-b", secret: "fallback-hmac-wait-b-material-32-bytes" };
    await sql`INSERT INTO accounts(id,primary_email,display_name) VALUES(${admin},${`${admin}@example.test`},'Fallback wait admin')`;
    await sql`INSERT INTO account_platform_roles(account_id,role,granted_at,reason) VALUES(${admin},'platform_admin',${now},'test')`;
    const beforePromotion = {
      primary: current,
      verificationOnly: [prior, retiring, replacement],
    };
    await reconcileScoringFallbackHmacKeyring(sql as unknown as PostgresJsSql, beforePromotion, now);
    await promoteScoringFallbackHmacKeyVersion(
      sql as unknown as PostgresJsSql,
      {
        keyVersion: retiring.version,
        accountId: admin,
        requestId: `promote-wait-a-${randomUUID()}`,
        reason: "Prepare verification-only retirement lock test",
        configuredKeyring: beforePromotion,
      },
      now,
    );
    const retiringPrimary = {
      primary: retiring,
      verificationOnly: [current, prior, replacement],
    };
    await reconcileScoringFallbackHmacKeyring(sql as unknown as PostgresJsSql, retiringPrimary, now);
    const { competitionId, matchId } = await seedResolvedMatch(admin);
    const issuingRuntime = new FallbackKeyringPhase2Runtime(
      sql as unknown as PostgresJsSql,
      phase2DomainAdapter,
      retiringPrimary,
    );
    const issued = await issuingRuntime.createAccessPass(
      { accountId: admin },
      competitionId,
      matchId,
      { expiresAt: "2030-01-02T00:00:00.000Z", role: "scorekeeper", idempotencyKey: `wait-a-${randomUUID()}` },
      randomUUID(),
    );
    await promoteScoringFallbackHmacKeyVersion(
      sql as unknown as PostgresJsSql,
      {
        keyVersion: replacement.version,
        accountId: admin,
        requestId: `promote-wait-b-${randomUUID()}`,
        reason: "Demote verification key before retirement",
        configuredKeyring: retiringPrimary,
      },
      now,
    );
    const replacementPrimary = {
      primary: replacement,
      verificationOnly: [retiring, current, prior],
    };
    await reconcileScoringFallbackHmacKeyring(sql as unknown as PostgresJsSql, replacementPrimary, now);
    const longRunningRuntime = new FallbackKeyringPhase2Runtime(
      sql as unknown as PostgresJsSql,
      phase2DomainAdapter,
      replacementPrimary,
    );
    const lockId = 717_533_092;
    // The exchange has already validated the pass and held the registry row
    // FOR SHARE. Revoke that one pass inside this test-only session trigger so
    // retirement can commit immediately after the verification transaction
    // releases its lock; production code is not altered by this fixture.
    await sql.unsafe(`
      CREATE FUNCTION test_fallback_hmac_verify_only_pause() RETURNS trigger AS $$
      BEGIN
        IF NEW.access_pass_id='${issued.id}' THEN
          UPDATE scoring_access_passes SET revoked_at=now(), revoked_by='${admin}' WHERE id=NEW.access_pass_id;
          PERFORM pg_advisory_xact_lock(${lockId});
          PERFORM pg_sleep(0.35);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fallback_hmac_verify_only_pause
      BEFORE INSERT ON scoring_access_sessions
      FOR EACH ROW EXECUTE FUNCTION test_fallback_hmac_verify_only_pause();
    `);
    try {
      const exchange = longRunningRuntime.exchangeAccess(
        { shortCode: issued.short_code!, deviceId: randomUUID(), ipAddress: "198.51.100.80" },
        randomUUID(),
      );
      await waitForAdvisoryLock(lockId);
      let retired = false;
      const retirement = retireScoringFallbackHmacKeyVersion(
        sql as unknown as PostgresJsSql,
        {
          keyVersion: retiring.version,
          accountId: admin,
          requestId: `retire-wait-a-${randomUUID()}`,
          reason: "Wait for verification",
        },
        now,
      ).then(() => {
        retired = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(retired).toBe(false);
      await expect(exchange).resolves.toMatchObject({ match_id: matchId });
      await within(retirement, "verification-only retirement");
    } finally {
      await sql.unsafe(
        "DROP TRIGGER IF EXISTS test_fallback_hmac_verify_only_pause ON scoring_access_sessions; DROP FUNCTION IF EXISTS test_fallback_hmac_verify_only_pause()",
        [],
      );
    }
    await expect(
      sql<
        { status: string }[]
      >`SELECT status FROM scoring_fallback_code_hmac_key_versions WHERE key_version=${retiring.version}`,
    ).resolves.toEqual([{ status: "retired" }]);
    await expect(
      longRunningRuntime.exchangeAccess(
        { shortCode: issued.short_code!, deviceId: randomUUID(), ipAddress: "198.51.100.81" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "FALLBACK_HMAC_KEY_VERSION_RETIRED", statusCode: 403 });
  });

  it("keeps bounded concurrent issue, exchange, and promotion lifecycles deadlock-free with consistent durable outcomes", async () => {
    const now = new Date();
    const admin = randomUUID();
    const base = { version: "wait-b", secret: "fallback-hmac-wait-b-material-32-bytes" };
    const retained = [
      { version: "txv3", secret: "fallback-hmac-transaction-v3-material-32-bytes" },
      { version: "v2", secret: "fallback-hmac-replacement-b-material-32-bytes" },
    ];
    await sql`INSERT INTO accounts(id,primary_email,display_name) VALUES(${admin},${`${admin}@example.test`},'Fallback stress admin')`;
    await sql`INSERT INTO account_platform_roles(account_id,role,granted_at,reason) VALUES(${admin},'platform_admin',${now},'test')`;
    const { competitionId, matchId } = await seedResolvedMatch(admin);
    let primary = base;
    let verificationOnly = [...retained];
    const createdPassIds: string[] = [];
    for (const round of [1, 2, 3]) {
      const candidate = {
        version: `stress-${round}`,
        secret: `fallback-hmac-stress-${round}-material-32-bytes`,
      };
      const configured = { primary, verificationOnly: [...verificationOnly, candidate] };
      await reconcileScoringFallbackHmacKeyring(sql as unknown as PostgresJsSql, configured, now);
      const runtime = new FallbackKeyringPhase2Runtime(
        sql as unknown as PostgresJsSql,
        phase2DomainAdapter,
        configured,
      );
      const prePromotionIssues = await within(
        Promise.all(
          Array.from({ length: 4 }, (_, index) =>
            runtime.createAccessPass(
              { accountId: admin },
              competitionId,
              matchId,
              {
                expiresAt: "2030-01-02T00:00:00.000Z",
                role: "scorekeeper",
                idempotencyKey: `stress-${round}-pre-${index}-${randomUUID()}`,
              },
              randomUUID(),
            ),
          ),
        ),
        `stress round ${round} initial issuance`,
      );
      createdPassIds.push(...prePromotionIssues.map((pass) => pass.id));
      const concurrent = await within(
        Promise.allSettled([
          ...prePromotionIssues.map((pass, index) =>
            runtime.exchangeAccess(
              {
                shortCode: pass.short_code!,
                deviceId: randomUUID(),
                ipAddress: `198.51.100.${90 + round * 4 + index}`,
              },
              randomUUID(),
            ),
          ),
          ...Array.from({ length: 4 }, (_, index) =>
            runtime.createAccessPass(
              { accountId: admin },
              competitionId,
              matchId,
              {
                expiresAt: "2030-01-02T00:00:00.000Z",
                role: "scorekeeper",
                idempotencyKey: `stress-${round}-racing-${index}-${randomUUID()}`,
              },
              randomUUID(),
            ),
          ),
          promoteScoringFallbackHmacKeyVersion(
            sql as unknown as PostgresJsSql,
            {
              keyVersion: candidate.version,
              accountId: admin,
              requestId: `stress-promote-${round}-${randomUUID()}`,
              reason: "Bounded lifecycle stress test",
              configuredKeyring: configured,
            },
            now,
          ),
        ]),
        `stress round ${round} concurrent lifecycle`,
      );
      const exchanges = concurrent.slice(0, prePromotionIssues.length);
      expect(exchanges.every((result) => result.status === "fulfilled")).toBe(true);
      const promotion = concurrent.at(-1);
      expect(promotion?.status).toBe("fulfilled");
      const racingIssues = concurrent.slice(prePromotionIssues.length, -1);
      for (const result of racingIssues) {
        if (result.status === "fulfilled") {
          expect(result.value).toMatchObject({ id: expect.any(String) });
          createdPassIds.push((result.value as { id: string }).id);
        } else expect(result.reason).toMatchObject({ code: "FALLBACK_HMAC_KEY_VERSION_ACTIVE_STATE", statusCode: 409 });
      }
      primary = candidate;
      verificationOnly = [configured.primary, ...verificationOnly];
    }
    await expect(
      sql<{ key_version: string; status: string }[]>`
        SELECT key_version,status FROM scoring_fallback_code_hmac_key_versions
        WHERE key_version LIKE 'stress-%' ORDER BY key_version
      `,
    ).resolves.toEqual([
      { key_version: "stress-1", status: "verification_only" },
      { key_version: "stress-2", status: "verification_only" },
      { key_version: "stress-3", status: "primary" },
    ]);
    await expect(
      sql<
        { count: string }[]
      >`SELECT count(*)::text AS count FROM scoring_access_sessions WHERE access_pass_id = ANY(${createdPassIds}::uuid[])`,
    ).resolves.toEqual([{ count: "12" }]);
    await sql`UPDATE scoring_access_passes SET revoked_at=${now},revoked_by=${admin} WHERE id = ANY(${createdPassIds}::uuid[])`;
    await expect(
      sql<
        { count: string }[]
      >`SELECT count(*)::text AS count FROM scoring_access_passes WHERE id = ANY(${createdPassIds}::uuid[]) AND revoked_at IS NULL`,
    ).resolves.toEqual([{ count: "0" }]);
  });
});
