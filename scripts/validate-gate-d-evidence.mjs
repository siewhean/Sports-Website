/**
 * Strict Gate D controlled-staging evidence validator.
 *
 * A component or socket-component benchmark is useful developer feedback, but
 * is never Gate D evidence. These receipts are deliberately fail-closed: they
 * must come from the same exact deployed candidate and use the same telemetry
 * envelope as PilotTelemetryCollector.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

// Keep this in lockstep with packages/observability/src/pilot-telemetry.ts.
// The validator is plain Node so it can run without loading the TypeScript
// workspace at release time.
export const CURRENT_SLO_DEFINITION_VERSION = "2026.09.gate-d";
export const MINIMUM_SAMPLES_PER_RECEIPT = 10;
export const MINIMUM_SESSIONS_PER_RECEIPT = 1;
export const MAXIMUM_ERROR_RATE = 0.001;

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
  {
    file: "artifacts/qa-011-result-propagation-summary.json",
    name: "QA-011 Result Propagation Staging Summary",
    qa_item: "QA-011-RP",
    max_p95_ms: 2000,
  },
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required`);
  return value;
}

function requireFiniteNumber(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function requireSafeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function canonicalTargetUrl(value, label) {
  const raw = requireNonEmptyString(value, label);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${label} must be an absolute HTTP(S) URL`);
  }
  if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

function validateObservationWindow(data, item) {
  if (!isPlainObject(data.observation_window)) {
    throw new Error(`Receipt ${item.file} is missing observation_window`);
  }
  const startsAt = new Date(requireNonEmptyString(data.observation_window.starts_at, `${item.file} starts_at`));
  const endsAt = new Date(requireNonEmptyString(data.observation_window.ends_at, `${item.file} ends_at`));
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || startsAt >= endsAt) {
    throw new Error(`Receipt ${item.file} has invalid observation time bounds`);
  }
  return { starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString() };
}

function validateMetrics(data, item) {
  const peak = data.peak_summary;
  if (!isPlainObject(peak)) throw new Error(`Receipt ${item.file} is missing peak_summary metrics object`);

  const minSamples = requireSafeInteger(
    data.minimum_samples_threshold,
    `Receipt ${item.file} minimum_samples_threshold`,
    MINIMUM_SAMPLES_PER_RECEIPT,
  );
  const minSessions = requireSafeInteger(
    data.minimum_sessions_threshold,
    `Receipt ${item.file} minimum_sessions_threshold`,
    MINIMUM_SESSIONS_PER_RECEIPT,
  );
  const observedSessions = requireSafeInteger(
    data.observed_session_count,
    `Receipt ${item.file} observed_session_count`,
    minSessions,
  );
  const sampleCount = requireSafeInteger(peak.sampleCount, `Receipt ${item.file} peak sampleCount`, minSamples);
  const successfulCount = requireSafeInteger(peak.successfulCount, `Receipt ${item.file} peak successfulCount`, 1);
  const expectedFailureCount = requireSafeInteger(
    peak.expectedFailureCount,
    `Receipt ${item.file} peak expectedFailureCount`,
  );
  const unexpectedFailureCount = requireSafeInteger(
    peak.unexpectedFailureCount,
    `Receipt ${item.file} peak unexpectedFailureCount`,
  );
  if (successfulCount + expectedFailureCount + unexpectedFailureCount !== sampleCount) {
    throw new Error(`Receipt ${item.file} peak summary counts do not add up to sampleCount`);
  }

  for (const metric of ["p50Ms", "p95Ms", "p99Ms", "maxMs", "errorRate"]) {
    requireFiniteNumber(peak[metric], `Receipt ${item.file} peak ${metric}`);
  }
  if (peak.p50Ms < 0 || peak.p95Ms < peak.p50Ms || peak.p99Ms < peak.p95Ms || peak.maxMs < peak.p99Ms) {
    throw new Error(`Receipt ${item.file} peak latency metrics are invalid`);
  }
  if (
    peak.errorRate < 0 ||
    peak.errorRate > 1 ||
    Math.abs(peak.errorRate - unexpectedFailureCount / sampleCount) > 1e-12
  ) {
    throw new Error(`Receipt ${item.file} peak errorRate does not match the retained counts`);
  }
  if (peak.p95Ms >= item.max_p95_ms) {
    throw new Error(`Receipt ${item.file} SLA breach: p95 ${peak.p95Ms}ms exceeds budget < ${item.max_p95_ms}ms`);
  }
  if (peak.errorRate > MAXIMUM_ERROR_RATE) {
    throw new Error(`Receipt ${item.file} error rate ${(peak.errorRate * 100).toFixed(2)}% exceeds max allowable 0.1%`);
  }
  return { minSamples, minSessions, observedSessions };
}

function validateReceipt(data, item, expectedCandidateSha) {
  if (!isPlainObject(data)) throw new Error(`Receipt ${item.file} must be a JSON object`);
  if (data.qa_item !== item.qa_item) {
    throw new Error(`Receipt ${item.file} qa_item mismatch: expected ${item.qa_item}, got ${data.qa_item}`);
  }
  if (data.mode !== "staging" || data.evidence_class !== "gate_d_staging") {
    throw new Error(
      `Receipt ${item.file} is not staging Gate D evidence (mode="${data.mode}", evidence_class="${data.evidence_class}"). ` +
        "Component and socket-component diagnostics are prohibited from Gate D qualification.",
    );
  }
  if (data.slo_definition_version !== CURRENT_SLO_DEFINITION_VERSION) {
    throw new Error(
      `Receipt ${item.file} has unsupported slo_definition_version "${data.slo_definition_version}"; expected ${CURRENT_SLO_DEFINITION_VERSION}`,
    );
  }
  if (data.verdict !== "PASS") throw new Error(`Receipt ${item.file} has non-passing verdict: "${data.verdict}"`);

  const candidateSha = requireNonEmptyString(data.candidate_sha, `Receipt ${item.file} candidate_sha`);
  const deployedSha = requireNonEmptyString(data.deployed_sha, `Receipt ${item.file} deployed_sha`);
  if (!SHA_PATTERN.test(candidateSha) || candidateSha.toLowerCase() !== expectedCandidateSha.toLowerCase()) {
    throw new Error(
      `Receipt ${item.file} candidate SHA mismatch: expected ${expectedCandidateSha}, got ${candidateSha}`,
    );
  }
  if (!SHA_PATTERN.test(deployedSha) || deployedSha.toLowerCase() !== expectedCandidateSha.toLowerCase()) {
    throw new Error(
      `Receipt ${item.file} deployed SHA mismatch: expected ${expectedCandidateSha}, but server served ${deployedSha}`,
    );
  }

  const competitionId = requireNonEmptyString(data.competition_id, `Receipt ${item.file} competition_id`);
  const targetUrl = canonicalTargetUrl(data.target_url, `Receipt ${item.file} target_url`);
  const observationWindow = validateObservationWindow(data, item);
  const metrics = validateMetrics(data, item);

  if (!SHA256_PATTERN.test(data.receipt_sha256 ?? "")) {
    throw new Error(`Receipt ${item.file} is missing a valid receipt_sha256 digest`);
  }
  const { receipt_sha256, ...dataToHash } = data;
  const expectedDigest = createHash("sha256").update(JSON.stringify(dataToHash)).digest("hex");
  if (expectedDigest !== receipt_sha256) {
    throw new Error(`Receipt ${item.file} integrity check failed: digest mismatch. File may have been tampered with.`);
  }

  return { candidateSha, deployedSha, competitionId, targetUrl, observationWindow, metrics };
}

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
    try {
      const data = JSON.parse(await readFile(path.join(root, item.file), "utf-8"));
      const parsed = validateReceipt(data, item, expectedCandidateSha);
      parsedReceipts.push({ item, parsed });
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
    } catch (error) {
      results.push({ file: item.file, name: item.name, qa_item: item.qa_item, status: "FAILED", error: error.message });
    }
  }

  if (parsedReceipts.length === REQUIRED_RECEIPTS.length) {
    const first = parsedReceipts[0].parsed;
    for (const { parsed } of parsedReceipts.slice(1)) {
      if (parsed.competitionId !== first.competitionId) {
        results.push({
          file: "cross-receipt",
          name: "Cross-Receipt Consistency",
          qa_item: "ALL",
          status: "FAILED",
          error: `Competition ID mismatch between receipts: ${first.competitionId} vs ${parsed.competitionId}`,
        });
      }
      if (parsed.targetUrl !== first.targetUrl) {
        results.push({
          file: "cross-receipt",
          name: "Cross-Receipt Consistency",
          qa_item: "ALL",
          status: "FAILED",
          error: `Target URL mismatch between receipts: ${first.targetUrl} vs ${parsed.targetUrl}`,
        });
      }
    }
  }

  const failed = results.filter((result) => result.status === "FAILED");
  return {
    valid: failed.length === 0,
    total: results.length,
    passed: results.filter((result) => result.status === "VALID").length,
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
    for (const result of report.results) {
      if (result.status === "VALID") {
        console.log(`  ✓ [${result.qa_item}] ${result.name}: VALID`);
      } else {
        console.log(`  ✗ [${result.qa_item}] ${result.name}: FAILED`);
        console.log(`      Error: ${result.error}\n`);
      }
    }
    if (!report.valid) {
      console.log(`❌ GATE D EVIDENCE VALIDATION FAILED (${report.failed.length} findings)`);
      process.exit(1);
    }
    console.log("✓ ALL GATE D STAGING EVIDENCE VERIFIED SUCCESSFULLY");
  } catch (error) {
    console.error(`❌ Validation Error: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runCli();
