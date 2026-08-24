import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { REQUIRED_FAULTS, sealGateCCertification } from "./seal-gate-c-certification.mjs";
import {
  MATCHDAY_GATE_C_BRANCH,
  MATCHDAY_VERCEL_PROJECT_ID,
  MATCHDAY_VERCEL_TEAM_ID,
} from "./verify-vercel-deployment.mjs";

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function setupLaneLedger(artifactsDir, candidateSha, directoryName, artifactKind) {
  const ledgerDir = path.join(artifactsDir, directoryName, candidateSha, "ledgers", "2026-08-21-test-ledger");
  const logPath = path.join(ledgerDir, "logs", "evidence.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, "all checks passed\n", "utf8");
  const bytes = fs.readFileSync(logPath);
  const commands = ["migrations", "backup", "integration", "secrets", "build"].map((label) => ({
    label,
    command: `pnpm ${label}`,
    exit_code: 0,
  }));
  const ledger = {
    schema_version: 1,
    artifact_kind: artifactKind,
    source_sha: candidateSha,
    source_guard: { clean_before: true, clean_after: true },
    environment: { node_version: process.version },
    commands,
    runs: [1, 2].map((run_number) => ({ run_number, receipt: { source_sha: candidateSha } })),
    artifacts: [
      {
        path: "logs/evidence.log",
        sha256: sha256(bytes),
        size_bytes: bytes.byteLength,
      },
    ],
  };
  writeJson(path.join(ledgerDir, "ledger.json"), ledger);
}

function setupC3(artifactsDir, candidateSha) {
  const runDir = path.join(artifactsDir, "gate-c-c3", candidateSha, "runs", "2026-08-21-browser-run");
  const projects = ["chromium-phone", "webkit-phone", "chromium-desktop", "webkit-desktop", "firefox-desktop"].map(
    (name, index) => {
      const projectName = `gate-c-c3-${name}`;
      const evidencePath = `${projectName}/project-evidence.json`;
      writeJson(path.join(runDir, evidencePath), {
        source_sha: candidateSha,
        project_name: projectName,
        pass_count: 15,
        failed_count: 0,
        skipped_count: 0,
      });
      return { project_name: projectName, pass_count: 15, evidence_path: evidencePath, index };
    },
  );
  writeJson(path.join(runDir, "run-evidence.json"), {
    artifact_kind: "gate-c-c3-run-evidence",
    source_sha: candidateSha,
    pass_count: 75,
    failed_count: 0,
    skipped_count: 0,
    projects,
  });

  const scenarios = [
    "online_preparation",
    "offline_event_and_local_reversal",
    "page_refresh",
    "browser_restart",
    "strict_ordered_replay",
    "pending_finalisation",
    "stale_generation_takeover",
    "sanitised_export",
  ];
  for (const platform of ["ios", "android"]) {
    const platformDir = path.join(artifactsDir, "gate-c-c3", candidateSha, "physical", platform);
    const receiptScenarios = scenarios.map((scenario) => {
      const trace = JSON.stringify([{ seq: 1, scenario, platform, observed: true }], null, 2) + "\n";
      const tracePath = path.join(platformDir, "traces", `${scenario}.trace.json`);
      fs.mkdirSync(path.dirname(tracePath), { recursive: true });
      fs.writeFileSync(tracePath, trace, "utf8");
      const base = {
        scenario_id: scenario,
        platform,
        status: "passed",
        raw_trace_sha256: sha256(trace),
      };
      return { ...base, scenario_hash: sha256(JSON.stringify(base)) };
    });
    const baseReceipt = {
      source_sha: candidateSha,
      platform,
      status: "passed",
      device_model: platform === "ios" ? "iPhone 15 Pro" : "Pixel 8 Pro",
      os_version: platform === "ios" ? "iOS 18.2" : "Android 15",
      browser_name: platform === "ios" ? "Mobile Safari" : "Chrome Mobile",
      browser_version: "test",
      collected_at: "2026-08-21T00:00:00.000Z",
      scenarios: receiptScenarios,
    };
    writeJson(path.join(platformDir, "receipt.json"), {
      ...baseReceipt,
      receipt_sha256: sha256(JSON.stringify(baseReceipt)),
    });
  }
}

function setupC4(artifactsDir, candidateSha) {
  writeJson(path.join(artifactsDir, "gate-c-c4", candidateSha, "run-evidence.json"), {
    artifact_kind: "gate-c-c4-exact-sha-evidence",
    record_status: "UNSEALED_COLLECTOR",
    source_sha: candidateSha,
    status: "PASS",
    environment: { node_version: process.version },
    checks: { zero_partial_state_verified: true, publication_and_public_truth: "PASS" },
    outputs: {
      unit_test_summary_sha256: sha256("unit pass"),
      e2e_test_summary_sha256: sha256("e2e pass"),
    },
  });
}

function setupC5(artifactsDir, candidateSha) {
  const c5Dir = path.join(artifactsDir, "gate-c-c5", candidateSha);
  const retainedAttestation = (fault, lane) => {
    const lanePhases = {
      injection: ["PRECONDITION", "INJECT", "DEGRADATION"],
      recovery: ["RECOVER", "INVARIANT"],
      cleanup: ["CLEANUP"],
    };
    return JSON.stringify({
      artifact_kind: "gate-c-c5-sanitized-fault-attestations-v1",
      lane,
      phases: lanePhases[lane].map((phase) => ({
        protocol: "gate-c-c5-fault-attestation-v1",
        source_sha: candidateSha,
        run_id: "controlled-staging-run-1",
        deployment_id: "dpl-controlled-staging-1",
        build_id: "build-controlled-staging-1",
        component: "gate_c_runner",
        fault,
        phase,
        nonce_sha256: sha256(`${fault}:${phase}:nonce`),
        observation_sha256: sha256(`${fault}:${phase}:observation`),
        attestation_sha256: sha256(`${fault}:${phase}:attestation`),
      })),
    });
  };
  const operation = (p95Ms) => ({
    operation: "placeholder",
    workerCount: 1,
    timeoutCount: 0,
    summary: {
      sampleCount: 500,
      successfulCount: 500,
      expectedFailureCount: 0,
      unexpectedFailureCount: 0,
      errorRate: 0,
      p50Ms: 1,
      p95Ms,
      p99Ms: p95Ms,
      maxMs: p95Ms,
    },
    correctness: { passed: true },
  });
  const operations = {
    score_event_acknowledgement: { ...operation(25), operation: "score_event_acknowledgement" },
    public_current_conditional_read: { ...operation(20), operation: "public_current_conditional_read" },
    public_result_convergence: { ...operation(100), operation: "public_result_convergence" },
    lease_takeover: { ...operation(80), operation: "lease_takeover" },
    repair_publication: { ...operation(90), operation: "repair_publication" },
  };
  const retained_artifacts = {};
  const controlled_failures = [];
  for (const fault of REQUIRED_FAULTS) {
    const faultDir = path.join(c5Dir, "retained", fault);
    const logs = {
      injection: retainedAttestation(fault, "injection"),
      recovery: retainedAttestation(fault, "recovery"),
      cleanup: retainedAttestation(fault, "cleanup"),
    };
    fs.mkdirSync(faultDir, { recursive: true });
    for (const [name, content] of Object.entries(logs)) fs.writeFileSync(path.join(faultDir, `${name}.log`), content);
    retained_artifacts[fault] = {
      injection: `${fault}/injection.log`,
      recovery: `${fault}/recovery.log`,
      cleanup: `${fault}/cleanup.log`,
    };
    controlled_failures.push({
      fault,
      recovery_observed: true,
      cleanup_observed: true,
      recovery_oracle: "recovery_verified",
      injector: "command",
      injection_evidence_sha256: sha256(logs.injection),
      recovery_evidence_sha256: sha256(logs.recovery),
      cleanup_evidence_sha256: sha256(logs.cleanup),
    });
  }
  writeJson(path.join(c5Dir, "certification.json"), {
    receipt: {
      artifact_kind: "gate-c-c5-integrated-workload-receipt",
      source_sha: candidateSha,
      profile_id: "gate-c-test-profile",
      approval_reference_sha256: sha256("approval"),
      workload_plan_sha256: sha256("plan"),
      minimum_samples_per_operation: 500,
      duration_ms: 4_500_000,
      operations,
      controlled_failures,
      postgresql_identifier_sha256: sha256("postgres"),
      redis_namespace_sha256: sha256("redis"),
    },
    retained_artifacts,
  });

  const rotation = {
    status: "PASS",
    new_primary_issuance_verified: true,
    old_material_overlap_verified: true,
    premature_retirement_refused: true,
    audited_retirement_verified: true,
    ambiguity_failed_closed: true,
    retirement_verified: true,
    retired_key_rejected: true,
    key_fingerprints: [sha256("new"), sha256("old")],
    recovery_oracle: "rotation_recovered",
  };
  const hmacLog =
    JSON.stringify({
      source_sha: candidateSha,
      run_id: "test-run",
      deployment_id: "test-deployment",
      build_id: "test-build",
      attestation: "test-attestation",
      attestation_nonce: "test-nonce",
      rate_limit: { ...rotation, status: undefined },
      fallback_code: {
        ...rotation,
        status: undefined,
        key_fingerprints: [sha256("fallback-new"), sha256("fallback-old")],
      },
    }) + "\n";
  fs.mkdirSync(path.join(c5Dir, "hmac-rotation"), { recursive: true });
  fs.writeFileSync(path.join(c5Dir, "hmac-rotation", "drill.log"), hmacLog, "utf8");
  writeJson(path.join(c5Dir, "hmac-rotation.json"), {
    artifact_kind: "gate-c-c5-hmac-rotation",
    source_sha: candidateSha,
    evidence_type: "operational_drill",
    status: "PASS",
    control_plane_sha256: sha256("https://control.example.test"),
    attestation_nonce_sha256: sha256("test-nonce"),
    run_id_sha256: sha256("test-run"),
    deployment_id_sha256: sha256("test-deployment"),
    build_id_sha256: sha256("test-build"),
    operator_attestation_sha256: sha256("test-attestation"),
    drill_log: "hmac-rotation/drill.log",
    drill_log_sha256: sha256(hmacLog),
    rate_limit: rotation,
    fallback_code: { ...rotation, key_fingerprints: [sha256("fallback-new"), sha256("fallback-old")] },
  });
}

function setupDeployment(artifactsDir, candidateSha) {
  writeJson(path.join(artifactsDir, "deployment", "vercel-response.json"), {
    schema_version: "gate-c-vercel-deployment-v2",
    candidate_sha: candidateSha,
    provider: "vercel",
    project_id: MATCHDAY_VERCEL_PROJECT_ID,
    team_id: MATCHDAY_VERCEL_TEAM_ID,
    deployment_id: "dpl_1234567890abcdefghijklmnopqr",
    url: "https://candidate.example.vercel.app",
    git_branch: MATCHDAY_GATE_C_BRANCH,
    git_commit_sha: candidateSha,
    environment: "preview",
    state: "READY",
    verification_mode: "live_api",
    release_eligible: true,
  });
}

function setupC2MigrationLockBenchmark(artifactsDir, candidateSha) {
  const directory = path.join(artifactsDir, "gate-c-c2", candidateSha);
  const fixtureProfile = {
    name: "representative-c2-v1",
    competitions: 3,
    divisionsPerCompetition: 2,
    matchesPerDivision: 12,
    scoreEventsPerMatch: 16,
    scoringSessionsPerMatch: 1,
    resultConflictsPerCompetition: 2,
  };
  const fixtureRows = {
    competitions: 3,
    divisions: 6,
    matches: 72,
    scheduledMatches: 72,
    scoreEvents: 1152,
    scoringSessions: 72,
    resultConflicts: 6,
  };
  const profileNames = {
    baseline: "Baseline",
    publicReads: "PublicReads",
    organiserReads: "OrganiserReads",
    writerMutations: "WriterMutations",
  };
  const profiles = {};
  for (const [key, profileName] of Object.entries(profileNames)) {
    const traffic = {
      executed: key === "baseline" ? 0 : 5,
      blocked: 0,
      timedOut: 0,
      deadlocked: 0,
      latencies: key === "baseline" ? [] : [1, 2, 3, 4, 5],
    };
    const raw = { lockSamples: [], traffic };
    const rawFilename = `${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}.json`;
    const rawPath = path.join(directory, "raw", rawFilename);
    const rawContent = JSON.stringify(raw, null, 2);
    fs.mkdirSync(path.dirname(rawPath), { recursive: true });
    fs.writeFileSync(rawPath, rawContent, "utf8");
    profiles[key] = {
      profileName,
      description: `${profileName} controlled staging profile`,
      migration0030DurationMs: 12,
      migration0031DurationMs: 8,
      totalDurationMs: 20,
      tableLockModes: {},
      lockWaitQueueMax: 0,
      concurrentQueriesExecuted: traffic.executed,
      concurrentQueriesBlocked: traffic.blocked,
      concurrentQueriesTimedOut: traffic.timedOut,
      concurrentQueriesDeadlocked: traffic.deadlocked,
      concurrentQueryLatenciesMs: { min: 0, p50: 0, p95: 0, max: 0 },
      fixtureRows,
      cleanup: { schemaDropped: true, temporaryMigrationDirectoryRemoved: true, failures: [] },
      retainedRawLog: {
        path: `artifacts/qa/gate-c-c2/${candidateSha}/raw/${rawFilename}`,
        sha256: sha256(rawContent),
      },
    };
  }
  writeJson(path.join(directory, "migration-lock-benchmark.json"), {
    schemaVersion: 3,
    artifactKind: "gate-c-c2-migration-lock-benchmark",
    sourceSha: candidateSha,
    executionClassification: "controlled_staging_observation",
    timestamp: "2026-08-24T00:00:00.000Z",
    engine: "PostgreSQL",
    postgresVersion: "16.4",
    database: { databaseNameHash: sha256("controlled-staging"), databaseSizeBytes: 1024 },
    fixtureProfile,
    fixtureRows,
    profiles,
    abortRollback: {
      scenario: "Malformed pre-0030 writer generation preflight abort",
      preflightFailureTriggered: "writer generation preflight failed",
      ddlAttemptDurationMs: 5,
      rollbackDurationMs: 5,
      postRollbackLocksRemaining: 0,
      lockReleaseVerified: true,
      cleanup: { schemaDropped: true, temporaryMigrationDirectoryRemoved: true, failures: [] },
    },
    recommendations: { maintenanceWindowRequired: true, writeDrainRequired: true },
    cleanup: { schemasDropped: 5, temporaryMigrationDirectoriesRemoved: 5, cleanupFailures: [] },
  });
}

function setupValidWorkspace(candidateSha) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matchday-seal-test-"));
  const qaDir = path.join(tempDir, "docs", "qa");
  const artifactsDir = path.join(tempDir, "artifacts", "qa");
  fs.mkdirSync(qaDir, { recursive: true });
  setupLaneLedger(artifactsDir, candidateSha, "gate-c-access", "gate-c-access-exact-sha-ledger");
  setupLaneLedger(artifactsDir, candidateSha, "gate-c-c2", "gate-c-c2-exact-sha-ledger");
  setupC2MigrationLockBenchmark(artifactsDir, candidateSha);
  setupC3(artifactsDir, candidateSha);
  setupC4(artifactsDir, candidateSha);
  setupC5(artifactsDir, candidateSha);
  setupDeployment(artifactsDir, candidateSha);
  return { tempDir, qaDir, artifactsDir };
}

