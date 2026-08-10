#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requiredLocalCommands } from "./run-gate-c-access-ledger.mjs";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256Pattern = /^[a-f0-9]{64}$/u;
const sourceShaPattern = /^[a-f0-9]{40}$/u;
const maximumArtifactBytes = 5 * 1024 * 1024;

export const approvedGateCC5Profile = Object.freeze({
  profileId: "c5-pilot-2026-001",
  durationSeconds: 3600,
  scorekeeperCount: 2,
  publicReaderCount: 150,
  organiserWorkerCount: 5,
  approval: Object.freeze({
    owner: "Siew Hean, Tournament Director",
    approvedAtUtc: "2026-07-04T08:30:00Z",
    reference: "C5-PILOT-APPROVAL-2026-001",
  }),
});
export const approvedGateCC5Plan = Object.freeze({
  profile: approvedGateCC5Profile,
  minimumSamplesPerOperation: 150,
  maximumSamplesPerOperation: Object.freeze({
    score_event_acknowledgement: 7_200,
    public_result_convergence: 300,
    public_current_conditional_read: 540_000,
    lease_takeover: 7_200,
    repair_publication: 18_000,
  }),
  maximumSamplesPerWorkerPerSecond: 1,
  convergencePolicy: Object.freeze({ waveCount: 2, samplesPerWave: 150 }),
});

export const gateCC5DeviceClasses = ["iphone", "ipad", "budget_android"];
export const gateCC5BrowserProjects = [
  "desktop-chromium",
  "desktop-firefox",
  "desktop-webkit",
  "phone-chromium",
  "phone-webkit",
  "tablet-webkit",
];
export const gateCC5WorkloadOperations = Object.keys(approvedGateCC5Plan.maximumSamplesPerOperation);
export const gateCC5ControlledFailures = [
  "postgres_interruption",
  "redis_interruption",
  "api_interruption",
  "web_interruption",
  "worker_interruption",
  "latency",
  "connection_pressure",
  "outbox_delay",
  "disk_pressure",
  "pdf_failure",
  "backup_restore",
  "projection_regeneration",
];
const gateCC5CacheReceiptKeys = [
  "artifact_kind",
  "source_sha",
  "deployment_sha",
  "profile_id",
  "workload_plan_sha256",
  "run_ordinal",
  "fixture_identifier_sha256",
  "public_url_sha256",
  "edge_origin_sha256",
  "edge_path_query_sha256",
  "initial_cache_status",
  "repeated_cache_status",
  "public_cache_control_observed",
  "etag_before_sha256",
  "last_modified_before_utc",
  "origin_url_sha256",
  "origin_api_origin_sha256",
  "origin_path_query_sha256",
  "origin_request_method",
  "origin_conditional_status",
  "origin_etag_sha256",
  "origin_last_modified_utc",
  "origin_publication_version",
  "origin_publication_version_header_sha256",
  "publication_kind",
  "previous_publication_version",
  "published_version",
  "purge_job_status",
  "purge_job_identifier_sha256",
  "purge_bridge_status",
  "fresh_cache_status",
  "fresh_publication_version",
  "stable_cache_status",
  "etag_after_sha256",
  "organiser_private",
  "session_private",
  "draft_private",
  "skipped_count",
  "evidence_sha256",
];

export const requiredGateCC5Commands = [
  ...requiredLocalCommands,
  { label: "gate-c-c1-exact-sha", command: "pnpm", args: ["evidence:gate-c-access:run"] },
  { label: "gate-c-c2-exact-sha", command: "pnpm", args: ["evidence:gate-c-c2:run"] },
  { label: "gate-c-c3-exact-sha", command: "pnpm", args: ["evidence:gate-c-c3:run"] },
];
export const canonicalGateCC5C4Argv = ["pnpm", "test:e2e:phase4:real"];
export const canonicalGateCC5IntegratedArgv = [
  "pnpm",
  "--filter",
  "@matchday/api",
  "exec",
  "tsx",
  "scripts/run-gate-c-c5-integrated.ts",
];
export const canonicalGateCC5BrowserArgv = [
  "pnpm",
  "--filter",
  "@matchday/web",
  "exec",
  "playwright",
  "test",
  "--config",
  "playwright.gate-c-c5.config.ts",
];

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256")
    .update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalJson(value))
    .digest("hex");
}

function assertHash(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
    throw new Error(`${label} has missing or unsupported fields`);
  }
}

function assertAllPass(value, label) {
  if (value?.status !== "passed" || value?.failed_count !== 0 || value?.skipped_count !== 0 || value?.sealed !== true) {
    throw new Error(`${label} must be passed, skip-free, failure-free, and sealed`);
  }
}

export function assertSanitisedGateCC5Text(value, label = "<root>") {
  const forbidden = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    /\b[a-z0-9-]*(?:authorization|api-key|token|secret|cookie)\s*:/iu,
    /\bbearer\s+[a-z0-9._~+/=-]+/iu,
    /"(?:[^"\r\n]*[_-])?(?:password|secret|token|cookie|api[_-]?key)(?:[_-][^"\r\n]*)?"\s*:/iu,
    /(?:^|\n)\s*[a-z0-9_]*(?:password|secret|token|cookie|api_key|access_key|private_key)[a-z0-9_]*\s*=/iu,
    /\b(?:postgres(?:ql)?|redis|rediss|amqp|https?):\/\//iu,
    /\b(?:localhost|127\.0\.0\.1|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/iu,
    /"(?:host|hostname|endpoint|database_url|redis_url)"\s*:/iu,
  ];
  if (forbidden.some((pattern) => pattern.test(value))) {
    throw new Error(`C5 evidence contains credentials or sensitive topology: ${label}`);
  }
}

export function assertNoGateCC5Secrets(value, segments = []) {
  if (typeof value === "string") {
    assertSanitisedGateCC5Text(value, segments.join(".") || "<root>");
    return;
  }
  if (Array.isArray(value))
    return value.forEach((item, index) => assertNoGateCC5Secrets(item, [...segments, String(index)]));
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const next = [...segments, key];
    if (
      /(?:^|_)(?:token|secret|password|cookie|authorization|raw_device_id|connection_url)(?:_|$)/iu.test(key) ||
      /^(?:host|hostname|endpoint|database_url|redis_url)$/iu.test(key)
    ) {
      throw new Error(`Secret-like evidence field is forbidden: ${next.join(".")}`);
    }
    assertNoGateCC5Secrets(item, next);
  }
}

