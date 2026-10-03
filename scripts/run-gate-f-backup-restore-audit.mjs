#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digestPattern = /^[0-9a-f]{64}$/;
const shaPattern = /^[0-9a-f]{40}$/;
const text = (value) => typeof value === "string" && value.trim().length > 0;
function containsTestMarker(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, entry]) =>
      (["synthetic", "simulated", "test_only"].includes(key) && entry === true) ||
      (["environment", "execution_mode", "evidence_class"].includes(key) &&
        ["test", "local", "simulation", "synthetic", "staging"].includes(entry)) ||
      containsTestMarker(entry),
  );
}
const timestamp = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"));

async function validateEvidence(evidence, candidateSha, evidenceFile, maxEvidenceAgeMs) {
  const errors = [];
  const require = (condition, field) => {
    if (!condition) errors.push(field);
  };
  const e = evidence ?? {};
  require(!containsTestMarker(e), "nonproduction_or_synthetic_marker");
  require(!/^(?:localhost|127\.|::1)/.test(e.source?.host_id ?? "") &&
    !/^matchday_(?:backup|restore)_test_/.test(e.source?.database_id ?? ""), "not_local_disposable_source");
  require(e.schema_version === "production-backup-v1", "schema_version");
  require(e.evidence_class === "production_operator_capture" && e.synthetic !== true, "independent_production_capture");
  require(e.candidate_sha === candidateSha, "candidate_sha");
  require(text(e.operator?.identity) && text(e.operator?.owner), "operator");
  require(e.authorization?.scope === "backup_and_isolated_restore_only" &&
    text(e.authorization?.reference), "owner_authorization");
  require(e.source?.environment === "production" &&
    text(e.source?.database_id) &&
    text(e.source?.host_id) &&
    shaPattern.test(e.source?.deployed_sha ?? ""), "production_source");
  require(timestamp(e.source?.observed_at) &&
    Date.now() - Date.parse(e.source?.observed_at) <= maxEvidenceAgeMs, "source_observed_at");
  const b = e.backup ?? {};
  const r = e.restore ?? {};
  const storage = b.storage ?? {};
  require(text(b.id) &&
    Number.isSafeInteger(b.size_bytes) &&
    b.size_bytes > 0 &&
    digestPattern.test(b.sha256 ?? ""), "backup_identity_size_checksum");
  require(text(b.format) && text(b.postgresql_version), "backup_format_version");
  require(text(storage.class) && text(storage.reference) && storage.off_host === true, "off_host_storage");
  require(storage.encrypted === true &&
    text(storage.encryption_reference) &&
    text(storage.access_control_reference), "encrypted_restricted_storage");
  require(Number.isSafeInteger(storage.retention_days) &&
    storage.retention_days > 0 &&
    text(storage.retention_reference), "retention");
  require(r.source_backup_id === b.id &&
    r.source_backup_sha256 === b.sha256 &&
    r.checksum_verified === true, "restore_source_checksum");
  require(r.isolated === true &&
    ["isolated_restore", "nonproduction"].includes(r.environment) &&
    text(r.database_id) &&
    text(r.host_id) &&
    r.database_id !== e.source?.database_id &&
    r.host_id !== e.source?.host_id, "isolated_restore_target");
  const dates = [b.created_at, b.recovered_through_at, r.started_at, r.completed_at, e.captured_at];
  require(dates.every(timestamp), "UTC_timestamps");
  if (dates.every(timestamp)) {
    const [created, recovered, started, completed, captured] = dates.map(Date.parse);
    require(recovered <= created &&
      created <= started &&
      started < completed &&
      completed <= captured &&
      captured <= Date.now() &&
      Date.now() - created <= maxEvidenceAgeMs &&
      Date.parse(e.source?.observed_at) <= created, "timestamp_order");
    require(e.recovery?.measured_rto_seconds === (completed - started) / 1000 &&
      e.recovery?.measured_rpo_seconds === (created - recovered) / 1000, "measured_recovery_intervals");
  }
  const integrity = r.integrity ?? {};
  for (const key of [
    "restore_completed",
    "migration_ledger",
    "schema",
    "constraints",
    "representative_reads",
    "application_schema_compatible",
  ]) {
    require(integrity[key] === "PASS", `restore_integrity.${key}`);
  }
  require(digestPattern.test(integrity.source_fingerprint_sha256 ?? "") &&
    integrity.source_fingerprint_sha256 === integrity.restore_fingerprint_sha256 &&
    text(integrity.snapshot_reference), "snapshot_consistent_fingerprint");

  const files = Array.isArray(e.evidence_files) ? e.evidence_files : [];
  require(files.length > 0, "evidence_files");
  const kinds = ["backup_artifact", "storage", "restore", "integrity", "authorization", "recovery"];
  const verifiedFiles = [];
  const seenPaths = new Set();
  const seenIdentities = new Set();
  const inputRealPath = await realpath(evidenceFile);
  const inputMetadata = await stat(inputRealPath, { bigint: true });
  const inputIdentity = `${inputMetadata.dev}:${inputMetadata.ino}`;
  for (const kind of kinds) {
    const matches = files.filter((file) => file?.kind === kind);
    require(matches.length === 1, `evidence_file.${kind}`);
    if (matches.length !== 1) continue;
    const file = matches[0];
    if (
      !text(file.path) ||
      !digestPattern.test(file.sha256 ?? "") ||
      !timestamp(file.captured_at) ||
      Date.parse(file.captured_at) > Date.now() ||
      Date.parse(file.captured_at) > Date.parse(e.captured_at)
    ) {
      errors.push(`evidence_file_metadata.${kind}`);
      continue;
    }
    if (["backup_artifact", "restore", "integrity", "recovery"].includes(kind)) {
      require(Date.parse(file.captured_at) >=
        Date.parse(kind === "backup_artifact" ? b.created_at : r.completed_at), `evidence_capture_order.${kind}`);
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
      require(actual === file.sha256, `evidence_file_checksum.${kind}`);
      if (kind === "backup_artifact")
        require(actual === b.sha256 && metadata.size === b.size_bytes, "actual_backup_size_checksum");
      verifiedFiles.push({ kind, reference: file.path, sha256: actual, captured_at: file.captured_at });
    } catch {
      errors.push(`evidence_file_unreadable.${kind}`);
    }
  }
  require(text(e.recovery?.measurement_reference), "recovery_measurement_reference");
  return { errors, verifiedFiles };
}