test("Gate C evidence-only sealer", async (t) => {
  const candidateSha = "1111111111111111111111111111111111111111";

  await t.test("fails if C1 exact-SHA execution ledger is absent", () => {
    const ws = setupValidWorkspace(candidateSha);
    fs.rmSync(path.join(ws.artifactsDir, "gate-c-access"), { recursive: true, force: true });
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /C1 access/,
    );
    fs.rmSync(ws.tempDir, { recursive: true, force: true });
  });

  await t.test("fails if a retained lane artifact is tampered", () => {
    const ws = setupValidWorkspace(candidateSha);
    const file = path.join(
      ws.artifactsDir,
      "gate-c-c2",
      candidateSha,
      "ledgers",
      "2026-08-21-test-ledger",
      "logs",
      "evidence.log",
    );
    fs.writeFileSync(file, "tampered\n");
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /immutable manifest/,
    );
    fs.rmSync(ws.tempDir, { recursive: true, force: true });
  });

  await t.test("fails if the exact-SHA controlled-staging C2 migration receipt is absent", () => {
    const ws = setupValidWorkspace(candidateSha);
    fs.rmSync(path.join(ws.artifactsDir, "gate-c-c2", candidateSha, "migration-lock-benchmark.json"));
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /C2 controlled-staging migration lock benchmark/,
    );
    fs.rmSync(ws.tempDir, { recursive: true, force: true });
  });

  await t.test("fails if the C2 migration receipt is malformed or bound to another SHA", () => {
    const ws = setupValidWorkspace(candidateSha);
    const receipt = path.join(ws.artifactsDir, "gate-c-c2", candidateSha, "migration-lock-benchmark.json");
    fs.writeFileSync(receipt, "{ nope", "utf8");
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /Malformed JSON/,
    );
    setupC2MigrationLockBenchmark(ws.artifactsDir, candidateSha);
    const value = JSON.parse(fs.readFileSync(receipt, "utf8"));
    value.sourceSha = "2".repeat(40);
    writeJson(receipt, value);
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /exact-SHA PostgreSQL receipt/,
    );
    fs.rmSync(ws.tempDir, { recursive: true, force: true });
  });

  await t.test("fails if C2 raw observations are tampered or their outcome summary is forged", () => {
    const ws = setupValidWorkspace(candidateSha);
    const raw = path.join(ws.artifactsDir, "gate-c-c2", candidateSha, "raw", "writer-mutations.json");
    fs.writeFileSync(raw, '{"lockSamples":[],"traffic":{"executed":5}}\n', "utf8");
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /raw observation hash mismatch/,
    );
    setupC2MigrationLockBenchmark(ws.artifactsDir, candidateSha);
    const receipt = path.join(ws.artifactsDir, "gate-c-c2", candidateSha, "migration-lock-benchmark.json");
    const value = JSON.parse(fs.readFileSync(receipt, "utf8"));
    value.profiles.writerMutations.concurrentQueriesExecuted = 0;
    writeJson(receipt, value);
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /did not retain successful concurrent traffic/,
    );
    fs.rmSync(ws.tempDir, { recursive: true, force: true });
  });

  await t.test("fails if C2 fixture, timeout, or cleanup evidence is incomplete", () => {
    const ws = setupValidWorkspace(candidateSha);
    const receipt = path.join(ws.artifactsDir, "gate-c-c2", candidateSha, "migration-lock-benchmark.json");
    const value = JSON.parse(fs.readFileSync(receipt, "utf8"));
    value.fixtureRows.scoreEvents = 1;
    writeJson(receipt, value);
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /fixture row outcome/,
    );
    setupC2MigrationLockBenchmark(ws.artifactsDir, candidateSha);
    const timeout = JSON.parse(fs.readFileSync(receipt, "utf8"));
    timeout.profiles.publicReads.concurrentQueriesTimedOut = 1;
    writeJson(receipt, timeout);
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /timeout or deadlock/,
    );
    setupC2MigrationLockBenchmark(ws.artifactsDir, candidateSha);
    const cleanup = JSON.parse(fs.readFileSync(receipt, "utf8"));
    cleanup.cleanup.schemasDropped = 4;
    writeJson(receipt, cleanup);
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /aggregate cleanup evidence/,
    );
    fs.rmSync(ws.tempDir, { recursive: true, force: true });
  });

  await t.test("fails if a physical trace is tampered", () => {
    const ws = setupValidWorkspace(candidateSha);
    const file = path.join(
      ws.artifactsDir,
      "gate-c-c3",
      candidateSha,
      "physical",
      "ios",
      "traces",
      "online_preparation.trace.json",
    );
    fs.writeFileSync(file, "[]\n");
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /Raw trace hash mismatch/,
    );
    fs.rmSync(ws.tempDir, { recursive: true, force: true });
  });

  await t.test("rejects a benchmark that is not real Matchday infrastructure", () => {
    const ws = setupValidWorkspace(candidateSha);
    const file = path.join(ws.artifactsDir, "gate-c-c5", candidateSha, "certification.json");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    value.receipt.minimum_samples_per_operation = 499;
    writeJson(file, value);
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /integrated workload receipt/,
    );
    fs.rmSync(ws.tempDir, { recursive: true, force: true });
  });

  await t.test("rejects narrative-only fault receipts", () => {
    const ws = setupValidWorkspace(candidateSha);
    const file = path.join(ws.artifactsDir, "gate-c-c5", candidateSha, "certification.json");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    value.receipt.controlled_failures = value.receipt.controlled_failures.filter(
      (entry) => entry.fault !== "web_interruption",
    );
    writeJson(file, value);
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /missing integrated/,
    );
    fs.rmSync(ws.tempDir, { recursive: true, force: true });
  });

  await t.test("rejects stale or malformed hash-listed retained C5 attestations", () => {
    const ws = setupValidWorkspace(candidateSha);
    const certificationPath = path.join(ws.artifactsDir, "gate-c-c5", candidateSha, "certification.json");
    const stalePath = path.join(
      ws.artifactsDir,
      "gate-c-c5",
      candidateSha,
      "retained",
      "postgres_interruption",
      "injection.log",
    );
    const certification = JSON.parse(fs.readFileSync(certificationPath, "utf8"));
    const stale = JSON.parse(fs.readFileSync(stalePath, "utf8"));
    stale.phases[0].source_sha = "2".repeat(40);
    fs.writeFileSync(stalePath, JSON.stringify(stale), "utf8");
    certification.receipt.controlled_failures.find(
      (entry) => entry.fault === "postgres_interruption",
    ).injection_evidence_sha256 = sha256(fs.readFileSync(stalePath));
    writeJson(certificationPath, certification);
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /invalid signed phase evidence/,
    );

    setupC5(ws.artifactsDir, candidateSha);
    const malformed = JSON.parse(fs.readFileSync(stalePath, "utf8"));
    [malformed.phases[0], malformed.phases[1]] = [malformed.phases[1], malformed.phases[0]];
    fs.writeFileSync(stalePath, JSON.stringify(malformed), "utf8");
    const replacement = JSON.parse(fs.readFileSync(certificationPath, "utf8"));
    replacement.receipt.controlled_failures.find(
      (entry) => entry.fault === "postgres_interruption",
    ).injection_evidence_sha256 = sha256(fs.readFileSync(stalePath));
    writeJson(certificationPath, replacement);
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /invalid signed phase evidence/,
    );
    fs.rmSync(ws.tempDir, { recursive: true, force: true });
  });

  await t.test("rejects hash-listed retained C5 artifacts with split run provenance", () => {
    const ws = setupValidWorkspace(candidateSha);
    const certificationPath = path.join(ws.artifactsDir, "gate-c-c5", candidateSha, "certification.json");
    const retainedPath = path.join(
      ws.artifactsDir,
      "gate-c-c5",
      candidateSha,
      "retained",
      "postgres_interruption",
      "cleanup.log",
    );
    const artifact = JSON.parse(fs.readFileSync(retainedPath, "utf8"));
    artifact.phases[0].run_id = "stale-run";
    fs.writeFileSync(retainedPath, JSON.stringify(artifact), "utf8");
    const certification = JSON.parse(fs.readFileSync(certificationPath, "utf8"));
    certification.receipt.controlled_failures.find(
      (entry) => entry.fault === "postgres_interruption",
    ).cleanup_evidence_sha256 = sha256(fs.readFileSync(retainedPath));
    writeJson(certificationPath, certification);
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /one exact source\/run\/deployment\/build provenance/,
    );
    fs.rmSync(ws.tempDir, { recursive: true, force: true });
  });

  await t.test("rejects hard-coded HMAC PASS without rotation observations", () => {
    const ws = setupValidWorkspace(candidateSha);
    const file = path.join(ws.artifactsDir, "gate-c-c5", candidateSha, "hmac-rotation.json");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    value.rate_limit.retirement_verified = false;
    writeJson(file, value);
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /mandatory observation/,
    );
    fs.rmSync(ws.tempDir, { recursive: true, force: true });
  });

  await t.test("rejects a tampered or escaped HMAC drill log", () => {
    const ws = setupValidWorkspace(candidateSha);
    const file = path.join(ws.artifactsDir, "gate-c-c5", candidateSha, "hmac-rotation.json");
    const log = path.join(ws.artifactsDir, "gate-c-c5", candidateSha, "hmac-rotation", "drill.log");
    fs.writeFileSync(log, "tampered\n", "utf8");
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /drill log hash mismatch/,
    );
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    value.drill_log = "../outside.log";
    writeJson(file, value);
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /genuine keyring rotations/,
    );
    fs.rmSync(ws.tempDir, { recursive: true, force: true });
  });

  await t.test("rejects a missing HMAC drill log", () => {
    const ws = setupValidWorkspace(candidateSha);
    fs.rmSync(path.join(ws.artifactsDir, "gate-c-c5", candidateSha, "hmac-rotation", "drill.log"));
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /missing a retained non-symlink drill log/,
    );
    fs.rmSync(ws.tempDir, { recursive: true, force: true });
  });

  await t.test("rejects disconnected HMAC provenance hashes", () => {
    const ws = setupValidWorkspace(candidateSha);
    const file = path.join(ws.artifactsDir, "gate-c-c5", candidateSha, "hmac-rotation.json");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    value.run_id_sha256 = sha256("forged-run");
    writeJson(file, value);
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /provenance hash mismatch/,
    );
    fs.rmSync(ws.tempDir, { recursive: true, force: true });
  });

  await t.test("rejects forged HMAC nonce, lifecycle and fingerprints", () => {
    const ws = setupValidWorkspace(candidateSha);
    const file = path.join(ws.artifactsDir, "gate-c-c5", candidateSha, "hmac-rotation.json");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    value.attestation_nonce_sha256 = sha256("forged-nonce");
    writeJson(file, value);
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /provenance hash mismatch/,
    );
    value.attestation_nonce_sha256 = sha256("test-nonce");
    value.rate_limit.retired_key_rejected = false;
    writeJson(file, value);
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /mandatory observation/,
    );
    fs.rmSync(ws.tempDir, { recursive: true, force: true });
  });

  await t.test("rejects artifact-only Vercel deployment evidence", () => {
    const ws = setupValidWorkspace(candidateSha);
    const file = path.join(ws.artifactsDir, "deployment", "vercel-response.json");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    value.verification_mode = "artifact_payload";
    value.release_eligible = false;
    writeJson(file, value);
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /live READY exact-candidate/,
    );
    fs.rmSync(ws.tempDir, { recursive: true, force: true });
  });

  await t.test("seals only when every required retained receipt is valid", () => {
    const ws = setupValidWorkspace(candidateSha);
    const result = sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir });
    assert.deepEqual(result, { candidateSha, status: "CERTIFIED", verdict: "PASS" });
    const c1 = JSON.parse(fs.readFileSync(path.join(ws.qaDir, "gate-c-c1-final-evidence.json"), "utf8"));
    const c4 = JSON.parse(fs.readFileSync(path.join(ws.qaDir, "gate-c-c4-final-evidence.json"), "utf8"));
    const release = JSON.parse(fs.readFileSync(path.join(ws.qaDir, "candidate-release.json"), "utf8"));
    assert.equal(c1.source_receipt.sha256.length, 64);
    assert.equal(c4.checks.zero_partial_state_verified, true);
    assert.equal(release.deployment.verification_mode, "live_api");
    fs.rmSync(ws.tempDir, { recursive: true, force: true });
  });
});
