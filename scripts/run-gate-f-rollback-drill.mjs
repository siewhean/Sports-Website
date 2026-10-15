#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAndValidateEvidence } from "./validate-external-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function requireSha(value) {
  if (!value || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`Rollback audit requires an exact 40-character candidate SHA; got ${value}`);
  }
  return value.toLowerCase();
}

export async function runGateFRollbackDrill(candidateSha, options = {}) {
  const sha = requireSha(candidateSha);
  const artifactsDir = options.artifactsDir ?? path.join(root, "artifacts");
  await mkdir(artifactsDir, { recursive: true });

  const evidenceFile = options.evidenceFile
    ? path.resolve(options.evidenceFile)
    : options.rollbackEvidenceFile
      ? path.resolve(options.rollbackEvidenceFile)
      : undefined;

  // Validate external production rollback evidence
  const validation = await loadAndValidateEvidence(sha, evidenceFile, {
    allowedEvidenceClasses: ["PROVIDER_RECEIPT", "OPERATOR_CAPTURE"],
    requireProductionEnvironment: true,
  });

  const hasSpecificProof =
    validation.errors.length === 0 &&
    Boolean(validation.evidence?.rollback_drill_id) &&
    validation.evidence?.simulated_or_observed_result === "PASS" &&
    validation.evidence?.scoring_availability === "PRESERVED";

  const isFailed =
    Boolean(validation.evidence?.rollback_drill_id) &&
    (validation.evidence?.simulated_or_observed_result === "FAIL" ||
      validation.evidence?.scoring_availability === "FAILED" ||
      validation.evidence?.scoring_availability === "COMPROMISED");

  const isPass = hasSpecificProof;
  const verdict = isPass ? "PASS" : isFailed ? "FAIL" : "PENDING";

  // Production rollback requires live external execution; do not invent simulation steps
  const receipt = {
    qa_item: "OPS-002",
    candidate_sha: sha,
    drill_type: "automated_zero_downtime_rollback_procedure",
    drill_executed: isPass || isFailed,
    scoring_availability: isPass
      ? (validation.evidence?.scoring_availability ?? "PRESERVED")
      : isFailed
        ? (validation.evidence?.scoring_availability ?? "FAILED")
        : "UNTESTED_PENDING_PRODUCTION_RUN",
    simulation_steps: isPass || isFailed ? (validation.evidence?.steps ?? []) : [],
    simulation_result: isPass ? "OBSERVED_PASS" : isFailed ? "OBSERVED_FAIL" : "NOT_EXECUTED_PENDING_PRODUCTION_DRILL",
    verdict,
    pending_reasons: isPass
      ? []
      : validation.errors.length > 0
        ? validation.errors
        : isFailed
          ? ["rollback_drill_failed_in_production"]
          : ["external_production_rollback_evidence_missing"],
    ...(validation.evidenceSha256
      ? { input_evidence_sha256: validation.evidenceSha256, evidence_reference: evidenceFile }
      : {}),
    verified_evidence_files: validation.verifiedFiles,
    ...(isPass ? { production_observations: validation.evidence } : {}),
    generated_at: new Date().toISOString(),
  };

  const { receipt_sha256, ...payload } = receipt;
  receipt.receipt_sha256 = createHash("sha256")
    .update(JSON.stringify(payload, null, 2))
    .digest("hex");

  await writeFile(path.join(artifactsDir, "gate-f-rollback-drill.json"), JSON.stringify(receipt, null, 2));

  return receipt;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sha = process.argv[2] ?? process.env.CANDIDATE_SHA;
  runGateFRollbackDrill(sha, { evidenceFile: process.argv[3] })
    .then((r) => {
      console.log(`Gate F rollback drill: ${r.verdict}`);
      if (r.verdict !== "PASS") process.exitCode = 1;
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
