import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SLO_DEFINITION_VERSION, validateGateDEvidence } from "./validate-gate-d-evidence.mjs";

const VALID_SHA = "9dfc2f963a5f63c0cdf90101d3b1225368d8ea61";
const OTHER_SHA = "6a1ca79048c25b02a1a34dc5c5eb7c0df92ae30c";
const WINDOW = {
  starts_at: "2026-09-02T08:00:00.000Z",
  ends_at: "2026-09-02T08:20:00.000Z",
};

describe("Gate D Evidence Ledger Validation Suite", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-d-test-"));
    await mkdir(path.join(tmpDir, "artifacts"), { recursive: true });
  });
  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  function createSignedReceipt(data) {
    const { receipt_sha256, ...dataToHash } = data;
    return { ...dataToHash, receipt_sha256: createHash("sha256").update(JSON.stringify(dataToHash)).digest("hex") };
  }

  function peakSummary({ sampleCount = 200, errorCount = 0, p95Ms = 120.5 } = {}) {
    return {
      sampleCount,
      successfulCount: sampleCount - errorCount,
      expectedFailureCount: 0,
      unexpectedFailureCount: errorCount,
      errorRate: errorCount / sampleCount,
      p50Ms: 25.4,
      p95Ms,
      p99Ms: Math.max(p95Ms, 150.2),
      maxMs: Math.max(p95Ms, 180),
    };
  }

  function receipt(qa_item, title, target_p95_budget_ms, peak_summary, custom = {}) {
    return createSignedReceipt({
      qa_item,
      mode: "staging",
      evidence_class: "gate_d_staging",
      slo_definition_version: CURRENT_SLO_DEFINITION_VERSION,
      candidate_sha: VALID_SHA,
      deployed_sha: VALID_SHA,
      competition_id: "comp-volleyball-pilot-01",
      target_url: "https://matchday-gate-d-api.onrender.com",
      title,
      target_p95_budget_ms,
      minimum_samples_threshold: 10,
      minimum_sessions_threshold: 1,
      observed_session_count: 8,
      observation_window: WINDOW,
      peak_summary,
      verdict: "PASS",
      generated_at: "2026-09-02T08:20:01.000Z",
      ...custom,
    });
  }

  async function writeValidStagingReceipts(custom = {}) {
    const entries = [
      [
        "qa-010-load-public-summary.json",
        receipt("QA-010", "Public Pages Read Workload Summary", 2500, peakSummary(), custom.qa10),
      ],
      [
        "qa-011-load-scoring-summary.json",
        receipt("QA-011", "Scoring Mutation Writes Workload Summary", 500, peakSummary({ p95Ms: 85.4 }), custom.qa11),
      ],
      [
        "qa-011-result-propagation-summary.json",
        receipt(
          "QA-011-RP",
          "Result Propagation Staging Summary",
          2000,
          peakSummary({ p95Ms: 600 }),
          custom.propagation,
        ),
      ],
    ];
    await Promise.all(
      entries.map(([file, data]) => writeFile(path.join(tmpDir, "artifacts", file), JSON.stringify(data, null, 2))),
    );
  }

  async function mutate(file, fn) {
    const filePath = path.join(tmpDir, "artifacts", file);
    const data = JSON.parse(await readFile(filePath, "utf8"));
    await writeFile(filePath, JSON.stringify(createSignedReceipt(fn(data)), null, 2));
  }

  it("passes only with all signed staging receipts from the same candidate", async () => {
    await writeValidStagingReceipts();
    const result = await validateGateDEvidence(VALID_SHA, { rootDir: tmpDir });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.passed, 3);
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

  it("requires a separate result propagation receipt", async () => {
    await writeValidStagingReceipts();
    await rm(path.join(tmpDir, "artifacts/qa-011-result-propagation-summary.json"));
    const result = await validateGateDEvidence(VALID_SHA, { rootDir: tmpDir });
    assert.strictEqual(result.valid, false);
    assert.ok(result.failed.some((failure) => failure.qa_item === "QA-011-RP"));
  });

  it("rejects stale telemetry contracts and invalid observation windows", async () => {
    await writeValidStagingReceipts();
    await mutate("qa-010-load-public-summary.json", (data) => ({ ...data, slo_definition_version: "old-contract" }));
    await mutate("qa-011-load-scoring-summary.json", (data) => ({
      ...data,
      observation_window: { ...WINDOW, ends_at: WINDOW.starts_at },
    }));
    const result = await validateGateDEvidence(VALID_SHA, { rootDir: tmpDir });
    assert.strictEqual(result.valid, false);
    assert.ok(result.failed.some((failure) => /slo_definition_version/.test(failure.error)));
    assert.ok(result.failed.some((failure) => /invalid observation time bounds/.test(failure.error)));
  });

  it("rejects insufficient samples, sessions, and malformed metric counts", async () => {
    await writeValidStagingReceipts();
    await mutate("qa-010-load-public-summary.json", (data) => ({ ...data, minimum_samples_threshold: 9 }));
    await mutate("qa-011-load-scoring-summary.json", (data) => ({ ...data, observed_session_count: 0 }));
    await mutate("qa-011-result-propagation-summary.json", (data) => ({
      ...data,
      peak_summary: { ...data.peak_summary, unexpectedFailureCount: 1 },
    }));
    const result = await validateGateDEvidence(VALID_SHA, { rootDir: tmpDir });
    assert.strictEqual(result.valid, false);
    assert.ok(result.failed.some((failure) => /minimum_samples_threshold/.test(failure.error)));
    assert.ok(result.failed.some((failure) => /observed_session_count/.test(failure.error)));
    assert.ok(result.failed.some((failure) => /counts do not add up/.test(failure.error)));
  });

  it("rejects candidate/deployed mismatch, component diagnostics, and cross-target data", async () => {
    await writeValidStagingReceipts();
    await mutate("qa-010-load-public-summary.json", (data) => ({ ...data, candidate_sha: OTHER_SHA }));
    await mutate("qa-011-load-scoring-summary.json", (data) => ({
      ...data,
      mode: "component",
      evidence_class: "developer_component_diagnostic_only",
    }));
    await mutate("qa-011-result-propagation-summary.json", (data) => ({
      ...data,
      target_url: "https://other.example.test/",
    }));
    const result = await validateGateDEvidence(VALID_SHA, { rootDir: tmpDir });
    assert.strictEqual(result.valid, false);
    assert.ok(result.failed.some((failure) => /candidate SHA mismatch/.test(failure.error)));
    assert.ok(result.failed.some((failure) => /not staging Gate D evidence/.test(failure.error)));
    assert.ok(result.failed.some((failure) => /Target URL mismatch/.test(failure.error)));
  });

  it("rejects p95 and API error-rate breaches while accepting strict boundaries", async () => {
    await writeValidStagingReceipts();
    await mutate("qa-010-load-public-summary.json", (data) => ({
      ...data,
      peak_summary: peakSummary({ p95Ms: 2500 }),
    }));
    await mutate("qa-011-load-scoring-summary.json", (data) => ({
      ...data,
      peak_summary: peakSummary({ p95Ms: 500 }),
    }));
    await mutate("qa-011-result-propagation-summary.json", (data) => ({
      ...data,
      peak_summary: peakSummary({ p95Ms: 2000 }),
    }));
    const result = await validateGateDEvidence(VALID_SHA, { rootDir: tmpDir });
    assert.strictEqual(result.valid, false);
    assert.equal(result.failed.filter((failure) => /SLA breach/.test(failure.error)).length, 3);

    await writeValidStagingReceipts();
    await mutate("qa-011-load-scoring-summary.json", (data) => ({
      ...data,
      peak_summary: peakSummary({ errorCount: 1 }),
    }));
    const errorResult = await validateGateDEvidence(VALID_SHA, { rootDir: tmpDir });
    assert.strictEqual(errorResult.valid, false);
    assert.ok(errorResult.failed.some((failure) => /error rate/.test(failure.error)));
  });

  it("rejects a tampered receipt digest", async () => {
    await writeValidStagingReceipts();
    const file = path.join(tmpDir, "artifacts/qa-010-load-public-summary.json");
    const data = JSON.parse(await readFile(file, "utf8"));
    data.peak_summary.p95Ms = 1;
    await writeFile(file, JSON.stringify(data, null, 2));
    const result = await validateGateDEvidence(VALID_SHA, { rootDir: tmpDir });
    assert.strictEqual(result.valid, false);
    assert.ok(result.failed.some((failure) => /integrity check failed/.test(failure.error)));
  });
});