export async function loadProductionBackupEvidence({
  candidateSha,
  evidenceFile,
  maxEvidenceAgeMs = 24 * 60 * 60 * 1000,
}) {
  if (!shaPattern.test(candidateSha ?? ""))
    throw new Error("Backup audit requires an exact lowercase 40-character candidate SHA");
  if (!Number.isSafeInteger(maxEvidenceAgeMs) || maxEvidenceAgeMs <= 0)
    throw new Error("Evidence freshness policy must be a positive integer duration");
  if (!evidenceFile) return { errors: ["production_evidence_not_supplied"], verifiedFiles: [] };
  try {
    const raw = await readFile(evidenceFile);
    const evidenceSha256 = createHash("sha256").update(raw).digest("hex");
    const evidence = JSON.parse(raw.toString("utf8"));
    const validation = await validateEvidence(evidence, candidateSha, evidenceFile, maxEvidenceAgeMs);
    return { ...validation, evidence, evidenceSha256 };
  } catch {
    return { errors: ["production_evidence_unreadable_or_malformed"], verifiedFiles: [] };
  }
}

export async function runGateFBackupRestoreAudit(candidateSha, options = {}) {
  const artifactsDir = options.artifactsDir ?? path.join(root, "artifacts");
  const evidenceFile = options.evidenceFile ? path.resolve(options.evidenceFile) : undefined;
  const validation = await loadProductionBackupEvidence({
    candidateSha,
    evidenceFile,
    maxEvidenceAgeMs: options.maxEvidenceAgeMs,
  });
  const { evidence, evidenceSha256 } = validation;
  const receipt = {
    qa_item: "OPS-011",
    candidate_sha: candidateSha,
    evidence_scope: "production_backup_and_isolated_restore",
    verdict: validation.errors.length === 0 ? "PASS" : "PENDING",
    pending_reasons: validation.errors,
    ...(evidenceSha256 ? { input_evidence_sha256: evidenceSha256, evidence_reference: evidenceFile } : {}),
    verified_evidence_files: validation.verifiedFiles,
    ...(validation.errors.length === 0 ? { observations: evidence } : {}),
    generated_at: new Date().toISOString(),
  };
  receipt.receipt_sha256 = createHash("sha256")
    .update(JSON.stringify(receipt, null, 2))
    .digest("hex");
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(path.join(artifactsDir, "gate-f-backup-restore.json"), JSON.stringify(receipt, null, 2));
  // A verified database backup is not proof of a cross-region disaster-recovery drill.
  await writeFile(
    path.join(artifactsDir, "gate-f-disaster-recovery.json"),
    JSON.stringify(
      {
        qa_item: "OPS-012",
        candidate_sha: candidateSha,
        verdict: "PENDING",
        pending_reasons: ["independent_disaster_recovery_evidence_required"],
        generated_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  return receipt;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runGateFBackupRestoreAudit(process.argv[2] ?? process.env.CANDIDATE_SHA, { evidenceFile: process.argv[3] })
    .then((receipt) => {
      console.log(`Gate F backup/restore: ${receipt.verdict}`);
      if (receipt.verdict !== "PASS") process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
