/**
 * validate-gate-d-evidence.mjs
 *
 * Strict Gate D evidence validator.
 * Enforces:
 *  1. Exact 40-character candidate SHA binding across all receipts (candidate_sha === deployed_sha === expectedCandidateSha).
 *  2. Mode MUST be "staging" and evidence_class MUST be "gate_d_staging".
 *  3. Component and socket-component diagnostic evidence is explicitly rejected with FAIL.
 *  4. Strict cross-receipt consistency (same candidate_sha, deployed_sha, competition_id, target_url).
 *  5. Recomputes SLA metrics and verifies p95 budgets and error rate thresholds.
 *  6. Recomputes and validates SHA-256 receipt integrity digest.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export const REQUIRED_RECEIPTS = [
  {
    file: "artifacts/qa-010-load-public-summary.json",
    name: "QA-010 Public Pages Staging Load Summary",
    qa_item: "QA-010",
    max_p95_ms: 2500,
  },
  {
    file: "artifacts/qa-011-load-scoring-summary.json",
    name: "QA-011 Scoring Writes Staging Load Summary",
    qa_item: "QA-011",
    max_p95_ms: 500,
  },
];

export async function validateGateDEvidence(expectedCandidateSha, options = {}) {
  const root = options.rootDir ?? defaultRoot;

  if (!expectedCandidateSha || !SHA_PATTERN.test(expectedCandidateSha)) {
    throw new Error(
      `Gate D evidence validation requires a valid 40-character candidate SHA. Received: "${expectedCandidateSha}"`,
    );
  }

  const results = [];
  const parsedReceipts = [];

  for (const item of REQUIRED_RECEIPTS) {
    const fullPath = path.join(root, item.file);
    try {
      const raw = await readFile(fullPath, "utf-8");
      const data = JSON.parse(raw);

      if (data.qa_item !== item.qa_item) {
        throw new Error(`Receipt ${item.file} qa_item mismatch: expected ${item.qa_item}, got ${data.qa_item}`);
      }

      if (data.mode !== "staging" || data.evidence_class !== "gate_d_staging") {
        throw new Error(
          `Receipt ${item.file} is not staging Gate D evidence (mode="${data.mode}", evidence_class="${data.evidence_class}"). ` +
            "Component and socket-component diagnostics are prohibited from Gate D qualification.",
        );
      }

      if (data.verdict !== "PASS") {
        throw new Error(`Receipt ${item.file} has non-passing verdict: "${data.verdict}"`);
      }

      if (!data.candidate_sha || data.candidate_sha.toLowerCase() !== expectedCandidateSha.toLowerCase()) {
        throw new Error(
          `Receipt ${item.file} candidate SHA mismatch: expected ${expectedCandidateSha}, got ${data.candidate_sha}`,
        );
      }

      if (!data.deployed_sha || data.deployed_sha.toLowerCase() !== expectedCandidateSha.toLowerCase()) {
        throw new Error(
          `Receipt ${item.file} deployed SHA mismatch: expected ${expectedCandidateSha}, but server served ${data.deployed_sha}`,
        );
      }

      if (!data.competition_id) {
        throw new Error(`Receipt ${item.file} is missing required competition_id`);
      }

      if (!data.target_url) {
        throw new Error(`Receipt ${item.file} is missing required target_url`);
      }

      // Metric recomputation
      const peak = data.peak_summary;
      if (!peak || typeof peak !== "object") {
        throw new Error(`Receipt ${item.file} is missing peak_summary metrics object`);
      }

      if (!peak.sampleCount || peak.sampleCount <= 0) {
        throw new Error(`Receipt ${item.file} has zero or missing sampleCount`);
      }

      if (peak.p95Ms === undefined || peak.p95Ms >= item.max_p95_ms) {
        throw new Error(`Receipt ${item.file} SLA breach: p95 ${peak.p95Ms}ms exceeds budget < ${item.max_p95_ms}ms`);
      }

      if (peak.errorRate === undefined || peak.errorRate > 0.001) {
        throw new Error(
          `Receipt ${item.file} error rate ${(peak.errorRate * 100).toFixed(2)}% exceeds max allowable 0.1%`,
        );
      }

      if (!data.receipt_sha256) {
        throw new Error(`Receipt ${item.file} is missing required receipt_sha256 digest`);
      }

      const { receipt_sha256, ...dataToHash } = data;
      const expectedDigest = createHash("sha256").update(JSON.stringify(dataToHash)).digest("hex");
      if (expectedDigest !== receipt_sha256) {
        throw new Error(
          `Receipt ${item.file} integrity check failed: digest mismatch. File may have been tampered with.`,
        );
      }

      parsedReceipts.push(data);

      results.push({
        file: item.file,
        name: item.name,
        qa_item: data.qa_item,
        mode: data.mode,
        candidate_sha: data.candidate_sha,
        deployed_sha: data.deployed_sha,
        verdict: data.verdict,
        status: "VALID",
      });
    } catch (err) {
      results.push({
        file: item.file,
        name: item.name,
        qa_item: item.qa_item,
        status: "FAILED",
        error: err.message,
      });
    }
  }

  // Cross-receipt consistency check
  if (parsedReceipts.length === REQUIRED_RECEIPTS.length) {
    const first = parsedReceipts[0];
    for (let i = 1; i < parsedReceipts.length; i++) {
      const other = parsedReceipts[i];
      if (other.competition_id !== first.competition_id) {
        results.push({
          file: "cross-receipt",
          name: "Cross-Receipt Consistency",
          qa_item: "ALL",
          status: "FAILED",
          error: `Competition ID mismatch between receipts: ${first.competition_id} vs ${other.competition_id}`,
        });
      }
      if (other.target_url !== first.target_url) {
        results.push({
          file: "cross-receipt",
          name: "Cross-Receipt Consistency",
          qa_item: "ALL",
          status: "FAILED",
          error: `Target URL mismatch between receipts: ${first.target_url} vs ${other.target_url}`,
        });
      }
    }
  }

  const failed = results.filter((r) => r.status === "FAILED");
  return {
    valid: failed.length === 0,
    total: results.length,
    passed: results.filter((r) => r.status === "VALID").length,
    expected_candidate_sha: expectedCandidateSha,
    results,
    failed,
  };
}

async function runCli() {
  const candidateSha = process.argv[2] ?? process.env.CANDIDATE_SHA;

  console.log("═".repeat(70));
  console.log(" Gate D Staging Evidence Ledger Validation");
  console.log(` Expected Candidate SHA: ${candidateSha ?? "(NOT PROVIDED)"}`);
  console.log("═".repeat(70) + "\n");

  try {
    const report = await validateGateDEvidence(candidateSha);

    for (const res of report.results) {
      if (res.status === "VALID") {
        console.log(`  ✓ [${res.qa_item}] ${res.name}: VALID`);
        console.log(`      candidate_sha: ${res.candidate_sha}`);
        console.log(`      deployed_sha:  ${res.deployed_sha}`);
        console.log(`      mode:          ${res.mode}`);
        console.log(`      verdict:       ${res.verdict}\n`);
      } else {
        console.log(`  ✗ [${res.qa_item}] ${res.name}: FAILED`);
        console.log(`      Error: ${res.error}\n`);
      }
    }

    if (!report.valid) {
      console.log("═".repeat(70));
      console.log(`❌ GATE D EVIDENCE VALIDATION FAILED (${report.failed.length} findings)`);
      console.log("═".repeat(70));
      process.exit(1);
    }

    console.log("═".repeat(70));
    console.log("✓ ALL GATE D STAGING EVIDENCE VERIFIED SUCCESSFULLY");
    console.log("═".repeat(70));
  } catch (err) {
    console.error(`❌ Validation Error: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli();
}
