import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { validateGateDEvidence } from "./validate-gate-d-evidence.mjs";

const VALID_SHA = "9dfc2f963a5f63c0cdf90101d3b1225368d8ea61";
const OTHER_SHA = "6a1ca79048c25b02a1a34dc5c5eb7c0df92ae30c";

describe("Gate D Evidence Ledger Validation Suite", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-d-test-"));
    await mkdir(path.join(tmpDir, "artifacts"), { recursive: true });
  });

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  function createSignedReceipt(data) {
    const { receipt_sha256, ...dataToHash } = data;
    const digest = createHash("sha256").update(JSON.stringify(dataToHash)).digest("hex");
    return { ...dataToHash, receipt_sha256: digest };
  }

  async function writeValidStagingReceipts(custom = {}) {
    const qa10Data = createSignedReceipt({
      qa_item: "QA-010",
      mode: "staging",
      evidence_class: "gate_d_staging",
      candidate_sha: VALID_SHA,
      deployed_sha: VALID_SHA,
      competition_id: "comp-volleyball-pilot-01",
      target_url: "https://matchday-gate-d-api.onrender.com",
      title: "Public Pages Read Workload Summary",
      target_p95_budget_ms: 2500,
      peak_summary: {
        sampleCount: 200,
        successfulCount: 200,
        unexpectedFailureCount: 0,
        errorRate: 0,
        p50Ms: 25.4,
        p95Ms: 120.5,
        p99Ms: 150.2,
        maxMs: 180.0,
      },
      verdict: "PASS",
      generated_at: new Date().toISOString(),
      ...(custom.qa10 ?? {}),
    });

    const qa11Data = createSignedReceipt({
      qa_item: "QA-011",
      mode: "staging",
      evidence_class: "gate_d_staging",
      candidate_sha: VALID_SHA,
      deployed_sha: VALID_SHA,
      competition_id: "comp-volleyball-pilot-01",
      target_url: "https://matchday-gate-d-api.onrender.com",
      title: "Scoring Mutation Writes Workload Summary",
      target_p95_budget_ms: 500,
      peak_summary: {
        sampleCount: 240,
        successfulCount: 240,
        unexpectedFailureCount: 0,
        errorRate: 0,
        p50Ms: 15.2,
        p95Ms: 85.4,
        p99Ms: 110.1,
        maxMs: 130.0,
      },
      verdict: "PASS",
      generated_at: new Date().toISOString(),
      ...(custom.qa11 ?? {}),
    });

    await writeFile(
      path.join(tmpDir, "artifacts/qa-010-load-public-summary.json"),
      JSON.stringify(qa10Data, null, 2),
      "utf-8",
    );
    await writeFile(
      path.join(tmpDir, "artifacts/qa-011-load-scoring-summary.json"),
      JSON.stringify(qa11Data, null, 2),
      "utf-8",
    );
  }

  it("passes when valid staging receipts are present with matching candidate SHA", async () => {
    await writeValidStagingReceipts();
    const result = await validateGateDEvidence(VALID_SHA, { rootDir: tmpDir });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.passed, 2);
    assert.strictEqual(result.failed.length, 0);
  });

  it("fails closed when expected candidate SHA is missing or malformed", async () => {
    await assert.rejects(
      () => validateGateDEvidence(undefined, { rootDir: tmpDir }),
      /requires a valid 40-character candidate SHA/,
    );
    await assert.rejects(
      () => validateGateDEvidence("not-a-valid-sha", { rootDir: tmpDir }),
      /requires a valid 40-character candidate SHA/,
    );
  });

  it("fails when candidate SHA does not match expected candidate SHA", async () => {
    await writeValidStagingReceipts({ qa10: { candidate_sha: OTHER_SHA } });
    const result = await validateGateDEvidence(VALID_SHA, { rootDir: tmpDir });
    assert.strictEqual(result.valid, false);
    assert.ok(result.failed.some((f) => /candidate SHA mismatch/.test(f.error)));
  });

  it("fails when deployed SHA does not match candidate SHA", async () => {
    await writeValidStagingReceipts({ qa11: { deployed_sha: OTHER_SHA } });
    const result = await validateGateDEvidence(VALID_SHA, { rootDir: tmpDir });
    assert.strictEqual(result.valid, false);
    assert.ok(result.failed.some((f) => /deployed SHA mismatch/.test(f.error)));
  });

  it("fails when receipt is a component diagnostic", async () => {
    await writeValidStagingReceipts({
      qa10: {
        mode: "component",
        evidence_class: "developer_component_diagnostic_only",
        verdict: "COMPONENT_PASS_NOT_GATE_D_EVIDENCE",
      },
    });
    const result = await validateGateDEvidence(VALID_SHA, { rootDir: tmpDir });
    assert.strictEqual(result.valid, false);
    assert.ok(result.failed.some((f) => /not staging Gate D evidence/.test(f.error)));
  });

  it("fails when cross-receipt competition ID does not match", async () => {
    await writeValidStagingReceipts({ qa11: { competition_id: "different-comp-id" } });
    const result = await validateGateDEvidence(VALID_SHA, { rootDir: tmpDir });
    assert.strictEqual(result.valid, false);
    assert.ok(result.failed.some((f) => /Competition ID mismatch between receipts/.test(f.error)));
  });

  it("fails when cross-receipt target URL does not match", async () => {
    await writeValidStagingReceipts({ qa11: { target_url: "https://other-url.onrender.com" } });
    const result = await validateGateDEvidence(VALID_SHA, { rootDir: tmpDir });
    assert.strictEqual(result.valid, false);
    assert.ok(result.failed.some((f) => /Target URL mismatch between receipts/.test(f.error)));
  });

  it("fails when SHA-256 digest has been tampered with", async () => {
    await writeValidStagingReceipts();
    const qa10File = path.join(tmpDir, "artifacts/qa-010-load-public-summary.json");
    const raw = await import("node:fs/promises").then((fs) => fs.readFile(qa10File, "utf-8"));
    const data = JSON.parse(raw);
    data.peak_summary.p95Ms = 1.0; // modified metric without updating digest
    await writeFile(qa10File, JSON.stringify(data, null, 2), "utf-8");

    const result = await validateGateDEvidence(VALID_SHA, { rootDir: tmpDir });
    assert.strictEqual(result.valid, false);
    assert.ok(result.failed.some((f) => /integrity check failed/.test(f.error)));
  });

  it("fails when sample count is zero", async () => {
    await writeValidStagingReceipts({ qa10: { peak_summary: { sampleCount: 0, p95Ms: 100, errorRate: 0 } } });
    const result = await validateGateDEvidence(VALID_SHA, { rootDir: tmpDir });
    assert.strictEqual(result.valid, false);
    assert.ok(result.failed.some((f) => /zero or missing sampleCount/.test(f.error)));
  });

  it("fails when p95 exceeds SLA budget", async () => {
    await writeValidStagingReceipts({ qa11: { peak_summary: { sampleCount: 200, p95Ms: 600.0, errorRate: 0 } } });
    const result = await validateGateDEvidence(VALID_SHA, { rootDir: tmpDir });
    assert.strictEqual(result.valid, false);
    assert.ok(result.failed.some((f) => /SLA breach: p95/.test(f.error)));
  });
});
