#!/usr/bin/env node
/**
 * Final Gate D freeze validator.
 *
 * This is intentionally stricter than source/release readiness. It composes the
 * cryptographically-bound controlled-staging receipts with an exact-SHA hosted
 * CI attestation and the physical/human pilot evidence required by Gate D.
 * Missing, pending, follow-up, or differently-bound evidence fails closed.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateGateDEvidence } from "./validate-gate-d-evidence.mjs";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export const GATE_D_FREEZE_SCHEMA_VERSION = "2026.09.gate-d-freeze";
export const REQUIRED_HOSTED_CI_JOBS = [
  "secrets",
  "quality-fast",
  "integration",
  "browser-e2e",
  "gate-d-real-e2e",
];
export const REQUIRED_HUMAN_EVIDENCE = [
  "accessibility_human_audit",
  "browser_device_matrix",
  "budget_android",
  "incident_tabletop",
  "event_day_tabletop",
  "restore_drill",
  "deployed_seo_crawl",
  "local_pilot",
  "standings_oracle",
  "organiser_intervention_log",
  "critical_high_defects",
  "independent_review",
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function requireExactPass(value, label) {
  if (value !== "PASS") {
    throw new Error(`${label} must be exactly PASS; received ${JSON.stringify(value)}`);
  }
}

function requireCompletedAt(value, label) {
  const raw = requireString(value, label);
  const timestamp = new Date(raw);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  return timestamp.toISOString();
}

function validateHostedCi(hostedCi, expectedCandidateSha) {
  if (!isPlainObject(hostedCi)) {
    throw new Error("Gate D certification is missing hosted_ci");
  }
  if (!Number.isSafeInteger(hostedCi.run_id) || hostedCi.run_id < 1) {
    throw new Error("Gate D certification hosted_ci.run_id must be a positive integer");
  }
  const headSha = requireString(hostedCi.head_sha, "Gate D certification hosted_ci.head_sha");
  if (!SHA_PATTERN.test(headSha) || headSha.toLowerCase() !== expectedCandidateSha.toLowerCase()) {
    throw new Error(`Gate D hosted CI head SHA mismatch: expected ${expectedCandidateSha}, got ${headSha}`);
  }
  requireExactPass(hostedCi.conclusion, "Gate D certification hosted_ci.conclusion");
  if (!isPlainObject(hostedCi.jobs)) {
    throw new Error("Gate D certification hosted_ci.jobs is required");
  }
  for (const job of REQUIRED_HOSTED_CI_JOBS) {
    requireExactPass(hostedCi.jobs[job], `Gate D hosted CI job ${job}`);
  }
  return { run_id: hostedCi.run_id, head_sha: headSha };
}

function validateEvidenceItem(item, key) {
  if (!isPlainObject(item)) {
    throw new Error(`Gate D human evidence ${key} is missing`);
  }
  requireExactPass(item.status, `Gate D human evidence ${key}.status`);
  requireCompletedAt(item.completed_at, `Gate D human evidence ${key}.completed_at`);
  requireString(item.evidence_ref, `Gate D human evidence ${key}.evidence_ref`);

  if (key === "critical_high_defects") {
    if (item.critical_open !== 0 || item.high_open !== 0) {
      throw new Error("Gate D requires zero open Critical and High pilot defects");
    }
  }
  if (key === "independent_review") {
    requireExactPass(item.verdict, "Gate D independent reviewer verdict");
    requireString(item.reviewer, "Gate D independent reviewer identity");
  }
}

export async function validateGateDFreeze(expectedCandidateSha, options = {}) {
  if (!expectedCandidateSha || !SHA_PATTERN.test(expectedCandidateSha)) {
    throw new Error(
      `Gate D freeze validation requires a valid 40-character candidate SHA: ${expectedCandidateSha}`,
    );
  }

  const root = options.rootDir ?? defaultRoot;
  const certificationPath =
    options.certificationFile ??
    process.env.GATE_D_CERTIFICATION_FILE ??
    path.join(root, "artifacts", "gate-d-certification.json");
  const stagingValidator = options.stagingValidator ?? validateGateDEvidence;
  const staging = await stagingValidator(expectedCandidateSha, { rootDir: root });
  if (!staging?.valid) {
    const findings = Array.isArray(staging?.failed) ? staging.failed.length : "unknown";
    throw new Error(`Gate D controlled-staging evidence is not valid (${findings} finding(s))`);
  }

  let certification;
  try {
    certification = JSON.parse(await readFile(certificationPath, "utf8"));
  } catch (error) {
    throw new Error(`Gate D certification manifest is unavailable or invalid: ${certificationPath}`, {
      cause: error,
    });
  }
  if (!isPlainObject(certification)) {
    throw new Error("Gate D certification manifest must be a JSON object");
  }
  if (certification.schema_version !== GATE_D_FREEZE_SCHEMA_VERSION) {
    throw new Error(
      `Gate D certification schema mismatch: expected ${GATE_D_FREEZE_SCHEMA_VERSION}, got ${certification.schema_version}`,
    );
  }
  if (certification.gate !== "D") {
    throw new Error("Gate D certification manifest gate must be D");
  }
  const candidateSha = requireString(certification.candidate_sha, "Gate D certification candidate_sha");
  if (!SHA_PATTERN.test(candidateSha) || candidateSha.toLowerCase() !== expectedCandidateSha.toLowerCase()) {
    throw new Error(
      `Gate D certification candidate SHA mismatch: expected ${expectedCandidateSha}, got ${candidateSha}`,
    );
  }

  const hostedCi = validateHostedCi(certification.hosted_ci, expectedCandidateSha);
  if (!isPlainObject(certification.human_evidence)) {
    throw new Error("Gate D certification manifest is missing human_evidence");
  }
  for (const key of REQUIRED_HUMAN_EVIDENCE) {
    validateEvidenceItem(certification.human_evidence[key], key);
  }

  return {
    valid: true,
    gate: "D",
    candidate_sha: expectedCandidateSha,
    hosted_ci_run_id: hostedCi.run_id,
    staging_receipts: staging.passed,
    human_evidence_items: REQUIRED_HUMAN_EVIDENCE.length,
    certification_file: certificationPath,
  };
}

async function runCli() {
  const candidateSha = process.argv[2] ?? process.env.CANDIDATE_SHA;
  try {
    const report = await validateGateDFreeze(candidateSha);
    console.log("✓ GATE D FREEZE CERTIFICATION VERIFIED");
    console.log(`  Candidate SHA: ${report.candidate_sha}`);
    console.log(`  Hosted CI run: ${report.hosted_ci_run_id}`);
    console.log(`  Staging receipts: ${report.staging_receipts}`);
    console.log(`  Human evidence items: ${report.human_evidence_items}`);
  } catch (error) {
    console.error(`❌ GATE D FREEZE NOT READY: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runCli();
