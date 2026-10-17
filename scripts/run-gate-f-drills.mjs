#!/usr/bin/env node
/**
 * Track R8: Gate F Recertification Drills Orchestrator
 *
 * Implements deliverable R8.5 from docs/EXECUTION_ROADMAP.md:
 * - Executes automated operational drills:
 *   1. Migration expand-contract safety certification
 *   2. Automated zero-downtime rollback drill (with canary fault simulation & scoring availability preserved)
 *   3. Database backup & isolated restore verification
 *   4. Edge cache / CDN purge invalidation drill
 *   5. Ops SLO baseline and alert routing verification
 *   6. DNS/TLS, security, SEO, email, accessibility, and legal recertifications
 *
 * In accordance with ADR 0005 (automated-only-owner-waived-v2):
 * - All machine-verifiable requirements run automated validation.
 * - Human-only and physical-device activities are explicitly recorded as WAIVED_NOT_EXECUTED.
 * - Live production external evidence is audited if present, or marked PENDING without fabrication.
 *
 * Usage:
 *   node scripts/run-gate-f-drills.mjs [<candidate-sha>]
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { certifyGateFMigrations } from "./certify-gate-f-migrations.mjs";
import { runGateFRollbackDrill } from "./run-gate-f-rollback-drill.mjs";
import { runGateFBackupRestoreAudit } from "./run-gate-f-backup-restore-audit.mjs";
import { runGateFCachePurgeAudit } from "./run-gate-f-cache-purge.mjs";
import { runGateFOpsAudit } from "./run-gate-f-ops-audit.mjs";
import { runGateFRecertifications } from "./run-gate-f-recertifications.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultArtifactsDir = path.join(root, "artifacts");

export function resolveCandidateSha(inputSha) {
  if (typeof inputSha === "string" && inputSha.trim().length > 0) {
    const candidate = inputSha.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/i.test(candidate)) {
      throw new Error(`Gate F drills require an exact 40-character candidate SHA; got "${inputSha}"`);
    }
    return candidate;
  }
  const envSha = (process.env.CANDIDATE_SHA ?? "").trim().toLowerCase();
  if (envSha.length > 0) {
    if (!/^[0-9a-f]{40}$/i.test(envSha)) {
      throw new Error(`Gate F drills require an exact 40-character candidate SHA; got "${envSha}" from CANDIDATE_SHA`);
    }
    return envSha;
  }
  try {
    const gitSha = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim().toLowerCase();
    if (/^[0-9a-f]{40}$/i.test(gitSha)) {
      return gitSha;
    }
  } catch {
    // ignore
  }
  throw new Error(
    "Gate F drills require an exact 40-character candidate SHA. Provide via argument, CANDIDATE_SHA env, or ensure running in a Git repository.",
  );
}

export const PENDING_VERDICT = "PENDING_PRODUCTION_DRILLS";

const defaultRunners = {
  certifyGateFMigrations,
  runGateFRollbackDrill,
  runGateFBackupRestoreAudit,
  runGateFCachePurgeAudit,
  runGateFOpsAudit,
  runGateFRecertifications,
};

/**
 * Overall verdict is PASS only when every check executed and reported exactly "PASS".
 * Any FAIL -> FAIL. Anything else (PENDING, NOT_EXECUTED, PASS_WITH_DEFERMENT, ...) -> PENDING_PRODUCTION_DRILLS.
 * The pending verdict intentionally contains no "PASS" substring.
 */
export function deriveOverallVerdict(checks) {
  const entries = Object.entries(checks);
  if (entries.some(([, verdict]) => verdict === "FAIL")) return "FAIL";
  if (entries.length > 0 && entries.every(([, verdict]) => verdict === "PASS")) return "PASS";
  return PENDING_VERDICT;
}

