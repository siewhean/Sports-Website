import { createHash, timingSafeEqual } from "node:crypto";
import type { PostgresJsSql } from "@matchday/identity";
import { ApiError } from "./errors.js";
import { productionScoringAccessHmacMetrics } from "./scoring-access-hmac-metrics.js";
import type { ScoringAccessHmacMetricRecorder } from "./scoring-access-hmac-metrics.js";
import type { ScoringAccessRateLimitHmacKeyring } from "./scoring-access-rate-limit.js";

const retirementRedisTtlSeconds = 15 * 60;
const keyringAdvisoryLock = 9_274_421_608_195;
const legacyUncommittedMaterial = Buffer.alloc(32);

type HmacKeyStatus = "primary" | "verification_only" | "retired";

type HmacKeyVersionRow = {
  key_version: string;
  material_commitment: Buffer;
  status: HmacKeyStatus;
  activated_at: Date;
  verification_only_since: Date | null;
  retirement_not_before: Date | null;
  retired_at: Date | null;
};

export type ScoringAccessHmacKeyringSnapshot = {
  primaryVersion: string;
  verificationOnlyVersions: readonly string[];
  registeredVersions: readonly { version: string; status: HmacKeyStatus }[];
};

function requireTransaction(sql: PostgresJsSql): <T>(operation: (tx: PostgresJsSql) => Promise<T>) => Promise<T> {
  if (!sql.begin) {
    throw new Error("Scoring access HMAC key lifecycle operations require a transaction-capable PostgreSQL client.");
  }
  return async <T>(operation: (tx: PostgresJsSql) => Promise<T>) => sql.begin!(operation);
}

async function lockAndRead(tx: PostgresJsSql): Promise<HmacKeyVersionRow[]> {
  await tx.unsafe("SELECT pg_advisory_xact_lock($1)", [keyringAdvisoryLock]);
  return [
    ...(await tx.unsafe<HmacKeyVersionRow>(
      `SELECT key_version,material_commitment,status,activated_at,verification_only_since,retirement_not_before,retired_at
     FROM scoring_access_hmac_key_versions
     ORDER BY key_version
     FOR UPDATE`,
    )),
  ];
}

function materialCommitment(secret: string): Buffer {
  return createHash("sha256")
    .update("matchday:scoring-access-hmac-key-material:v1:\u0000", "utf8")
    .update(secret, "utf8")
    .digest();
}

function configuredLegacyV1Commitment(keyring: ScoringAccessRateLimitHmacKeyring): Buffer | undefined {
  const legacy = [keyring.primary, ...keyring.verificationOnly].find((key) => key.version === "v1");
  if (!legacy || !keyring.legacyV1MaterialCommitment) return undefined;
  const configured = Buffer.from(keyring.legacyV1MaterialCommitment, "hex");
  const expected = materialCommitment(legacy.secret);
  if (!sameCommitment(configured, expected)) {
    throw new Error("Configured C1-C4 v1 HMAC material commitment does not match the configured v1 key.");
  }
  return configured;
}

