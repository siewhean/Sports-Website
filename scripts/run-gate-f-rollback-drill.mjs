#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadAndValidateEvidence,
  validateExternalEvidence,
  isValidUtcTimestamp,
  isNonEmptyString,
} from "./validate-external-evidence.mjs";

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

  // A production envelope must retain an independently hashed observation capture.
  const validation = await loadAndValidateEvidence(sha, evidenceFile, {
    allowedEvidenceClasses: ["PROVIDER_RECEIPT", "OPERATOR_CAPTURE"],
    requireProductionEnvironment: true,
    requiredFiles: ["rollback_observations"],
  });
  const errors = [...validation.errors];
  let observations;
  if (errors.length === 0) {
    const capture = validation.verifiedFiles.find((file) => file.kind === "rollback_observations");
    try {
      observations = JSON.parse(await readFile(path.resolve(path.dirname(evidenceFile), capture.reference), "utf8"));
      const observedValidation = await validateExternalEvidence(observations, sha, evidenceFile, {
        allowedEvidenceClasses: ["PROVIDER_RECEIPT", "OPERATOR_CAPTURE"],
        requireProductionEnvironment: true,
      });
      errors.push(...observedValidation.errors.map((error) => `rollback_observations.${error}`));
      const require = (condition, field) => {
        if (!condition) errors.push(field);
      };
      require(isNonEmptyString(observations.rollback_drill_id), "rollback_drill_id_required");
      require(observations.observed_result === "PASS", "observed_rollback_not_pass");
      require(observations.scoring_availability === "PRESERVED", "scoring_availability_not_preserved");
      const capturedTimes = [observations.captured_at, validation.evidence?.captured_at, capture.captured_at];
      const validCaptureTimes = capturedTimes.every(isValidUtcTimestamp);
      const captureEnd = validCaptureTimes ? Math.min(...capturedTimes.map(Date.parse)) : NaN;
      const freshnessFloor = Date.now() - 24 * 60 * 60 * 1000;
      const withinCaptureWindow = (event) =>
        isValidUtcTimestamp(event?.observed_at) &&
        Date.parse(event.observed_at) >= freshnessFloor &&
        Date.parse(event.observed_at) <= captureEnd;
      require(validCaptureTimes, "observation_capture_timestamps_required");
      const steps = observations.observed_steps;
      const names = [
        "baseline_health_check",
        "canary_failure_injection",
        "automated_rollback_trigger",
        "post_rollback_health_check",
      ];
      require(Array.isArray(steps) && steps.length === names.length, "observed_steps_required");
      if (Array.isArray(steps) && steps.length === names.length) {
        require(steps.every(withinCaptureWindow), "observed_event_outside_capture_window");
        require(steps.every(
          (step, i) =>
            step?.step === names[i] &&
            isValidUtcTimestamp(step.observed_at) &&
            Date.parse(step.observed_at) <= Date.now() &&
            (i === 0 || Date.parse(step.observed_at) >= Date.parse(steps[i - 1].observed_at)),
        ), "observed_steps_order_or_timestamp_invalid");
        require(steps[0].status === "HEALTHY" && steps[0].active_version === sha, "baseline_candidate_health_required");
        require(steps[1].status === "DETECTED" &&
          isNonEmptyString(steps[1].injected_error), "observed_failure_detection_required");
        require(steps[2].status === "COMPLETED" &&
          steps[2].action === "RESTORE_PREVIOUS_REVISION", "observed_automated_rollback_required");
        require(/^[0-9a-f]{40}$/.test(steps[2].restored_version ?? "") &&
          steps[2].restored_version !== sha &&
          steps[3].status === "HEALTHY" &&
          steps[3].active_version === steps[2].restored_version, "restored_revision_health_required");
        const checks = observations.scoring_checks;
        require(Array.isArray(checks) &&
          checks.length >= 3 &&
          checks.every(withinCaptureWindow) &&
          checks.some(
            (check) =>
              Date.parse(check.observed_at) > Date.parse(steps[1].observed_at) &&
              Date.parse(check.observed_at) < Date.parse(steps[2].observed_at),
          ) &&
          checks.every(
            (check) =>
              check?.availability === "AVAILABLE" &&
              isValidUtcTimestamp(check.observed_at) &&
              Date.parse(check.observed_at) <= Date.now(),
          ) &&
          Date.parse(checks[0].observed_at) <= Date.parse(steps[0].observed_at) &&
          Date.parse(checks.at(-1).observed_at) >=
            Date.parse(steps[3].observed_at), "observed_scoring_checks_required");
      }
    } catch {
      errors.push("rollback_observations_unreadable_or_malformed");
    }
  }
  const isPass = errors.length === 0;
  // This checks only the source-defined sequence. No runtime actions are executed.
  const plannedSteps = [
    "baseline_health_check",
    "canary_failure_injection",
    "automated_rollback_trigger",
    "post_rollback_health_check",
  ];

  const receipt = {
    qa_item: "OPS-002",
    candidate_sha: sha,
    drill_type: "automated_zero_downtime_rollback_simulation",
    scoring_availability: isPass ? observations.scoring_availability : "UNKNOWN",
    simulation_steps: plannedSteps.map((step) => ({ step, execution: "NOT_EXECUTED" })),
    simulation_scope: "SOURCE_SEQUENCE_ONLY",
    simulation_result: "SIMULATION_PASS",
    verdict: isPass ? "PASS" : "PENDING",
    pending_reasons: errors,
    ...(validation.evidenceSha256
      ? { input_evidence_sha256: validation.evidenceSha256, evidence_reference: evidenceFile }
      : {}),
    verified_evidence_files: validation.verifiedFiles,
    ...(isPass ? { production_observations: observations } : {}),
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
