#!/usr/bin/env node
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAndValidateEvidence } from "./validate-external-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveCandidateSha(value) {
  if (value && /^[0-9a-f]{40}$/i.test(value)) {
    return value.toLowerCase();
  }
  if (process.env.CANDIDATE_SHA && /^[0-9a-f]{40}$/i.test(process.env.CANDIDATE_SHA)) {
    return process.env.CANDIDATE_SHA.toLowerCase();
  }
  try {
    const gitSha = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
    if (/^[0-9a-f]{40}$/i.test(gitSha)) {
      return gitSha.toLowerCase();
    }
  } catch {
    // git rev-parse failure falls through
  }
  return value;
}

function requireSha(value) {
  const resolved = resolveCandidateSha(value);
  if (!resolved || !/^[0-9a-f]{40}$/i.test(resolved)) {
    throw new Error(`Ops audit requires an exact 40-character candidate SHA; got ${value}`);
  }
  return resolved.toLowerCase();
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
  const isSloPass =
    sloValidation.errors.length === 0 &&
    Boolean(sloValidation.evidence?.probe_id) &&
    sloValidation.evidence?.availability_observed_percent >= 99.9 &&
    sloValidation.evidence?.scoring_p95_observed_ms <= 500 &&
    sloValidation.evidence?.public_read_p95_observed_ms <= 2500;

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
    source_status: "SOURCE_COMPLETE",
    operational_status: "PRODUCTION_EVIDENCE_PENDING",
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
  const isAlertPass =
    alertValidation.errors.length === 0 &&
    Boolean(alertValidation.evidence?.alert_drill_id) &&
    alertValidation.evidence?.all_routes_verified === true &&
    alertValidation.evidence?.delivery_acknowledged === true;

  const alertRouting = {
    qa_item: "OPS-005",
    candidate_sha: sha,
    configured_alert_routes: [
      { condition: "service_unavailable", target: "pagerduty_or_webhook" },
      { condition: "scoring_latency_breach", target: "oncall_slack" },
      { condition: "worker_dead", target: "infra_alerts" },
      { condition: "backup_failed", target: "ops_alerts" },
    ],
    source_status: "SOURCE_COMPLETE",
    operational_status: "PRODUCTION_EVIDENCE_PENDING",
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
  const isCostPass =
    costValidation.errors.length === 0 &&
    Boolean(costValidation.evidence?.billing_account_id) &&
    costValidation.evidence?.budget_alerts_configured === true &&
    costValidation.evidence?.anomaly_detection_active === true;

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
    source_status: "SOURCE_COMPLETE",
    operational_status: "EXTERNAL_PROVIDER_PENDING",
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

  // 5. Synthetic Health Monitoring (OPS-008)
  const syntheticProbes = {
    qa_item: "OPS-008",
    candidate_sha: sha,
    probe_definitions: [
      { name: "homepage", path: "/", method: "GET", interval_sec: 60, timeout_ms: 5000, expected_status: 200 },
      {
        name: "health_ready",
        path: "/health/ready",
        method: "GET",
        interval_sec: 30,
        timeout_ms: 3000,
        expected_status: 200,
      },
      {
        name: "meta_build",
        path: "/api/v1/meta/build",
        method: "GET",
        interval_sec: 60,
        timeout_ms: 5000,
        expected_status: 200,
      },
      {
        name: "public_competition_read",
        path: "/api/v1/competitions/:id",
        method: "GET",
        interval_sec: 60,
        timeout_ms: 5000,
        expected_status: 200,
      },
    ],
    production_slos: {
      scoring_p95_target_ms: 500,
      public_read_p95_target_ms: 2500,
      result_propagation_target_ms: 2000,
      availability_target_percent: 99.9,
    },
    source_status: "SOURCE_COMPLETE",
    operational_status: "PRODUCTION_EVIDENCE_PENDING",
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
  syntheticProbes.receipt_sha256 = computeReceiptHash(syntheticProbes);
  await writeFile(path.join(artifactsDir, "gate-f-synthetic-probes.json"), JSON.stringify(syntheticProbes, null, 2));

  // 6. External Status Page (OPS-006)
  const statusPage = {
    qa_item: "OPS-006",
    candidate_sha: sha,
    status_page_provider: "PENDING_PROVISIONING",
    public_incident_history: false,
    source_status: "SOURCE_MISSING",
    operational_status: "EXTERNAL_PROVIDER_PENDING",
    verdict: "PENDING_IMPLEMENTATION",
    pending_reasons: [
      "status_page_provider_unconfigured",
      "public_incident_history_not_provisioned",
      "status_page_dns_pending",
    ],
    generated_at: new Date().toISOString(),
  };
  statusPage.receipt_sha256 = computeReceiptHash(statusPage);
  await writeFile(path.join(artifactsDir, "gate-f-status-page.json"), JSON.stringify(statusPage, null, 2));

  // 7. Log Aggregation & Retention (OPS-007)
  const logRetention = {
    qa_item: "OPS-007",
    candidate_sha: sha,
    log_engine: "pino",
    log_format: "ndjson",
    timestamp_format: "iso8601_utc",
    context_propagation: ["requestId", "correlationId", "jobId", "traceId", "spanId"],
    pii_scrubbing_status: "SOURCE_COMPLETE",
    target_retention_days: 90,
    policy_reference: "docs/policies/PUBLIC_DATA.md",
    host_aggregator: "PENDING_INFRASTRUCTURE_PROVISIONING",
    source_status: "SOURCE_PARTIAL",
    operational_status: "PRODUCTION_EVIDENCE_PENDING",
    verdict: "PENDING",
    pending_reasons: ["host_log_aggregation_unconfigured", "retention_lifecycle_policy_receipt_pending"],
    generated_at: new Date().toISOString(),
  };
  logRetention.receipt_sha256 = computeReceiptHash(logRetention);
  await writeFile(path.join(artifactsDir, "gate-f-log-retention.json"), JSON.stringify(logRetention, null, 2));

  // 8. Consolidated Operations Inventory (OPS-004..008, OPS-016)
  const inventory = {
    qa_item: "OPS-INVENTORY",
    candidate_sha: sha,
    taxonomy: {
      source_states: ["SOURCE_COMPLETE", "SOURCE_PARTIAL", "SOURCE_MISSING"],
      operational_states: ["PRODUCTION_EVIDENCE_PENDING", "EXTERNAL_PROVIDER_PENDING", "VERIFIED", "NOT_REQUIRED"],
    },
    items: [
      {
        req_id: "OPS-004",
        name: "Monitoring Dashboards",
        priority: "P0",
        source_status: "SOURCE_COMPLETE",
        operational_status: "PRODUCTION_EVIDENCE_PENDING",
        verdict: sloBaseline.verdict,
      },
      {
        req_id: "OPS-005",
        name: "Alerting Rules",
        priority: "P0",
        source_status: "SOURCE_COMPLETE",
        operational_status: "PRODUCTION_EVIDENCE_PENDING",
        verdict: alertRouting.verdict,
      },
      {
        req_id: "OPS-006",
        name: "External Status Page",
        priority: "P0",
        source_status: "SOURCE_MISSING",
        operational_status: "EXTERNAL_PROVIDER_PENDING",
        verdict: statusPage.verdict,
      },
      {
        req_id: "OPS-007",
        name: "Log Aggregation & Retention",
        priority: "P0",
        source_status: "SOURCE_PARTIAL",
        operational_status: "PRODUCTION_EVIDENCE_PENDING",
        verdict: logRetention.verdict,
      },
      {
        req_id: "OPS-008",
        name: "Synthetic Health Monitoring",
        priority: "P0",
        source_status: "SOURCE_COMPLETE",
        operational_status: "PRODUCTION_EVIDENCE_PENDING",
        verdict: syntheticProbes.verdict,
      },
      {
        req_id: "OPS-016",
        name: "Cost Monitoring & Controls",
        priority: "P1",
        source_status: "SOURCE_COMPLETE",
        operational_status: "EXTERNAL_PROVIDER_PENDING",
        verdict: costControls.verdict,
      },
    ],
    generated_at: new Date().toISOString(),
  };
  inventory.receipt_sha256 = computeReceiptHash(inventory);
  await writeFile(path.join(artifactsDir, "gate-f-ops-inventory.json"), JSON.stringify(inventory, null, 2));

  return {
    sloBaseline,
    alertRouting,
    featureFlags,
    costControls,
    syntheticProbes,
    statusPage,
    logRetention,
    inventory,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const strictMode = process.argv.includes("--strict") || process.env.STRICT_GATE_F === "1";
  const rawArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  const sha = resolveCandidateSha(rawArg);
  runGateFOpsAudit(sha)
    .then((res) => {
      console.log(`Gate F ops audit completed for ${res.sloBaseline.candidate_sha}:`);
      console.log(`  SLO Baseline (OPS-004): ${res.sloBaseline.verdict} [${res.sloBaseline.source_status}]`);
      console.log(`  Alert Routing (OPS-005): ${res.alertRouting.verdict} [${res.alertRouting.source_status}]`);
      console.log(`  Status Page (OPS-006): ${res.statusPage.verdict} [${res.statusPage.source_status}]`);
      console.log(`  Log Retention (OPS-007): ${res.logRetention.verdict} [${res.logRetention.source_status}]`);
      console.log(
        `  Synthetic Probes (OPS-008): ${res.syntheticProbes.verdict} [${res.syntheticProbes.source_status}]`,
      );
      console.log(`  Cost Controls (OPS-016): ${res.costControls.verdict} [${res.costControls.source_status}]`);
      console.log(`  Feature Flags (OPS-018): ${res.featureFlags.verdict}`);
      if (
        strictMode &&
        (res.sloBaseline.verdict !== "PASS" ||
          res.alertRouting.verdict !== "PASS" ||
          res.featureFlags.verdict !== "PASS" ||
          res.costControls.verdict !== "PASS")
      ) {
        process.exitCode = 1;
      }
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
