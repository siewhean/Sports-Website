import { createHash, createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import type { PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import {
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
      staleRuntime.exchangeAccess(
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
});
