#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export const VALID_COMPETITION_STATUSES = new Set([
  "draft",
  "ready",
  "published",
  "active",
  "live",
  "completed",
  "archived",
]);

export const ACTIVE_COMPETITION_STATUSES = new Set(["active", "live"]);

export const SCORING_IN_PROGRESS_STATE = "in_progress";

export const VALID_MATCH_STATES = new Set(["pending", "ready", "in_progress", "final", "corrected"]);

export const VALID_DELIVERY_STATUSES = new Set(["delivered", "acknowledged", "confirmed"]);

export function parseEnvContent(content) {
  const env = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

export async function parseEnvFile(filePath) {
  if (!filePath || !existsSync(filePath)) return {};
  try {
    const content = await readFile(filePath, "utf8");
    return parseEnvContent(content);
  } catch {
    return {};
  }
}

export function timingSafeEqualStrings(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (!a || !b) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  try {
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Authoritative production database freeze provider.
 * Strictly queries PostgreSQL via Docker Compose; never accepts synthetic or mock environment inputs.
 */
export function createProductionFreezeProvider(env = {}, options = {}) {
  return {
    async getSnapshot() {
      const postgresUser = env.POSTGRES_USER || process.env.POSTGRES_USER || "matchday";
      const postgresDb = env.POSTGRES_DB || process.env.POSTGRES_DB || "matchday_prod";
      const envFile = options.envFile || (existsSync("infra/oci/.env.prod") ? "infra/oci/.env.prod" : null);

      const sql = `SELECT json_build_object(
        'timestamp', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'competitions', COALESCE((SELECT json_agg(json_build_object('id', id, 'name', name, 'status', status)) FROM competitions), '[]'::json),
        'scoringMatches', COALESCE((SELECT json_agg(json_build_object('id', id, 'competition_id', competition_id, 'state', state)) FROM matches WHERE state = 'in_progress'), '[]'::json)
      );`;

      const composeArgs = [
        "compose",
        ...(envFile ? ["--env-file", envFile] : []),
        "-f",
        "infra/oci/compose.prod.yaml",
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        postgresUser,
        "-d",
        postgresDb,
        "-t",
        "-A",
        "-c",
        sql,
      ];

      return new Promise((resolve, reject) => {
        const timeoutMs = options.timeoutMs ?? 10_000;
        const proc = spawn("docker", composeArgs, {
          timeout: timeoutMs,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        proc.stderr.on("data", (chunk) => {
          stderr += chunk;
        });

        proc.on("error", (err) => {
          reject(new Error(`DATABASE_UNAVAILABLE: Failed executing docker compose psql: ${err.message}`));
        });

        proc.on("close", (code) => {
          if (code !== 0) {
            return reject(new Error(`DATABASE_UNAVAILABLE: Database query failed (exit ${code}): ${stderr.trim()}`));
          }
          const trimmed = stdout.trim();
          if (!trimmed) {
            return reject(new Error("EMPTY_PROVIDER_RESPONSE: Database query returned empty response"));
          }
          let data;
          try {
            data = JSON.parse(trimmed);
          } catch (parseErr) {
            return reject(new Error(`INVALID_JSON: Failed parsing database snapshot JSON: ${parseErr.message}`));
          }
          if (!data || typeof data !== "object") {
            return reject(new Error("INVALID_PROVIDER_RESPONSE: Provider returned non-object response"));
          }
          if (!Array.isArray(data.competitions)) {
            return reject(new Error("MISSING_COMPETITION_DATA: competitions array is missing"));
          }
          if (!Array.isArray(data.scoringMatches)) {
            return reject(new Error("MISSING_COMPETITION_DATA: scoringMatches array is missing"));
          }
          resolve(data);
        });
      });
    },
  };
}

/**
 * Evaluates the OPS-015 deployment freeze policy.
 *
 * @param {object} options
 * @param {object|null} customProvider Dependency-injected provider (used only in unit tests)
 */
export async function evaluateDeploymentFreeze(options = {}, customProvider = null) {
  const env = { ...(options.env || {}) };

  // 1. Genuine Emergency Rollback Exemption
  // Environment flags (MATCHDAY_EMERGENCY_ROLLBACK, ROLLBACK_IN_PROGRESS) MUST NOT independently authorize deployment.
  // Only an explicit programmatic isRollbackOperation flag (or emergencyRollback option passed by caller code) is permitted.
  if (options.isRollbackOperation === true || options.emergencyRollback === true) {
    return {
      disposition: "ALLOWED_SAFELY",
      status: "ALLOW",
      code: "EMERGENCY_ROLLBACK",
      reason: "Emergency rollback active: deployment freeze bypassed safely to restore healthy release",
      allowed: true,
      overrideApplied: false,
      timestamp: new Date().toISOString(),
      details: { emergencyRollback: true },
    };
  }

  // 2. Query freeze snapshot from authoritative provider (fail-closed if unavailable)
  const provider = customProvider || createProductionFreezeProvider(options.parsedEnv || env, options);
  let snapshot;
  try {
    snapshot = await provider.getSnapshot();
    if (!snapshot || typeof snapshot !== "object") {
      throw new Error("Provider returned non-object snapshot");
    }
    if (!Array.isArray(snapshot.competitions) && !Array.isArray(snapshot.activeCompetitions)) {
      throw new Error("MISSING_COMPETITION_DATA: Snapshot lacks competitions array");
    }
    if (!Array.isArray(snapshot.scoringMatches)) {
      throw new Error("MISSING_COMPETITION_DATA: Snapshot lacks scoringMatches array");
    }
  } catch (err) {
    return {
      disposition: "BLOCK",
      status: "BLOCK",
      code: "FREEZE_PROVIDER_UNAVAILABLE",
      reason: `Freeze provider unavailable or query failed: ${err?.message || "Unknown provider error"}`,
      allowed: false,
      overrideApplied: false,
      timestamp: new Date().toISOString(),
      details: { error: err?.message },
    };
  }

  // 3. Stale Freeze Information Check
  if (!snapshot.timestamp || isNaN(new Date(snapshot.timestamp).getTime())) {
    return {
      disposition: "BLOCK",
      status: "BLOCK",
      code: "STALE_FREEZE_INFORMATION",
      reason: "Freeze snapshot timestamp is missing or unparseable",
      allowed: false,
      overrideApplied: false,
      timestamp: new Date().toISOString(),
      details: { snapshotTimestamp: snapshot.timestamp },
    };
  }

  const snapshotTime = new Date(snapshot.timestamp).getTime();
  const now = options.now !== undefined ? new Date(options.now).getTime() : Date.now();
  const maxAgeMs = options.maxAgeMs ?? 60_000;
  const ageMs = now - snapshotTime;

  if (ageMs > maxAgeMs) {
    return {
      disposition: "BLOCK",
      status: "BLOCK",
      code: "STALE_FREEZE_INFORMATION",
      reason: `Freeze snapshot is stale: age ${Math.round(ageMs / 1000)}s exceeds threshold of ${Math.round(maxAgeMs / 1000)}s`,
      allowed: false,
      overrideApplied: false,
      timestamp: new Date().toISOString(),
      details: { snapshotTimestamp: snapshot.timestamp, ageMs, maxAgeMs },
    };
  }

  if (ageMs < -30_000) {
    return {
      disposition: "BLOCK",
      status: "BLOCK",
      code: "STALE_FREEZE_INFORMATION",
      reason: `Freeze snapshot timestamp is in the future (${Math.round(-ageMs / 1000)}s ahead)`,
      allowed: false,
      overrideApplied: false,
      timestamp: new Date().toISOString(),
      details: { snapshotTimestamp: snapshot.timestamp, ageMs },
    };
  }

  // 4. Unknown Competition and Match State Checks
  const allCompetitions = snapshot.competitions || snapshot.activeCompetitions || [];
  const unknownCompetitions = [];

  if (Array.isArray(snapshot.unknownStateCompetitions)) {
    unknownCompetitions.push(...snapshot.unknownStateCompetitions);
  }

  for (const comp of allCompetitions) {
    if (!comp.status || !VALID_COMPETITION_STATUSES.has(comp.status)) {
      unknownCompetitions.push(comp);
    }
  }

  if (unknownCompetitions.length > 0) {
    const invalidStatuses = unknownCompetitions.map((c) => `${c.id || "comp"}:${c.status}`);
    return {
      disposition: "BLOCK",
      status: "BLOCK",
      code: "UNKNOWN_COMPETITION_STATE",
      reason: `Unknown competition state detected: ${invalidStatuses.join(", ")}`,
      allowed: false,
      overrideApplied: false,
      timestamp: new Date().toISOString(),
      details: { unknownCompetitions },
    };
  }

  const scoringMatches = snapshot.scoringMatches || [];
  for (const match of scoringMatches) {
    if (!match.state || !VALID_MATCH_STATES.has(match.state)) {
      return {
        disposition: "BLOCK",
        status: "BLOCK",
        code: "UNKNOWN_COMPETITION_STATE",
        reason: `Unknown match state detected: ${match.id || "match"}:${match.state}`,
        allowed: false,
        overrideApplied: false,
        timestamp: new Date().toISOString(),
        details: { match },
      };
    }
  }

  // 5. Active Competitions and Scoring Matches Detection
  const activeCompetitions =
    snapshot.activeCompetitions && snapshot.activeCompetitions.length > 0
      ? snapshot.activeCompetitions
      : allCompetitions.filter((c) => ACTIVE_COMPETITION_STATUSES.has(c.status));

  let freezeViolation = null;
  if (scoringMatches.length > 0) {
    freezeViolation = {
      code: "SCORING_IN_PROGRESS",
      reason: `Live match scoring is currently in progress (${scoringMatches.length} match(es) active)`,
    };
  } else if (activeCompetitions.length >= 2) {
    freezeViolation = {
      code: "MULTIPLE_ACTIVE_COMPETITIONS",
      reason: `Multiple active competitions currently in progress (${activeCompetitions.length} active competitions)`,
    };
  } else if (activeCompetitions.length === 1) {
    freezeViolation = {
      code: "ACTIVE_COMPETITION",
      reason: `Active competition currently in progress (${activeCompetitions[0].name || activeCompetitions[0].id})`,
    };
  }

  // 6. Authorised Exceptions Evaluation
  const overrideRequested =
    options.overrideRequested === true || env.DEPLOY_FREEZE_OVERRIDE === "1" || env.DEPLOY_FREEZE_OVERRIDE === "true";

  if (overrideRequested) {
    // 6a. Reject caller-supplied boolean without verifiable notification evidence
    const hasCallerBoolOnly =
      (options.organiserNotified === true ||
        env.DEPLOY_FREEZE_ORGANISER_NOTIFIED === "true" ||
        env.DEPLOY_FREEZE_ORGANISER_NOTIFIED === "1") &&
      !options.notificationEvidence &&
      !env.DEPLOY_FREEZE_NOTIFICATION_EVIDENCE;

    if (hasCallerBoolOnly) {
      return {
        disposition: "BLOCK",
        status: "BLOCK",
        code: "CALLER_NOTIFICATION_BOOLEAN_ONLY",
        reason: "Caller-supplied organiser notification boolean rejected: verifiable notification record required",
        allowed: false,
        overrideApplied: false,
        timestamp: new Date().toISOString(),
        details: { activeCompetitions, scoringMatches },
      };
    }

    // 6b. Operator Authorisation validation
    // Trusted secret MUST be sourced exclusively from server .env.prod. Never fall back to scoring HMAC secret.
    const trustedServerSecret = options.parsedEnv?.DEPLOY_FREEZE_OVERRIDE_SECRET;
    const hasTrustedSecret = typeof trustedServerSecret === "string" && trustedServerSecret.trim().length > 0;

    // Provided authorization
    let authObj = options.authorization || null;
    if (!authObj && env.DEPLOY_FREEZE_AUTHORIZATION) {
      try {
        authObj = JSON.parse(env.DEPLOY_FREEZE_AUTHORIZATION);
      } catch {
        authObj = null;
      }
    }

    const providedSecret =
      authObj?.token ||
      options.overrideSecret ||
      options.overrideToken ||
      env.DEPLOY_FREEZE_OVERRIDE_TOKEN ||
      env.DEPLOY_FREEZE_OVERRIDE_SECRET_TOKEN ||
      env.DEPLOY_FREEZE_OVERRIDE_SECRET;

    const operatorId =
      authObj?.operator_id || authObj?.operator_identity || options.operatorId || env.DEPLOY_FREEZE_OPERATOR_ID;

    const overrideReason = (
      authObj?.reason ||
      options.overrideReason ||
      env.DEPLOY_FREEZE_OVERRIDE_REASON ||
      ""
    ).trim();

    const overrideScope = authObj?.scope || options.overrideScope || env.DEPLOY_FREEZE_OVERRIDE_SCOPE || "all";

    const validUntil = authObj?.valid_until || authObj?.expires_at || options.validUntil;

    // Check operator identity
    if (!operatorId || typeof operatorId !== "string" || operatorId.trim().length === 0) {
      return {
        disposition: "BLOCK",
        status: "BLOCK",
        code: "MISSING_OPERATOR_AUTHORIZATION",
        reason: "Missing authorised operator or service identity in deployment override request",
        allowed: false,
        overrideApplied: false,
        timestamp: new Date().toISOString(),
        details: { activeCompetitions, scoringMatches },
      };
    }

    // Check trusted secret match
    const secretValid =
      hasTrustedSecret &&
      typeof providedSecret === "string" &&
      providedSecret.trim().length > 0 &&
      timingSafeEqualStrings(trustedServerSecret, providedSecret);

    if (!secretValid) {
      return {
        disposition: "BLOCK",
        status: "BLOCK",
        code: "UNAUTHORISED_OVERRIDE",
        reason: "Unauthorized deployment freeze override rejected: invalid or missing override secret",
        allowed: false,
        overrideApplied: false,
        timestamp: new Date().toISOString(),
        details: { activeCompetitions, scoringMatches },
      };
    }

    // Check reason minimum length
    if (overrideReason.length < 8) {
      return {
        disposition: "BLOCK",
        status: "BLOCK",
        code: "UNAUTHORISED_OVERRIDE",
        reason:
          "Unauthorized deployment freeze override rejected: missing or insufficient override reason (minimum 8 characters)",
        allowed: false,
        overrideApplied: false,
        timestamp: new Date().toISOString(),
        details: { activeCompetitions, scoringMatches },
      };
    }

    // Check expiration / time-limit
    if (validUntil) {
      const expTime = new Date(validUntil).getTime();
      if (isNaN(expTime) || now > expTime) {
        return {
          disposition: "BLOCK",
          status: "BLOCK",
          code: "EXPIRED_AUTHORIZATION",
          reason: `Override authorization expired at ${validUntil}`,
          allowed: false,
          overrideApplied: false,
          timestamp: new Date().toISOString(),
          details: { validUntil, now: new Date(now).toISOString() },
        };
      }
    }

    // Check scope covers all active competitions
    if (overrideScope !== "all") {
      const allowedCompIds = new Set(
        Array.isArray(overrideScope) ? overrideScope : overrideScope.split(",").map((s) => s.trim()),
      );
      const uncovered = activeCompetitions.filter((c) => !allowedCompIds.has(c.id));
      if (uncovered.length > 0) {
        return {
          disposition: "BLOCK",
          status: "BLOCK",
          code: "INVALID_OVERRIDE_SCOPE",
          reason: `Override scope does not cover active competition(s): ${uncovered.map((c) => c.id).join(", ")}`,
          allowed: false,
          overrideApplied: false,
          timestamp: new Date().toISOString(),
          details: { uncovered },
        };
      }
    }

    // 6c. Organiser Notification Evidence validation
    let notifEvidence = options.notificationEvidence || null;
    if (!notifEvidence && env.DEPLOY_FREEZE_NOTIFICATION_EVIDENCE) {
      try {
        notifEvidence = JSON.parse(env.DEPLOY_FREEZE_NOTIFICATION_EVIDENCE);
      } catch {
        notifEvidence = null;
      }
    }

    if (!notifEvidence || typeof notifEvidence !== "object") {
      return {
        disposition: "BLOCK",
        status: "BLOCK",
        code: "MISSING_NOTIFICATION_EVIDENCE",
        reason: "Verifiable organiser notification evidence record is missing",
        allowed: false,
        overrideApplied: false,
        timestamp: new Date().toISOString(),
        details: { activeCompetitions, scoringMatches },
      };
    }

    const {
      notification_id,
      competition_id,
      recipient_or_organiser_reference,
      notification_timestamp,
      delivery_or_acknowledgement_status,
      evidence_source,
    } = notifEvidence;

    const notifTime = new Date(notification_timestamp).getTime();
    const isNotifTimeValid =
      notification_timestamp && !isNaN(notifTime) && notifTime <= now + 30_000 && notifTime >= now - 86_400_000;

    const isDeliveryStatusValid =
      typeof delivery_or_acknowledgement_status === "string" &&
      VALID_DELIVERY_STATUSES.has(delivery_or_acknowledgement_status.toLowerCase());

    const isNotifScopeValid =
      competition_id === "all" ||
      activeCompetitions.length === 0 ||
      activeCompetitions.some((c) => c.id === competition_id);

    if (
      !notification_id ||
      typeof notification_id !== "string" ||
      !competition_id ||
      !recipient_or_organiser_reference ||
      !evidence_source ||
      !isNotifTimeValid ||
      !isDeliveryStatusValid ||
      !isNotifScopeValid
    ) {
      return {
        disposition: "BLOCK",
        status: "BLOCK",
        code: "INVALID_NOTIFICATION_EVIDENCE",
        reason: "Organiser notification evidence is malformed, unconfirmed, or does not match active competition scope",
        allowed: false,
        overrideApplied: false,
        timestamp: new Date().toISOString(),
        details: { notifEvidence, isNotifTimeValid, isDeliveryStatusValid, isNotifScopeValid },
      };
    }

    // A caller-supplied "delivered" payload is NOT independently authenticated
    // evidence of organiser notification. This code has no trusted delivery-provider
    // lookup, authority-bound expiry/scope verification, or replay-protected nonce
    // ledger. Do not enable forward-deployment exceptions until those exist.
    // OPS-002's internal emergency rollback remains a separate control path.
    return {
      disposition: "BLOCK",
      status: "BLOCK",
      code: "OVERRIDE_EVIDENCE_NOT_VERIFIABLE",
      reason:
        "Forward deployment override disabled: notification delivery and replay-safe authorization are not independently verifiable",
      allowed: false,
      overrideApplied: false,
      timestamp: new Date().toISOString(),
      details: { activeCompetitions, scoringMatches },
    };
  }

  // 7. No override requested: if freeze violation exists, BLOCK
  if (freezeViolation) {
    return {
      disposition: "BLOCK",
      status: "BLOCK",
      code: freezeViolation.code,
      reason: freezeViolation.reason,
      allowed: false,
      overrideApplied: false,
      timestamp: new Date().toISOString(),
      details: {
        activeCompetitions,
        scoringMatches,
      },
    };
  }

  // 8. Zero active competitions verified
  return {
    disposition: "ALLOW",
    status: "ALLOW",
    code: "NO_ACTIVE_COMPETITION",
    reason: "No active competitions or scoring in progress; deployment freeze not active",
    allowed: true,
    overrideApplied: false,
    timestamp: new Date().toISOString(),
    details: {
      activeCompetitions: [],
      scoringMatches: [],
    },
  };
}

/**
 * Durably writes an audit receipt.
 * Fails closed by throwing if writing fails.
 */
export async function writeFreezeReceipt(result, options = {}) {
  const artifactsDir = options.artifactsDir || path.resolve("artifacts");
  try {
    await mkdir(artifactsDir, { recursive: true });
    const receiptPath = path.join(artifactsDir, "deployment-freeze-receipt.json");
    const tmpPath = path.join(artifactsDir, `.freeze-receipt.${process.pid}.${Date.now()}.tmp`);
    const payload = {
      qa_item: "OPS-015",
      policy: "deployment-freeze",
      timestamp: result.timestamp,
      candidate_sha: options.candidateSha || process.env.CANDIDATE_SHA || null,
      disposition: result.disposition,
      status: result.status,
      code: result.code,
      allowed: result.allowed,
      override_applied: result.overrideApplied,
      reason: result.reason,
      operator_identity: result.details?.operator_id || null,
      authorisation_reference: result.details?.authorization_reference || null,
      competition_scope: result.details?.scope || null,
      notification_reference: result.details?.notification_id || null,
      details: result.details,
    };
    await writeFile(tmpPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await rename(tmpPath, receiptPath);
    return receiptPath;
  } catch (err) {
    throw new Error(`AUDIT_RECEIPT_WRITE_FAILURE: Failed writing durable freeze receipt: ${err.message}`);
  }
}

// CLI runner
const isDirectExecution = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectExecution) {
  const args = process.argv.slice(2);
  let envFile = "infra/oci/.env.prod";
  if (args.length > 0 && !args[0].startsWith("-")) {
    envFile = args[0];
  }

  const parsedEnv = existsSync(envFile) ? await parseEnvFile(envFile) : {};

  const options = {
    envFile,
    parsedEnv,
    candidateSha: process.env.CANDIDATE_SHA || null,
    env: { ...process.env },
  };

  evaluateDeploymentFreeze(options)
    .then(async (result) => {
      try {
        await writeFreezeReceipt(result, options);
      } catch (receiptErr) {
        console.error(`[deployment-freeze] FATAL: ${receiptErr.message}`);
        process.exit(1);
      }

      if (result.allowed) {
        console.log(`[deployment-freeze] ${result.disposition} (${result.code}): ${result.reason}`);
        process.exit(0);
      } else {
        console.error(`[deployment-freeze] FATAL: Deployment blocked by freeze policy: ${result.code}`);
        console.error(`[deployment-freeze] REASON: ${result.reason}`);
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(`[deployment-freeze] FATAL: Unhandled freeze evaluation exception: ${err.message}`);
      process.exit(1);
    });
}