export function validateGateCC5ApprovedProfile(profile) {
  assertExactKeys(
    profile,
    ["profileId", "durationSeconds", "scorekeeperCount", "publicReaderCount", "organiserWorkerCount", "approval"],
    "C5 approved profile",
  );
  assertExactKeys(profile.approval, ["owner", "approvedAtUtc", "reference"], "C5 workload approval");
  if (canonicalJson(profile) !== canonicalJson(approvedGateCC5Profile)) {
    throw new Error("C5 workload profile does not exactly match C5-PILOT-APPROVAL-2026-001");
  }
  return hash(approvedGateCC5Plan);
}

export function validateGateCC5TargetReceipt(receipt, sourceSha) {
  if (
    receipt?.artifact_kind !== "gate-c-c5-target-attestation" ||
    receipt?.source_sha !== sourceSha ||
    receipt?.environment !== "staging" ||
    receipt?.production !== false ||
    receipt?.shared !== false ||
    receipt?.dedicated_drill_processes !== true ||
    receipt?.shared_physical_device_session !== false
  ) {
    throw new Error("C5 targets must be exact-SHA, dedicated, non-production staging targets");
  }
  assertAllPass(receipt, "C5 target attestation");
  if (receipt?.deployment?.source_sha !== sourceSha) throw new Error("C5 deployment is not bound to the source SHA");
  for (const [label, value] of [
    ["deployment build", receipt?.deployment?.build_id_sha256],
    ["service revision", receipt?.deployment?.service_revision_sha256],
    ["staging ingress", receipt?.deployment?.ingress_origin_sha256],
    ["PostgreSQL target", receipt?.postgresql?.identifier_sha256],
    ["Redis target", receipt?.redis?.namespace_sha256],
  ])
    assertHash(value, label);
  if (receipt?.postgresql?.disposable !== true || receipt?.redis?.disposable !== true) {
    throw new Error("C5 controlled-failure storage targets must be disposable");
  }
  assertNoGateCC5Secrets(receipt);
  return receipt;
}

export function validateGateCC5PhysicalDeviceReceipts(receipts, sourceSha) {
  if (!Array.isArray(receipts) || receipts.length !== 3)
    throw new Error("C5 requires exactly three physical-device receipts");
  const classes = new Set();
  const identifiers = new Set();
  for (const receipt of receipts) {
    if (
      receipt?.artifact_kind !== "gate-c-c5-physical-device-receipt" ||
      receipt?.source_sha !== sourceSha ||
      receipt?.deployment_sha !== sourceSha ||
      receipt?.profile_id !== approvedGateCC5Profile.profileId ||
      receipt?.workload_plan_sha256 !== hash(approvedGateCC5Plan) ||
      !gateCC5DeviceClasses.includes(receipt?.platform) ||
      receipt?.trusted_https !== true
    )
      throw new Error("C5 physical-device receipt is incomplete or not exact-SHA trusted HTTPS evidence");
    if (
      receipt.skipped_count !== 0 ||
      receipt.console_errors !== 0 ||
      receipt.network_errors !== 0 ||
      receipt.service_worker_errors !== 0 ||
      receipt.synchronisation_errors !== 0
    )
      throw new Error(`C5 ${receipt.platform} physical receipt has failures or skips`);
    const expectedScenarios = [
      "sign_in_and_scoring_preparation",
      "online_score_and_reversal",
      "offline_queueing",
      "refresh_and_browser_restart",
      "ordered_replay_and_duplicate_fencing",
      "pending_finalisation",
      "stale_generation_takeover_read_only",
      "sanitised_export",
      "final_public_projection",
    ];
    assertExactKeys(receipt.scenarios, expectedScenarios, `C5 ${receipt.platform} physical scenarios`);
    if (expectedScenarios.some((scenario) => receipt.scenarios[scenario] !== "PASS")) {
      throw new Error(`C5 ${receipt.platform} physical journey is incomplete`);
    }
    assertHash(receipt?.device_identifier_sha256, `${receipt.platform} device identifier`);
    assertHash(receipt?.evidence_sha256, `${receipt.platform} evidence`);
    classes.add(receipt.platform);
    identifiers.add(receipt.device_identifier_sha256);
    assertNoGateCC5Secrets(receipt);
  }
  if (classes.size !== 3 || identifiers.size !== 3)
    throw new Error("C5 physical devices must have distinct required classes and identities");
  return receipts;
}

