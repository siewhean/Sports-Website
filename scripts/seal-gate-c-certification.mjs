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

function validateC4Receipt(artifactsRoot, targetSha) {
  const receiptPath = path.join(artifactsRoot, "gate-c-c4", targetSha, "run-evidence.json");
  const receipt = readJson(receiptPath, "C4 exact-SHA run evidence");
  if (
    receipt.artifact_kind !== "gate-c-c4-exact-sha-evidence" ||
    receipt.record_status !== "CURRENT_CERTIFICATION" ||
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
    const projectPath = safeRelative(path.dirname(runPath), path.join(path.dirname(runPath), project.evidence_path), "C3 project evidence");
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
    if (!fs.existsSync(tracePath)) throw new Error(`Missing raw trace file for ${platform} scenario ${scenario.scenario_id}`);
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

function validateC5Benchmark(artifactsRoot, targetSha) {
  const benchmarkPath = path.join(artifactsRoot, "gate-c-c5", targetSha, "benchmark.json");
  const benchmark = readJson(benchmarkPath, "C5 benchmark receipt");
  if (
    benchmark.source_sha !== targetSha ||
    benchmark.evidence_type !== "real_infrastructure" ||
    benchmark.runtime?.application !== "matchday-api" ||
    benchmark.runtime?.benchmark_owned_routes !== false ||
    benchmark.status !== "PASS"
  ) {
    throw new Error("C5 benchmark is not release-eligible real Matchday infrastructure evidence");
  }
  if (!benchmark.operations || typeof benchmark.operations !== "object") {
    throw new Error("C5 benchmark operations are missing or malformed");
  }
  for (const [name, budget] of Object.entries(C5_OPERATION_BUDGETS)) {
    const operation = benchmark.operations[name];
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
  return { data: benchmark, evidence: fileEvidence(benchmarkPath), path: benchmarkPath };
}

function validateFaults(artifactsRoot, targetSha) {
  const retained = path.join(artifactsRoot, "gate-c-c5", targetSha, "retained");
  const receipts = {};
  for (const fault of REQUIRED_FAULTS) {
    const faultDir = path.join(retained, fault);
    const receiptPath = path.join(faultDir, "receipt.json");
    const receipt = readJson(receiptPath, `${fault} fault receipt`);
    if (
      receipt.source_sha !== targetSha ||
      receipt.fault !== fault ||
      receipt.evidence_type !== "operational_drill" ||
      receipt.status !== "PASS" ||
      receipt.injection_observed !== true ||
      receipt.recovery_observed !== true ||
      receipt.cleanup_observed !== true ||
      receipt.invariants_verified !== true ||
      typeof receipt.actual_action !== "string" ||
      receipt.actual_action.length < 3
    ) {
      throw new Error(`Fault drill ${fault} is not genuine fail/recover/invariant evidence`);
    }
    if (
      receipt.invariants?.score_loss_count !== 0 ||
      receipt.invariants?.duplicate_effect_count !== 0 ||
      receipt.invariants?.stale_writer_accept_count !== 0
    ) {
      throw new Error(`Fault drill ${fault} violated a Gate C invariant`);
    }
    for (const [file, field] of [
      ["injection.log", "injection_evidence_sha256"],
      ["recovery.log", "recovery_evidence_sha256"],
      ["cleanup.log", "cleanup_evidence_sha256"],
    ]) {
      const full = path.join(faultDir, file);
      if (!fs.existsSync(full)) throw new Error(`Missing retained ${fault}/${file}`);
      const digest = sha256(fs.readFileSync(full));
      if (receipt[field] !== digest) throw new Error(`${fault}/${file} hash mismatch`);
    }
    receipts[fault] = receipt;
  }
  return receipts;
}

function validateHmac(artifactsRoot, targetSha) {
  const file = path.join(artifactsRoot, "gate-c-c5", targetSha, "hmac-rotation.json");
  const receipt = readJson(file, "HMAC rotation evidence");
  if (
    receipt.artifact_kind !== "gate-c-c5-hmac-rotation" ||
    receipt.source_sha !== targetSha ||
    receipt.evidence_type !== "operational_drill" ||
    receipt.status !== "PASS" ||
    receipt.rate_limit?.status !== "PASS" ||
    receipt.fallback_code?.status !== "PASS"
  ) {
    throw new Error("HMAC rotation receipt does not prove both genuine keyring rotations");
  }
  for (const [name, rotation] of [
    ["rate_limit", receipt.rate_limit],
    ["fallback_code", receipt.fallback_code],
  ]) {
    if (
      rotation.new_primary_issuance_verified !== true ||
      rotation.old_material_overlap_verified !== true ||
      rotation.ambiguity_failed_closed !== true ||
      rotation.retirement_verified !== true
    ) {
      throw new Error(`HMAC ${name} rotation is missing a mandatory observation`);
    }
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
  const c3Browser = validateC3BrowserRun(artifactsRoot, targetSha);
  const ios = validatePhysicalPlatform(artifactsRoot, targetSha, "ios");
  const android = validatePhysicalPlatform(artifactsRoot, targetSha, "android");
  const c4 = validateC4Receipt(artifactsRoot, targetSha);
  const c5 = validateC5Benchmark(artifactsRoot, targetSha);
  const faults = validateFaults(artifactsRoot, targetSha);
  const hmac = validateHmac(artifactsRoot, targetSha);
  const deployment = validateDeployment(artifactsRoot, qaDir, targetSha);

  const laneEvidence = {
    c1: { receipt: relative(rootDir, c1.path), sha256: c1.evidence.sha256 },
    c2: { receipt: relative(rootDir, c2.path), sha256: c2.evidence.sha256 },
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
      source_receipt: laneEvidence.c2,
      command_count: c2.data.commands.length,
      independent_run_count: c2.data.runs.length,
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
      environment: c5.data.environment,
      source_receipts: { benchmark: laneEvidence.c5, hmac: laneEvidence.hmac },
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
      c2_scoring_and_projection: { status: "PASS", evidence: laneEvidence.c2 },
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
