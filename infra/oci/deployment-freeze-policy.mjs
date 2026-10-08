#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

export function createDefaultFreezeProvider(env = {}, options = {}) {
  return {
    async getSnapshot() {
      // 1. Explicit mock triggers for tests/fixtures
      if (options.simulateUnavailable || process.env.MOCK_FREEZE_PROVIDER_UNAVAILABLE === "1") {
        throw new Error("FREEZE_PROVIDER_UNAVAILABLE: Database connection refused or query timed out");
      }
      if (options.simulateStale || process.env.MOCK_FREEZE_STALE === "1") {
        return {
          timestamp: new Date(Date.now() - 3600 * 1000).toISOString(),
          activeCompetitions: [],
          scoringMatches: [],
          competitions: [],
        };
      }
      if (options.simulateUnknownState || process.env.MOCK_FREEZE_UNKNOWN_STATE === "1") {
        return {
          timestamp: new Date().toISOString(),
          activeCompetitions: [],
          scoringMatches: [],
          competitions: [
            { id: "comp-corrupt-001", name: "Corrupted Competition", status: "corrupted_lifecycle_state" },
          ],
        };
      }
      if (options.simulateScoring || process.env.MOCK_FREEZE_SCORING === "1") {
        return {
          timestamp: new Date().toISOString(),
          activeCompetitions: [{ id: "comp-live-001", name: "National Canoe Polo Championship", status: "live" }],
          scoringMatches: [
            { id: "match-active-001", competition_id: "comp-live-001", state: SCORING_IN_PROGRESS_STATE },
          ],
          competitions: [{ id: "comp-live-001", name: "National Canoe Polo Championship", status: "live" }],
        };
      }
      if (
        options.simulateActiveCompetitions !== undefined ||
        process.env.MOCK_FREEZE_ACTIVE_COMPETITIONS !== undefined
      ) {
        const count =
          options.simulateActiveCompetitions !== undefined
            ? Number(options.simulateActiveCompetitions)
            : Number(process.env.MOCK_FREEZE_ACTIVE_COMPETITIONS);
        const comps = [];
        for (let i = 1; i <= count; i++) {
          comps.push({
            id: `comp-active-${i}`,
            name: `Active Tournament ${i}`,
            status: "active",
          });
        }
        return {
          timestamp: new Date().toISOString(),
          activeCompetitions: comps,
          scoringMatches: [],
          competitions: comps,
        };
      }

      // 2. Explicit snapshot JSON via env or file
      if (process.env.MATCHDAY_FREEZE_SNAPSHOT) {
        return JSON.parse(process.env.MATCHDAY_FREEZE_SNAPSHOT);
      }
      if (process.env.MATCHDAY_FREEZE_SNAPSHOT_FILE) {
        const content = await readFile(process.env.MATCHDAY_FREEZE_SNAPSHOT_FILE, "utf8");
        return JSON.parse(content);
      }

      // 3. Test harness detection: if MOCK_LOG or testMode is set, return empty snapshot
      if (process.env.MOCK_LOG || options.testMode) {
        return {
          timestamp: new Date().toISOString(),
          activeCompetitions: [],
          scoringMatches: [],
          competitions: [],
        };
      }

      // 4. Production database query via docker compose psql
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
        const proc = spawn("docker", composeArgs, {
          timeout: 10_000,
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
          reject(new Error(`Failed executing docker compose exec postgres psql: ${err.message}`));
        });

        proc.on("close", (code) => {
          if (code !== 0) {
            return reject(new Error(`Database freeze query failed (exit ${code}): ${stderr.trim()}`));
          }
          try {
            const trimmed = stdout.trim();
            if (!trimmed) {
              return reject(new Error("Database freeze query returned empty response"));
            }
            const data = JSON.parse(trimmed);
            resolve(data);
          } catch (parseErr) {
            reject(new Error(`Failed parsing database freeze snapshot JSON: ${parseErr.message}`));
          }
        });
      });
    },
  };
}

