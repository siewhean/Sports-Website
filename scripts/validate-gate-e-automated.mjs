#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const HASH_PATTERN = /^[0-9a-f]{64}$/iu;

export const GATE_E_SCHEMA_VERSION = "2026.09.gate-e-automated-only";
export const GATE_E_ASSURANCE_PROFILE = "automated-only-owner-waived-v1";
export const REQUIRED_HOSTED_CI_JOBS = ["secrets", "quality-fast", "integration", "browser-e2e", "gate-d-real-e2e"];
export const REQUIRED_WAIVERS = [
  "national_parallel_pilot",
  "pilot_standings_observation",
  "organiser_intervention_log",
  "pilot_critical_high_defect_observation",
  "independent_manual_pentest",
  "independent_gate_e_review",
];

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value.trim();
}

function requireExact(value, expected, label) {
  if (value !== expected) throw new Error(`${label} must be exactly ${expected}; got ${JSON.stringify(value)}`);
}

function requireSha(value, label, expected) {
  const sha = requireString(value, label).toLowerCase();
  if (!SHA_PATTERN.test(sha)) throw new Error(`${label} must be a 40-character SHA`);
  if (expected && sha !== expected.toLowerCase()) throw new Error(`${label} mismatch: expected ${expected}, got ${sha}`);
  return sha;
}

function requireHash(value, label) {
  const hash = requireString(value, label);
  if (!HASH_PATTERN.test(hash)) throw new Error(`${label} must be a SHA-256 digest`);
  return hash;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function validateTechnicalReceipt(receipt, expectedQa, candidateSha, acceptedVerdicts) {
  requireObject(receipt, expectedQa);
  requireExact(receipt.qa_item, expectedQa, `${expectedQa}.qa_item`);
  requireSha(receipt.candidate_sha, `${expectedQa}.candidate_sha`, candidateSha);
  if (!acceptedVerdicts.includes(receipt.verdict)) {
    throw new Error(`${expectedQa}.verdict must be one of ${acceptedVerdicts.join(", ")}; got ${JSON.stringify(receipt.verdict)}`);
  }
  requireHash(receipt.receipt_sha256, `${expectedQa}.receipt_sha256`);
}

export async function validateGateEAutomated(candidateSha, options = {}) {
  const expectedSha = requireSha(candidateSha, "candidate SHA");
  const artifactsDir = options.artifactsDir ?? path.join(root, "artifacts");
  const certificationFile = options.certificationFile ?? path.join(artifactsDir, "gate-e-certification.json");

  const [certification, slo, seo, email, security, legal] = await Promise.all([
    readJson(certificationFile),
    readJson(path.join(artifactsDir, "gate-e-slo-validation.json")),
    readJson(path.join(artifactsDir, "gate-e-seo-audit.json")),
    readJson(path.join(artifactsDir, "gate-e-email-deliverability.json")),
    readJson(path.join(artifactsDir, "gate-e-security-automation.json")),
    readJson(path.join(artifactsDir, "gate-e-legal-package.json")),
  ]);

  requireObject(certification, "Gate E certification");
  requireExact(certification.schema_version, GATE_E_SCHEMA_VERSION, "Gate E schema_version");
  requireExact(certification.gate, "E", "Gate E gate");
  requireExact(certification.assurance_profile, GATE_E_ASSURANCE_PROFILE, "Gate E assurance_profile");
  requireSha(certification.candidate_sha, "Gate E candidate_sha", expectedSha);

  const hostedCi = requireObject(certification.hosted_ci, "Gate E hosted_ci");
  if (!Number.isSafeInteger(hostedCi.run_id) || hostedCi.run_id < 1) throw new Error("Gate E hosted_ci.run_id must be a positive integer");
  requireSha(hostedCi.head_sha, "Gate E hosted_ci.head_sha", expectedSha);
  requireExact(hostedCi.conclusion, "PASS", "Gate E hosted_ci.conclusion");
  const jobs = requireObject(hostedCi.jobs, "Gate E hosted_ci.jobs");
  for (const job of REQUIRED_HOSTED_CI_JOBS) requireExact(jobs[job], "PASS", `Gate E hosted CI job ${job}`);

  const qualification = requireObject(certification.controlled_qualification, "Gate E controlled_qualification");
  if (!Number.isSafeInteger(qualification.run_id) || qualification.run_id < 1) throw new Error("Gate E controlled_qualification.run_id must be a positive integer");
  requireSha(qualification.candidate_sha, "Gate E controlled_qualification.candidate_sha", expectedSha);
  requireExact(qualification.conclusion, "PASS", "Gate E controlled_qualification.conclusion");

  const waivers = requireObject(certification.human_waivers, "Gate E human_waivers");
  for (const waiver of REQUIRED_WAIVERS) requireExact(waivers[waiver], "WAIVED_NOT_EXECUTED", `Gate E human waiver ${waiver}`);

  validateTechnicalReceipt(slo, "QA-024", expectedSha, ["PASS"]);
  validateTechnicalReceipt(seo, "QA-028", expectedSha, ["PASS"]);
  validateTechnicalReceipt(email, "QA-030", expectedSha, ["PASS"]);
  validateTechnicalReceipt(security, "QA-029-AUTOMATED", expectedSha, ["PASS_AUTOMATED_SCOPE"]);
  validateTechnicalReceipt(legal, "QA-027", expectedSha, ["PASS_TECHNICAL_PACKAGE_WITH_GATE_F_DEFERMENT"]);

  if (slo.metrics?.scoring_peak_2x_p95_ms >= 500 || slo.metrics?.public_projection_peak_2x_p95_ms >= 2500 || slo.metrics?.result_propagation_p95_ms >= 2000) {
    throw new Error("Gate E SLO receipt contains an out-of-budget p95");
  }
  if (slo.metrics?.scoring_error_rate > 0.001 || slo.metrics?.public_projection_error_rate > 0.001 || slo.metrics?.result_propagation_error_rate > 0.001) {
    throw new Error("Gate E SLO receipt contains an excessive error rate");
  }
  requireExact(security.independent_manual_pentest, "WAIVED_NOT_EXECUTED", "Gate E security independent pentest disposition");
  requireExact(legal.formal_authorised_legal_approval, "DEFERRED_TO_GATE_F_BY_ADR_0003", "Gate E legal approval disposition");

  return {
    valid: true,
    gate: "E",
    assurance_profile: GATE_E_ASSURANCE_PROFILE,
    candidate_sha: expectedSha,
    hosted_ci_run_id: hostedCi.run_id,
    controlled_qualification_run_id: qualification.run_id,
    technical_receipts: 5,
    waived_human_items: REQUIRED_WAIVERS.length,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  validateGateEAutomated(process.argv[2] ?? process.env.CANDIDATE_SHA)
    .then((report) => {
      console.log("✓ GATE E AUTOMATED-ONLY CERTIFICATION VERIFIED");
      console.log(`  Candidate SHA: ${report.candidate_sha}`);
      console.log(`  Hosted CI run: ${report.hosted_ci_run_id}`);
      console.log(`  Controlled qualification run: ${report.controlled_qualification_run_id}`);
      console.log(`  Human/physical waivers: ${report.waived_human_items}`);
    })
    .catch((error) => {
      console.error(`❌ GATE E AUTOMATED-ONLY CERTIFICATION NOT READY: ${error.message}`);
      process.exitCode = 1;
    });
}
