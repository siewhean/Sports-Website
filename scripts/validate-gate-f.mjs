#!/usr/bin/env node
import { createHash } from "node:crypto";
import { productionHostname } from "./lib/hostnames.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProductionBackupEvidence } from "./run-gate-f-backup-restore-audit.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const HASH_PATTERN = /^[0-9a-f]{64}$/iu;

export const GATE_F_SCHEMA_VERSION = "2026.09.gate-f-production";
export const GATE_F_ASSURANCE_PROFILE = "automated-only-owner-waived-v2";

export const REQUIRED_HOSTED_CI_JOBS = ["secrets", "quality-fast", "integration", "browser-e2e", "gate-d-real-e2e"];
export const REQUIRED_WAIVERS = [
  "independent_manual_pentest",
  "independent_gate_f_reviewer",
  "physical_device_matrix_session",
  "human_screen_reader_audit",
  "live_organiser_pilot_observation",
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
  if (expected && sha !== expected.toLowerCase())
    throw new Error(`${label} mismatch: expected ${expected}, got ${sha}`);
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

async function validateProductionBackup(cert, expectedSha, artifactsDir, certFile) {
  const declared = requireObject(cert.backup_restore, "Gate F backup_restore");
  requireExact(declared.conclusion, "PASS", "Gate F backup_restore.conclusion");
  requireExact(declared.production_operator_review, "PASS", "Gate F backup_restore.production_operator_review");
  const evidenceFile = path.resolve(
    path.dirname(certFile),
    requireString(declared.evidence_reference, "Gate F backup evidence_reference"),
  );
  const inputHash = requireHash(declared.evidence_sha256, "Gate F backup evidence_sha256");
  const receipt = requireObject(
    await readJson(path.join(artifactsDir, "gate-f-backup-restore.json")),
    "Backup receipt",
  );
  requireSha(receipt.candidate_sha, "Backup candidate_sha", expectedSha);
  requireExact(receipt.verdict, "PASS", "Backup verdict");
  requireExact(receipt.evidence_scope, "production_backup_and_isolated_restore", "Backup evidence_scope");
  requireExact(receipt.input_evidence_sha256, inputHash, "Backup input_evidence_sha256");
  const receiptEvidenceFile = path.resolve(
    artifactsDir,
    requireString(receipt.evidence_reference, "Backup evidence_reference"),
  );
  requireExact(receiptEvidenceFile, evidenceFile, "Backup evidence reference binding");
  const { receipt_sha256: receiptHash, ...payload } = receipt;
  const actualReceiptHash = createHash("sha256")
    .update(JSON.stringify(payload, null, 2))
    .digest("hex");
  requireExact(requireHash(receiptHash, "Backup receipt_sha256"), actualReceiptHash, "Backup receipt checksum");
  const generatedAt = Date.parse(receipt.generated_at);
  if (!Number.isFinite(generatedAt) || generatedAt > Date.now() || Date.now() - generatedAt > 24 * 60 * 60 * 1000)
    throw new Error("Backup receipt generated_at must be within the last 24 hours");
  const validated = await loadProductionBackupEvidence({ candidateSha: expectedSha, evidenceFile });
  if (validated.errors.length > 0)
    throw new Error(`Production backup evidence invalid: ${validated.errors.join(", ")}`);
  requireExact(validated.evidenceSha256, inputHash, "Production backup evidence checksum");
}

export async function validateGateF(candidateSha, options = {}) {
  const expectedSha = requireSha(candidateSha, "candidate SHA");
  const artifactsDir = options.artifactsDir ?? path.join(root, "artifacts");
  const certFile = options.certificationFile ?? path.join(artifactsDir, "gate-f-certification.json");

  const [cert, sim] = await Promise.all([
    readJson(certFile),
    readJson(path.join(artifactsDir, "gate-f-production-simulation.json")),
  ]);

  requireObject(cert, "Gate F certification");
  requireExact(cert.schema_version, GATE_F_SCHEMA_VERSION, "Gate F schema_version");
  requireExact(cert.gate, "F", "Gate F gate");
  requireExact(cert.assurance_profile, GATE_F_ASSURANCE_PROFILE, "Gate F assurance_profile");
  requireSha(cert.candidate_sha, "Gate F candidate_sha", expectedSha);

  const prod = requireObject(cert.production_deployment, "Gate F production_deployment");
  requireSha(prod.deployed_sha, "Gate F production deployed_sha", expectedSha);
  requireExact(prod.conclusion, "PASS", "Gate F production conclusion");
  requireExact(prod.hostname, productionHostname(), "Gate F production hostname");

  const hostedCi = requireObject(cert.hosted_ci, "Gate F hosted_ci");
  requireSha(hostedCi.head_sha, "Gate F hosted_ci.head_sha", expectedSha);
  requireExact(hostedCi.conclusion, "PASS", "Gate F hosted_ci.conclusion");
  const jobs = requireObject(hostedCi.jobs, "Gate F hosted_ci.jobs");
  for (const job of REQUIRED_HOSTED_CI_JOBS) {
    requireExact(jobs[job], "PASS", `Gate F hosted CI job ${job}`);
  }

  const waivers = requireObject(cert.human_waivers, "Gate F human_waivers");
  for (const waiver of REQUIRED_WAIVERS) {
    requireExact(waivers[waiver], "WAIVED_NOT_EXECUTED", `Gate F human waiver ${waiver}`);
  }

  requireExact(cert.legal_approval, "DEFERRED_TO_FIRST_COMMERCIAL_RELEASE", "Gate F legal approval disposition");

  if (
    sim.production_certification === false ||
    cert.simulation?.production_certification === false ||
    (typeof sim.simulation_environment === "string" && /simulation|staging|local/iu.test(sim.simulation_environment)) ||
    sim.pending_reasons?.includes?.("simulation_is_not_production_certification")
  )
    throw new Error("Simulation-only evidence cannot certify production");
  requireExact(sim.verdict, "PASS", "Simulation verdict");
  requireSha(sim.candidate_sha, "Simulation candidate_sha", expectedSha);
  requireHash(sim.receipt_sha256, "Simulation receipt_sha256");

  await validateProductionBackup(cert, expectedSha, artifactsDir, certFile);

  // Validate that simulation receipts match expected results and simulation cannot certify production
  if (cert.simulation?.receipts) {
    const receipts = cert.simulation.receipts;
    for (const [key, val] of Object.entries(receipts)) {
      if (cert.simulation.conclusion === "PASS") {
        const allowedSuccess = ["PASS", "PASS_AUTOMATED_SCOPE", "PASS_TECHNICAL_PACKAGE_WITH_DEFERMENT"];
        if (!allowedSuccess.includes(val)) {
          throw new Error(`Gate F simulation declared PASS but component ${key} has nonpassing status: ${val}`);
        }
      }
    }
  }

  return {
    valid: true,
    gate: "F",
    candidate_sha: expectedSha,
    production_hostname: prod.hostname,
    assurance_profile: GATE_F_ASSURANCE_PROFILE,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  validateGateF(process.argv[2] ?? process.env.CANDIDATE_SHA)
    .then((report) => {
      console.log("✓ GATE F PRODUCTION CERTIFICATION VERIFIED");
      console.log(`  Candidate SHA: ${report.candidate_sha}`);
      console.log(`  Hostname: ${report.production_hostname}`);
      console.log(`  Assurance Profile: ${report.assurance_profile}`);
    })
    .catch((error) => {
      console.error(`✗ GATE F VALIDATION FAILED: ${error.message}`);
      process.exit(1);
    });
}