export function validateGateCC5IntegratedRunReceipt(receipt, sourceSha, _runNumber, planSha256) {
  if (
    receipt?.artifact_kind !== "gate-c-c5-integrated-workload-receipt" ||
    receipt?.source_sha !== sourceSha ||
    receipt?.profile_id !== approvedGateCC5Profile.profileId ||
    receipt?.approval_reference_sha256 !== hash(approvedGateCC5Profile.approval.reference) ||
    receipt?.workload_plan_sha256 !== planSha256 ||
    receipt?.minimum_samples_per_operation !== 150
  )
    throw new Error("C5 integrated workload receipt is not exact-SHA/profile-bound evidence");
  if (!Number.isFinite(receipt.duration_ms) || receipt.duration_ms < 18_000_000) {
    throw new Error("C5 integrated workload did not cover five one-hour operations");
  }
  assertHash(receipt?.postgresql_identifier_sha256, "integrated PostgreSQL identifier");
  assertHash(receipt?.redis_namespace_sha256, "integrated Redis namespace");
  assertExactKeys(receipt.operations, gateCC5WorkloadOperations, "C5 workload operations");
  const p95Budgets = {
    score_event_acknowledgement: 500,
    public_result_convergence: 2_000,
    public_current_conditional_read: 500,
    lease_takeover: 2_000,
    repair_publication: 2_000,
  };
  const workerCounts = {
    score_event_acknowledgement: 2,
    public_result_convergence: 150,
    public_current_conditional_read: 150,
    lease_takeover: 2,
    repair_publication: 5,
  };
  for (const operation of gateCC5WorkloadOperations) {
    const item = receipt.operations[operation];
    const summary = item?.summary;
    if (
      item?.operation !== operation ||
      item?.sourceSha !== sourceSha ||
      item?.workerCount !== workerCounts[operation] ||
      item?.timeoutCount !== 0 ||
      !Number.isFinite(item?.elapsedMs) ||
      item.elapsedMs < 3_600_000 ||
      !Number.isSafeInteger(summary?.sampleCount) ||
      summary.sampleCount < 150 ||
      !Number.isSafeInteger(summary?.successfulCount) ||
      summary?.successfulCount !== summary?.sampleCount ||
      summary?.expectedFailureCount !== 0 ||
      summary?.unexpectedFailureCount !== 0 ||
      summary?.errorRate !== 0 ||
      ![summary?.p50Ms, summary?.p95Ms, summary?.p99Ms, summary?.maxMs].every(
        (value) => Number.isFinite(value) && value >= 0,
      ) ||
      summary.p50Ms > summary.p95Ms ||
      summary.p95Ms > summary.p99Ms ||
      summary.p99Ms > summary.maxMs ||
      summary?.p95Ms > p95Budgets[operation] ||
      item?.correctness?.passed !== true
    )
      throw new Error(`C5 integrated workload receipt failed ${operation}`);
    if (operation === "public_result_convergence") {
      if (
        item.scheduledCadenceMs !== null ||
        item.convergenceWaveCount !== 2 ||
        item.convergenceSamplesPerWave !== 150 ||
        summary.sampleCount !== 300
      ) {
        throw new Error("C5 convergence did not prove two waves of 150");
      }
    } else if (
      item.scheduledCadenceMs !== 1_000 ||
      item.convergenceWaveCount !== 0 ||
      item.convergenceSamplesPerWave !== 0 ||
      summary.sampleCount > approvedGateCC5Plan.maximumSamplesPerOperation[operation]
    ) {
      throw new Error(`C5 integrated workload exceeded the approved cadence or ceiling for ${operation}`);
    }
  }
  if (!Array.isArray(receipt.controlled_failures) || receipt.controlled_failures.length !== 12)
    throw new Error("C5 integrated workload is missing controlled failures");
  const injectors = [
    "process_signal",
    "network_proxy",
    "connection_limit",
    "bounded_delay",
    "filesystem_limit",
    "command",
  ];
  for (const fault of gateCC5ControlledFailures) {
    const matches = receipt.controlled_failures.filter((item) => item?.fault === fault);
    if (
      matches.length !== 1 ||
      !injectors.includes(matches[0].injector) ||
      matches[0].recovery_observed !== true ||
      matches[0].cleanup_observed !== true ||
      !/^[a-z][a-z0-9_]{2,199}$/u.test(matches[0].recovery_oracle ?? "")
    )
      throw new Error(`C5 controlled failure is incomplete: ${fault}`);
    ["injection_evidence_sha256", "recovery_evidence_sha256", "cleanup_evidence_sha256"].forEach((key) =>
      assertHash(matches[0][key], `${fault} ${key}`),
    );
  }
  assertNoGateCC5Secrets(receipt);
  return receipt;
}

export function validateGateCC5CacheReceipts(receipts, sourceSha, planSha256) {
  if (!Array.isArray(receipts) || receipts.length !== 2) throw new Error("C5 requires two cache lifecycle receipts");
  for (const [index, receipt] of receipts.entries()) {
    assertExactKeys(receipt, gateCC5CacheReceiptKeys, `C5 cache lifecycle receipt ${index + 1}`);
    const lastModified = receipt?.last_modified_before_utc;
    const canonicalLastModified =
      typeof lastModified === "string" && !Number.isNaN(Date.parse(lastModified))
        ? new Date(lastModified).toISOString()
        : null;
    const originLastModified = receipt?.origin_last_modified_utc;
    const canonicalOriginLastModified =
      typeof originLastModified === "string" && !Number.isNaN(Date.parse(originLastModified))
        ? new Date(originLastModified).toISOString()
        : null;
    if (
      receipt?.artifact_kind !== "gate-c-c5-cache-lifecycle-receipt" ||
      receipt?.source_sha !== sourceSha ||
      receipt?.deployment_sha !== sourceSha ||
      receipt?.profile_id !== approvedGateCC5Profile.profileId ||
      receipt?.workload_plan_sha256 !== planSha256 ||
      receipt?.run_ordinal !== index + 1 ||
      receipt?.initial_cache_status !== "MISS" ||
      receipt?.repeated_cache_status !== "HIT" ||
      receipt?.public_cache_control_observed !== true ||
      canonicalLastModified !== lastModified ||
      receipt?.origin_conditional_status !== 304 ||
      canonicalOriginLastModified !== originLastModified ||
      originLastModified !== lastModified ||
      receipt?.origin_request_method !== "GET" ||
      receipt?.origin_etag_sha256 !== receipt?.etag_before_sha256 ||
      receipt?.origin_api_origin_sha256 === receipt?.edge_origin_sha256 ||
      receipt?.origin_path_query_sha256 !== receipt?.edge_path_query_sha256 ||
      !["result", "schedule"].includes(receipt?.publication_kind) ||
      !Number.isSafeInteger(receipt?.previous_publication_version) ||
      receipt.previous_publication_version < 0 ||
      !Number.isSafeInteger(receipt?.published_version) ||
      receipt.published_version !== receipt.previous_publication_version + 1 ||
      receipt?.origin_publication_version !== receipt.previous_publication_version ||
      receipt?.origin_publication_version_header_sha256 !== hash(String(receipt.previous_publication_version)) ||
      receipt?.purge_job_status !== "completed" ||
      receipt?.purge_bridge_status !== 204 ||
      receipt?.fresh_cache_status !== "MISS" ||
      !Number.isSafeInteger(receipt?.fresh_publication_version) ||
      receipt.fresh_publication_version !== receipt.published_version ||
      receipt?.stable_cache_status !== "HIT" ||
      receipt?.etag_before_sha256 === receipt?.etag_after_sha256 ||
      receipt?.organiser_private !== true ||
      receipt?.session_private !== true ||
      receipt?.draft_private !== true ||
      receipt?.skipped_count !== 0
    )
      throw new Error(`C5 cache lifecycle receipt ${index + 1} is incomplete`);
    [
      "fixture_identifier_sha256",
      "public_url_sha256",
      "edge_origin_sha256",
      "edge_path_query_sha256",
      "etag_before_sha256",
      "origin_url_sha256",
      "origin_api_origin_sha256",
      "origin_path_query_sha256",
      "origin_etag_sha256",
      "origin_publication_version_header_sha256",
      "etag_after_sha256",
      "purge_job_identifier_sha256",
      "evidence_sha256",
    ].forEach((key) => assertHash(receipt[key], `cache ${key}`));
  }
  if (receipts[0].fixture_identifier_sha256 === receipts[1].fixture_identifier_sha256)
    throw new Error("C5 cache receipts reused a fixture");
  return receipts;
}

