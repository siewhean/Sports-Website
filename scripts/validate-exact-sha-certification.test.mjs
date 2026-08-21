import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EVIDENCE_ONLY_ALLOWLIST_PATTERNS,
  REQUIRED_EVIDENCE_FILES,
  REQUIRED_VERDICT_FILES,
  validateExactShaCertification,
} from "./validate-exact-sha-certification.mjs";

function setupCompleteEvidence(dir, sha, overrides = {}) {
  const lanes = ["c1", "c2", "c3", "c4", "c5"];

  fs.writeFileSync(
    path.join(dir, "candidate-release.json"),
    JSON.stringify({ candidateSha: sha, verdict: "PASS", status: "CERTIFIED" }),
  );

  fs.writeFileSync(
    path.join(dir, "gate-c-final-evidence.json"),
    JSON.stringify({
      candidate_sha: sha,
      record_status: "CURRENT_CERTIFICATION",
      branch: "integration/gate-c-final",
      certified_at: new Date().toISOString(),
      environment: { os: "darwin" },
      status: "PASS",
    }),
  );

  for (const lane of lanes) {
    const laneSha = overrides[`${lane}_sha`] || sha;
    const laneStatus = overrides[`${lane}_status`] || "PASS";

    fs.writeFileSync(
      path.join(dir, `gate-c-${lane}-final-evidence.json`),
      JSON.stringify({
        source_sha: laneSha,
        record_status: "CURRENT_CERTIFICATION",
        branch: "integration/gate-c-final",
        collected_at: new Date().toISOString(),
        environment: { os: "darwin" },
        status: laneStatus,
      }),
    );

    fs.writeFileSync(
      path.join(dir, `gate-c-${lane}-verdict.md`),
      `# Gate C ${lane.toUpperCase()} Verdict\nSource SHA: ${laneSha}\nVerdict: ${laneStatus}\n`,
    );
  }

  fs.writeFileSync(
    path.join(dir, "gate-c-verdict.md"),
    `# Gate C Final Verdict\nCandidate SHA: ${sha}\nVerdict: PASS\n`,
  );
}

