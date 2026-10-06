#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, realpath } from "node:fs/promises";
import path from "node:path";

export const DIGEST_PATTERN = /^[0-9a-f]{64}$/i;
export const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export const NON_PRODUCTION_MARKERS = ["synthetic", "simulated", "test_only"];
export const NON_PRODUCTION_ENVIRONMENTS = ["test", "local", "simulation", "synthetic", "staging"];

export const ALLOWED_EVIDENCE_CLASSES = [
  "SOURCE_STATIC",
  "LOCAL_EXECUTABLE",
  "HOSTED_CI",
  "PRODUCTION_LIVE_PROBE",
  "PROVIDER_RECEIPT",
  "OPERATOR_CAPTURE",
  "HUMAN_ONLY",
  "PHYSICAL_ONLY",
  "LEGAL_DEFERRED",
];

export function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function isValidUtcTimestamp(value) {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const iso = new Date(parsed).toISOString();
  return value.includes(".") ? iso === value : iso === value.replace("Z", ".000Z");
}

export function containsNonProductionMarker(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, entry]) => {
    if (NON_PRODUCTION_MARKERS.includes(key) && entry === true) return true;
    if (
      ["environment", "execution_mode", "evidence_class"].includes(key) &&
      typeof entry === "string" &&
      NON_PRODUCTION_ENVIRONMENTS.includes(entry.toLowerCase())
    ) {
      return true;
    }
    return containsNonProductionMarker(entry);
  });
}

export function sanitizeError(err) {
  if (!err) return "";
  const msg = typeof err === "string" ? err : err.message || String(err);
  // Redact potential secret leaks (API keys, authorization bearer, tokens, passwords)
  return msg
    .replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(password\s*[:=]\s*)[^\s,]+/gi, "$1[REDACTED]")
    .replace(/(token\s*[:=]\s*)[^\s,]+/gi, "$1[REDACTED]")
    .replace(/(secret\s*[:=]\s*)[^\s,]+/gi, "$1[REDACTED]")
    .replace(/(key\s*[:=]\s*)[^\s,]+/gi, "$1[REDACTED]");
}

/**
 * Validates a production evidence payload against required rules.
 *
 * @param {object} evidence - Parsed evidence object
 * @param {string} candidateSha - Expected 40-character SHA
 * @param {string} evidenceFile - Absolute path to evidence file
 * @param {object} [options]
 * @param {string[]} [options.allowedEvidenceClasses] - Classes permitted for this check
 * @param {number} [options.maxEvidenceAgeMs] - Maximum age in ms
 * @param {boolean} [options.requireProductionEnvironment=true]
 * @param {string[]} [options.requiredFiles] - List of evidence_files kind names required
 */