export function validateGateCC5GrafanaReceipts(receipts, sourceSha, planSha256) {
  if (!Array.isArray(receipts) || receipts.length !== 2) throw new Error("C5 requires two Grafana receipts");
  for (const [index, receipt] of receipts.entries()) {
    if (
      receipt?.artifact_kind !== "gate-c-c5-grafana-receipt" ||
      receipt?.source_sha !== sourceSha ||
      receipt?.deployment_sha !== sourceSha ||
      receipt?.profile_id !== approvedGateCC5Profile.profileId ||
      receipt?.workload_plan_sha256 !== planSha256 ||
      receipt?.run_ordinal !== index + 1 ||
      !receipt?.correlation_id ||
      !Number.isFinite(Date.parse(receipt?.window_started_at_utc ?? "")) ||
      Date.parse(receipt?.window_ended_at_utc ?? "") <= Date.parse(receipt?.window_started_at_utc ?? "") ||
      receipt?.workload_visible !== true ||
      receipt?.fault_visible !== true ||
      receipt?.recovery_visible !== true ||
      receipt?.alert_routed !== true ||
      receipt?.alert_recovered !== true ||
      receipt?.skipped_count !== 0
    )
      throw new Error(`C5 Grafana receipt ${index + 1} is incomplete`);
    assertHash(receipt.evidence_sha256, "Grafana evidence");
  }
  if (receipts[0].correlation_id === receipts[1].correlation_id)
    throw new Error("C5 Grafana receipts reused a correlation ID");
  return receipts;
}

export function validateGateCC5QaReceipt(receipt, sourceSha, reviewBundleSha256) {
  if (
    receipt?.artifact_kind !== "gate-c-c5-independent-qa-receipt" ||
    receipt?.source_sha !== sourceSha ||
    receipt?.p0_count !== 0 ||
    receipt?.p1_count !== 0 ||
    receipt?.verdict !== "PASS" ||
    receipt?.reviewed_bundle_sha256 !== reviewBundleSha256
  ) {
    throw new Error("C5 requires independent QA with P0: 0, P1: 0, and Verdict: PASS");
  }
  assertHash(receipt.reviewer_agent_sha256, "independent QA reviewer");
  assertHash(receipt.evidence_sha256, "independent QA evidence");
  return receipt;
}

export function validateGateCC5Certification(manifest, sourceSha) {
  if (
    manifest?.schema_version !== 1 ||
    manifest?.artifact_kind !== "gate-c-c5-exact-sha-ledger" ||
    manifest?.source_sha !== sourceSha
  ) {
    throw new Error("C5 ledger is not bound to the expected full source SHA");
  }
  if (!sourceShaPattern.test(sourceSha))
    throw new Error("C5 source SHA must be the full lowercase 40-character commit SHA");
  if (manifest?.environment?.node_version !== "v24.18.0" || manifest?.environment?.pnpm_version !== "10.33.0") {
    throw new Error("C5 requires Node v24.18.0 and pnpm 10.33.0 exactly");
  }
  validateGateCC5ApprovedProfile(manifest.approved_profile);
  if (manifest.approved_profile_sha256 !== hash(approvedGateCC5Plan)) {
    throw new Error("C5 approved workload-plan hash is inconsistent");
  }
  validateGateCC5TargetReceipt(manifest.targets, sourceSha);
  validateGateCC5PhysicalDeviceReceipts(manifest.physical_devices, sourceSha);
  if (!Array.isArray(manifest.runs) || manifest.runs.length !== 2)
    throw new Error("C5 requires exactly two top-level runs");
  const postgres = new Set();
  const redis = new Set();
  for (const [index, run] of manifest.runs.entries()) {
    validateGateCC5IntegratedRunReceipt(run.integrated_receipt, sourceSha, index + 1, manifest.approved_profile_sha256);
    postgres.add(run.integrated_receipt.postgresql_identifier_sha256);
    redis.add(run.integrated_receipt.redis_namespace_sha256);
    validateGateCC5BrowserReport(run.browser_report, sourceSha);
  }
  if (postgres.size !== 2 || redis.size !== 2)
    throw new Error("C5 top-level runs reused PostgreSQL or Redis isolation");
  validateGateCC5CacheReceipts(manifest.cache, sourceSha, manifest.approved_profile_sha256);
  validateGateCC5GrafanaReceipts(manifest.grafana, sourceSha, manifest.approved_profile_sha256);
  validateGateCC5QaReceipt(manifest.independent_qa, sourceSha, manifest.review_bundle_sha256);
  for (const run of manifest.runs) {
    if (!Array.isArray(run.commands) || run.commands.length !== requiredGateCC5Commands.length + 3) {
      throw new Error(`C5 run ${run.run_number} command ledger is incomplete`);
    }
    const expectedLabels = [
      ...requiredGateCC5Commands.map((entry) => `run-${run.run_number}-${entry.label}`),
      `run-${run.run_number}-gate-c-c4-real-boundary`,
      `run-${run.run_number}-gate-c-c5-browser-matrix`,
      `run-${run.run_number}-gate-c-c5-integrated`,
    ];
    const expectedCommands = [
      ...requiredGateCC5Commands.map((entry) => [entry.command, ...entry.args].join(" ")),
      canonicalGateCC5C4Argv.join(" "),
      canonicalGateCC5BrowserArgv.join(" "),
      canonicalGateCC5IntegratedArgv.join(" "),
    ];
    for (const [index, command] of run.commands.entries()) {
      if (command?.label !== expectedLabels[index])
        throw new Error(`C5 run ${run.run_number} changed canonical command order`);
      if (command?.command !== expectedCommands[index])
        throw new Error(`C5 run ${run.run_number} changed a canonical command`);
      if (command?.exit_code !== 0 || command?.failed_count !== 0 || command?.skipped_count !== 0) {
        throw new Error(`C5 command failed or skipped: ${command?.label ?? "unknown"}`);
      }
      assertHash(command?.log_sha256, `${command?.label ?? "unknown"} log`);
    }
  }
  assertNoGateCC5Secrets(manifest);
  return manifest;
}

export function parseSafeArgv(value, environmentName) {
  let argv;
  try {
    argv = JSON.parse(value ?? "");
  } catch {
    throw new Error(`${environmentName} must be a JSON argv array`);
  }
  if (
    !Array.isArray(argv) ||
    argv.length < 1 ||
    argv.some((item) => typeof item !== "string" || !item.trim() || item.includes("\0"))
  ) {
    throw new Error(`${environmentName} must be a non-empty JSON argv array of strings`);
  }
  const executable = path.basename(argv[0]).toLowerCase();
  if (
    ["sh", "bash", "zsh", "dash", "fish", "cmd", "cmd.exe", "powershell", "pwsh"].includes(executable) ||
    argv.slice(1).some((item) => item === "-c" || item === "/c")
  ) {
    throw new Error(`${environmentName} must not use a shell wrapper or command string`);
  }
  return { command: argv[0], args: argv.slice(1) };
}