test("exact-sha certification validator", async (t) => {
  await t.test("passes when all C1-C5 final evidence files match candidate SHA and PASS status", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exact-sha-test-"));
    const mockSha = "3333333333333333333333333333333333333333";
    setupCompleteEvidence(tempDir, mockSha);

    const result = validateExactShaCertification({
      qaDir: tempDir,
      targetSha: mockSha,
      remoteSha: mockSha,
      checkGit: false,
    });

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("fails when C1 evidence has mismatched SHA", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exact-sha-test-"));
    const mockSha = "3333333333333333333333333333333333333333";
    setupCompleteEvidence(tempDir, mockSha, { c1_sha: "1111111111111111111111111111111111111111" });

    const result = validateExactShaCertification({
      qaDir: tempDir,
      targetSha: mockSha,
      remoteSha: mockSha,
      checkGit: false,
    });

    assert.strictEqual(result.valid, false);
    assert.strictEqual(
      result.errors.some((e) => e.includes("gate-c-c1-final-evidence.json SHA")),
      true,
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("fails when C2 evidence has mismatched SHA", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exact-sha-test-"));
    const mockSha = "3333333333333333333333333333333333333333";
    setupCompleteEvidence(tempDir, mockSha, { c2_sha: "2222222222222222222222222222222222222222" });

    const result = validateExactShaCertification({
      qaDir: tempDir,
      targetSha: mockSha,
      remoteSha: mockSha,
      checkGit: false,
    });

    assert.strictEqual(result.valid, false);
    assert.strictEqual(
      result.errors.some((e) => e.includes("gate-c-c2-final-evidence.json SHA")),
      true,
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("fails when C4 final evidence is missing", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exact-sha-test-"));
    const mockSha = "3333333333333333333333333333333333333333";
    setupCompleteEvidence(tempDir, mockSha);
    fs.rmSync(path.join(tempDir, "gate-c-c4-final-evidence.json"));

    const result = validateExactShaCertification({
      qaDir: tempDir,
      targetSha: mockSha,
      remoteSha: mockSha,
      checkGit: false,
    });

    assert.strictEqual(result.valid, false);
    assert.strictEqual(
      result.errors.some((e) => e.includes("Missing required final evidence artifact: gate-c-c4-final-evidence.json")),
      true,
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("fails when one lane is INCOMPLETE or failed", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exact-sha-test-"));
    const mockSha = "3333333333333333333333333333333333333333";
    setupCompleteEvidence(tempDir, mockSha, { c5_status: "INCOMPLETE" });

    const result = validateExactShaCertification({
      qaDir: tempDir,
      targetSha: mockSha,
      remoteSha: mockSha,
      checkGit: false,
    });

    assert.strictEqual(result.valid, false);
    assert.strictEqual(
      result.errors.some((e) => e.includes("gate-c-c5-final-evidence.json status is not PASS")),
      true,
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("fails when historical evidence is present but current candidate evidence is absent", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exact-sha-test-"));
    const mockSha = "3333333333333333333333333333333333333333";
    // Write historical C1 & C2 files
    fs.writeFileSync(
      path.join(tempDir, "gate-c-access-final-evidence.json"),
      JSON.stringify({ source_sha: "old1111", status: "PASS" }),
    );
    fs.writeFileSync(
      path.join(tempDir, "gate-c-c2-historical-evidence.json"),
      JSON.stringify({ source_sha: "old2222", status: "PASS" }),
    );

    const result = validateExactShaCertification({
      qaDir: tempDir,
      targetSha: mockSha,
      remoteSha: mockSha,
      checkGit: false,
    });

    assert.strictEqual(result.valid, false);
    assert.strictEqual(
      result.errors.some((e) => e.includes("Missing required candidate-release.json artifact")),
      true,
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("passes when historical evidence is present AND valid current candidate evidence is present", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exact-sha-test-"));
    const mockSha = "3333333333333333333333333333333333333333";
    setupCompleteEvidence(tempDir, mockSha);

    // Keep historical files alongside current files
    fs.writeFileSync(
      path.join(tempDir, "gate-c-access-final-evidence.json"),
      JSON.stringify({ source_sha: "old1111", status: "PASS" }),
    );

    const result = validateExactShaCertification({
      qaDir: tempDir,
      targetSha: mockSha,
      remoteSha: mockSha,
      checkGit: false,
    });

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("strictly enforces evidence-only allowlist patterns", () => {
    const allowedFiles = [
      "docs/qa/candidate-release.json",
      "docs/qa/gate-c-c1-final-evidence.json",
      "artifacts/qa/gate-c-c3/abc/receipt.json",
      "fixtures/physical-device-evidence/ios-iphone15pro.json",
      "scripts/seal-gate-c-certification.mjs",
      "scripts/seal-gate-c-certification.test.mjs",
      "scripts/validate-exact-sha-certification.mjs",
      "scripts/validate-exact-sha-certification.test.mjs",
      "scripts/verify-vercel-deployment.mjs",
      "scripts/verify-vercel-deployment.test.mjs",
    ];
    for (const f of allowedFiles) {
      assert.strictEqual(
        EVIDENCE_ONLY_ALLOWLIST_PATTERNS.some((p) => p.test(f)),
        true,
        `Expected ${f} to be allowed`,
      );
    }

    const disallowedFiles = [
      "apps/api/src/app.ts",
      "apps/web/app/page.tsx",
      "packages/domain/src/scoring.ts",
      "infra/migrations/0036_test.sql",
      "turbo.json",
      "package.json",
      ".githooks/pre-push",
      "fixtures/canonical-competitions.json",
      "scripts/run-gate-c-access-ledger.mjs",
    ];
    for (const f of disallowedFiles) {
      assert.strictEqual(
        EVIDENCE_ONLY_ALLOWLIST_PATTERNS.some((p) => p.test(f)),
        false,
        `Expected ${f} to be disallowed`,
      );
    }
  });
});