export async function validateExternalEvidence(evidence, candidateSha, evidenceFile, options = {}) {
  const errors = [];
  const require = (condition, field) => {
    if (!condition) errors.push(field);
  };

  const e = evidence ?? {};
  const maxEvidenceAgeMs = options.maxEvidenceAgeMs ?? 24 * 60 * 60 * 1000;
  const requireProdEnv = options.requireProductionEnvironment ?? true;

  require(!containsNonProductionMarker(e), "nonproduction_or_synthetic_marker");

  if (!isNonEmptyString(e.schema_version)) {
    errors.push("schema_version_required");
  }

  // Evidence class check
  const evidenceClass = e.evidence_class;
  if (!isNonEmptyString(evidenceClass)) {
    errors.push("evidence_class_required");
  } else {
    const allowed = options.allowedEvidenceClasses ?? ALLOWED_EVIDENCE_CLASSES;
    require(allowed.includes(evidenceClass), "evidence_class_not_allowed");
  }

  // Candidate SHA binding
  if (!SHA_PATTERN.test(candidateSha ?? "")) {
    errors.push("invalid_expected_candidate_sha");
  } else {
    require(typeof e.candidate_sha === "string" &&
      e.candidate_sha.toLowerCase() === candidateSha.toLowerCase(), "candidate_sha_mismatch");
  }

  // Production environment check
  if (requireProdEnv) {
    const env = e.environment ?? e.source?.environment;
    require(env === "production", "production_environment_required");
    const host = e.source?.host_id ?? e.hostname ?? "";
    require(!/^(?:localhost|127\.|::1)/i.test(host), "not_local_host");
  }

  // Captured / observed timestamp checks
  const timestampField = e.observed_at ?? e.captured_at ?? e.generated_at;
  if (isNonEmptyString(timestampField)) {
    require(isValidUtcTimestamp(timestampField), "valid_utc_timestamp");
    if (isValidUtcTimestamp(timestampField)) {
      const parsed = Date.parse(timestampField);
      require(parsed <= Date.now(), "timestamp_not_in_future");
      require(Date.now() - parsed <= maxEvidenceAgeMs, "evidence_stale");
    }
  } else {
    errors.push("timestamp_required");
  }

  // File reference checks if present
  const verifiedFiles = [];
  if (Array.isArray(e.evidence_files) && e.evidence_files.length > 0) {
    const inputRealPath = await realpath(evidenceFile);
    const inputMetadata = await stat(inputRealPath, { bigint: true });
    const inputIdentity = `${inputMetadata.dev}:${inputMetadata.ino}`;
    const seenPaths = new Set();
    const seenIdentities = new Set();

    if (Array.isArray(options.requiredFiles)) {
      for (const requiredKind of options.requiredFiles) {
        const matches = e.evidence_files.filter((f) => f?.kind === requiredKind);
        require(matches.length === 1, `missing_required_evidence_file.${requiredKind}`);
      }
    }

    for (const file of e.evidence_files) {
      const kind = file?.kind ?? "unknown";
      if (
        !isNonEmptyString(file.path) ||
        !DIGEST_PATTERN.test(file.sha256 ?? "") ||
        !isValidUtcTimestamp(file.captured_at) ||
        Date.parse(file.captured_at) > Date.now()
      ) {
        errors.push(`invalid_evidence_file_metadata.${kind}`);
        continue;
      }

      const resolved = path.resolve(path.dirname(evidenceFile), file.path);
      require(resolved !== path.resolve(evidenceFile), `distinct_evidence_file.${kind}`);

      try {
        const actualPath = await realpath(resolved);
        const physicalMetadata = await stat(actualPath, { bigint: true });
        const identity = `${physicalMetadata.dev}:${physicalMetadata.ino}`;
        require(actualPath !== inputRealPath &&
          !seenPaths.has(actualPath) &&
          identity !== inputIdentity &&
          !seenIdentities.has(identity), `distinct_physical_evidence_file.${kind}`);
        seenPaths.add(actualPath);
        seenIdentities.add(identity);

        const metadata = await stat(actualPath);
        require(metadata.isFile() && metadata.size > 0, `nonempty_evidence_file.${kind}`);

        const hash = createHash("sha256");
        for await (const chunk of createReadStream(actualPath)) hash.update(chunk);
        const actual = hash.digest("hex");
        require(actual === file.sha256, `evidence_file_checksum_mismatch.${kind}`);
        verifiedFiles.push({ kind, reference: file.path, sha256: actual, captured_at: file.captured_at });
      } catch {
        errors.push(`evidence_file_unreadable.${kind}`);
      }
    }
  } else if (Array.isArray(options.requiredFiles) && options.requiredFiles.length > 0) {
    errors.push("evidence_files_missing");
  }

  return { errors, verifiedFiles };
}

/**
 * Loads and validates external evidence from a file path. Fails closed.
 */
export async function loadAndValidateEvidence(candidateSha, evidenceFile, options = {}) {
  if (!evidenceFile) {
    return {
      errors: ["external_evidence_not_supplied"],
      verifiedFiles: [],
      evidence: null,
      evidenceSha256: null,
    };
  }

  try {
    const raw = await readFile(evidenceFile);
    const evidenceSha256 = createHash("sha256").update(raw).digest("hex");
    const evidence = JSON.parse(raw.toString("utf8"));
    const validation = await validateExternalEvidence(evidence, candidateSha, evidenceFile, options);
    return {
      ...validation,
      evidence,
      evidenceSha256,
    };
  } catch (err) {
    return {
      errors: [`evidence_unreadable_or_malformed: ${sanitizeError(err)}`],
      verifiedFiles: [],
      evidence: null,
      evidenceSha256: null,
    };
  }
}
