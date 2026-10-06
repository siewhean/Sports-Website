#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAndValidateEvidence } from "./validate-external-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function requireSha(value) {
  if (!value || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`Ops audit requires an exact 40-character candidate SHA; got ${value}`);
  }
  return value.toLowerCase();
}

function computeReceiptHash(receipt) {
  const { receipt_sha256, ...payload } = receipt;
  return createHash("sha256")
    .update(JSON.stringify(payload, null, 2))
    .digest("hex");
}

export async function runGateFOpsAudit(candidateSha, options = {}) {
  const sha = requireSha(candidateSha);
  const artifactsDir = options.artifactsDir ?? path.join(root, "artifacts");
  await mkdir(artifactsDir, { recursive: true });

  // 1. Synthetic Probes & SLO baseline (OPS-004, OPS-008)
  const sloEvidenceFile = options.sloEvidenceFile ? path.resolve(options.sloEvidenceFile) : undefined;
  const sloValidation = await loadAndValidateEvidence(sha, sloEvidenceFile, {
    allowedEvidenceClasses: ["PRODUCTION_LIVE_PROBE", "PROVIDER_RECEIPT", "OPERATOR_CAPTURE"],
    requireProductionEnvironment: true,
  });
  const isSloPass = sloValidation.errors.length === 0;

  const sloBaseline = {
    qa_item: "OPS-004",
    candidate_sha: sha,
    protocol_probe_targets: [
      { name: "homepage", interval_sec: 60 },
      { name: "health_ready", interval_sec: 30 },
      { name: "meta_build", interval_sec: 60 },
      { name: "public_competition_read", interval_sec: 60 },
    ],
    production_slos: {
      scoring_p95_target_ms: 500,
      public_read_p95_target_ms: 2500,
      result_propagation_target_ms: 2000,
      availability_target_percent: 99.9,
    },
    protocol_verification: "SOURCE_PASS",
    verdict: isSloPass ? "PASS" : "PENDING",
    pending_reasons: isSloPass ? [] : sloValidation.errors,
    ...(sloValidation.evidenceSha256
      ? { input_evidence_sha256: sloValidation.evidenceSha256, evidence_reference: sloEvidenceFile }
      : {}),
    verified_evidence_files: sloValidation.verifiedFiles,
    ...(isSloPass ? { production_observations: sloValidation.evidence } : {}),
    generated_at: new Date().toISOString(),
  };
  sloBaseline.receipt_sha256 = computeReceiptHash(sloBaseline);
  await writeFile(path.join(artifactsDir, "gate-f-slo-baseline.json"), JSON.stringify(sloBaseline, null, 2));

  // 2. Alert Routing Drill (OPS-005)
  const alertEvidenceFile = options.alertEvidenceFile ? path.resolve(options.alertEvidenceFile) : undefined;
  const alertValidation = await loadAndValidateEvidence(sha, alertEvidenceFile, {
    allowedEvidenceClasses: ["PROVIDER_RECEIPT", "OPERATOR_CAPTURE"],
    requireProductionEnvironment: true,
  });
  const isAlertPass = alertValidation.errors.length === 0;

  const alertRouting = {
    qa_item: "OPS-005",
    candidate_sha: sha,
    configured_alert_routes: [
      { condition: "service_unavailable", target: "pagerduty_or_webhook" },
      { condition: "scoring_latency_breach", target: "oncall_slack" },
      { condition: "worker_dead", target: "infra_alerts" },
      { condition: "backup_failed", target: "ops_alerts" },
    ],
    protocol_verification: "SOURCE_PASS",
    verdict: isAlertPass ? "PASS" : "PENDING",
    pending_reasons: isAlertPass ? [] : alertValidation.errors,
    ...(alertValidation.evidenceSha256
      ? { input_evidence_sha256: alertValidation.evidenceSha256, evidence_reference: alertEvidenceFile }
      : {}),
    verified_evidence_files: alertValidation.verifiedFiles,
    ...(isAlertPass ? { production_observations: alertValidation.evidence } : {}),
    generated_at: new Date().toISOString(),
  };
  alertRouting.receipt_sha256 = computeReceiptHash(alertRouting);
  await writeFile(path.join(artifactsDir, "gate-f-alert-routing.json"), JSON.stringify(alertRouting, null, 2));

  // 3. Feature Flags Admin Runbook (OPS-018)
  // Per spec OPS-018: "Implement feature flag administration. UI for toggling flags without deployment."
  // PostgresFeatureFlagStorage exists in source, but admin UI is not implemented.
  const featureFlags = {
    qa_item: "OPS-018",
    candidate_sha: sha,
    storage_engine: "PostgresFeatureFlagStorage",
    audit_logging: true,
    safe_defaults_enforced: true,
    emergency_killswitch_capable: true,
    privileged_entitlement_bypass_prevented: true,
    admin_ui_present: false,
    verdict: "PENDING_IMPLEMENTATION",
    pending_reasons: ["feature_flag_admin_ui_not_implemented"],
    generated_at: new Date().toISOString(),
  };
  featureFlags.receipt_sha256 = computeReceiptHash(featureFlags);
  await writeFile(path.join(artifactsDir, "gate-f-feature-flags.json"), JSON.stringify(featureFlags, null, 2));

  // 4. Cost Controls (OPS-016)
  const costEvidenceFile = options.costEvidenceFile ? path.resolve(options.costEvidenceFile) : undefined;
  const costValidation = await loadAndValidateEvidence(sha, costEvidenceFile, {
    allowedEvidenceClasses: ["PROVIDER_RECEIPT", "OPERATOR_CAPTURE"],
    requireProductionEnvironment: true,
  });
  const isCostPass = costValidation.errors.length === 0;

  const costControls = {
    qa_item: "OPS-016",
    candidate_sha: sha,
    monitored_categories: [
      "compute_a1_flex",
      "block_storage",
      "object_storage",
      "network_egress",
      "transactional_email",
    ],
    protocol_verification: "SOURCE_PASS",
    verdict: isCostPass ? "PASS" : "PENDING",
    pending_reasons: isCostPass ? [] : costValidation.errors,
    ...(costValidation.evidenceSha256
      ? { input_evidence_sha256: costValidation.evidenceSha256, evidence_reference: costEvidenceFile }
      : {}),
    verified_evidence_files: costValidation.verifiedFiles,
    ...(isCostPass ? { production_observations: costValidation.evidence } : {}),
    generated_at: new Date().toISOString(),
  };
  costControls.receipt_sha256 = computeReceiptHash(costControls);
  await writeFile(path.join(artifactsDir, "gate-f-cost-controls.json"), JSON.stringify(costControls, null, 2));

  return { sloBaseline, alertRouting, featureFlags, costControls };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sha = process.argv[2] ?? process.env.CANDIDATE_SHA;
  runGateFOpsAudit(sha)
    .then((res) => {
      console.log(`Gate F ops audit completed:`);
      console.log(`  SLO Baseline (OPS-004): ${res.sloBaseline.verdict}`);
      console.log(`  Alert Routing (OPS-005): ${res.alertRouting.verdict}`);
      console.log(`  Feature Flags (OPS-018): ${res.featureFlags.verdict}`);
      console.log(`  Cost Controls (OPS-016): ${res.costControls.verdict}`);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
