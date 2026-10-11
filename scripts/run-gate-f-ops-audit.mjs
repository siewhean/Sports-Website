#!/usr/bin/env node
import { existsSync } from "node:fs";
import { productionOrigin } from "./lib/hostnames.mjs";
import { createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAndValidateEvidence, isValidUtcTimestamp } from "./validate-external-evidence.mjs";

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
    requiredFiles: ["provider_capture"],
  });
  const window = sloValidation.evidence?.observation_window;
  const validWindow =
    isValidUtcTimestamp(window?.started_at) &&
    isValidUtcTimestamp(window?.completed_at) &&
    Date.parse(window.started_at) < Date.parse(window.completed_at) &&
    Date.parse(window.completed_at) <= Date.now();
  const isSloPass =
    sloValidation.errors.length === 0 &&
    validWindow &&
    Number.isInteger(sloValidation.evidence?.observation_sample_count) &&
    sloValidation.evidence.observation_sample_count > 0 &&
    Boolean(sloValidation.evidence?.dashboard_id) &&
    Array.isArray(sloValidation.evidence?.observed_metrics) &&
    ["api_latency", "error_rate", "queue_depth", "active_scoring_sessions", "public_reads"].every((metric) =>
      sloValidation.evidence?.observed_metrics?.includes(metric),
    ) &&
    Number.isFinite(sloValidation.evidence?.result_propagation_observed_ms) &&
    sloValidation.evidence.result_propagation_observed_ms >= 0 &&
    sloValidation.evidence.result_propagation_observed_ms <= 2000 &&
    Number.isFinite(sloValidation.evidence?.availability_observed_percent) &&
    sloValidation.evidence.availability_observed_percent >= 99.9 &&
    Number.isFinite(sloValidation.evidence?.scoring_p95_observed_ms) &&
    sloValidation.evidence.scoring_p95_observed_ms >= 0 &&
    sloValidation.evidence.scoring_p95_observed_ms <= 500 &&
    Number.isFinite(sloValidation.evidence?.public_read_p95_observed_ms) &&
    sloValidation.evidence.public_read_p95_observed_ms >= 0 &&
    sloValidation.evidence.public_read_p95_observed_ms <= 2500 &&
    sloValidation.evidence.availability_observed_percent <= 100;
  if (!isSloPass) sloValidation.errors.push("dashboard_metrics_and_slo_observations_required");

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
    source_status: "SOURCE_PARTIAL",
    operational_status: isSloPass ? "VERIFIED" : "PRODUCTION_EVIDENCE_PENDING",
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
    requiredFiles: ["provider_capture"],
  });
  const isAlertPass =
    alertValidation.errors.length === 0 &&
    Boolean(alertValidation.evidence?.alert_drill_id) &&
    alertValidation.evidence?.all_routes_verified === true &&
    alertValidation.evidence?.delivery_acknowledged === true &&
    Array.isArray(alertValidation.evidence?.routes) &&
    ["service_unavailable", "scoring_latency_breach", "worker_dead", "backup_failed"].every((condition) =>
      alertValidation.evidence.routes?.some(
        (route) => route.condition === condition && route.delivery_acknowledged === true && Boolean(route.receipt_id),
      ),
    );
  if (!isAlertPass) alertValidation.errors.push("all_four_alert_route_delivery_receipts_required");

  const alertRouting = {
    qa_item: "OPS-005",
    candidate_sha: sha,
    configured_alert_routes: [
      { condition: "service_unavailable", target: "pagerduty_or_webhook" },
      { condition: "scoring_latency_breach", target: "oncall_slack" },
      { condition: "worker_dead", target: "infra_alerts" },
      { condition: "backup_failed", target: "ops_alerts" },
    ],
    source_status: "SOURCE_PARTIAL",
    operational_status: isAlertPass ? "VERIFIED" : "PRODUCTION_EVIDENCE_PENDING",
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
  // OPS-018 UI/control-plane source landed on main via PR #64.
  // Check actual source wiring, not a permanent hard-coded "missing UI" result.
  // Source presence is NOT a production operator audit or proof of live access.
  const featureFlagAdminFiles = [
    "apps/web/app/internal/feature-flags/page.tsx",
    "apps/web/components/phase3/FeatureFlagsAdmin.tsx",
    "apps/web/app/api/phase3/admin/feature-flags/[key]/override/route.ts",
    "apps/api/src/admin-routes.ts",
    "packages/feature-flags/src/postgres-storage.ts",
  ];
  const adminUiSourcePresent = featureFlagAdminFiles.every((file) => existsSync(path.join(root, file)));
  const featureFlags = {
    qa_item: "OPS-018",
    candidate_sha: sha,
    storage_engine: "PostgresFeatureFlagStorage",
    audit_logging: true,
    safe_defaults_enforced: true,
    emergency_killswitch_capable: true,
    privileged_entitlement_bypass_prevented: true,
    admin_ui_present: adminUiSourcePresent,
    source_status: adminUiSourcePresent ? "SOURCE_COMPLETE" : "SOURCE_PARTIAL",
    operational_status: "PRODUCTION_EVIDENCE_PENDING",
    verdict: adminUiSourcePresent ? "PENDING" : "PENDING_IMPLEMENTATION",
    pending_reasons: adminUiSourcePresent
      ? ["production_feature_flag_admin_operational_verification_pending"]
      : ["feature_flag_admin_ui_not_implemented"],
    generated_at: new Date().toISOString(),
  };
  featureFlags.receipt_sha256 = computeReceiptHash(featureFlags);
  await writeFile(path.join(artifactsDir, "gate-f-feature-flags.json"), JSON.stringify(featureFlags, null, 2));

  // 4. Cost Controls (OPS-016)
  const costEvidenceFile = options.costEvidenceFile ? path.resolve(options.costEvidenceFile) : undefined;
  const costValidation = await loadAndValidateEvidence(sha, costEvidenceFile, {
    allowedEvidenceClasses: ["PROVIDER_RECEIPT", "OPERATOR_CAPTURE"],
    requireProductionEnvironment: true,
    requiredFiles: ["provider_capture"],
  });
  const isCostPass =
    costValidation.errors.length === 0 &&
    Boolean(costValidation.evidence?.billing_account_id) &&
    costValidation.evidence?.budget_alerts_configured === true &&
    costValidation.evidence?.anomaly_detection_active === true &&
    Array.isArray(costValidation.evidence?.monitored_categories) &&
    ["compute_a1_flex", "block_storage", "object_storage", "network_egress", "transactional_email"].every((category) =>
      costValidation.evidence.monitored_categories?.includes(category),
    );
  if (!isCostPass) costValidation.errors.push("budget_anomaly_and_all_five_cost_categories_required");

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
    source_status: "SOURCE_PARTIAL",
    operational_status: isCostPass ? "VERIFIED" : "EXTERNAL_PROVIDER_PENDING",
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
  const syntheticValidation = await loadAndValidateEvidence(sha, options.syntheticEvidenceFile, {
    allowedEvidenceClasses: ["PRODUCTION_LIVE_PROBE", "PROVIDER_RECEIPT", "OPERATOR_CAPTURE"],
    requireProductionEnvironment: true,
    requiredFiles: ["provider_capture"],
  });
  const probeTargetMatches = (probe) => {
    try {
      const target = new URL(probe.target_url);
      if (target.origin !== productionOrigin() || target.search || target.hash || target.username || target.password)
        return false;
      const paths = { homepage: "/", health_ready: "/health/ready", meta_build: "/api/v1/meta/build" };
      if (probe.name === "public_competition_read") {
        const id = syntheticValidation.evidence?.public_competition_id;
        return (
          typeof id === "string" &&
          id.length > 0 &&
          probe.observed_competition_id === id &&
          target.pathname === `/api/v1/competitions/${encodeURIComponent(id)}`
        );
      }
      return (
        target.pathname === paths[probe.name] && (probe.name !== "meta_build" || probe.observed_candidate_sha === sha)
      );
    } catch {
      return false;
    }
  };
  const isSyntheticPass =
    syntheticValidation.errors.length === 0 &&
    Array.isArray(syntheticValidation.evidence?.probes) &&
    syntheticValidation.evidence?.serving_sha === sha &&
    [
      ["homepage", 60],
      ["health_ready", 30],
      ["meta_build", 60],
      ["public_competition_read", 60],
    ].every(([name, interval]) =>
      syntheticValidation.evidence?.probes?.some(
        (probe) =>
          probeTargetMatches(probe) &&
          probe.name === name &&
          probe.external === true &&
          probe.status === 200 &&
          Number.isFinite(probe.interval_sec) &&
          probe.interval_sec > 0 &&
          probe.interval_sec <= interval &&
          Boolean(probe.provider_monitor_id),
      ),
    );
  if (!isSyntheticPass)
    syntheticValidation.errors.push("all_four_external_probe_captures_and_required_intervals_required");
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
    source_status: "SOURCE_PARTIAL",
    operational_status: isSyntheticPass ? "VERIFIED" : "PRODUCTION_EVIDENCE_PENDING",
    protocol_verification: "SOURCE_PASS",
    verdict: isSyntheticPass ? "PASS" : "PENDING",
    pending_reasons: isSyntheticPass ? [] : syntheticValidation.errors,
    ...(syntheticValidation.evidenceSha256
      ? { input_evidence_sha256: syntheticValidation.evidenceSha256, evidence_reference: options.syntheticEvidenceFile }
      : {}),
    verified_evidence_files: syntheticValidation.verifiedFiles,
    ...(isSyntheticPass ? { production_observations: syntheticValidation.evidence } : {}),
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
    items: [sloBaseline, alertRouting, statusPage, logRetention, syntheticProbes, costControls, featureFlags].map(
      (item) => ({
        req_id: item.qa_item,
        source_status: item.source_status,
        operational_status: item.operational_status,
        verdict: item.verdict,
      }),
    ),
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
  const sha = process.argv[2] ?? process.env.CANDIDATE_SHA;
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
        res.sloBaseline.verdict !== "PASS" ||
        res.alertRouting.verdict !== "PASS" ||
        res.featureFlags.verdict !== "PASS" ||
        res.costControls.verdict !== "PASS" ||
        res.syntheticProbes.verdict !== "PASS" ||
        res.statusPage.verdict !== "PASS" ||
        res.logRetention.verdict !== "PASS"
      ) {
        process.exitCode = 1;
      }
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