function sameCommitment(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

async function assertOrBootstrapMaterialCommitment(
  tx: PostgresJsSql,
  row: HmacKeyVersionRow,
  secret: string,
  legacyV1Commitment: Buffer | undefined,
): Promise<void> {
  const expected = materialCommitment(secret);
  if (sameCommitment(Buffer.from(row.material_commitment), legacyUncommittedMaterial)) {
    if (row.key_version !== "v1" || !legacyV1Commitment || !sameCommitment(legacyV1Commitment, expected)) {
      throw new Error(
        "C1-C4 v1 HMAC material is uncommitted; provide the matching legacy v1 material commitment before startup.",
      );
    }
    await tx.unsafe(`UPDATE scoring_access_hmac_key_versions SET material_commitment=$2 WHERE key_version=$1`, [
      row.key_version,
      legacyV1Commitment,
    ]);
    return;
  }
  if (!sameCommitment(Buffer.from(row.material_commitment), expected)) {
    throw new Error(`Configured scoring access HMAC key version ${row.key_version} has different key material.`);
  }
}

async function auditLifecycle(
  tx: PostgresJsSql,
  input: {
    requestId: string;
    action: "activated" | "verification_only" | "retired";
    keyVersion: string;
    occurredAt: Date;
  },
): Promise<void> {
  await tx.unsafe(
    `INSERT INTO audit_events (
       occurred_at,request_id,actor_account_id,actor_type,organisation_id,
       action,target_type,target_id,reason,before_state,after_state,metadata
     ) VALUES ($1,$2,NULL,'system',NULL,$3,'scoring_access_hmac_key_version',$4,NULL,NULL,
       jsonb_build_object('key_version',$4::text,'lifecycle_action',$3::text), '{}'::jsonb)`,
    [input.occurredAt, input.requestId, `scoring_access_hmac_key.${input.action}`, input.keyVersion],
  );
}

async function auditRetirement(
  tx: PostgresJsSql,
  input: { requestId: string; accountId: string; keyVersion: string; reason: string; occurredAt: Date },
): Promise<void> {
  await tx.unsafe(
    `INSERT INTO audit_events (
       occurred_at,request_id,actor_account_id,actor_type,organisation_id,
       action,target_type,target_id,reason,before_state,after_state,metadata
     ) VALUES ($1,$2,$3,'platform_admin',NULL,'scoring_access_hmac_key.retired',
       'scoring_access_hmac_key_version',$4,$5,NULL,
       jsonb_build_object('key_version',$4::text,'lifecycle_action','retired'), '{}'::jsonb)`,
    [input.occurredAt, input.requestId, input.accountId, input.keyVersion, input.reason],
  );
}

function snapshot(
  keyring: ScoringAccessRateLimitHmacKeyring,
  rows: readonly HmacKeyVersionRow[],
): ScoringAccessHmacKeyringSnapshot {
  return {
    primaryVersion: keyring.primary.version,
    verificationOnlyVersions: keyring.verificationOnly.map((key) => key.version),
    registeredVersions: rows.map((row) => ({ version: row.key_version, status: row.status })),
  };
}

function recordLifecycleMetric(
  hmacMetrics: ScoringAccessHmacMetricRecorder,
  event: { keyVersion: string; action: "activated" | "verification_only" | "retired" },
): void {
  // Lifecycle truth is already durable in PostgreSQL and audit_events. Metrics
  // are intentionally best-effort so telemetry outage cannot turn a committed
  // key transition into a failed startup or administrator response.
  try {
    hmacMetrics.lifecycle(event);
  } catch {
    // The next scrape/reconciliation still observes the durable registry.
  }
}

/**
 * Reconciles public configuration key versions with the durable registry at
 * startup. It never accepts an unknown/retired configured version and never
 * auto-retires an omitted key: retirement has a separate timed operation.
 */
export async function reconcileScoringAccessHmacKeyring(
  sql: PostgresJsSql,
  keyring: ScoringAccessRateLimitHmacKeyring,
  now = new Date(),
  hmacMetrics: ScoringAccessHmacMetricRecorder = productionScoringAccessHmacMetrics,
): Promise<ScoringAccessHmacKeyringSnapshot> {
  const metricEvents: { keyVersion: string; action: "activated" | "verification_only" }[] = [];
  const result = await requireTransaction(sql)(async (tx) => {
    const legacyV1Commitment = configuredLegacyV1Commitment(keyring);
    const rows = await lockAndRead(tx);
    const byVersion = new Map(rows.map((row) => [row.key_version, row]));
    const configuredVersions = new Set([
      keyring.primary.version,
      ...keyring.verificationOnly.map((key) => key.version),
    ]);
    for (const row of rows) {
      if (row.status !== "retired" && !configuredVersions.has(row.key_version)) {
        throw new Error(
          `Configured scoring access HMAC keyring omits non-retired key version ${row.key_version}; retire it explicitly first.`,
        );
      }
    }
    for (const key of keyring.verificationOnly) {
      const row = byVersion.get(key.version);
      if (row?.status === "retired") {
        throw new Error(`Configured scoring access HMAC key version ${key.version} is retired.`);
      }
      if (!row) {
        const retirementNotBefore = new Date(now.getTime() + retirementRedisTtlSeconds * 1_000);
        await tx.unsafe(
          `INSERT INTO scoring_access_hmac_key_versions(
             key_version,material_commitment,status,activated_at,verification_only_since,retirement_not_before
           ) VALUES ($1,$2,'verification_only',$3,$3,$4)`,
          [key.version, materialCommitment(key.secret), now, retirementNotBefore],
        );
        await auditLifecycle(tx, {
          requestId: `system:scoring-access-hmac-key:${key.version}:verification-only`,
          action: "verification_only",
          keyVersion: key.version,
          occurredAt: now,
        });
        metricEvents.push({ keyVersion: key.version, action: "verification_only" });
      } else if (row.status === "primary") {
        await assertOrBootstrapMaterialCommitment(tx, row, key.secret, legacyV1Commitment);
        await tx.unsafe(
          `UPDATE scoring_access_hmac_key_versions
           SET status='verification_only',verification_only_since=$2,
               retirement_not_before=$3,retired_at=NULL
           WHERE key_version=$1`,
          [key.version, now, new Date(now.getTime() + retirementRedisTtlSeconds * 1_000)],
        );
        await auditLifecycle(tx, {
          requestId: `system:scoring-access-hmac-key:${key.version}:verification-only`,
          action: "verification_only",
          keyVersion: key.version,
          occurredAt: now,
        });
        metricEvents.push({ keyVersion: key.version, action: "verification_only" });
      } else {
        await assertOrBootstrapMaterialCommitment(tx, row, key.secret, legacyV1Commitment);
      }
    }
    const primaryRow = byVersion.get(keyring.primary.version);
    if (primaryRow?.status === "retired") {
      throw new Error(`Configured scoring access HMAC key version ${keyring.primary.version} is retired.`);
    }
    if (!primaryRow) {
      await tx.unsafe(
        `INSERT INTO scoring_access_hmac_key_versions(key_version,material_commitment,status,activated_at)
         VALUES ($1,$2,'primary',$3)`,
        [keyring.primary.version, materialCommitment(keyring.primary.secret), now],
      );
      await auditLifecycle(tx, {
        requestId: `system:scoring-access-hmac-key:${keyring.primary.version}:activated`,
        action: "activated",
        keyVersion: keyring.primary.version,
        occurredAt: now,
      });
      metricEvents.push({ keyVersion: keyring.primary.version, action: "activated" });
    } else if (primaryRow.status === "verification_only") {
      await assertOrBootstrapMaterialCommitment(tx, primaryRow, keyring.primary.secret, legacyV1Commitment);
      await tx.unsafe(
        `UPDATE scoring_access_hmac_key_versions
         SET status='primary',verification_only_since=NULL,retirement_not_before=NULL,retired_at=NULL
         WHERE key_version=$1`,
        [keyring.primary.version],
      );
      await auditLifecycle(tx, {
        requestId: `system:scoring-access-hmac-key:${keyring.primary.version}:activated`,
        action: "activated",
        keyVersion: keyring.primary.version,
        occurredAt: now,
      });
      metricEvents.push({ keyVersion: keyring.primary.version, action: "activated" });
    } else {
      await assertOrBootstrapMaterialCommitment(tx, primaryRow, keyring.primary.secret, legacyV1Commitment);
    }
    return snapshot(keyring, await lockAndRead(tx));
  });
  for (const event of metricEvents) recordLifecycleMetric(hmacMetrics, event);
  return result;
}

export async function retireScoringAccessHmacKeyVersion(
  sql: PostgresJsSql,
  input: { keyVersion: string; accountId: string; requestId: string; reason: string },
  now = new Date(),
  hmacMetrics: ScoringAccessHmacMetricRecorder = productionScoringAccessHmacMetrics,
): Promise<void> {
  await requireTransaction(sql)(async (tx) => {
    const platformAdmin = await tx.unsafe<{ account_id: string }>(
      `SELECT account_id FROM account_platform_roles
       WHERE account_id=$1 AND role='platform_admin' AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at>$2)`,
      [input.accountId, now],
    );
    if (!platformAdmin[0]) {
      throw new ApiError(403, "PLATFORM_ADMIN_REQUIRED", "Platform administrator access required");
    }
    const rows = await lockAndRead(tx);
    const row = rows.find((candidate) => candidate.key_version === input.keyVersion);
    if (!row) {
      throw new ApiError(409, "SCORING_ACCESS_HMAC_KEY_VERSION_UNKNOWN", "Scoring access HMAC key version is unknown");
    }
    if (row.status === "retired") {
      throw new ApiError(
        409,
        "SCORING_ACCESS_HMAC_KEY_VERSION_RETIRED",
        "Scoring access HMAC key version is already retired",
      );
    }
    if (row.status === "primary") {
      throw new ApiError(
        409,
        "SCORING_ACCESS_HMAC_KEY_VERSION_PRIMARY",
        "Scoring access HMAC key version must be verification-only before retirement",
      );
    }
    if (!row.retirement_not_before || row.retirement_not_before.getTime() > now.getTime()) {
      throw new ApiError(
        409,
        "SCORING_ACCESS_HMAC_KEY_VERSION_RETENTION_PENDING",
        "Scoring access HMAC key version has not completed its Redis TTL retention period",
      );
    }
    const activeAttempt = await tx.unsafe<{ id: string }>(
      `SELECT id FROM scoring_access_attempts
       WHERE hmac_key_version=$1
         AND rate_limit_state_expires_at>$2
       LIMIT 1`,
      [input.keyVersion, now],
    );
    if (activeAttempt[0]) {
      throw new ApiError(
        409,
        "SCORING_ACCESS_HMAC_KEY_VERSION_ACTIVE_STATE",
        "Scoring access HMAC key version still has active access-attempt retention",
      );
    }
    await tx.unsafe(
      `UPDATE scoring_access_hmac_key_versions
       SET status='retired',retired_at=$2
       WHERE key_version=$1`,
      [input.keyVersion, now],
    );
    await auditRetirement(tx, {
      requestId: input.requestId,
      accountId: input.accountId,
      keyVersion: input.keyVersion,
      reason: input.reason,
      occurredAt: now,
    });
  });
  recordLifecycleMetric(hmacMetrics, { keyVersion: input.keyVersion, action: "retired" });
}

export const scoringAccessHmacRetirementRedisTtlSeconds = retirementRedisTtlSeconds;
