import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateExactShaCertification } from "./validate-exact-sha-certification.mjs";

test("exact-sha certification validator", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exact-sha-test-"));

  await t.test("fails when evidence SHA does not match target SHA", () => {
    const mockSha = "1111111111111111111111111111111111111111";
    const wrongSha = "2222222222222222222222222222222222222222";

    fs.writeFileSync(
      path.join(tempDir, "candidate-release.json"),
      JSON.stringify({ candidateSha: wrongSha, verdict: "PASS", status: "CERTIFIED" }),
    );
    fs.writeFileSync(
      path.join(tempDir, "gate-c-final-evidence.json"),
      JSON.stringify({
        candidate_sha: wrongSha,
        certified_at: new Date().toISOString(),
        environment: { os: "darwin" },
      }),
    );

    const result = validateExactShaCertification({
      qaDir: tempDir,
      targetSha: mockSha,
      remoteSha: mockSha,
      checkGit: false,
    });

    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors.length >= 2, true);
  });

  await t.test("passes when all evidence and verdict files match target SHA", () => {
    const mockSha = "3333333333333333333333333333333333333333";

    fs.writeFileSync(
      path.join(tempDir, "candidate-release.json"),
      JSON.stringify({ candidateSha: mockSha, verdict: "PASS", status: "CERTIFIED" }),
    );
    fs.writeFileSync(
      path.join(tempDir, "gate-c-final-evidence.json"),
      JSON.stringify({ candidate_sha: mockSha, certified_at: new Date().toISOString(), environment: { os: "darwin" } }),
    );
    fs.writeFileSync(
      path.join(tempDir, "gate-c-c3-final-evidence.json"),
      JSON.stringify({ source_sha: mockSha, collected_at: new Date().toISOString(), environment: { os: "darwin" } }),
    );
    fs.writeFileSync(
      path.join(tempDir, "gate-c-c5-final-evidence.json"),
      JSON.stringify({ source_sha: mockSha, collected_at: new Date().toISOString(), environment: { os: "darwin" } }),
    );
    fs.writeFileSync(
      path.join(tempDir, "gate-c-verdict.md"),
      `# Gate C Verdict\nCandidate SHA: ${mockSha}\nVerdict: PASS\n`,
    );
    fs.writeFileSync(
      path.join(tempDir, "gate-c-c3-verdict.md"),
      `# Gate C C3 Verdict\nSource SHA: ${mockSha}\nVerdict: PASS\n`,
    );
    fs.writeFileSync(
      path.join(tempDir, "gate-c-c5-verdict.md"),
      `# Gate C C5 Verdict\nSource SHA: ${mockSha}\nVerdict: PASS\n`,
    );

    const result = validateExactShaCertification({
      qaDir: tempDir,
      targetSha: mockSha,
      remoteSha: mockSha,
      checkGit: false,
    });

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });

  await t.test("fails when local HEAD differs from remote branch HEAD unless allowHistorical is true", () => {
    const mockSha = "4444444444444444444444444444444444444444";
    const remoteSha = "5555555555555555555555555555555555555555";

    const result = validateExactShaCertification({
      qaDir: tempDir,
      targetSha: mockSha,
      remoteSha,
      allowHistorical: false,
      checkGit: true,
    });

    assert.strictEqual(result.valid, false);
    assert.strictEqual(
      result.errors.some(
        (e) => e.includes("not on integration/gate-c-final branch history") || e.includes("not a valid commit"),
      ),
      true,
    );

    const historicalResult = validateExactShaCertification({
      qaDir: tempDir,
      targetSha: mockSha,
      remoteSha,
      allowHistorical: true,
      checkGit: false,
    });

    assert.strictEqual(
      historicalResult.errors.some((e) => e.includes("not on integration/gate-c-final branch history")),
      false,
    );
  });

  await t.test("allows post-candidate evidence paths and rejects application runtime paths", async () => {
    const { EVIDENCE_ONLY_ALLOWLIST_PATTERNS } = await import("./validate-exact-sha-certification.mjs");
    const allowedFiles = [
      "docs/qa/candidate-release.json",
      "artifacts/qa/gate-c-c3/abc/receipt.json",
      "fixtures/physical-device-evidence/ios-iphone15pro.json",
      "scripts/seal-gate-c-certification.mjs",
      "scripts/verify-vercel-deployment.mjs",
      "scripts/record-vercel-deployment.mjs",
      ".githooks/pre-push",
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
    ];
    for (const f of disallowedFiles) {
      assert.strictEqual(
        EVIDENCE_ONLY_ALLOWLIST_PATTERNS.some((p) => p.test(f)),
        false,
        `Expected ${f} to be disallowed`,
      );
    }
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
});
