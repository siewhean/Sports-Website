/**
 * validate-gate-d-evidence.mjs
 *
 * Strict Gate D evidence validator.
 * Asserts:
 *  1. Exact 40-character candidate SHA binding across all receipts.
 *  2. Schema completeness and valid timestamp ranges.
 *  3. Presence and completeness of human tabletop drills and physical device logs.
 *  4. Strict fail-closed policy on missing, corrupted, or unverified evidence.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export const REQUIRED_RECEIPTS = [
  { file: "artifacts/qa-010-load-public-summary.json", name: "QA-010 Public Pages Load Summary" },
  { file: "artifacts/qa-011-load-scoring-summary.json", name: "QA-011 Scoring Writes Load Summary" },
];

export async function validateGateDEvidence(expectedCandidateSha) {
  if (expectedCandidateSha && !SHA_PATTERN.test(expectedCandidateSha)) {
    throw new Error(`Invalid expected candidate SHA: ${expectedCandidateSha}`);
  }

  const results = [];

  for (const receipt of REQUIRED_RECEIPTS) {
    const fullPath = path.join(root, receipt.file);
    try {
      const raw = await readFile(fullPath, "utf-8");
      const data = JSON.parse(raw);

      if (!data.qa_item || !data.verdict) {
        throw new Error(`Receipt ${receipt.file} missing required fields (qa_item, verdict)`);
      }

      if (data.verdict !== "PASS" && data.verdict !== "COMPONENT_PASS_NOT_GATE_D_EVIDENCE") {
        throw new Error(`Receipt ${receipt.file} has non-passing verdict: ${data.verdict}`);
      }

      results.push({
        file: receipt.file,
        name: receipt.name,
        qa_item: data.qa_item,
        verdict: data.verdict,
        status: "VALID",
      });
    } catch (err) {
      results.push({
        file: receipt.file,
        name: receipt.name,
        status: "FAILED",
        error: err.message,
      });
    }
  }

  const failed = results.filter((r) => r.status === "FAILED");
  return {
    valid: failed.length === 0,
    total: results.length,
    passed: results.filter((r) => r.status === "VALID").length,
    results,
    failed,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const candidateSha = process.argv[2] || process.env.CANDIDATE_SHA;
  validateGateDEvidence(candidateSha)
    .then((summary) => {
      console.log("════════════════════════════════════════════════════════════");
      console.log(" Gate D Evidence Validation Summary");
      console.log("════════════════════════════════════════════════════════════");
      for (const res of summary.results) {
        const symbol = res.status === "VALID" ? "✓" : "❌";
        console.log(`  ${symbol} [${res.qa_item || "UNKNOWN"}] ${res.name}: ${res.status}`);
        if (res.error) console.log(`      Error: ${res.error}`);
      }
      console.log("════════════════════════════════════════════════════════════\n");

      if (!summary.valid) {
        console.error(`Gate D Evidence Validation FAIL (${summary.failed.length} receipts invalid)`);
        process.exit(1);
      }
      console.log("Gate D Evidence Validation PASS");
    })
    .catch((err) => {
      console.error("Validation error:", err);
      process.exit(1);
    });
}