export async function runGateFDrills(candidateSha, options = {}) {
  const sha = resolveCandidateSha(candidateSha);
  const artifactsDir = options.artifactsDir ?? defaultArtifactsDir;
  const log = options.log ?? console.log;
  const runners = { ...defaultRunners, ...(options.runners ?? {}) };
  const {
    certifyGateFMigrations: certifyMigrations,
    runGateFRollbackDrill: runRollback,
    runGateFBackupRestoreAudit: runBackup,
    runGateFCachePurgeAudit: runCache,
    runGateFOpsAudit: runOps,
    runGateFRecertifications: runRecerts,
  } = runners;
  await mkdir(artifactsDir, { recursive: true });

  log("════════════════════════════════════════════════════════════");
  log(" Track R8: Gate F Recertification Drills Suite");
  log(` Candidate SHA:     ${sha}`);
  log(" Assurance Profile: automated-only-owner-waived-v2 (ADR 0005)");
  log("════════════════════════════════════════════════════════════\n");

  // 1. Migration Expand-Contract Certification (OPS-003, OPS-010)
  log("[Drill 1/6] Running Database Migration Expand-Contract Certification...");
  const migrationResult = await certifyMigrations(sha, { artifactsDir });
  log(`  Migrations: ${migrationResult.migration_count} files (${migrationResult.verdict})\n`);

  // 2. Automated Rollback Drill (OPS-002)
  log("[Drill 2/6] Running Automated Zero-Downtime Rollback Drill...");
  const rollbackResult = await runRollback(sha, {
    artifactsDir,
    evidenceFile: options.rollbackEvidenceFile,
  });
  log(
    `  Rollback: ${rollbackResult.simulation_result} (Scoring Availability: ${rollbackResult.scoring_availability})\n`,
  );

  // 3. Backup & Isolated Restore Drill (OPS-001)
  log("[Drill 3/6] Running Database Backup and Isolated Restore Drill...");
  const backupResult = await runBackup(sha, {
    artifactsDir,
    evidenceFile: options.backupEvidenceFile,
  });
  log(`  Backup/Restore Audit Status: ${backupResult.verdict}\n`);

  // 4. CDN / Edge Cache Purge Drill (OPS-009)
  log("[Drill 4/6] Running Edge Cache / CDN Purge Invalidation Drill...");
  const cacheResult = await runCache(sha, {
    artifactsDir,
    evidenceFile: options.cacheEvidenceFile,
  });
  log(`  Cache Invalidation Protocol: ${cacheResult.protocol_verification}\n`);

  // 5. Operations & Alert Routing Drill (OPS-004, OPS-005, OPS-007, OPS-008, OPS-018)
  log("[Drill 5/6] Running Operations Baseline & Alert Routing Drill...");
  const opsResult = await runOps(sha, {
    artifactsDir,
    sloEvidenceFile: options.sloEvidenceFile,
    alertEvidenceFile: options.alertEvidenceFile,
    costEvidenceFile: options.costEvidenceFile,
  });
  log(`  Alert Routing Protocol: ${opsResult.alertRouting.protocol_verification}`);
  log(`  SLO Protocol Baseline:  ${opsResult.sloBaseline.protocol_verification}\n`);

  // 6. Recertifications (DNS/TLS, Security, SEO, Email, A11y, Legal)
  log("[Drill 6/6] Running Gate F Recertifications Suite...");
  const recertsResult = await runRecerts(sha, {
    artifactsDir,
    dnsTlsEvidenceFile: options.dnsTlsEvidenceFile,
    seoEvidenceFile: options.seoEvidenceFile,
    emailEvidenceFile: options.emailEvidenceFile,
  });
  log(`  Security Audit:  ${recertsResult.security.verdict}`);
  log(`  Legal Technical: ${recertsResult.legal.verdict}\n`);

  // Every check counts toward the overall verdict; none are silently excluded.
  const checks = {
    migration_expand_contract: migrationResult.verdict,
    zero_downtime_rollback: rollbackResult.verdict,
    backup_restore: backupResult.verdict,
    edge_cache_purge: cacheResult.verdict,
    alert_routing: opsResult.alertRouting.verdict,
    slo_baseline: opsResult.sloBaseline.verdict,
    cost_controls: opsResult.costControls.verdict,
    feature_flags: opsResult.featureFlags?.verdict ?? "NOT_EXECUTED",
    dns_tls: recertsResult.dnsTls.verdict,
    security: recertsResult.security.verdict,
    seo: recertsResult.seo.verdict,
    email: recertsResult.email.verdict,
    accessibility: recertsResult.a11y.verdict,
    legal: recertsResult.legal.verdict,
  };
  const overallVerdict = deriveOverallVerdict(checks);
  const nonPassingChecks = Object.entries(checks)
    .filter(([, verdict]) => verdict !== "PASS")
    .map(([name, verdict]) => ({ check: name, verdict }));

  // Aggregate Drill Artifact
  const receipt = {
    qa_item: "R8.5",
    candidate_sha: sha,
    assurance_profile: "automated-only-owner-waived-v2",
    drills: {
      migration_expand_contract: {
        verdict: migrationResult.verdict,
        migration_count: migrationResult.migration_count,
        expand_contract_compliant: migrationResult.expand_contract_compliant,
      },
      zero_downtime_rollback: {
        drill_executed: rollbackResult.drill_executed ?? false,
        simulation_result: rollbackResult.simulation_result,
        scoring_availability: rollbackResult.scoring_availability,
        verdict: rollbackResult.verdict,
      },
      backup_restore: {
        verdict: backupResult.verdict,
      },
      edge_cache_purge: {
        protocol_verification: cacheResult.protocol_verification,
        static_asset_hashing: cacheResult.static_asset_hashing,
        verdict: cacheResult.verdict,
      },
      operations_alerting: {
        alert_routes_verified: opsResult.alertRouting.protocol_verification,
        slo_baseline_verified: opsResult.sloBaseline.protocol_verification,
        alert_routing_verdict: opsResult.alertRouting.verdict,
        slo_baseline_verdict: opsResult.sloBaseline.verdict,
        cost_controls_verdict: opsResult.costControls.verdict,
        feature_flags_verdict: checks.feature_flags,
      },
      security_recertification: {
        dependency_audit: recertsResult.security.dependency_audit,
        secret_scan: recertsResult.security.secret_scan,
        independent_manual_pentest: recertsResult.security.independent_manual_pentest,
        verdict: recertsResult.security.verdict,
      },
      legal_compliance: {
        disposition: recertsResult.legal.disposition,
        verdict: recertsResult.legal.verdict,
      },
      accessibility: {
        verdict: recertsResult.a11y.verdict,
      },
    },
    human_waivers: {
      independent_manual_pentest: "WAIVED_NOT_EXECUTED",
      independent_gate_f_reviewer: "WAIVED_NOT_EXECUTED",
      physical_device_matrix_session: "WAIVED_NOT_EXECUTED",
      human_screen_reader_audit: "WAIVED_NOT_EXECUTED",
      live_organiser_pilot_observation: "WAIVED_NOT_EXECUTED",
    },
    legal_approval: "DEFERRED_TO_FIRST_COMMERCIAL_RELEASE",
    simulation_environment: "staging_rehearsal_suite",
    verdict: overallVerdict,
    checks,
    non_passing_checks: nonPassingChecks,
    status_summary: {
      migration_safety: migrationResult.verdict === "PASS" ? "STATIC_CONTRACT_AUDIT_PASS" : migrationResult.verdict,
      zero_downtime_rollback: rollbackResult.drill_executed
        ? rollbackResult.verdict
        : rollbackResult.verdict === "FAIL"
          ? "FAIL"
          : "NOT_EXECUTED_PENDING_PRODUCTION_RUN",
      backup_isolated_restore:
        backupResult.verdict === "PASS"
          ? "PASS"
          : backupResult.verdict === "FAIL"
            ? "FAIL"
            : "NOT_EXECUTED_PENDING_PRODUCTION_BACKUP",
      edge_cache_purge:
        cacheResult.verdict === "PASS"
          ? "PASS"
          : cacheResult.verdict === "FAIL"
            ? "FAIL"
            : "CONFIG_AUDIT_ONLY_PURGE_NOT_EXECUTED",
      alert_routing:
        opsResult.alertRouting.verdict === "PASS"
          ? "PASS"
          : opsResult.alertRouting.verdict === "FAIL"
            ? "FAIL"
            : "CONFIG_AUDIT_ONLY_ALERTS_NOT_FIRED",
      security_recertification: recertsResult.security.verdict,
      accessibility: recertsResult.a11y.verdict,
      legal_technical_compliance: recertsResult.legal.verdict,
    },
    generated_at: new Date().toISOString(),
  };

  const { content_fingerprint_sha256, receipt_sha256, ...payload } = receipt;
  const checksum = createHash("sha256")
    .update(JSON.stringify(payload, null, 2))
    .digest("hex");
  receipt.content_fingerprint_sha256 = checksum;
  receipt.receipt_sha256 = checksum;

  const receiptFile = path.join(artifactsDir, "gate-f-drills-receipt.json");
  await writeFile(receiptFile, JSON.stringify(receipt, null, 2));

  log("════════════════════════════════════════════════════════════");
  log(" Gate F Recertification Drills Summary");
  log("════════════════════════════════════════════════════════════");
  log(` Migration Safety:      ${receipt.drills.migration_expand_contract.verdict} (Static Contract Audit)`);
  log(
    ` Rollback Drill:        ${receipt.drills.zero_downtime_rollback.simulation_result} (${receipt.drills.zero_downtime_rollback.scoring_availability})`,
  );
  log(` Backup/Restore Drill:  ${receipt.drills.backup_restore.verdict}`);
  log(` Cache Purge Drill:     ${receipt.drills.edge_cache_purge.verdict} (Config Audit Only)`);
  log(
    ` Alert Routing Drill:   ${receipt.drills.operations_alerting.alert_routing_verdict ?? "PENDING"} (Config Audit Only)`,
  );
  log(` Security Audit:        ${receipt.drills.security_recertification.verdict}`);
  log(` Legal Compliance:      ${receipt.drills.legal_compliance.verdict}`);
  log(` Accessibility:         ${receipt.drills.accessibility.verdict}`);
  log(` Feature Flags:         ${receipt.drills.operations_alerting.feature_flags_verdict}`);
  log(` Overall Verdict:       ${receipt.verdict}`);
  if (nonPassingChecks.length > 0) {
    log(` Not passing:           ${nonPassingChecks.map((c) => `${c.check}=${c.verdict}`).join(", ")}`);
  }
  log(` Content Fingerprint:   ${receipt.content_fingerprint_sha256}`);
  log(` Artifact Saved:        ${receiptFile}`);
  log("════════════════════════════════════════════════════════════\n");

  return receipt;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sha = process.argv[2] ?? process.env.CANDIDATE_SHA;
  runGateFDrills(sha)
    .then((receipt) => {
      if (receipt.verdict === "FAIL") {
        console.error(`\n[FAILURE] Gate F drills overall verdict is FAIL.`);
        process.exit(1);
      }
      if (receipt.verdict !== "PASS") {
        console.warn(
          `\n[NOT CERTIFIED] Overall verdict is ${receipt.verdict}: ${receipt.non_passing_checks.length} check(s) did not execute or did not pass. ` +
            "This run is NOT Gate F certification evidence. Exiting 0 because no check FAILED.",
        );
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error("[FATAL] Gate F drills failed:", err.message);
      process.exit(1);
    });
}
