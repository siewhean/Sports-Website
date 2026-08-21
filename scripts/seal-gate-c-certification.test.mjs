import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { REQUIRED_FAULTS, sealGateCCertification } from "./seal-gate-c-certification.mjs";

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function setupValidWorkspace(candidateSha) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matchday-seal-test-"));
  const qaDir = path.join(tempDir, "docs", "qa");
  const artifactsDir = path.join(tempDir, "artifacts", "qa");

  fs.mkdirSync(qaDir, { recursive: true });

  // 1. Setup C3 Physical Receipts and Raw Traces
  const scenarioList = [
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
    const tracesDir = path.join(platformDir, "traces");
    fs.mkdirSync(tracesDir, { recursive: true });

    const scenarios = scenarioList.map((s) => {
      const traceContent = JSON.stringify({
        scenario_id: s,
        platform,
        events: [{ type: "goal", timestamp: "2026-08-21T00:00:00Z" }],
      });
      const tracePath = path.join(tracesDir, `${s}.trace.json`);
      fs.writeFileSync(tracePath, traceContent, "utf8");
      const traceHash = sha256(traceContent);

      return {
        scenario_id: s,
        status: "passed",
        raw_trace_sha256: traceHash,
      };
    });

    const rawReceipt = {
      source_sha: candidateSha,
      platform,
      status: "passed",
      device_model: platform === "ios" ? "iPhone 15 Pro" : "Pixel 8 Pro",
      os_version: platform === "ios" ? "iOS 18.2" : "Android 15",
      browser_name: platform === "ios" ? "Mobile Safari" : "Chrome Mobile",
      browser_version: "1.0",
      collected_at: "2026-08-21T00:00:00.000Z",
      scenarios,
    };

    const receiptHash = sha256(JSON.stringify(rawReceipt));
    const finalReceipt = {
      ...rawReceipt,
      receipt_sha256: receiptHash,
    };

    fs.writeFileSync(path.join(platformDir, "receipt.json"), JSON.stringify(finalReceipt, null, 2), "utf8");
  }

  // 2. Setup C5 Benchmark Receipt
  const c5Dir = path.join(artifactsDir, "gate-c-c5", candidateSha);
  fs.mkdirSync(c5Dir, { recursive: true });

  const dummyOperations = {
    score_event_acknowledgement: { sampleCount: 500, unexpectedFailureCount: 0, p95Ms: 12.5 },
    public_current_conditional_read: { sampleCount: 500, unexpectedFailureCount: 0, p95Ms: 8.2 },
    public_result_convergence: { sampleCount: 500, unexpectedFailureCount: 0, p95Ms: 15.0 },
    lease_takeover: { sampleCount: 500, unexpectedFailureCount: 0, p95Ms: 22.0 },
    repair_publication: { sampleCount: 500, unexpectedFailureCount: 0, p95Ms: 18.0 },
  };

  fs.writeFileSync(
    path.join(c5Dir, "benchmark.json"),
    JSON.stringify({ source_sha: candidateSha, operations: dummyOperations }, null, 2),
    "utf8",
  );

  // 3. Setup 12 Controlled Failure Receipts and Retained Logs
  const c5RetainedDir = path.join(c5Dir, "retained");
  for (const fault of REQUIRED_FAULTS) {
    const faultDir = path.join(c5RetainedDir, fault);
    fs.mkdirSync(faultDir, { recursive: true });

    const injLog = `[DRILL: ${fault}] Injection verified\n`;
    const recLog = `[DRILL: ${fault}] Recovery verified\n`;
    const clnLog = `[DRILL: ${fault}] Cleanup verified\n`;

    fs.writeFileSync(path.join(faultDir, "injection.log"), injLog, "utf8");
    fs.writeFileSync(path.join(faultDir, "recovery.log"), recLog, "utf8");
    fs.writeFileSync(path.join(faultDir, "cleanup.log"), clnLog, "utf8");

    const faultReceipt = {
      fault,
      recovery_observed: true,
      cleanup_observed: true,
      injection_evidence_sha256: sha256(injLog),
      recovery_evidence_sha256: sha256(recLog),
      cleanup_evidence_sha256: sha256(clnLog),
    };

    fs.writeFileSync(path.join(faultDir, "receipt.json"), JSON.stringify(faultReceipt, null, 2), "utf8");
  }

  // 4. Setup HMAC Rotation Receipt
  fs.writeFileSync(
    path.join(c5Dir, "hmac-rotation.json"),
    JSON.stringify({ rateLimitHmacRotationPassed: true, fallbackCodeHmacRotationPassed: true }, null, 2),
    "utf8",
  );

  // 5. Setup Deployment Evidence
  const deploymentPayload = {
    schema_version: "gate-c-vercel-deployment-v1",
    candidate_sha: candidateSha,
    provider: "vercel",
    deployment_id: "dpl_gate_c_test_deployment",
    state: "READY",
  };

  const deploymentDir = path.join(artifactsDir, "deployment");
  fs.mkdirSync(deploymentDir, { recursive: true });
  fs.writeFileSync(
    path.join(deploymentDir, "vercel-response.json"),
    JSON.stringify(deploymentPayload, null, 2),
    "utf8",
  );
  fs.writeFileSync(path.join(qaDir, "deployment-evidence.json"), JSON.stringify(deploymentPayload, null, 2), "utf8");

  return { tempDir, qaDir, artifactsDir };
}