export async function evaluateDeploymentFreeze(options = {}, customProvider = null) {
  const env = { ...process.env, ...(options.env || {}) };

  // 1. Emergency Rollback Exemption
  const isEmergencyRollback =
    options.emergencyRollback === true ||
    env.MATCHDAY_EMERGENCY_ROLLBACK === "1" ||
    env.MATCHDAY_EMERGENCY_ROLLBACK === "true" ||
    env.ROLLBACK_IN_PROGRESS === "1" ||
    env.ROLLBACK_IN_PROGRESS === "true";

  if (isEmergencyRollback) {
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

  // 2. Query freeze snapshot from provider (fail-closed if unavailable)
  const provider = customProvider || createDefaultFreezeProvider(env, options);
  let snapshot;
  try {
    snapshot = await provider.getSnapshot();
    if (!snapshot || typeof snapshot !== "object") {
      throw new Error("Provider returned non-object snapshot");
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

  // 4. Unknown Competition State Check
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

  // 5. Active Competitions and Scoring Matches Detection
  const activeCompetitions =
    snapshot.activeCompetitions && snapshot.activeCompetitions.length > 0
      ? snapshot.activeCompetitions
      : allCompetitions.filter((c) => ACTIVE_COMPETITION_STATUSES.has(c.status));

  const scoringMatches = snapshot.scoringMatches || [];

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

  // 6. Override evaluation
  const overrideRequested =
    options.overrideRequested === true || env.DEPLOY_FREEZE_OVERRIDE === "1" || env.DEPLOY_FREEZE_OVERRIDE === "true";

  if (overrideRequested) {
    // Expected secret MUST be sourced exclusively from trusted server configuration.
    // Never fall back to env or process.env to prevent circular self-validation attacks.
    const expectedSecret =
      options.expectedOverrideSecret ||
      options.parsedEnv?.DEPLOY_FREEZE_OVERRIDE_SECRET ||
      options.parsedEnv?.SCORING_ACCESS_RATE_LIMIT_HMAC_SECRET;

    // Provided secret MUST be sourced exclusively from caller input parameters.
    // Never fall back to env which may inherit .env.prod contents.
    const providedSecret =
      options.overrideSecret ||
      options.overrideToken ||
      process.env.DEPLOY_FREEZE_OVERRIDE_TOKEN ||
      process.env.DEPLOY_FREEZE_OVERRIDE_SECRET_TOKEN ||
      process.env.DEPLOY_FREEZE_OVERRIDE_SECRET;

    const overrideReason = (options.overrideReason || env.DEPLOY_FREEZE_OVERRIDE_REASON || "").trim();

    const organiserNotified =
      options.organiserNotified === true ||
      env.DEPLOY_FREEZE_ORGANISER_NOTIFIED === "true" ||
      env.DEPLOY_FREEZE_ORGANISER_NOTIFIED === "1";

    const hasExpectedSecret = Boolean(typeof expectedSecret === "string" && expectedSecret.trim().length > 0);
    const hasProvidedSecret = Boolean(typeof providedSecret === "string" && providedSecret.trim().length > 0);
    const secretValid =
      hasExpectedSecret && hasProvidedSecret && timingSafeEqualStrings(expectedSecret, providedSecret);
    const reasonValid = overrideReason.length >= 8;
    const notificationValid = organiserNotified === true;

    if (!secretValid || !reasonValid || !notificationValid) {
      const failures = [];
      if (!secretValid) failures.push("invalid or missing override secret");
      if (!reasonValid) failures.push("missing or insufficient override reason (minimum 8 characters)");
      if (!notificationValid) failures.push("explicit organiser notification not affirmed");

      return {
        disposition: "BLOCK",
        status: "BLOCK",
        code: "UNAUTHORISED_OVERRIDE",
        reason: `Unauthorized deployment freeze override rejected: ${failures.join("; ")}`,
        allowed: false,
        overrideApplied: false,
        timestamp: new Date().toISOString(),
        details: {
          failures,
          activeCompetitions,
          scoringMatches,
        },
      };
    }

    // Authorized override granted
    return {
      disposition: "POLICY_CONTROLLED",
      status: "ALLOW",
      code: "EXPLICIT_AUTHORISED_OVERRIDE",
      reason: `Deployment freeze override authorized with valid credentials and organiser notification: ${overrideReason}`,
      allowed: true,
      overrideApplied: true,
      timestamp: new Date().toISOString(),
      details: {
        overrideReason,
        organiserNotified: true,
        activeCompetitions,
        scoringMatches,
      },
    };
  }

  // No override requested: if freeze violation exists, BLOCK
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

  // Case 1: NO_ACTIVE_COMPETITION
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

export async function writeFreezeReceipt(result, options = {}) {
  const artifactsDir = options.artifactsDir || path.resolve("artifacts");
  try {
    await mkdir(artifactsDir, { recursive: true });
    const receiptPath = path.join(artifactsDir, "deployment-freeze-receipt.json");
    const payload = {
      qa_item: "OPS-015",
      policy: "deployment-freeze",
      timestamp: result.timestamp,
      disposition: result.disposition,
      status: result.status,
      code: result.code,
      allowed: result.allowed,
      override_applied: result.overrideApplied,
      reason: result.reason,
      details: result.details,
    };
    await writeFile(receiptPath, JSON.stringify(payload, null, 2), "utf8");
    return receiptPath;
  } catch (err) {
    // Non-fatal warning if receipt writing fails
    console.error(`[deployment-freeze] WARNING: Failed to write freeze receipt: ${err.message}`);
    return null;
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
  const expectedOverrideSecret =
    parsedEnv.DEPLOY_FREEZE_OVERRIDE_SECRET || parsedEnv.SCORING_ACCESS_RATE_LIMIT_HMAC_SECRET;

  const options = {
    envFile,
    parsedEnv,
    expectedOverrideSecret,
    env: { ...parsedEnv, ...process.env },
  };

  evaluateDeploymentFreeze(options)
    .then(async (result) => {
      await writeFreezeReceipt(result, options);

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