export function parseCanonicalArgv(value, environmentName, expected) {
  const parsed = parseSafeArgv(value, environmentName);
  if ([parsed.command, ...parsed.args].join("\0") !== expected.join("\0")) {
    throw new Error(`${environmentName} must be the canonical command: ${expected.join(" ")}`);
  }
  return parsed;
}

export function validateGateCC5BrowserReport(report, sourceSha) {
  if (report?.config?.metadata?.sourceSha !== sourceSha || !Array.isArray(report?.suites)) {
    throw new Error("C5 browser report is not bound to the exact source SHA");
  }
  const tests = [];
  const visit = (suite) => {
    for (const spec of suite?.specs ?? []) tests.push(...(spec.tests ?? []));
    for (const child of suite?.suites ?? []) visit(child);
  };
  report.suites.forEach(visit);
  for (const project of gateCC5BrowserProjects) {
    const matches = tests.filter((item) => item?.projectName === project);
    if (
      matches.length < 1 ||
      matches.some(
        (item) =>
          item.status !== "expected" ||
          !Array.isArray(item.results) ||
          item.results.length !== 1 ||
          item.results[0]?.status !== "passed",
      )
    ) {
      throw new Error(`C5 browser project failed or skipped: ${project}`);
    }
  }
  if (new Set(tests.map((item) => item?.projectName)).size !== gateCC5BrowserProjects.length) {
    throw new Error("C5 browser report contains an unexpected project");
  }
  assertNoGateCC5Secrets(report);
  return report;
}

export async function executeCommandsStopFirst(entries, execute) {
  const receipts = [];
  for (const entry of entries) receipts.push(await execute(entry));
  return receipts;
}

async function readReceipt(receiptPath, root, label) {
  if (!receiptPath?.trim()) throw new Error(`${label} receipt path is required`);
  const absolute = path.resolve(root, receiptPath);
  const canonicalRoot = await realpath(root);
  const canonicalFile = await realpath(absolute);
  if (!canonicalFile.startsWith(`${canonicalRoot}${path.sep}`))
    throw new Error(`${label} receipt escaped the exact-SHA evidence root`);
  const metadata = await lstat(canonicalFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximumArtifactBytes) {
    throw new Error(`${label} receipt must be a regular non-symlink file no larger than 5 MiB`);
  }
  const bytes = await readFile(canonicalFile);
  const parsed = JSON.parse(bytes.toString("utf8"));
  assertNoGateCC5Secrets(parsed);
  return { parsed, canonicalFile, sha256: hash(bytes), size_bytes: bytes.byteLength };
}

async function retainedFiles(directory, relative = "") {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`C5 evidence contains a symlink: ${child}`);
    if (entry.isDirectory()) files.push(...(await retainedFiles(directory, child)));
    else if (entry.isFile()) files.push(child.split(path.sep).join("/"));
  }
  return files.sort();
}

async function verifyReferencedEvidenceHashes(directory, expectedHashes) {
  const observed = new Set();
  for (const relative of await retainedFiles(directory))
    observed.add(hash(await readFile(path.join(directory, relative))));
  for (const expected of expectedHashes) {
    assertHash(expected, "referenced retained evidence");
    if (!observed.has(expected)) throw new Error(`C5 referenced evidence bytes are not retained: ${expected}`);
  }
}

async function retainedEvidenceTreeSha256(directory) {
  const entries = [];
  for (const relative of await retainedFiles(directory)) {
    const bytes = await readFile(path.join(directory, relative));
    entries.push({ path: relative, size_bytes: bytes.length, sha256: hash(bytes) });
  }
  return hash(entries);
}

export async function writeAndVerifyGateCC5Seal(directory, sourceSha) {
  const files = await retainedFiles(directory);
  if (files.includes("ledger-seal.json")) throw new Error("C5 ledger seal already exists");
  const entries = [];
  for (const relative of files) {
    const absolute = path.join(directory, relative);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumArtifactBytes)
      throw new Error(`C5 retained artifact is invalid or exceeds 5 MiB: ${relative}`);
    const bytes = await readFile(absolute);
    if (relative.endsWith(".json")) {
      let document;
      try {
        document = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new Error(`C5 JSON evidence is malformed: ${relative}`);
      }
      assertNoGateCC5Secrets(document);
    } else {
      assertNoGateCC5Secrets(bytes.toString("utf8"));
    }
    entries.push({ path: relative, size_bytes: bytes.length, sha256: hash(bytes) });
  }
  const seal = {
    schema_version: 1,
    artifact_kind: "gate-c-c5-ledger-tree-seal",
    source_sha: sourceSha,
    entries,
    tree_sha256: hash(entries),
  };
  const sealPath = path.join(directory, "ledger-seal.json");
  await writeFile(sealPath, `${JSON.stringify(seal, null, 2)}\n`, { flag: "wx" });
  const reopened = JSON.parse(await readFile(sealPath, "utf8"));
  if (canonicalJson(reopened) !== canonicalJson(seal)) throw new Error("C5 ledger seal failed reopen validation");
  for (const entry of entries)
    if (hash(await readFile(path.join(directory, entry.path))) !== entry.sha256)
      throw new Error(`C5 evidence changed during sealing: ${entry.path}`);
  for (const relative of files) await chmod(path.join(directory, relative), 0o444);
  await chmod(sealPath, 0o444);
  const directories = [];
  const collectDirectories = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const child = path.join(current, entry.name);
        await collectDirectories(child);
        directories.push(child);
      }
    }
  };
  await collectDirectories(directory);
  for (const child of directories) await chmod(child, 0o555);
  await chmod(directory, 0o555);
  return sealPath;
}

export async function verifyGateCC5SealedTree(directory, sourceSha) {
  const sealPath = path.join(directory, "ledger-seal.json");
  const seal = JSON.parse(await readFile(sealPath, "utf8"));
  if (seal?.artifact_kind !== "gate-c-c5-ledger-tree-seal" || seal?.source_sha !== sourceSha) {
    throw new Error("C5 prepared review seal is missing or not exact-SHA");
  }
  const files = (await retainedFiles(directory)).filter((relative) => relative !== "ledger-seal.json");
  const entries = [];
  for (const relative of files) {
    const absolute = path.join(directory, relative);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o222) !== 0) {
      throw new Error(`C5 prepared review file is mutable or invalid: ${relative}`);
    }
    const bytes = await readFile(absolute);
    entries.push({ path: relative, size_bytes: bytes.length, sha256: hash(bytes) });
  }
  if (canonicalJson(entries) !== canonicalJson(seal.entries) || hash(entries) !== seal.tree_sha256) {
    throw new Error("C5 prepared review changed after preparation");
  }
  return seal;
}

