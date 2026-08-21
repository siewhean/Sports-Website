import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { REQUIRED_FAULTS, sealGateCCertification } from "./seal-gate-c-certification.mjs";

function setupValidWorkspace(candidateSha) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matchday-seal-test-"));
  const qaDir = path.join(tempDir, "docs", "qa");
  const artifactsDir = path.join(tempDir, "artifacts", "qa");

  fs.mkdirSync(qaDir, { recursive: true });

  // 1. Setup C3 Physical Receipts
  const iosDir = path.join(artifactsDir, "gate-c-c3", candidateSha, "physical", "ios");
  const androidDir = path.join(artifactsDir, "gate-c-c3", candidateSha, "physical", "android");
  fs.mkdirSync(iosDir, { recursive: true });
  fs.mkdirSync(androidDir, { recursive: true });

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

  const dummyPhysicalReceipt = (platform) => ({
    source_sha: candidateSha,
    platform,
    status: "passed",
    device_model: platform === "ios" ? "iPhone 15 Pro" : "Pixel 8 Pro",
    os_version: platform === "ios" ? "iOS 18.2" : "Android 15",
    browser_name: platform === "ios" ? "Mobile Safari" : "Chrome Mobile",
    browser_version: "1.0",
    collected_at: "2026-08-21T00:00:00.000Z",
    receipt_sha256: "abc123def456",
    scenarios: scenarioList.map((s) => ({ scenario: s, status: "passed", receipt_sha256: "hash" })),
  });

  fs.writeFileSync(path.join(iosDir, "receipt.json"), JSON.stringify(dummyPhysicalReceipt("ios")));
  fs.writeFileSync(path.join(androidDir, "receipt.json"), JSON.stringify(dummyPhysicalReceipt("android")));

  // 2. Setup C5 Benchmark Receipt
  const c5Dir = path.join(artifactsDir, "gate-c-c5", candidateSha);
  fs.mkdirSync(c5Dir, { recursive: true });

  const dummyOperations = {
    score_event_acknowledgement: { sampleCount: 500, errorCount: 0, p95DurationMs: 0.1 },
    public_current_conditional_read: { sampleCount: 500, errorCount: 0, p95DurationMs: 0.1 },
    public_result_convergence: { sampleCount: 500, errorCount: 0, p95DurationMs: 0.1 },
    lease_takeover: { sampleCount: 500, errorCount: 0, p95DurationMs: 0.1 },
    repair_publication: { sampleCount: 500, errorCount: 0, p95DurationMs: 0.1 },
  };

  fs.writeFileSync(
    path.join(c5Dir, "benchmark.json"),
    JSON.stringify({ sourceSha: candidateSha, operations: dummyOperations }),
  );

  // 3. Setup 12 Controlled Failure Receipts
  const c5RetainedDir = path.join(c5Dir, "retained");
  for (const fault of REQUIRED_FAULTS) {
    const faultDir = path.join(c5RetainedDir, fault);
    fs.mkdirSync(faultDir, { recursive: true });
    fs.writeFileSync(
      path.join(faultDir, "receipt.json"),
      JSON.stringify({ fault, recovery_observed: true, cleanup_observed: true }),
    );
  }

  // 4. Setup Deployment Evidence
  fs.writeFileSync(
    path.join(qaDir, "deployment-evidence.json"),
    JSON.stringify({
      schema_version: "gate-c-vercel-deployment-v1",
      candidate_sha: candidateSha,
      provider: "vercel",
      state: "READY",
    }),
  );

  return { tempDir, qaDir, artifactsDir };
}

test("gate-c evidence-only sealer", async (t) => {
  const candidateSha = "1111111111111111111111111111111111111111";

  await t.test("fails when iOS physical receipt is missing", () => {
    const { tempDir, qaDir, artifactsDir } = setupValidWorkspace(candidateSha);
    fs.rmSync(path.join(artifactsDir, "gate-c-c3", candidateSha, "physical", "ios", "receipt.json"));

    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir, artifactsDir }),
      /Missing iOS physical device receipt/,
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("fails when Android physical receipt is missing", () => {
    const { tempDir, qaDir, artifactsDir } = setupValidWorkspace(candidateSha);
    fs.rmSync(path.join(artifactsDir, "gate-c-c3", candidateSha, "physical", "android", "receipt.json"));

    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir, artifactsDir }),
      /Missing Android physical device receipt/,
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("fails when C5 benchmark receipt is missing", () => {
    const { tempDir, qaDir, artifactsDir } = setupValidWorkspace(candidateSha);
    fs.rmSync(path.join(artifactsDir, "gate-c-c5", candidateSha, "benchmark.json"));

    assert.throws(() => sealGateCCertification({ candidateSha, qaDir, artifactsDir }), /Missing C5 benchmark receipt/);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("fails when running in an otherwise empty directory", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "matchday-empty-"));
    const qaDir = path.join(emptyDir, "docs", "qa");
    const artifactsDir = path.join(emptyDir, "artifacts", "qa");

    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir, artifactsDir }),
      /Missing iOS physical device receipt/,
    );
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  await t.test("fails when source_sha does not match candidate SHA", () => {
    const { tempDir, qaDir, artifactsDir } = setupValidWorkspace(candidateSha);
    const iosReceiptPath = path.join(artifactsDir, "gate-c-c3", candidateSha, "physical", "ios", "receipt.json");
    const data = JSON.parse(fs.readFileSync(iosReceiptPath, "utf8"));
    data.source_sha = "2222222222222222222222222222222222222222";
    fs.writeFileSync(iosReceiptPath, JSON.stringify(data));

    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir, artifactsDir }),
      /Physical receipt source_sha does not match/,
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("fails when a fault drill is missing or incomplete", () => {
    const { tempDir, qaDir, artifactsDir } = setupValidWorkspace(candidateSha);
    const faultReceiptPath = path.join(
      artifactsDir,
      "gate-c-c5",
      candidateSha,
      "retained",
      "postgres_interruption",
      "receipt.json",
    );
    fs.writeFileSync(faultReceiptPath, JSON.stringify({ fault: "postgres_interruption", recovery_observed: false }));

    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir, artifactsDir }),
      /did not observe clean recovery\/cleanup/,
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("fails when deployment evidence state is not READY", () => {
    const { tempDir, qaDir, artifactsDir } = setupValidWorkspace(candidateSha);
    fs.writeFileSync(
      path.join(qaDir, "deployment-evidence.json"),
      JSON.stringify({
        schema_version: "gate-c-vercel-deployment-v1",
        candidate_sha: candidateSha,
        state: "FAILED",
      }),
    );

    assert.throws(
      () => sealGateCCertification({ candidateSha, qaDir, artifactsDir }),
      /Deployment evidence state is not READY/,
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("passes when all required external evidence artifacts exist and are valid", () => {
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
