#!/usr/bin/env node
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MATCHDAY_GATE_C_BRANCH,
  MATCHDAY_VERCEL_PROJECT_ID,
  MATCHDAY_VERCEL_TEAM_ID,
} from "./verify-vercel-deployment.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const SHA256_RE = /^[a-f0-9]{64}$/u;

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function readJson(file, label = file) {
  if (!fs.existsSync(file)) throw new Error(`Missing ${label}: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Malformed JSON in ${label}: ${error.message}`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
}

function safeRelative(root, candidate, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} escaped its evidence root`);
  }
  return resolved;
}

function latestChildFile(directory, filename, label) {
  if (!fs.existsSync(directory)) throw new Error(`Missing ${label} directory: ${directory}`);
  const candidates = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => path.join(directory, entry.name, filename))
    .filter((file) => fs.existsSync(file))
    .sort();
  const selected = candidates.at(-1);
  if (!selected) throw new Error(`Missing ${label} ${filename} beneath ${directory}`);
  return selected;
}

function fileEvidence(file) {
  const bytes = fs.readFileSync(file);
  return { path: file, sha256: sha256(bytes), size_bytes: bytes.byteLength };
}

function verifyListedArtifacts(ledgerDirectory, artifacts, label) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error(`${label} contains no retained artifact manifest`);
  }
  for (const artifact of artifacts) {
    if (
      !artifact ||
      typeof artifact.path !== "string" ||
      artifact.path.startsWith("/") ||
      artifact.path.split(/[\\/]/u).includes("..") ||
      !Number.isSafeInteger(artifact.size_bytes) ||
      artifact.size_bytes < 0
    ) {
      throw new Error(`${label} contains an unsafe retained artifact entry`);
    }
    assertSha256(artifact.sha256, `${label}/${artifact.path}`);
    const file = safeRelative(ledgerDirectory, path.join(ledgerDirectory, artifact.path), `${label}/${artifact.path}`);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}/${artifact.path} is not a regular file`);
    const bytes = fs.readFileSync(file);
    if (bytes.byteLength !== artifact.size_bytes || sha256(bytes) !== artifact.sha256) {
      throw new Error(`${label}/${artifact.path} differs from its immutable manifest`);
    }
  }
}

function validateLaneLedger({ artifactsRoot, targetSha, directoryName, artifactKind, label }) {
  const ledgers = path.join(artifactsRoot, directoryName, targetSha, "ledgers");
  const ledgerPath = latestChildFile(ledgers, "ledger.json", label);
  const ledger = readJson(ledgerPath, `${label} exact-SHA ledger`);
  if (ledger.artifact_kind !== artifactKind || ledger.source_sha !== targetSha) {
    throw new Error(`${label} ledger is not bound to candidate SHA ${targetSha}`);
  }
  if (ledger.source_guard?.clean_before !== true || ledger.source_guard?.clean_after !== true) {
    throw new Error(`${label} ledger did not prove a clean immutable source tree`);
  }
  if (!Array.isArray(ledger.commands) || ledger.commands.length === 0) {
    throw new Error(`${label} ledger contains no executed commands`);
  }
  const failedCommand = ledger.commands.find((command) => command?.exit_code !== 0);
  if (failedCommand) throw new Error(`${label} ledger command failed: ${String(failedCommand.label)}`);
  if (!Array.isArray(ledger.runs) || ledger.runs.length < 2) {
    throw new Error(`${label} ledger must retain at least two independent real runs`);
  }
  for (const run of ledger.runs) {
    if (run?.receipt?.source_sha !== targetSha) throw new Error(`${label} run receipt SHA does not match candidate`);
  }
  const requiredCommandLabels = new Set(["migrations", "backup", "integration", "secrets", "build"]);
  const executed = new Set(ledger.commands.map((command) => command.label));
  for (const required of requiredCommandLabels) {
    if (!executed.has(required)) throw new Error(`${label} ledger omitted mandatory command: ${required}`);
  }
  verifyListedArtifacts(path.dirname(ledgerPath), ledger.artifacts, label);
  return { data: ledger, evidence: fileEvidence(ledgerPath), path: ledgerPath };
}

const C2_PROFILE_KEYS = {
  baseline: "Baseline",
  publicReads: "PublicReads",
  organiserReads: "OrganiserReads",
  writerMutations: "WriterMutations",
};

const C2_MINIMUM_FIXTURE = {
  competitions: 3,
  divisionsPerCompetition: 2,
  matchesPerDivision: 12,
  scoreEventsPerMatch: 16,
  scoringSessionsPerMatch: 1,
  resultConflictsPerCompetition: 2,
};

function assertFiniteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`);
}

function validateC2MigrationLockBenchmark(artifactsRoot, targetSha) {
  const c2Directory = path.join(artifactsRoot, "gate-c-c2", targetSha);
  const reportPath = path.join(c2Directory, "migration-lock-benchmark.json");
  if (!fs.existsSync(reportPath)) {
    throw new Error(`Missing C2 controlled-staging migration lock benchmark: ${reportPath}`);
  }
  if (fs.lstatSync(reportPath).isSymbolicLink()) {
    throw new Error("C2 controlled-staging migration lock benchmark must not be a symlink");
  }
  const report = readJson(reportPath, "C2 controlled-staging migration lock benchmark");
  if (
    report?.schemaVersion !== 3 ||
    report?.artifactKind !== "gate-c-c2-migration-lock-benchmark" ||
    report?.sourceSha !== targetSha ||
    report?.executionClassification !== "controlled_staging_observation" ||
    typeof report?.timestamp !== "string" ||
    !Number.isFinite(Date.parse(report.timestamp)) ||
    report?.engine !== "PostgreSQL" ||
    typeof report?.postgresVersion !== "string" ||
    report.postgresVersion.trim() === "" ||
    report.postgresVersion === "unknown"
  ) {
    throw new Error("C2 controlled-staging migration lock benchmark is not a current exact-SHA PostgreSQL receipt");
  }
  assertSha256(report.database?.databaseNameHash, "C2 database identifier hash");
  assertFiniteNonNegative(report.database?.databaseSizeBytes, "C2 database size");

  const fixture = report.fixtureProfile;
  if (!fixture || fixture.name !== "representative-c2-v1") {
    throw new Error("C2 controlled-staging benchmark lacks the representative fixture profile");
  }
  for (const [key, minimum] of Object.entries(C2_MINIMUM_FIXTURE)) {
    if (!Number.isSafeInteger(fixture[key]) || fixture[key] < minimum) {
      throw new Error(`C2 controlled-staging fixture ${key} is below the representative minimum`);
    }
  }
  const expectedRows = {
    competitions: fixture.competitions,
    divisions: fixture.competitions * fixture.divisionsPerCompetition,
    matches: fixture.competitions * fixture.divisionsPerCompetition * fixture.matchesPerDivision,
    scheduledMatches: fixture.competitions * fixture.divisionsPerCompetition * fixture.matchesPerDivision,
    scoreEvents:
      fixture.competitions * fixture.divisionsPerCompetition * fixture.matchesPerDivision * fixture.scoreEventsPerMatch,
    scoringSessions:
      fixture.competitions *
      fixture.divisionsPerCompetition *
      fixture.matchesPerDivision *
      fixture.scoringSessionsPerMatch,
    resultConflicts: fixture.competitions * fixture.resultConflictsPerCompetition,
  };
  for (const [key, expected] of Object.entries(expectedRows)) {
    if (report.fixtureRows?.[key] !== expected) {
      throw new Error(`C2 controlled-staging fixture row outcome is inconsistent for ${key}`);
    }
  }

  if (!report.profiles || typeof report.profiles !== "object") {
    throw new Error("C2 controlled-staging benchmark has no profile outcomes");
  }
  for (const [key, profileName] of Object.entries(C2_PROFILE_KEYS)) {
    const profile = report.profiles[key];
    if (!profile || profile.profileName !== profileName || typeof profile.description !== "string") {
      throw new Error(`C2 controlled-staging profile ${key} is missing or malformed`);
    }
    for (const field of ["migration0030DurationMs", "migration0031DurationMs", "totalDurationMs", "lockWaitQueueMax"]) {
      assertFiniteNonNegative(profile[field], `C2 ${key}/${field}`);
    }
    if (!profile.tableLockModes || typeof profile.tableLockModes !== "object") {
      throw new Error(`C2 controlled-staging profile ${key} has no lock observations`);
    }
    for (const field of ["min", "p50", "p95", "max"]) {
      assertFiniteNonNegative(profile.concurrentQueryLatenciesMs?.[field], `C2 ${key}/latency/${field}`);
    }
    if (
      profile.totalDurationMs < profile.migration0030DurationMs ||
      profile.totalDurationMs < profile.migration0031DurationMs
    ) {
      throw new Error(`C2 controlled-staging profile ${key} has inconsistent migration timing`);
    }
    for (const field of [
      "concurrentQueriesExecuted",
      "concurrentQueriesBlocked",
      "concurrentQueriesTimedOut",
      "concurrentQueriesDeadlocked",
    ]) {
      if (!Number.isSafeInteger(profile[field]) || profile[field] < 0) {
        throw new Error(`C2 ${key}/${field} must be a non-negative integer`);
      }
    }
    if (profile.concurrentQueriesTimedOut !== 0 || profile.concurrentQueriesDeadlocked !== 0) {
      throw new Error(`C2 controlled-staging profile ${key} observed a timeout or deadlock`);
    }
    if (key !== "baseline" && profile.concurrentQueriesExecuted < 1) {
      throw new Error(`C2 controlled-staging profile ${key} did not retain successful concurrent traffic`);
    }
    if (JSON.stringify(profile.fixtureRows) !== JSON.stringify(expectedRows)) {
      throw new Error(`C2 controlled-staging profile ${key} has inconsistent fixture row outcomes`);
    }
    if (
      !profile.cleanup ||
      profile.cleanup.schemaDropped !== true ||
      profile.cleanup.temporaryMigrationDirectoryRemoved !== true ||
      !Array.isArray(profile.cleanup.failures) ||
      profile.cleanup.failures.length !== 0
    ) {
      throw new Error(`C2 controlled-staging profile ${key} has incomplete cleanup evidence`);
    }
    const raw = profile.retainedRawLog;
    const rawFilename = `${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}.json`;
    const expectedRawPath = `artifacts/qa/gate-c-c2/${targetSha}/raw/${rawFilename}`;
    if (!raw || raw.path !== expectedRawPath) {
      throw new Error(`C2 controlled-staging profile ${key} has an unexpected raw observation path`);
    }
    assertSha256(raw.sha256, `C2 ${key} raw observation hash`);
    const rawPath = path.join(c2Directory, "raw", rawFilename);
    if (fs.lstatSync(rawPath).isSymbolicLink()) {
      throw new Error(`C2 controlled-staging profile ${key} raw observation must not be a symlink`);
    }
    const rawBytes = fs.readFileSync(rawPath);
    if (sha256(rawBytes) !== raw.sha256)
      throw new Error(`C2 controlled-staging profile ${key} raw observation hash mismatch`);
    const rawObservation = readJson(rawPath, `C2 ${key} raw observation`);
    const traffic = rawObservation?.traffic;
    const summaryTraffic = {
      executed: profile.concurrentQueriesExecuted,
      blocked: profile.concurrentQueriesBlocked,
      timedOut: profile.concurrentQueriesTimedOut,
      deadlocked: profile.concurrentQueriesDeadlocked,
    };
    if (
      !Array.isArray(rawObservation?.lockSamples) ||
      !traffic ||
      Object.entries(summaryTraffic).some(([field, value]) => traffic[field] !== value) ||
      !Array.isArray(traffic.latencies) ||
      rawObservation.lockSamples.some(
        (sample) =>
          !sample ||
          typeof sample.tableName !== "string" ||
          typeof sample.lockMode !== "string" ||
          typeof sample.granted !== "boolean" ||
          typeof sample.querySnippet !== "string" ||
          !Number.isFinite(sample.timestampMs),
      )
    ) {
      throw new Error(`C2 controlled-staging profile ${key} raw observation is inconsistent with its summary`);
    }
  }
  const abort = report.abortRollback;
  if (
    !abort ||
    typeof abort.scenario !== "string" ||
    abort.scenario.trim() === "" ||
    typeof abort.preflightFailureTriggered !== "string" ||
    abort.preflightFailureTriggered.trim() === "" ||
    abort.lockReleaseVerified !== true ||
    abort.postRollbackLocksRemaining !== 0 ||
    !abort.cleanup ||
    abort.cleanup.schemaDropped !== true ||
    abort.cleanup.temporaryMigrationDirectoryRemoved !== true ||
    !Array.isArray(abort.cleanup.failures) ||
    abort.cleanup.failures.length !== 0
  ) {
    throw new Error("C2 controlled-staging abort/rollback cleanup evidence is incomplete");
  }
  assertFiniteNonNegative(abort.ddlAttemptDurationMs, "C2 abort/rollback DDL duration");
  assertFiniteNonNegative(abort.rollbackDurationMs, "C2 abort/rollback duration");
  if (
    !report.cleanup ||
    report.cleanup.schemasDropped !== 5 ||
    report.cleanup.temporaryMigrationDirectoriesRemoved !== 5 ||
    !Array.isArray(report.cleanup.cleanupFailures) ||
    report.cleanup.cleanupFailures.length !== 0
  ) {
    throw new Error("C2 controlled-staging aggregate cleanup evidence is incomplete");
  }
  if (
    report.recommendations?.maintenanceWindowRequired !== true ||
    report.recommendations?.writeDrainRequired !== true
  ) {
    throw new Error("C2 controlled-staging benchmark must retain the maintenance and write-drain conclusion");
  }
  return { data: report, evidence: fileEvidence(reportPath), path: reportPath };
}

function validateC4Receipt(artifactsRoot, targetSha) {
  const receiptPath = path.join(artifactsRoot, "gate-c-c4", targetSha, "run-evidence.json");
  const receipt = readJson(receiptPath, "C4 exact-SHA run evidence");
  if (
    receipt.artifact_kind !== "gate-c-c4-exact-sha-evidence" ||
    receipt.record_status !== "UNSEALED_COLLECTOR" ||
    receipt.source_sha !== targetSha ||
    receipt.status !== "PASS"
  ) {
    throw new Error("C4 run evidence is not a current all-pass exact-SHA receipt");
  }
  if (receipt.checks?.zero_partial_state_verified !== true) {
    throw new Error("C4 run evidence does not prove atomic rollback / zero partial state");
  }
  assertSha256(receipt.outputs?.unit_test_summary_sha256, "C4 unit output hash");
  assertSha256(receipt.outputs?.e2e_test_summary_sha256, "C4 E2E output hash");
  return { data: receipt, evidence: fileEvidence(receiptPath), path: receiptPath };
}

function validateC3BrowserRun(artifactsRoot, targetSha) {
  const runs = path.join(artifactsRoot, "gate-c-c3", targetSha, "runs");
  const runPath = latestChildFile(runs, "run-evidence.json", "C3 browser matrix");
  const run = readJson(runPath, "C3 browser matrix run evidence");
  if (
    run.artifact_kind !== "gate-c-c3-run-evidence" ||
    run.source_sha !== targetSha ||
    run.failed_count !== 0 ||
    run.skipped_count !== 0 ||
    !Array.isArray(run.projects) ||
    run.projects.length !== 5 ||
    run.pass_count < 5
  ) {
    throw new Error("C3 browser matrix is not an all-pass exact-SHA five-project run");
  }
  for (const project of run.projects) {
    const projectPath = safeRelative(
      path.dirname(runPath),
      path.join(path.dirname(runPath), project.evidence_path),
      "C3 project evidence",
    );
    const receipt = readJson(projectPath, `C3 ${project.project_name} receipt`);
    if (
      receipt.source_sha !== targetSha ||
      receipt.project_name !== project.project_name ||
      receipt.failed_count !== 0 ||
      receipt.skipped_count !== 0 ||
      receipt.pass_count !== project.pass_count
    ) {
      throw new Error(`C3 project ${String(project.project_name)} is not an exact-SHA all-pass receipt`);
    }
  }
  return { data: run, evidence: fileEvidence(runPath), path: runPath };
}

function validatePhysicalPlatform(artifactsRoot, targetSha, platform) {
  const platformDir = path.join(artifactsRoot, "gate-c-c3", targetSha, "physical", platform);
  const receiptPath = path.join(platformDir, "receipt.json");
  const receipt = readJson(receiptPath, `${platform} physical device receipt`);
  if (receipt.source_sha !== targetSha || receipt.status !== "passed") {
    throw new Error(`${platform} physical receipt is not a passing exact-SHA receipt`);
  }
  if (!Array.isArray(receipt.scenarios) || receipt.scenarios.length < 8) {
    throw new Error(`${platform} physical receipt has fewer than 8 required scenarios`);
  }
  const base = { ...receipt };
  delete base.receipt_sha256;
  const computedReceiptHash = sha256(JSON.stringify(base));
  if (receipt.receipt_sha256 !== computedReceiptHash) {
    throw new Error(`${platform} physical receipt hash mismatch`);
  }
  for (const scenario of receipt.scenarios) {
    if (scenario.status !== "passed" || !scenario.scenario_id) {
      throw new Error(`${platform} physical scenario did not pass`);
    }
    assertSha256(scenario.raw_trace_sha256, `${platform}/${scenario.scenario_id} raw trace`);
    const tracePath = path.join(platformDir, "traces", `${scenario.scenario_id}.trace.json`);
    if (!fs.existsSync(tracePath))
      throw new Error(`Missing raw trace file for ${platform} scenario ${scenario.scenario_id}`);
    const traceContent = fs.readFileSync(tracePath);
    if (sha256(traceContent) !== scenario.raw_trace_sha256) {
      throw new Error(`Raw trace hash mismatch for ${platform} scenario ${scenario.scenario_id}`);
    }
    const trace = JSON.parse(traceContent.toString("utf8"));
    const events = Array.isArray(trace) ? trace : trace.events;
    if (!Array.isArray(events) || events.length === 0) {
      throw new Error(`Raw trace file for ${platform} scenario ${scenario.scenario_id} contains no event stream`);
    }
    if (scenario.scenario_hash) {
      const canonical = { ...scenario };
      delete canonical.scenario_hash;
      if (sha256(JSON.stringify(canonical)) !== scenario.scenario_hash) {
        throw new Error(`Scenario receipt hash mismatch for ${platform}/${scenario.scenario_id}`);
      }
    }
  }
  return { data: receipt, evidence: fileEvidence(receiptPath), path: receiptPath };
}

export const REQUIRED_FAULTS = [
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

export const C5_OPERATION_BUDGETS = {
  score_event_acknowledgement: 500,
  public_current_conditional_read: 500,
  public_result_convergence: 2000,
  lease_takeover: 2000,
  repair_publication: 2000,
};

function validateC5Certification(artifactsRoot, targetSha) {
  const certificationPath = path.join(artifactsRoot, "gate-c-c5", targetSha, "certification.json");
  const certification = readJson(certificationPath, "C5 integrated certification receipt");
  const receipt = certification.receipt;
  if (
    !receipt ||
    receipt.artifact_kind !== "gate-c-c5-integrated-workload-receipt" ||
    receipt.source_sha !== targetSha ||
    !Number.isSafeInteger(receipt.minimum_samples_per_operation) ||
    receipt.minimum_samples_per_operation < 500 ||
    !Number.isFinite(receipt.duration_ms) ||
    receipt.duration_ms <= 0
  ) {
    throw new Error("C5 certification is not an exact-SHA integrated workload receipt");
  }
  if (!receipt.operations || typeof receipt.operations !== "object") {
    throw new Error("C5 certification operations are missing or malformed");
  }
  for (const [name, budget] of Object.entries(C5_OPERATION_BUDGETS)) {
    const operation = receipt.operations[name];
    if (!operation) throw new Error(`Missing required C5 operation: ${name}`);
    const summary = operation.summary || operation;
    const sampleCount = summary.sampleCount ?? summary.sample_count ?? 0;
    const successfulCount = summary.successfulCount ?? summary.successful_count ?? sampleCount;
    const errors = summary.unexpectedFailureCount ?? summary.errorCount ?? summary.error_count ?? 0;
    const p95 = summary.p95Ms ?? summary.p95_ms;
    if (sampleCount < 500 || successfulCount < 500) {
      throw new Error(`C5 operation ${name} has fewer than 500 successful measured samples`);
    }
    if (errors !== 0 || operation.correctness?.passed === false) {
      throw new Error(`C5 operation ${name} contains correctness or unexpected failures`);
    }
    if (!Number.isFinite(p95) || p95 > budget) {
      throw new Error(`C5 operation ${name} exceeded p95 latency budget: ${String(p95)}ms > ${budget}ms`);
    }
  }
  if (!Array.isArray(receipt.controlled_failures) || !certification.retained_artifacts) {
    throw new Error("C5 certification is missing controlled fault evidence");
  }
  const retained = path.join(artifactsRoot, "gate-c-c5", targetSha, "retained");
  const faults = {};
  for (const fault of REQUIRED_FAULTS) {
    const faultReceipt = receipt.controlled_failures.filter((candidate) => candidate?.fault === fault);
    const paths = certification.retained_artifacts[fault];
    if (
      faultReceipt.length !== 1 ||
      !paths ||
      faultReceipt[0].recovery_observed !== true ||
      faultReceipt[0].cleanup_observed !== true ||
      typeof faultReceipt[0].recovery_oracle !== "string"
    ) {
      throw new Error(`Fault drill ${fault} is missing integrated fail/recover/cleanup evidence`);
    }
    for (const [key, field] of [
      ["injection", "injection_evidence_sha256"],
      ["recovery", "recovery_evidence_sha256"],
      ["cleanup", "cleanup_evidence_sha256"],
    ]) {
      const relative = paths[key];
      if (typeof relative !== "string" || path.isAbsolute(relative) || relative.split(/[\\/]/u).includes("..")) {
        throw new Error(`Fault drill ${fault} has an unsafe retained log path`);
      }
      const full = safeRelative(retained, path.join(retained, relative), `Fault drill ${fault}`);
      if (!fs.existsSync(full)) throw new Error(`Missing retained ${fault}/${key} log`);
      if (fs.lstatSync(full).isSymbolicLink()) throw new Error(`Retained ${fault}/${key} log must not be a symlink`);
      const digest = sha256(fs.readFileSync(full));
      if (faultReceipt[0][field] !== digest) throw new Error(`${fault}/${key} log hash mismatch`);
    }
    faults[fault] = faultReceipt[0];
  }
  return { data: receipt, faults, evidence: fileEvidence(certificationPath), path: certificationPath };
}

function validateHmac(artifactsRoot, targetSha) {
  const file = path.join(artifactsRoot, "gate-c-c5", targetSha, "hmac-rotation.json");
  const receipt = readJson(file, "HMAC rotation evidence");
  if (
    receipt.artifact_kind !== "gate-c-c5-hmac-rotation" ||
    receipt.source_sha !== targetSha ||
    receipt.evidence_type !== "operational_drill" ||
    receipt.status !== "PASS" ||
    !/^([a-f0-9]{64})$/u.test(receipt.control_plane_sha256 || "") ||
    !/^([a-f0-9]{64})$/u.test(receipt.attestation_nonce_sha256 || "") ||
    !/^([a-f0-9]{64})$/u.test(receipt.run_id_sha256 || "") ||
    !/^([a-f0-9]{64})$/u.test(receipt.deployment_id_sha256 || "") ||
    !/^([a-f0-9]{64})$/u.test(receipt.build_id_sha256 || "") ||
    !/^([a-f0-9]{64})$/u.test(receipt.operator_attestation_sha256 || "") ||
    typeof receipt.drill_log !== "string" ||
    path.isAbsolute(receipt.drill_log) ||
    receipt.drill_log.split(/[\\/]/u).includes("..") ||
    !/^([a-f0-9]{64})$/u.test(receipt.drill_log_sha256 || "") ||
    receipt.rate_limit?.status !== "PASS" ||
    receipt.fallback_code?.status !== "PASS"
  ) {
    throw new Error("HMAC rotation receipt does not prove both genuine keyring rotations");
  }
  const drillLog = safeRelative(path.dirname(file), path.join(path.dirname(file), receipt.drill_log), "HMAC drill log");
  const drillDirectory = path.dirname(drillLog);
  const expectedDrillDirectory = path.join(artifactsRoot, "gate-c-c5", targetSha, "hmac-rotation");
  if (
    !fs.existsSync(drillLog) ||
    fs.lstatSync(drillLog).isSymbolicLink() ||
    drillDirectory !== expectedDrillDirectory ||
    fs.lstatSync(expectedDrillDirectory).isSymbolicLink()
  ) {
    throw new Error("HMAC rotation receipt is missing a retained non-symlink drill log");
  }
  if (sha256(fs.readFileSync(drillLog)) !== receipt.drill_log_sha256) {
    throw new Error("HMAC rotation drill log hash mismatch");
  }
  let drillAttestation;
  try {
    drillAttestation = JSON.parse(fs.readFileSync(drillLog, "utf8"));
  } catch {
    throw new Error("HMAC rotation drill log is not JSON");
  }
  if (
    !drillAttestation ||
    drillAttestation.source_sha !== targetSha ||
    sha256(drillAttestation.attestation_nonce || "") !== receipt.attestation_nonce_sha256 ||
    sha256(drillAttestation.run_id || "") !== receipt.run_id_sha256 ||
    sha256(drillAttestation.deployment_id || "") !== receipt.deployment_id_sha256 ||
    sha256(drillAttestation.build_id || "") !== receipt.build_id_sha256 ||
    sha256(drillAttestation.attestation || "") !== receipt.operator_attestation_sha256
  )
    throw new Error("HMAC rotation drill provenance hash mismatch");
  for (const [name, rotation] of [
    ["rate_limit", receipt.rate_limit],
    ["fallback_code", receipt.fallback_code],
  ]) {
    if (
      rotation.new_primary_issuance_verified !== true ||
      rotation.old_material_overlap_verified !== true ||
      rotation.premature_retirement_refused !== true ||
      rotation.audited_retirement_verified !== true ||
      rotation.ambiguity_failed_closed !== true ||
      rotation.retirement_verified !== true ||
      rotation.retired_key_rejected !== true ||
      typeof rotation.recovery_oracle !== "string" ||
      !/^[a-z][a-z0-9_]{2,199}$/u.test(rotation.recovery_oracle)
    ) {
      throw new Error(`HMAC ${name} rotation is missing a mandatory observation`);
    }
    const rawRotation = drillAttestation[name];
    const rotationFields = [
      "new_primary_issuance_verified",
      "old_material_overlap_verified",
      "premature_retirement_refused",
      "audited_retirement_verified",
      "retirement_verified",
      "retired_key_rejected",
      "ambiguity_failed_closed",
      "recovery_oracle",
    ];
    if (
      !rawRotation ||
      rotationFields.some((field) => rotation[field] !== rawRotation[field]) ||
      !Array.isArray(rotation.key_fingerprints) ||
      rotation.key_fingerprints.length < 2 ||
      new Set(rotation.key_fingerprints).size !== rotation.key_fingerprints.length ||
      !Array.isArray(rawRotation.key_fingerprints) ||
      rawRotation.key_fingerprints.length !== rotation.key_fingerprints.length ||
      rawRotation.key_fingerprints.some((value, index) => value !== rotation.key_fingerprints[index])
    )
      throw new Error(`HMAC ${name} rotation is not bound to the retained drill attestation`);
    for (const fingerprint of rotation.key_fingerprints || []) assertSha256(fingerprint, `${name} key fingerprint`);
  }
  return { data: receipt, evidence: fileEvidence(file), path: file };
}

function validateDeployment(artifactsRoot, qaDir, targetSha) {
  const artifact = path.join(artifactsRoot, "deployment", "vercel-response.json");
  const docs = path.join(qaDir, "deployment-evidence.json");
  const file = fs.existsSync(artifact) ? artifact : docs;
  const deployment = readJson(file, "Vercel deployment evidence");
  if (
    deployment.provider !== "vercel" ||
    deployment.verification_mode !== "live_api" ||
    deployment.release_eligible !== true ||
    deployment.project_id !== MATCHDAY_VERCEL_PROJECT_ID ||
    deployment.team_id !== MATCHDAY_VERCEL_TEAM_ID ||
    deployment.git_branch !== MATCHDAY_GATE_C_BRANCH ||
    deployment.git_commit_sha !== targetSha ||
    deployment.candidate_sha !== targetSha ||
    deployment.state !== "READY" ||
    typeof deployment.deployment_id !== "string" ||
    !/^dpl_[A-Za-z0-9]+$/u.test(deployment.deployment_id)
  ) {
    throw new Error("Deployment evidence is not a live READY exact-candidate Matchday Vercel receipt");
  }
  if (!deployment.url || !deployment.url.startsWith("https://")) {
    throw new Error("Deployment evidence is missing the verified HTTPS deployment URL");
  }
  return { data: deployment, evidence: fileEvidence(file), path: file };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

export function sealGateCCertification(options = {}) {
  const targetSha = options.candidateSha || execSync("git rev-parse HEAD", { cwd: rootDir, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/u.test(targetSha)) throw new Error(`Invalid candidate SHA: ${targetSha}`);
  const qaDir = options.qaDir || path.join(rootDir, "docs", "qa");
  const artifactsRoot = options.artifactsDir || path.join(rootDir, "artifacts", "qa");
  const timestamp = new Date().toISOString();

  const c1 = validateLaneLedger({
    artifactsRoot,
    targetSha,
    directoryName: "gate-c-access",
    artifactKind: "gate-c-access-exact-sha-ledger",
    label: "C1 access",
  });
  const c2 = validateLaneLedger({
    artifactsRoot,
    targetSha,
    directoryName: "gate-c-c2",
    artifactKind: "gate-c-c2-exact-sha-ledger",
    label: "C2 scoring",
  });
  const c2MigrationLock = validateC2MigrationLockBenchmark(artifactsRoot, targetSha);
  const c3Browser = validateC3BrowserRun(artifactsRoot, targetSha);
  const ios = validatePhysicalPlatform(artifactsRoot, targetSha, "ios");
  const android = validatePhysicalPlatform(artifactsRoot, targetSha, "android");
  const c4 = validateC4Receipt(artifactsRoot, targetSha);
  const c5 = validateC5Certification(artifactsRoot, targetSha);
  const faults = c5.faults;
  const hmac = validateHmac(artifactsRoot, targetSha);
  const deployment = validateDeployment(artifactsRoot, qaDir, targetSha);

  const laneEvidence = {
    c1: { receipt: relative(rootDir, c1.path), sha256: c1.evidence.sha256 },
    c2: { receipt: relative(rootDir, c2.path), sha256: c2.evidence.sha256 },
    c2_migration_lock: { receipt: relative(rootDir, c2MigrationLock.path), sha256: c2MigrationLock.evidence.sha256 },
    c3_browser: { receipt: relative(rootDir, c3Browser.path), sha256: c3Browser.evidence.sha256 },
    c3_ios: { receipt: relative(rootDir, ios.path), sha256: ios.evidence.sha256 },
    c3_android: { receipt: relative(rootDir, android.path), sha256: android.evidence.sha256 },
    c4: { receipt: relative(rootDir, c4.path), sha256: c4.evidence.sha256 },
    c5: { receipt: relative(rootDir, c5.path), sha256: c5.evidence.sha256 },
    hmac: { receipt: relative(rootDir, hmac.path), sha256: hmac.evidence.sha256 },
    deployment: { receipt: relative(rootDir, deployment.path), sha256: deployment.evidence.sha256 },
  };

  const summaries = {
    c1: {
      schema_version: 2,
      artifact_kind: "gate-c-c1-exact-sha-summary",
      record_status: "CURRENT_CERTIFICATION",
      source_sha: targetSha,
      branch: MATCHDAY_GATE_C_BRANCH,
      status: "PASS",
      collected_at: timestamp,
      environment: c1.data.environment,
      source_receipt: laneEvidence.c1,
      command_count: c1.data.commands.length,
      independent_run_count: c1.data.runs.length,
    },
    c2: {
      schema_version: 2,
      artifact_kind: "gate-c-c2-exact-sha-summary",
      record_status: "CURRENT_CERTIFICATION",
      source_sha: targetSha,
      branch: MATCHDAY_GATE_C_BRANCH,
      status: "PASS",
      collected_at: timestamp,
      environment: c2.data.environment,
      source_receipts: { scoring: laneEvidence.c2, migration_lock: laneEvidence.c2_migration_lock },
      command_count: c2.data.commands.length,
      independent_run_count: c2.data.runs.length,
      controlled_staging: {
        profile: c2MigrationLock.data.fixtureProfile,
        fixture_rows: c2MigrationLock.data.fixtureRows,
        database_size_bytes: c2MigrationLock.data.database.databaseSizeBytes,
        maintenance_window_required: c2MigrationLock.data.recommendations.maintenanceWindowRequired,
        write_drain_required: c2MigrationLock.data.recommendations.writeDrainRequired,
      },
    },
    c3: {
      schema_version: 2,
      artifact_kind: "gate-c-c3-exact-sha-summary",
      record_status: "CURRENT_CERTIFICATION",
      source_sha: targetSha,
      branch: MATCHDAY_GATE_C_BRANCH,
      status: "PASS",
      collected_at: timestamp,
      environment: { browser_projects: c3Browser.data.projects.length },
      source_receipts: {
        browser: laneEvidence.c3_browser,
        ios: laneEvidence.c3_ios,
        android: laneEvidence.c3_android,
      },
      physical_device_testing: {
        ios: { device_model: ios.data.device_model, receipt_sha256: ios.data.receipt_sha256 },
        android: { device_model: android.data.device_model, receipt_sha256: android.data.receipt_sha256 },
      },
    },
    c4: {
      schema_version: 2,
      artifact_kind: "gate-c-c4-exact-sha-summary",
      record_status: "CURRENT_CERTIFICATION",
      source_sha: targetSha,
      branch: MATCHDAY_GATE_C_BRANCH,
      status: "PASS",
      collected_at: timestamp,
      environment: c4.data.environment,
      source_receipt: laneEvidence.c4,
      checks: c4.data.checks,
    },
    c5: {
      schema_version: 2,
      artifact_kind: "gate-c-c5-exact-sha-summary",
      record_status: "CURRENT_CERTIFICATION",
      source_sha: targetSha,
      branch: MATCHDAY_GATE_C_BRANCH,
      status: "PASS",
      collected_at: timestamp,
      environment: {
        profile_id: c5.data.profile_id,
        minimum_samples_per_operation: c5.data.minimum_samples_per_operation,
      },
      source_receipts: { certification: laneEvidence.c5, hmac: laneEvidence.hmac },
      operations: c5.data.operations,
      controlled_failures: faults,
      hmac_rotation: hmac.data,
    },
  };

  for (const [lane, summary] of Object.entries(summaries)) {
    writeJson(path.join(qaDir, `gate-c-${lane}-final-evidence.json`), summary);
    fs.writeFileSync(
      path.join(qaDir, `gate-c-${lane}-verdict.md`),
      `# Gate C ${lane.toUpperCase()} Final Verdict\n\n**Candidate SHA**: \`${targetSha}\`\n**Status**: \`CERTIFIED / PASS\`\n**Sealed**: \`${timestamp}\`\n\nThis verdict is derived from the exact-SHA retained execution receipts referenced by the JSON evidence file.\n`,
      "utf8",
    );
  }

  const finalEvidence = {
    schema_version: 2,
    artifact_kind: "gate-c-consolidated-final-evidence",
    record_status: "CURRENT_CERTIFICATION",
    candidate_sha: targetSha,
    branch: MATCHDAY_GATE_C_BRANCH,
    verdict: "PASS",
    status: "CERTIFIED",
    certified_at: timestamp,
    components: {
      c1_access_and_leasing: { status: "PASS", evidence: laneEvidence.c1 },
      c2_scoring_and_projection: {
        status: "PASS",
        evidence: { scoring: laneEvidence.c2, migration_lock: laneEvidence.c2_migration_lock },
      },
      c3_offline_sync: { status: "PASS", evidence: laneEvidence.c3_browser },
      c4_repairs_and_truth: { status: "PASS", evidence: laneEvidence.c4 },
      c5_performance_and_drills: { status: "PASS", evidence: laneEvidence.c5 },
      migrations_backup_build_security: { status: "PASS", evidence: laneEvidence.c1 },
      deployment_readiness: { status: "PASS", evidence: laneEvidence.deployment },
    },
  };
  writeJson(path.join(qaDir, "gate-c-final-evidence.json"), finalEvidence);
  fs.writeFileSync(
    path.join(qaDir, "gate-c-verdict.md"),
    `# Gate C Final Release Certification Verdict\n\n**Candidate SHA**: \`${targetSha}\`\n**Status**: \`CERTIFIED / PASS\`\n**Sealed**: \`${timestamp}\`\n\nAll C1–C5 lanes, real infrastructure performance/failure evidence, physical-device evidence, migration/backup/build/security gates, and the live exact-candidate Vercel deployment were validated before sealing.\n`,
    "utf8",
  );

  const candidateRelease = {
    schema_version: 2,
    releaseId: `gate-c-certified-${targetSha.slice(0, 12)}`,
    candidateSha: targetSha,
    branch: MATCHDAY_GATE_C_BRANCH,
    status: "CERTIFIED",
    verdict: "PASS",
    milestone: "GATE_C",
    certifiedAtUtc: timestamp,
    deployment: {
      deployment_id: deployment.data.deployment_id,
      project_id: deployment.data.project_id,
      team_id: deployment.data.team_id,
      url: deployment.data.url,
      verification_mode: deployment.data.verification_mode,
    },
    evidence: laneEvidence,
  };
  writeJson(path.join(qaDir, "candidate-release.json"), candidateRelease);
  writeJson(path.join(qaDir, "deployment-evidence.json"), deployment.data);

  return { candidateSha: targetSha, status: "CERTIFIED", verdict: "PASS" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const candidateSha = args.find((arg) => arg.startsWith("--sha="))?.split("=")[1];
  try {
    const result = sealGateCCertification({ candidateSha });
    console.log(`\n✅ Gate C sealed from retained exact-SHA evidence: ${result.candidateSha}`);
  } catch (error) {
    console.error(`\n❌ Gate C sealing FAILED: ${error.message}`);
    process.exit(1);
  }
}
