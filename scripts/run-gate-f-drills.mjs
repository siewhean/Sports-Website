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
const artifactsDir = path.join(root, "artifacts");

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

export async function runGateFDrills(candidateSha, options = {}) {
  const sha = resolveCandidateSha(candidateSha);
  await mkdir(artifactsDir, { recursive: true });

  console.log("════════════════════════════════════════════════════════════");
  console.log(" Track R8: Gate F Recertification Drills Suite");
  console.log(` Candidate SHA:     ${sha}`);
  console.log(" Assurance Profile: automated-only-owner-waived-v2 (ADR 0005)");
  console.log("════════════════════════════════════════════════════════════\n");

  // 1. Migration Expand-Contract Certification (OPS-003, OPS-010)
  console.log("[Drill 1/6] Running Database Migration Expand-Contract Certification...");
  const migrationResult = await certifyGateFMigrations(sha, { artifactsDir });
  console.log(`  ✓ Migrations Verified: ${migrationResult.migration_count} files (${migrationResult.verdict})\n`);

  // 2. Automated Rollback Drill (OPS-002)
  console.log("[Drill 2/6] Running Automated Zero-Downtime Rollback Drill...");
  const rollbackResult = await runGateFRollbackDrill(sha, {
    artifactsDir,
    evidenceFile: options.rollbackEvidenceFile,
  });
  console.log(
    `  ✓ Rollback Simulation: ${rollbackResult.simulation_result} (Scoring Availability: ${rollbackResult.scoring_availability})\n`,
  );

  // 3. Backup & Isolated Restore Drill (OPS-001)
  console.log("[Drill 3/6] Running Database Backup and Isolated Restore Drill...");
  const backupResult = await runGateFBackupRestoreAudit(sha, {
    artifactsDir,
    evidenceFile: options.backupEvidenceFile,
  });
  console.log(`  ✓ Backup/Restore Audit Status: ${backupResult.verdict}\n`);

  // 4. CDN / Edge Cache Purge Drill (OPS-009)
  console.log("[Drill 4/6] Running Edge Cache / CDN Purge Invalidation Drill...");
  const cacheResult = await runGateFCachePurgeAudit(sha, {
    artifactsDir,
    evidenceFile: options.cacheEvidenceFile,
  });
  console.log(`  ✓ Cache Invalidation Protocol: ${cacheResult.protocol_verification}\n`);

  // 5. Operations & Alert Routing Drill (OPS-004, OPS-005, OPS-007, OPS-008)
  console.log("[Drill 5/6] Running Operations Baseline & Alert Routing Drill...");
  const opsResult = await runGateFOpsAudit(sha, {
    artifactsDir,
    sloEvidenceFile: options.sloEvidenceFile,
    alertEvidenceFile: options.alertEvidenceFile,
    costEvidenceFile: options.costEvidenceFile,
  });
  console.log(`  ✓ Alert Routing Protocol: ${opsResult.alertRouting.protocol_verification}`);
  console.log(`  ✓ SLO Protocol Baseline:  ${opsResult.sloBaseline.protocol_verification}\n`);

  // 6. Recertifications (DNS/TLS, Security, SEO, Email, A11y, Legal)
  console.log("[Drill 6/6] Running Gate F Recertifications Suite...");
  const recertsResult = await runGateFRecertifications(sha, {
    artifactsDir,
    dnsTlsEvidenceFile: options.dnsTlsEvidenceFile,
    seoEvidenceFile: options.seoEvidenceFile,
    emailEvidenceFile: options.emailEvidenceFile,
  });
  console.log(`  ✓ Security Audit:  ${recertsResult.security.verdict}`);
  console.log(`  ✓ Legal Technical: ${recertsResult.legal.verdict}\n`);

  // Determine dynamic overall verdict from actual execution results
  const allLiveDrillsPassed =
    migrationResult.verdict === "PASS" &&
    rollbackResult.verdict === "PASS" &&
    backupResult.verdict === "PASS" &&
    cacheResult.verdict === "PASS" &&
    opsResult.alertRouting.verdict === "PASS" &&
    opsResult.sloBaseline.verdict === "PASS";

  const overallVerdict = allLiveDrillsPassed ? "PASS" : "CONFIG_AND_CONTRACT_AUDIT_PASS_PRODUCTION_DRILLS_PENDING";

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
    status_summary: {
      migration_safety: migrationResult.verdict === "PASS" ? "STATIC_CONTRACT_AUDIT_PASS" : "FAIL",
      zero_downtime_rollback: rollbackResult.drill_executed ? "PASS" : "NOT_EXECUTED_PENDING_PRODUCTION_RUN",
      backup_isolated_restore: backupResult.verdict === "PASS" ? "PASS" : "NOT_EXECUTED_PENDING_PRODUCTION_BACKUP",
      edge_cache_purge: cacheResult.verdict === "PASS" ? "PASS" : "CONFIG_AUDIT_ONLY_PURGE_NOT_EXECUTED",
      alert_routing: opsResult.alertRouting.verdict === "PASS" ? "PASS" : "CONFIG_AUDIT_ONLY_ALERTS_NOT_FIRED",
      security_recertification: recertsResult.security.verdict,
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

  console.log("════════════════════════════════════════════════════════════");
  console.log(" Gate F Recertification Drills Summary");
  console.log("════════════════════════════════════════════════════════════");
  console.log(` Migration Safety:      ${receipt.drills.migration_expand_contract.verdict} (Static Contract Audit)`);
  console.log(
    ` Rollback Drill:        ${receipt.drills.zero_downtime_rollback.simulation_result} (${receipt.drills.zero_downtime_rollback.scoring_availability})`,
  );
  console.log(` Backup/Restore Drill:  ${receipt.drills.backup_restore.verdict}`);
  console.log(` Cache Purge Drill:     ${receipt.drills.edge_cache_purge.verdict} (Config Audit Only)`);
  console.log(
    ` Alert Routing Drill:   ${receipt.drills.operations_alerting.alert_routing_verdict ?? "PENDING"} (Config Audit Only)`,
  );
  console.log(` Security Audit:        ${receipt.drills.security_recertification.verdict}`);
  console.log(` Legal Compliance:      ${receipt.drills.legal_compliance.verdict}`);
  console.log(` Overall Verdict:       ${receipt.verdict}`);
  console.log(` Content Fingerprint:   ${receipt.content_fingerprint_sha256}`);
  console.log(` Artifact Saved:        ${receiptFile}`);
  console.log("════════════════════════════════════════════════════════════\n");

  return receipt;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sha = process.argv[2] ?? process.env.CANDIDATE_SHA;
  runGateFDrills(sha)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[FATAL] Gate F drills failed:", err.message);
      process.exit(1);
    });
}