function commandOutput(root, command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

async function runLogged(root, entry, logPath, env) {
  const child = spawn(entry.command, entry.args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  let size = 0;
  const collect = (chunk, target) => {
    size += chunk.length;
    if (size > maximumArtifactBytes) child.kill("SIGTERM");
    else chunks.push(chunk);
    target.write(chunk);
  };
  child.stdout.on("data", (chunk) => collect(chunk, process.stdout));
  child.stderr.on("data", (chunk) => collect(chunk, process.stderr));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (size > maximumArtifactBytes) throw new Error(`${entry.label} output exceeded the 5 MiB evidence limit`);
  const bytes = Buffer.concat(chunks);
  assertNoGateCC5Secrets(bytes.toString("utf8"));
  await writeFile(logPath, bytes, { flag: "wx" });
  if (exitCode !== 0) throw new Error(`${entry.label} exited with code ${String(exitCode)}`);
  const skippedCount = countGateCC5Skips(bytes.toString("utf8"));
  if (skippedCount !== 0) throw new Error(`${entry.label} reported ${skippedCount} skipped/pending/todo checks`);
  return {
    label: entry.label,
    command: [entry.command, ...entry.args].join(" "),
    exit_code: 0,
    failed_count: 0,
    skipped_count: 0,
    log_sha256: hash(bytes),
  };
}

export function countGateCC5Skips(output) {
  return [
    ...output.matchAll(/(?:\b(\d+)\s+(?:skipped|pending|todo)\b|\b(?:skipped|pending|todo)\s+(\d+)\b)/giu),
  ].reduce((total, match) => total + Number(match[1] ?? match[2]), 0);
}

export async function runGateCC5Ledger(options = {}) {
  const root = options.root ?? defaultRoot;
  const env = options.env ?? process.env;
  const version = options.nodeVersion ?? process.version;
  const exec = options.commandOutput ?? ((command, args) => commandOutput(root, command, args));
  const sourceSha = exec("git", ["rev-parse", "HEAD"]);
  if (!sourceShaPattern.test(sourceSha)) throw new Error("C5 requires a full lowercase 40-character source SHA");
  const dirtyBefore = exec("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirtyBefore) throw new Error(`Refusing C5 ledger on a dirty source tree:\n${dirtyBefore}`);
  if (version !== "v24.18.0") throw new Error(`Expected Node v24.18.0, received ${version}`);
  if (exec("pnpm", ["--version"]) !== "10.33.0") throw new Error("Expected pnpm 10.33.0");
  const upstream = exec("git", ["rev-parse", "@{upstream}"]);
  if (upstream !== sourceSha) throw new Error(`C5 source ${sourceSha} is not at exact upstream parity (${upstream})`);

  const shaRoot = path.join(root, "artifacts", "qa", "gate-c-c5", sourceSha);
  await mkdir(path.join(shaRoot, "ledgers"), { recursive: true });
  const inputNames = {
    approval: "GATE_C_C5_APPROVAL_RECEIPT",
    targets: "GATE_C_C5_TARGET_RECEIPT",
  };
  const inputs = {};
  for (const [key, name] of Object.entries(inputNames)) inputs[key] = await readReceipt(env[name], shaRoot, name);
  const profileSha256 = validateGateCC5ApprovedProfile(inputs.approval.parsed);
  validateGateCC5TargetReceipt(inputs.targets.parsed, sourceSha);
  const c4 = parseCanonicalArgv(env.GATE_C_C5_C4_COMMAND_JSON, "GATE_C_C5_C4_COMMAND_JSON", canonicalGateCC5C4Argv);
  const integrated = parseCanonicalArgv(
    env.GATE_C_C5_INTEGRATED_COMMAND_JSON,
    "GATE_C_C5_INTEGRATED_COMMAND_JSON",
    canonicalGateCC5IntegratedArgv,
  );
  if (!env.GATE_C_C5_INTEGRATED_RECEIPT?.includes("{run}"))
    throw new Error("GATE_C_C5_INTEGRATED_RECEIPT must contain the {run} placeholder");

  const ledgerId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
  const directory = path.join(shaRoot, "ledgers", ledgerId);
  const logs = path.join(directory, "logs");
  const receiptsDirectory = path.join(directory, "receipts");
  await mkdir(logs, { recursive: true });
  await mkdir(receiptsDirectory);
  const execute = options.runLogged ?? ((entry, logPath, commandEnv) => runLogged(root, entry, logPath, commandEnv));
  const runs = [];
  for (const runNumber of [1, 2]) {
    const runDirectory = path.join(directory, "runs", `run-${runNumber}`);
    await mkdir(runDirectory, { recursive: true });
    const entries = [
      ...requiredGateCC5Commands,
      { label: "gate-c-c4-real-boundary", ...c4 },
      {
        label: "gate-c-c5-browser-matrix",
        command: canonicalGateCC5BrowserArgv[0],
        args: canonicalGateCC5BrowserArgv.slice(1),
      },
      { label: "gate-c-c5-integrated", ...integrated },
    ];
    const commands = await executeCommandsStopFirst(entries, (entry) =>
      execute(
        { ...entry, label: `run-${runNumber}-${entry.label}` },
        path.join(logs, `run-${runNumber}-${entry.label}.log`),
        {
          ...env,
          GATE_C_C5_RUN_NUMBER: String(runNumber),
          GATE_C_C5_EVIDENCE_DIR: runDirectory,
          GATE_C_C5_APPROVED_PROFILE_SHA256: profileSha256,
          GATE_C_C5_SOURCE_SHA: sourceSha,
          GATE_C_C5_WORKLOAD_PROFILE_JSON: JSON.stringify(inputs.approval.parsed),
          GATE_C_C5_REDIS_DATABASE: String(runNumber - 1),
          GATE_C_C5_INTEGRATED_RECEIPT: env.GATE_C_C5_INTEGRATED_RECEIPT.replaceAll("{run}", String(runNumber)),
        },
      ),
    );
    const integratedPath = env.GATE_C_C5_INTEGRATED_RECEIPT.replaceAll("{run}", String(runNumber));
    const integratedInput = await readReceipt(integratedPath, shaRoot, `C5 integrated run ${runNumber}`);
    validateGateCC5IntegratedRunReceipt(integratedInput.parsed, sourceSha, runNumber, profileSha256);
    const browserInput = await readReceipt(
      path.join(runDirectory, sourceSha, "browser-matrix", "playwright-results.json"),
      shaRoot,
      `C5 browser run ${runNumber}`,
    );
    validateGateCC5BrowserReport(browserInput.parsed, sourceSha);
    await copyFile(integratedInput.canonicalFile, path.join(receiptsDirectory, `integrated-run-${runNumber}.json`));
    await copyFile(browserInput.canonicalFile, path.join(receiptsDirectory, `browser-run-${runNumber}.json`));
    runs.push({
      run_number: runNumber,
      commands,
      integrated_receipt: integratedInput.parsed,
      integrated_receipt_sha256: integratedInput.sha256,
      browser_report: browserInput.parsed,
      browser_report_sha256: browserInput.sha256,
    });
  }
  for (const [name, input] of Object.entries(inputs))
    await copyFile(input.canonicalFile, path.join(receiptsDirectory, `${name}.json`));
  if (
    exec("git", ["rev-parse", "HEAD"]) !== sourceSha ||
    exec("git", ["status", "--porcelain=v1", "--untracked-files=all"])
  ) {
    throw new Error("C5 ledger changed the exact source tree");
  }
  const execution = {
    schema_version: 1,
    artifact_kind: "gate-c-c5-exact-sha-execution",
    source_sha: sourceSha,
    environment: { node_version: version, pnpm_version: "10.33.0" },
    source_guard: { clean_before: true, clean_after: true, upstream_parity: true },
    approved_profile: inputs.approval.parsed,
    approved_profile_sha256: profileSha256,
    targets: inputs.targets.parsed,
    runs,
  };
  const executionPath = path.join(directory, "execution.json");
  await writeFile(executionPath, `${JSON.stringify(execution, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${path.relative(root, executionPath)}\n`);
  return executionPath;
}

async function gateCC5PhaseContext(options, label) {
  const root = options.root ?? defaultRoot;
  const env = options.env ?? process.env;
  const version = options.nodeVersion ?? process.version;
  const exec = options.commandOutput ?? ((command, args) => commandOutput(root, command, args));
  const sourceSha = exec("git", ["rev-parse", "HEAD"]);
  if (!sourceShaPattern.test(sourceSha) || version !== "v24.18.0" || exec("pnpm", ["--version"]) !== "10.33.0") {
    throw new Error(`C5 ${label} requires the exact SHA, Node v24.18.0, and pnpm 10.33.0`);
  }
  if (
    exec("git", ["status", "--porcelain=v1", "--untracked-files=all"]) ||
    exec("git", ["rev-parse", "@{upstream}"]) !== sourceSha
  ) {
    throw new Error(`C5 ${label} requires a clean source tree at exact upstream parity`);
  }
  const shaRoot = path.join(root, "artifacts", "qa", "gate-c-c5", sourceSha);
  const directory = path.resolve(root, env.GATE_C_C5_LEDGER_DIRECTORY ?? "");
  const [canonicalShaRoot, canonicalDirectory] = await Promise.all([realpath(shaRoot), realpath(directory)]);
  if (!canonicalDirectory.startsWith(`${canonicalShaRoot}${path.sep}ledgers${path.sep}`)) {
    throw new Error("GATE_C_C5_LEDGER_DIRECTORY must be the unsealed exact-SHA execution directory");
  }
  return { root, env, exec, sourceSha, shaRoot, canonicalDirectory };
}

async function readAndValidateExecution(directory, sourceSha) {
  const executionPath = path.join(directory, "execution.json");
  const executionBytes = await readFile(executionPath);
  const execution = JSON.parse(executionBytes.toString("utf8"));
  if (execution?.artifact_kind !== "gate-c-c5-exact-sha-execution" || execution?.source_sha !== sourceSha) {
    throw new Error("C5 execution receipt is missing or not exact-SHA");
  }
  for (const run of execution.runs ?? []) {
    for (const command of run.commands ?? []) {
      const logPath = path.join(directory, "logs", `${command.label}.log`);
      if (hash(await readFile(logPath)) !== command.log_sha256)
        throw new Error(`C5 command log changed: ${command.label}`);
    }
  }
  return { execution, executionBytes };
}

export async function prepareGateCC5Review(options = {}) {
  const { root, env, sourceSha, shaRoot, canonicalDirectory } = await gateCC5PhaseContext(
    options,
    "review preparation",
  );
  const { execution, executionBytes } = await readAndValidateExecution(canonicalDirectory, sourceSha);
  const inputNames = {
    iphone: "GATE_C_C5_IPHONE_RECEIPT",
    ipad: "GATE_C_C5_IPAD_RECEIPT",
    android: "GATE_C_C5_ANDROID_RECEIPT",
    cache: "GATE_C_C5_CACHE_RECEIPT",
    grafana: "GATE_C_C5_GRAFANA_RECEIPT",
  };
  const inputs = {};
  for (const [key, name] of Object.entries(inputNames)) inputs[key] = await readReceipt(env[name], shaRoot, name);
  const devices = validateGateCC5PhysicalDeviceReceipts(
    [inputs.iphone.parsed, inputs.ipad.parsed, inputs.android.parsed],
    sourceSha,
  );
  validateGateCC5CacheReceipts(inputs.cache.parsed, sourceSha, execution.approved_profile_sha256);
  validateGateCC5GrafanaReceipts(inputs.grafana.parsed, sourceSha, execution.approved_profile_sha256);
  const retainedSource = path.join(shaRoot, "retained");
  const referencedHashes = [
    ...devices.map((receipt) => receipt.evidence_sha256),
    ...inputs.cache.parsed.map((receipt) => receipt.evidence_sha256),
    ...inputs.grafana.parsed.map((receipt) => receipt.evidence_sha256),
    ...execution.runs.flatMap((run) =>
      run.integrated_receipt.controlled_failures.flatMap((fault) => [
        fault.injection_evidence_sha256,
        fault.recovery_evidence_sha256,
        fault.cleanup_evidence_sha256,
      ]),
    ),
  ];
  await verifyReferencedEvidenceHashes(retainedSource, referencedHashes);
  const reviewBundleSha256 = hash({
    execution_sha256: hash(executionBytes),
    physical_receipt_sha256: [inputs.iphone.sha256, inputs.ipad.sha256, inputs.android.sha256],
    cache_receipt_sha256: inputs.cache.sha256,
    grafana_receipt_sha256: inputs.grafana.sha256,
    retained_tree_sha256: await retainedEvidenceTreeSha256(retainedSource),
  });
  const preparedDirectory = path.join(canonicalDirectory, "prepared-review");
  await mkdir(preparedDirectory);
  const preparedReceipts = path.join(preparedDirectory, "receipts");
  await mkdir(preparedReceipts);
  await copyFile(path.join(canonicalDirectory, "execution.json"), path.join(preparedDirectory, "execution.json"));
  for (const [name, input] of Object.entries(inputs))
    await copyFile(input.canonicalFile, path.join(preparedReceipts, `${name}.json`));
  await cp(retainedSource, path.join(preparedDirectory, "retained"), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  if (
    (await retainedEvidenceTreeSha256(path.join(preparedDirectory, "retained"))) !==
    (await retainedEvidenceTreeSha256(retainedSource))
  ) {
    throw new Error("C5 retained evidence changed during review preparation");
  }
  const preparation = {
    schema_version: 1,
    artifact_kind: "gate-c-c5-prepared-review",
    source_sha: sourceSha,
    execution_sha256: hash(executionBytes),
    physical_receipt_sha256: [inputs.iphone.sha256, inputs.ipad.sha256, inputs.android.sha256],
    cache_receipt_sha256: inputs.cache.sha256,
    grafana_receipt_sha256: inputs.grafana.sha256,
    retained_tree_sha256: await retainedEvidenceTreeSha256(retainedSource),
    review_bundle_sha256: reviewBundleSha256,
  };
  const preparationPath = path.join(preparedDirectory, "review-preparation.json");
  await writeFile(preparationPath, `${JSON.stringify(preparation, null, 2)}\n`, { flag: "wx" });
  await writeAndVerifyGateCC5Seal(preparedDirectory, sourceSha);
  process.stdout.write(
    `${JSON.stringify({ review_preparation: path.relative(root, preparationPath), review_bundle_sha256: reviewBundleSha256 })}\n`,
  );
  return preparationPath;
}

async function findEvidenceByHash(directory, expectedHash) {
  for (const relative of await retainedFiles(directory)) {
    const absolute = path.join(directory, relative);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximumArtifactBytes)
      continue;
    const bytes = await readFile(absolute);
    if (hash(bytes) === expectedHash) {
      assertSanitisedGateCC5Text(bytes.toString("utf8"), relative);
      return absolute;
    }
  }
  throw new Error("C5 independent QA evidence bytes are not retained");
}

export async function finalizeGateCC5Ledger(options = {}) {
  const { root, env, sourceSha, shaRoot, canonicalDirectory } = await gateCC5PhaseContext(options, "finalization");
  const preparedDirectory = path.join(canonicalDirectory, "prepared-review");
  await verifyGateCC5SealedTree(preparedDirectory, sourceSha);
  const preparation = JSON.parse(await readFile(path.join(preparedDirectory, "review-preparation.json"), "utf8"));
  if (preparation?.artifact_kind !== "gate-c-c5-prepared-review" || preparation?.source_sha !== sourceSha) {
    throw new Error("C5 prepared review receipt is missing or not exact-SHA");
  }
  const original = await readAndValidateExecution(canonicalDirectory, sourceSha);
  const preparedExecutionBytes = await readFile(path.join(preparedDirectory, "execution.json"));
  if (
    hash(original.executionBytes) !== preparation.execution_sha256 ||
    hash(preparedExecutionBytes) !== preparation.execution_sha256
  ) {
    throw new Error("C5 execution changed after review preparation");
  }
  const preparedInputs = {};
  for (const name of ["iphone", "ipad", "android", "cache", "grafana"]) {
    const bytes = await readFile(path.join(preparedDirectory, "receipts", `${name}.json`));
    preparedInputs[name] = { parsed: JSON.parse(bytes.toString("utf8")), sha256: hash(bytes) };
  }
  const devices = validateGateCC5PhysicalDeviceReceipts(
    [preparedInputs.iphone.parsed, preparedInputs.ipad.parsed, preparedInputs.android.parsed],
    sourceSha,
  );
  validateGateCC5CacheReceipts(preparedInputs.cache.parsed, sourceSha, original.execution.approved_profile_sha256);
  validateGateCC5GrafanaReceipts(preparedInputs.grafana.parsed, sourceSha, original.execution.approved_profile_sha256);
  const recomputedReviewBundleSha256 = hash({
    execution_sha256: hash(preparedExecutionBytes),
    physical_receipt_sha256: [preparedInputs.iphone.sha256, preparedInputs.ipad.sha256, preparedInputs.android.sha256],
    cache_receipt_sha256: preparedInputs.cache.sha256,
    grafana_receipt_sha256: preparedInputs.grafana.sha256,
    retained_tree_sha256: await retainedEvidenceTreeSha256(path.join(preparedDirectory, "retained")),
  });
  if (recomputedReviewBundleSha256 !== preparation.review_bundle_sha256) {
    throw new Error("C5 prepared review digest changed after preparation");
  }
  const qa = await readReceipt(env.GATE_C_C5_QA_RECEIPT, shaRoot, "GATE_C_C5_QA_RECEIPT");
  validateGateCC5QaReceipt(qa.parsed, sourceSha, preparation.review_bundle_sha256);
  const qaEvidence = await findEvidenceByHash(shaRoot, qa.parsed.evidence_sha256);
  const manifest = {
    ...original.execution,
    artifact_kind: "gate-c-c5-exact-sha-ledger",
    execution_sha256: preparation.execution_sha256,
    review_bundle_sha256: preparation.review_bundle_sha256,
    physical_devices: devices,
    cache: preparedInputs.cache.parsed,
    grafana: preparedInputs.grafana.parsed,
    independent_qa: qa.parsed,
  };
  validateGateCC5Certification(manifest, sourceSha);
  const receiptsDirectory = path.join(canonicalDirectory, "receipts");
  await copyFile(qa.canonicalFile, path.join(receiptsDirectory, "qa.json"));
  await copyFile(qaEvidence, path.join(receiptsDirectory, "qa-evidence.txt"));
  const manifestPath = path.join(canonicalDirectory, "ledger.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  await writeAndVerifyGateCC5Seal(canonicalDirectory, sourceSha);
  process.stdout.write(`${path.relative(root, manifestPath)}\n`);
  return manifestPath;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const phaseFlags = process.argv.slice(2).filter((argument) => argument.startsWith("--"));
  if (phaseFlags.some((argument) => !["--prepare-review", "--finalize"].includes(argument)) || phaseFlags.length > 1) {
    throw new Error("C5 ledger accepts at most one phase flag: --prepare-review or --finalize");
  }
  const action = phaseFlags.includes("--prepare-review")
    ? prepareGateCC5Review
    : phaseFlags.includes("--finalize")
      ? finalizeGateCC5Ledger
      : runGateCC5Ledger;
  action().catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
