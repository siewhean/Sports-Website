/**
 * validate-gate-d-evidence.mjs
 *
 * Strict Gate D evidence validator.
 * Enforces:
 *  1. Exact 40-character candidate SHA binding across all receipts (receipt.candidate_sha === expectedCandidateSha).
 *  2. Mode MUST be "staging" and evidence_class MUST be "gate_d_staging".
 *  3. Component diagnostic evidence is explicitly rejected with FAIL.
 *  4. Strict fail-closed policy on missing, tampered, corrupted, or unverified evidence.
 *  5. Recomputes and validates SHA-256 hash binding.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export const REQUIRED_RECEIPTS = [
  {
    file: "artifacts/qa-010-load-public-summary.json",
    name: "QA-010 Public Pages Staging Load Summary",
    qa_item: "QA-010",
  },
  {
    file: "artifacts/qa-011-load-scoring-summary.json",
    name: "QA-011 Scoring Writes Staging Load Summary",
    qa_item: "QA-011",
  },
];

export async function validateGateDEvidence(expectedCandidateSha) {
  if (!expectedCandidateSha || !SHA_PATTERN.test(expectedCandidateSha)) {
    throw new Error(
      `Gate D evidence validation requires a valid 40-character candidate SHA. Received: "${expectedCandidateSha}"`,
    );
  }

  const results = [];

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
            "Component and local-integration diagnostics are prohibited from Gate D qualification.",
        );
      }

      if (data.verdict !== "PASS") {
        throw new Error(`Receipt ${item.file} has non-passing verdict: "${data.verdict}"`);
      }

      if (!data.candidate_sha || data.candidate_sha.toLowerCase() !== expectedCandidateSha.toLowerCase()) {
        throw new Error(
          `Receipt ${item.file} SHA binding mismatch: expected ${expectedCandidateSha}, but receipt was generated for ${data.candidate_sha}`,
        );
      }

      if (!data.competition_id) {
        throw new Error(`Receipt ${item.file} is missing required competition_id`);
      }

      if (!data.target_url) {
        throw new Error(`Receipt ${item.file} is missing required target_url`);
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

      results.push({
        file: item.file,
        name: item.name,
        qa_item: data.qa_item,
        mode: data.mode,
        candidate_sha: data.candidate_sha,
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const candidateSha = process.argv[2] || process.env.CANDIDATE_SHA;
  validateGateDEvidence(candidateSha)
    .then((summary) => {
      console.log("════════════════════════════════════════════════════════════");
      console.log(` Gate D Evidence Validation Summary (Target SHA: ${summary.expected_candidate_sha})`);
      console.log("════════════════════════════════════════════════════════════");
      for (const res of summary.results) {
        const symbol = res.status === "VALID" ? "✓" : "❌";
        console.log(`  ${symbol} [${res.qa_item}] ${res.name}: ${res.status}`);
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
