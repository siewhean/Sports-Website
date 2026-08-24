import { createHash, timingSafeEqual } from "node:crypto";
import type { ScoringFallbackHmacKey, ScoringFallbackHmacKeyring } from "@matchday/config";
import type { PostgresJsSql } from "@matchday/identity";
import { ApiError } from "./errors.js";

const advisoryLock = 9_274_421_609_196;
const legacyUncommittedMaterial = Buffer.alloc(32);
type KeyStatus = "primary" | "verification_only" | "retired";
type Row = {
  key_version: string;
  material_commitment: Buffer;
  status: KeyStatus;
  activated_at: Date;
  verification_only_since: Date | null;
  retired_at: Date | null;
};
export type ScoringFallbackHmacKeyringSnapshot = {
  primaryVersion: string;
  verificationOnlyVersions: readonly string[];
  registeredVersions: readonly { version: string; status: KeyStatus }[];
};

function commitment(secret: string): Buffer {
  return createHash("sha256")
    .update("matchday:scoring-fallback-code-hmac-key-material:v1:\u0000", "utf8")
    .update(secret, "utf8")
    .digest();
}
function equal(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
function transaction(sql: PostgresJsSql): <T>(fn: (tx: PostgresJsSql) => Promise<T>) => Promise<T> {
  if (!sql.begin)
    throw new Error("Fallback-code HMAC lifecycle operations require a transaction-capable PostgreSQL client.");
  return async <T>(fn: (tx: PostgresJsSql) => Promise<T>) => sql.begin!(fn);
}
async function lockedRows(tx: PostgresJsSql): Promise<Row[]> {
  await tx.unsafe("SELECT pg_advisory_xact_lock($1)", [advisoryLock]);
  return [
    ...(await tx.unsafe<Row>(
      "SELECT key_version,material_commitment,status,activated_at,verification_only_since,retired_at FROM scoring_fallback_code_hmac_key_versions ORDER BY key_version FOR UPDATE",
    )),
  ];
}
async function assertMaterial(tx: PostgresJsSql, row: Row, key: ScoringFallbackHmacKey): Promise<void> {
  const wanted = commitment(key.secret);
  if (equal(Buffer.from(row.material_commitment), legacyUncommittedMaterial)) {
    if (row.key_version !== "v1")
      throw new Error(`Fallback-code HMAC key version ${row.key_version} has no committed material.`);
    await tx.unsafe("UPDATE scoring_fallback_code_hmac_key_versions SET material_commitment=$2 WHERE key_version=$1", [
      row.key_version,
      wanted,
    ]);
    return;
  }
  if (!equal(Buffer.from(row.material_commitment), wanted))
    throw new Error(`Configured fallback-code HMAC key version ${row.key_version} has different key material.`);
}
function assertNoMaterialReuse(rows: readonly Row[], key: ScoringFallbackHmacKey): void {
  const wanted = commitment(key.secret);
  const duplicate = rows.find(
    (row) =>
      row.key_version !== key.version &&
      !equal(Buffer.from(row.material_commitment), legacyUncommittedMaterial) &&
      equal(Buffer.from(row.material_commitment), wanted),
  );
  if (duplicate) {
    throw new Error(
      `Configured fallback-code HMAC key version ${key.version} reuses material committed to ${duplicate.key_version}.`,
    );
  }
}
async function audit(
  tx: PostgresJsSql,
  input: {
    requestId: string;
    actorType: "system" | "platform_admin";
    accountId?: string;
    action: string;
    keyVersion: string;
    reason?: string;
    now: Date;
  },
): Promise<void> {
  await tx.unsafe(
    `INSERT INTO audit_events(occurred_at,request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id,reason,before_state,after_state,metadata)
    VALUES($1,$2,$3,$4,NULL,$5,'scoring_fallback_code_hmac_key_version',$6,$7,NULL,jsonb_build_object('key_version',$6::text), '{}'::jsonb)`,
    [
      input.now,
      input.requestId,
      input.accountId ?? null,
      input.actorType,
      input.action,
      input.keyVersion,
      input.reason ?? null,
    ],
  );
}
function snapshot(keyring: ScoringFallbackHmacKeyring, rows: readonly Row[]): ScoringFallbackHmacKeyringSnapshot {
  return {
    primaryVersion: keyring.primary.version,
    verificationOnlyVersions: keyring.verificationOnly.map((key) => key.version),
    registeredVersions: rows.map((row) => ({ version: row.key_version, status: row.status })),
  };
}
/** Startup reconciliation registers candidates but refuses an implicit promotion or retirement. */
export async function reconcileScoringFallbackHmacKeyring(
  sql: PostgresJsSql,
  keyring: ScoringFallbackHmacKeyring,
  now = new Date(),
): Promise<ScoringFallbackHmacKeyringSnapshot> {
  return transaction(sql)(async (tx) => {
    const rows = await lockedRows(tx);
    const byVersion = new Map(rows.map((row) => [row.key_version, row]));
    const configured = new Map([keyring.primary, ...keyring.verificationOnly].map((key) => [key.version, key]));
    for (const row of rows)
      if (row.status !== "retired" && !configured.has(row.key_version))
        throw new Error(
          `Configured fallback-code HMAC keyring omits non-retired key version ${row.key_version}; retire it explicitly first.`,
        );
    for (const key of configured.values()) assertNoMaterialReuse(rows, key);
    for (const key of keyring.verificationOnly) {
      const row = byVersion.get(key.version);
      if (row?.status === "retired")
        throw new Error(`Configured fallback-code HMAC key version ${key.version} is retired.`);
      if (!row) {
        await tx.unsafe(
          "INSERT INTO scoring_fallback_code_hmac_key_versions(key_version,material_commitment,status,activated_at,verification_only_since) VALUES($1,$2,'verification_only',$3,$3)",
          [key.version, commitment(key.secret), now],
        );
        await audit(tx, {
          requestId: `system:scoring-fallback-hmac-key:${key.version}:introduced`,
          actorType: "system",
          action: "scoring_fallback_hmac_key.introduced",
          keyVersion: key.version,
          now,
        });
      } else {
        await assertMaterial(tx, row, key);
      }
    }
    const primary = byVersion.get(keyring.primary.version);
    if (!primary)
      throw new Error(
        `Configured fallback-code HMAC primary ${keyring.primary.version} is unregistered; introduce it as verification-only before promotion.`,
      );
    if (primary.status !== "primary")
      throw new Error(
        `Configured fallback-code HMAC primary ${keyring.primary.version} is not durably promoted; use the explicit promotion action first.`,
      );
    await assertMaterial(tx, primary, keyring.primary);
    return snapshot(keyring, await lockedRows(tx));
  });
}
async function requireAdmin(tx: PostgresJsSql, accountId: string, now: Date): Promise<void> {
  const row = (
    await tx.unsafe<{ account_id: string }>(
      "SELECT account_id FROM account_platform_roles WHERE account_id=$1 AND role='platform_admin' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$2)",
      [accountId, now],
    )
  )[0];
  if (!row) throw new ApiError(403, "PLATFORM_ADMIN_REQUIRED", "Platform administrator access required");
}
export async function promoteScoringFallbackHmacKeyVersion(
  sql: PostgresJsSql,
  input: {
    keyVersion: string;
    accountId: string;
    requestId: string;
    reason: string;
    configuredKeyring: ScoringFallbackHmacKeyring;
  },
  now = new Date(),
): Promise<void> {
  await transaction(sql)(async (tx) => {
    await requireAdmin(tx, input.accountId, now);
    const rows = await lockedRows(tx);
    const next = rows.find((row) => row.key_version === input.keyVersion);
    const configured = input.configuredKeyring.verificationOnly.find((key) => key.version === input.keyVersion);
    if (!next || !configured)
      throw new ApiError(
        409,
        "FALLBACK_HMAC_KEY_VERSION_UNKNOWN",
        "Fallback-code HMAC key version must be configured verification-only before promotion",
      );
    if (next.status !== "verification_only")
      throw new ApiError(
        409,
        next.status === "retired" ? "FALLBACK_HMAC_KEY_VERSION_RETIRED" : "FALLBACK_HMAC_KEY_VERSION_ACTIVE_STATE",
        "Fallback-code HMAC key version is not eligible for promotion",
      );
    await assertMaterial(tx, next, configured);
    const previous = rows.find((row) => row.status === "primary");
    if (!previous) throw new Error("Fallback-code HMAC registry has no primary version.");
    await tx.unsafe(
      "UPDATE scoring_fallback_code_hmac_key_versions SET status='verification_only',verification_only_since=$2 WHERE key_version=$1",
      [previous.key_version, now],
    );
    await tx.unsafe(
      "UPDATE scoring_fallback_code_hmac_key_versions SET status='primary',verification_only_since=NULL,retired_at=NULL WHERE key_version=$1",
      [next.key_version],
    );
    await audit(tx, {
      requestId: input.requestId,
      actorType: "platform_admin",
      accountId: input.accountId,
      action: "scoring_fallback_hmac_key.promoted",
      keyVersion: next.key_version,
      reason: input.reason,
      now,
    });
    await audit(tx, {
      requestId: input.requestId,
      actorType: "platform_admin",
      accountId: input.accountId,
      action: "scoring_fallback_hmac_key.verification_only",
      keyVersion: previous.key_version,
      reason: input.reason,
      now,
    });
  });
}
export async function retireScoringFallbackHmacKeyVersion(
  sql: PostgresJsSql,
  input: { keyVersion: string; accountId: string; requestId: string; reason: string },
  now = new Date(),
): Promise<void> {
  const blocked = await transaction(sql)(async (tx) => {
    await requireAdmin(tx, input.accountId, now);
    const rows = await lockedRows(tx);
    const row = rows.find((candidate) => candidate.key_version === input.keyVersion);
    if (!row) throw new ApiError(409, "FALLBACK_HMAC_KEY_VERSION_UNKNOWN", "Fallback-code HMAC key version is unknown");
    if (row.status === "retired")
      throw new ApiError(409, "FALLBACK_HMAC_KEY_VERSION_RETIRED", "Fallback-code HMAC key version is already retired");
    if (row.status === "primary")
      throw new ApiError(
        409,
        "FALLBACK_HMAC_KEY_VERSION_PRIMARY",
        "Fallback-code HMAC key version must be verification-only before retirement",
      );
    await audit(tx, {
      requestId: input.requestId,
      actorType: "platform_admin",
      accountId: input.accountId,
      action: "scoring_fallback_hmac_key.retirement_attempted",
      keyVersion: row.key_version,
      reason: input.reason,
      now,
    });
    const active = (
      await tx.unsafe<{ id: string }>(
        "SELECT id FROM scoring_access_passes WHERE fallback_code_hmac_key_version=$1 AND short_code_hash IS NOT NULL AND revoked_at IS NULL AND expires_at>$2 LIMIT 1",
        [row.key_version, now],
      )
    )[0];
    if (active) {
      await audit(tx, {
        requestId: input.requestId,
        actorType: "platform_admin",
        accountId: input.accountId,
        action: "scoring_fallback_hmac_key.retirement_blocked",
        keyVersion: row.key_version,
        reason: input.reason,
        now,
      });
      return true;
    }
    await tx.unsafe(
      "UPDATE scoring_fallback_code_hmac_key_versions SET status='retired',retired_at=$2 WHERE key_version=$1",
      [row.key_version, now],
    );
    await audit(tx, {
      requestId: input.requestId,
      actorType: "platform_admin",
      accountId: input.accountId,
      action: "scoring_fallback_hmac_key.retired",
      keyVersion: row.key_version,
      reason: input.reason,
      now,
    });
    return false;
  });
  if (blocked)
    throw new ApiError(
      409,
      "FALLBACK_HMAC_KEY_RETIREMENT_BLOCKED",
      "Fallback-code HMAC key version still protects unexpired, unrevoked access passes",
    );
}