test("gate-c evidence-only sealer", async (t) => {
  const candidateSha = "1111111111111111111111111111111111111111";

  await t.test("fails when iOS physical receipt is missing", () => {
    const { tempDir, qaDir, artifactsDir } = setupValidWorkspace(candidateSha);
    fs.rmSync(path.join(artifactsDir, "gate-c-c3", candidateSha, "physical", "ios", "receipt.json"));

    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir, artifactsDir }),
      /Missing ios physical device receipt/,
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("fails when physical receipt hash is tampered", () => {
    const { tempDir, qaDir, artifactsDir } = setupValidWorkspace(candidateSha);
    const receiptPath = path.join(artifactsDir, "gate-c-c3", candidateSha, "physical", "ios", "receipt.json");
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    receipt.receipt_sha256 = "0000000000000000000000000000000000000000000000000000000000000000";
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));

    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir, artifactsDir }),
      /physical receipt hash mismatch/,
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("fails when physical trace file is missing or corrupted", () => {
    const { tempDir, qaDir, artifactsDir } = setupValidWorkspace(candidateSha);
    const tracePath = path.join(
      artifactsDir,
      "gate-c-c3",
      candidateSha,
      "physical",
      "ios",
      "traces",
      "online_preparation.trace.json",
    );
    fs.writeFileSync(tracePath, JSON.stringify({ events: [] }), "utf8");

    assert.throws(() => sealGateCCertification({ candidateSha, qaDir, artifactsDir }), /Raw trace hash mismatch/);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("fails when C5 benchmark receipt is missing", () => {
    const { tempDir, qaDir, artifactsDir } = setupValidWorkspace(candidateSha);
    fs.rmSync(path.join(artifactsDir, "gate-c-c5", candidateSha, "benchmark.json"));

    assert.throws(() => sealGateCCertification({ candidateSha, qaDir, artifactsDir }), /Missing C5 benchmark receipt/);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("fails when C5 benchmark operation has fewer than 500 samples", () => {
    const { tempDir, qaDir, artifactsDir } = setupValidWorkspace(candidateSha);
    const benchmarkPath = path.join(artifactsDir, "gate-c-c5", candidateSha, "benchmark.json");
    const benchmark = JSON.parse(fs.readFileSync(benchmarkPath, "utf8"));
    benchmark.operations.score_event_acknowledgement.sampleCount = 499;
    fs.writeFileSync(benchmarkPath, JSON.stringify(benchmark));

    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir, artifactsDir }),
      /fewer than 500 measured samples/,
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("fails when C5 operation exceeds p95 latency budget", () => {
    const { tempDir, qaDir, artifactsDir } = setupValidWorkspace(candidateSha);
    const benchmarkPath = path.join(artifactsDir, "gate-c-c5", candidateSha, "benchmark.json");
    const benchmark = JSON.parse(fs.readFileSync(benchmarkPath, "utf8"));
    benchmark.operations.score_event_acknowledgement.p95Ms = 600; // budget is 500ms
    fs.writeFileSync(benchmarkPath, JSON.stringify(benchmark));

    assert.throws(() => sealGateCCertification({ candidateSha, qaDir, artifactsDir }), /exceeded p95 latency budget/);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("fails when a controlled failure drill log hash is mismatched", () => {
    const { tempDir, qaDir, artifactsDir } = setupValidWorkspace(candidateSha);
    const faultDir = path.join(artifactsDir, "gate-c-c5", candidateSha, "retained", "postgres_interruption");
    fs.writeFileSync(path.join(faultDir, "injection.log"), "tampered log\n", "utf8");

    assert.throws(() => sealGateCCertification({ candidateSha, qaDir, artifactsDir }), /Injection log hash mismatch/);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("fails when deployment evidence is not READY", () => {
    const { tempDir, qaDir, artifactsDir } = setupValidWorkspace(candidateSha);
    const depPath = path.join(artifactsDir, "deployment", "vercel-response.json");
    const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
    dep.state = "BUILDING";
    fs.writeFileSync(depPath, JSON.stringify(dep));

    assert.throws(() => sealGateCCertification({ candidateSha, qaDir, artifactsDir }), /Deployment state is not READY/);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("successfully seals all artifacts when evidence is complete and authentic", () => {
    const { tempDir, qaDir, artifactsDir } = setupValidWorkspace(candidateSha);

    const result = sealGateCCertification({ candidateSha, qaDir, artifactsDir });
    assert.equal(result.status, "CERTIFIED");
    assert.equal(result.verdict, "PASS");
    assert.equal(result.candidateSha, candidateSha);

    assert.ok(fs.existsSync(path.join(qaDir, "candidate-release.json")));
    assert.ok(fs.existsSync(path.join(qaDir, "gate-c-c3-final-evidence.json")));
    assert.ok(fs.existsSync(path.join(qaDir, "gate-c-c5-final-evidence.json")));
    assert.ok(fs.existsSync(path.join(qaDir, "gate-c-final-evidence.json")));
    assert.ok(fs.existsSync(path.join(qaDir, "gate-c-verdict.md")));

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
