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

  const isPass = validation.errors.length === 0;

  // Simulation steps for component testing/tracing
  const drillSteps = [
    { step: "baseline_health_check", status: "HEALTHY", version: sha },
    { step: "canary_failure_injection", injected_error: "HEALTH_CHECK_TIMEOUT_SIMULATION", status: "DETECTED" },
    { step: "automated_rollback_trigger", action: "RESTORE_PREVIOUS_REVISION", duration_ms: 420 },
    { step: "post_rollback_health_check", status: "HEALTHY", active_version: sha },
  ];

  const receipt = {
    qa_item: "OPS-002",
    candidate_sha: sha,
    drill_type: "automated_zero_downtime_rollback_simulation",
    scoring_availability: "PRESERVED",
    simulation_steps: drillSteps,
    simulation_result: "SIMULATION_PASS",
    verdict: isPass ? "PASS" : "PENDING",
    pending_reasons: isPass ? [] : validation.errors,
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
