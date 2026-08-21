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
    record_status: "CURRENT_CERTIFICATION",
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
  const operation = (p95Ms) => ({
    summary: {
      sampleCount: 500,
      successfulCount: 500,
      unexpectedFailureCount: 0,
      p95Ms,
    },
    correctness: { passed: true },
  });
  writeJson(path.join(c5Dir, "benchmark.json"), {
    artifact_kind: "gate-c-c5-real-infrastructure-benchmark",
    source_sha: candidateSha,
    evidence_type: "real_infrastructure",
    status: "PASS",
    runtime: { application: "matchday-api", benchmark_owned_routes: false },
    environment: { postgresql_version: "18.4", redis_version: "8.2" },
    operations: {
      score_event_acknowledgement: operation(25),
      public_current_conditional_read: operation(20),
      public_result_convergence: operation(100),
      lease_takeover: operation(80),
      repair_publication: operation(90),
    },
  });

  for (const fault of REQUIRED_FAULTS) {
    const faultDir = path.join(c5Dir, "retained", fault);
    const logs = {
      injection: `${fault}: real fault observed\n`,
      recovery: `${fault}: recovery observed\n`,
      cleanup: `${fault}: cleanup observed\n`,
    };
    fs.mkdirSync(faultDir, { recursive: true });
    for (const [name, content] of Object.entries(logs)) fs.writeFileSync(path.join(faultDir, `${name}.log`), content);
    writeJson(path.join(faultDir, "receipt.json"), {
      source_sha: candidateSha,
      fault,
      evidence_type: "operational_drill",
      status: "PASS",
      actual_action: `inject_${fault}`,
      injection_observed: true,
      recovery_observed: true,
      cleanup_observed: true,
      invariants_verified: true,
      invariants: { score_loss_count: 0, duplicate_effect_count: 0, stale_writer_accept_count: 0 },
      injection_evidence_sha256: sha256(logs.injection),
      recovery_evidence_sha256: sha256(logs.recovery),
      cleanup_evidence_sha256: sha256(logs.cleanup),
    });
  }

  const rotation = {
    status: "PASS",
    new_primary_issuance_verified: true,
    old_material_overlap_verified: true,
    ambiguity_failed_closed: true,
    retirement_verified: true,
    key_fingerprints: [sha256("new"), sha256("old")],
  };
  writeJson(path.join(c5Dir, "hmac-rotation.json"), {
    artifact_kind: "gate-c-c5-hmac-rotation",
    source_sha: candidateSha,
    evidence_type: "operational_drill",
    status: "PASS",
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

function setupValidWorkspace(candidateSha) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matchday-seal-test-"));
  const qaDir = path.join(tempDir, "docs", "qa");
  const artifactsDir = path.join(tempDir, "artifacts", "qa");
  fs.mkdirSync(qaDir, { recursive: true });
  setupLaneLedger(artifactsDir, candidateSha, "gate-c-access", "gate-c-access-exact-sha-ledger");
  setupLaneLedger(artifactsDir, candidateSha, "gate-c-c2", "gate-c-c2-exact-sha-ledger");
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
    const file = path.join(ws.artifactsDir, "gate-c-c5", candidateSha, "benchmark.json");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    value.runtime.benchmark_owned_routes = true;
    writeJson(file, value);
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /real Matchday infrastructure/,
    );
    fs.rmSync(ws.tempDir, { recursive: true, force: true });
  });

  await t.test("rejects narrative-only fault receipts", () => {
    const ws = setupValidWorkspace(candidateSha);
    const file = path.join(ws.artifactsDir, "gate-c-c5", candidateSha, "retained", "web_interruption", "receipt.json");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    delete value.injection_observed;
    writeJson(file, value);
    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir: ws.qaDir, artifactsDir: ws.artifactsDir }),
      /not genuine/,
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
