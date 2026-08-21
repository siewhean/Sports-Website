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
    });

    assert.strictEqual(result.valid, false);
    assert.strictEqual(
      result.errors.some((e) => e.includes("does not match remote origin/integration/gate-c-final")),
      true,
    );

    const historicalResult = validateExactShaCertification({
      qaDir: tempDir,
      targetSha: mockSha,
      remoteSha,
      allowHistorical: true,
    });

    assert.strictEqual(
      historicalResult.errors.some((e) => e.includes("does not match remote origin/integration/gate-c-final")),
      false,
    );
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
});
