#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA_PATTERN = /^[0-9a-f]{40}$/iu;

function requireSha(value) {
  if (!value || !SHA_PATTERN.test(value)) throw new Error(`Gate E SLO audit requires an exact 40-character SHA; got ${value}`);
  return value.toLowerCase();
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function requireReceipt(receipt, expectedQa, candidateSha, budgetMs) {
  if (receipt.qa_item !== expectedQa) throw new Error(`Expected ${expectedQa} receipt; got ${receipt.qa_item}`);
  if (String(receipt.candidate_sha).toLowerCase() !== candidateSha) throw new Error(`${expectedQa} candidate SHA mismatch`);
  if (String(receipt.deployed_sha).toLowerCase() !== candidateSha) throw new Error(`${expectedQa} deployed SHA mismatch`);
  if (receipt.verdict !== "PASS") throw new Error(`${expectedQa} receipt is not PASS`);
  const peak = receipt.peak_summary;
  if (!peak || !Number.isFinite(peak.p95Ms) || !Number.isFinite(peak.errorRate)) throw new Error(`${expectedQa} peak summary is invalid`);
  if (peak.p95Ms >= budgetMs) throw new Error(`${expectedQa} p95 ${peak.p95Ms}ms is not below ${budgetMs}ms`);
  if (peak.errorRate > 0.001) throw new Error(`${expectedQa} error rate ${peak.errorRate} exceeds 0.1%`);
  if (!receipt.receipt_sha256 || !/^[0-9a-f]{64}$/iu.test(receipt.receipt_sha256)) throw new Error(`${expectedQa} receipt hash missing`);
  return peak;
}

export async function runGateESloAudit(candidateSha, options = {}) {
  const sha = requireSha(candidateSha);
  const artifactsDir = options.artifactsDir ?? path.join(root, "artifacts");
  const qa010 = await readJson(path.join(artifactsDir, "qa-010-load-public-summary.json"));
  const qa011 = await readJson(path.join(artifactsDir, "qa-011-load-scoring-summary.json"));
  const propagation = await readJson(path.join(artifactsDir, "qa-011-result-propagation-summary.json"));

  const publicPeak = requireReceipt(qa010, "QA-010", sha, 2500);
  const scoringPeak = requireReceipt(qa011, "QA-011", sha, 500);
  const propagationPeak = requireReceipt(propagation, "QA-011-RP", sha, 2000);

  const competitionIds = new Set([qa010.competition_id, qa011.competition_id, propagation.competition_id]);
  if (competitionIds.size !== 1 || [...competitionIds][0] === undefined) throw new Error("Gate E SLO source receipts must share one competition ID");

  const receipt = {
    qa_item: "QA-024",
    evidence_class: "gate_e_automated_only",
    candidate_sha: sha,
    competition_id: [...competitionIds][0],
    slo_definition_version: "2026.09.gate-e-automated-only",
    sources: {
      qa_010_receipt_sha256: qa010.receipt_sha256,
      qa_011_receipt_sha256: qa011.receipt_sha256,
      qa_011_result_propagation_receipt_sha256: propagation.receipt_sha256,
    },
    metrics: {
      public_projection_peak_2x_p95_ms: publicPeak.p95Ms,
      public_projection_error_rate: publicPeak.errorRate,
      scoring_peak_2x_p95_ms: scoringPeak.p95Ms,
      scoring_error_rate: scoringPeak.errorRate,
      result_propagation_p95_ms: propagationPeak.p95Ms,
      result_propagation_error_rate: propagationPeak.errorRate,
    },
    budgets: {
      public_projection_p95_ms: 2500,
      scoring_p95_ms: 500,
      result_propagation_p95_ms: 2000,
      maximum_error_rate: 0.001,
    },
    verdict: "PASS",
    generated_at: new Date().toISOString(),
  };
  const receiptSha256 = createHash("sha256").update(JSON.stringify(receipt), "utf8").digest("hex");
  const output = { ...receipt, receipt_sha256: receiptSha256 };
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(path.join(artifactsDir, "gate-e-slo-validation.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  return output;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runGateESloAudit(process.argv[2] ?? process.env.CANDIDATE_SHA)
    .then((receipt) => {
      console.log("✓ QA-024 GATE E SLO VALIDATED");
      console.log(`  Candidate SHA: ${receipt.candidate_sha}`);
      console.log(`  Scoring p95: ${receipt.metrics.scoring_peak_2x_p95_ms.toFixed(2)}ms`);
    })
    .catch((error) => {
      console.error(`❌ QA-024 GATE E SLO NOT READY: ${error.message}`);
      process.exitCode = 1;
    });
}
