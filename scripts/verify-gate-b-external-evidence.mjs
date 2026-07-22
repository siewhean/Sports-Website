#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const evidenceDirectory = path.resolve(
  root,
  process.env.GATE_B_EXTERNAL_EVIDENCE_DIR || "artifacts/qa/gate-b/external",
);
const outputDirectory = path.resolve(
  root,
  process.env.GATE_B_EXTERNAL_SUMMARY_DIR || "artifacts/qa/gate-b/external-validation",
);
const migrationsDirectory = path.resolve(root, "packages/database/migrations");
const maximumAgeDays = Number(process.env.GATE_B_EXTERNAL_MAX_AGE_DAYS || 30);
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const now = Date.now();
const futureToleranceMs = 5 * 60_000;
let latestMigration = "";

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function exactKeys(value, keys) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function iso(value) {
  return nonEmpty(value) && !Number.isNaN(Date.parse(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNotFuture(name, value, reference = now) {
  assert(iso(value), `${name}: must be ISO-8601`);
  assert(Date.parse(value) <= reference + futureToleranceMs, `${name}: is unexpectedly in the future`);
}

function assertFresh(name, value) {
  assertNotFuture(name, value);
  assert(now - Date.parse(value) <= maximumAgeDays * 86_400_000, `${name}: is older than ${maximumAgeDays} days`);
}

function assertCommon(name, evidence) {
  assert(evidence.schema_version === 1, `${name}: schema_version must be 1`);
  assert(evidence.commit === commit, `${name}: evidence commit must equal ${commit}`);
  assert(evidence.environment === "staging", `${name}: environment must be staging`);
  assert(nonEmpty(evidence.provider), `${name}: provider is required`);
  assertFresh(`${name}.collected_at`, evidence.collected_at);
}

function assertNoSecrets(value, location = "evidence") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${location}[${index}]`));
    return;
  }
  const item = record(value);
  if (item) {
    for (const [key, child] of Object.entries(item)) {
      assert(
        !/(?:password|secret|credential|cookie|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token)$/iu.test(
          key,
        ),
        `${location}.${key}: secret-bearing fields are forbidden`,
      );
      assertNoSecrets(child, `${location}.${key}`);
    }
    return;
  }
  if (typeof value === "string") {
    assert(!/^Bearer\s+/iu.test(value), `${location}: Bearer credentials are forbidden`);
    assert(!/https?:\/\/[^/\s:@]+:[^/\s@]+@/u.test(value), `${location}: URL credentials are forbidden`);
    assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value), `${location}: private keys are forbidden`);
  }
}

function passedReceipt(value, name) {
  const item = record(value);
  assert(item && exactKeys(item, ["passed", "receipt_id"]), `${name}: exact passed/receipt_id object required`);
  assert(item.passed === true, `${name}: passed must be true`);
  assert(nonEmpty(item.receipt_id), `${name}: receipt_id is required`);
}

function validateOidc(evidence) {
  assertCommon("oidc", evidence);
  assert(
    exactKeys(evidence, [
      "schema_version",
      "commit",
      "environment",
      "provider",
      "collected_at",
      "issuer",
      "authorization_code_pkce",
      "hosted_recovery_delivery",
      "password_change_revocation",
      "sid_revocation",
      "signed_event_verified",
      "event_replay_rejected",
    ]),
    "oidc: unexpected or missing fields",
  );
  const issuer = new URL(evidence.issuer);
  assert(issuer.protocol === "https:" && !issuer.username && !issuer.password, "oidc: issuer must be credential-free HTTPS");
  for (const field of [
    "authorization_code_pkce",
    "hosted_recovery_delivery",
    "password_change_revocation",
    "sid_revocation",
    "signed_event_verified",
    "event_replay_rejected",
  ]) {
    passedReceipt(evidence[field], `oidc.${field}`);
  }
}

function validateCdn(evidence) {
  assertCommon("cdn", evidence);
  assert(
    exactKeys(evidence, [
      "schema_version",
      "commit",
      "environment",
      "provider",
      "collected_at",
      "public_url",
      "tls_valid",
      "brotli",
      "first_cache_status",
      "second_cache_status",
      "private_response_bypassed_shared_cache",
      "avif_negotiated",
      "webp_negotiated",
      "purge",
    ]),
    "cdn: unexpected or missing fields",
  );
  const publicUrl = new URL(evidence.public_url);
  assert(publicUrl.protocol === "https:" && !publicUrl.username && !publicUrl.password, "cdn: public_url must be credential-free HTTPS");
  for (const field of [
    "tls_valid",
    "brotli",
    "private_response_bypassed_shared_cache",
    "avif_negotiated",
    "webp_negotiated",
  ]) {
    assert(evidence[field] === true, `cdn.${field}: must be true`);
  }
  assert(evidence.first_cache_status === "MISS", "cdn.first_cache_status: must be MISS");
  assert(evidence.second_cache_status === "HIT", "cdn.second_cache_status: must be HIT");
  const purge = record(evidence.purge);
  assert(
    purge && exactKeys(purge, ["passed", "receipt_id", "published_version", "purged_at"]),
    "cdn.purge: exact passed/receipt_id/published_version/purged_at object required",
  );
  assert(purge.passed === true && nonEmpty(purge.receipt_id), "cdn.purge: successful receipt required");
  assert(Number.isSafeInteger(purge.published_version) && purge.published_version >= 1, "cdn.purge: published_version must be positive");
  assertFresh("cdn.purge.purged_at", purge.purged_at);
  assert(
    Date.parse(purge.purged_at) <= Date.parse(evidence.collected_at) + futureToleranceMs,
    "cdn.purge.purged_at: cannot be later than evidence collection",
  );
}

function validateTelemetry(evidence) {
  assertCommon("telemetry", evidence);
  assert(
    exactKeys(evidence, [
      "schema_version",
      "commit",
      "environment",
      "provider",
      "collected_at",
      "trace_exported",
      "error_captured",
      "alert_delivered",
      "request_correlation_verified",
    ]),
    "telemetry: unexpected or missing fields",
  );
  const trace = record(evidence.trace_exported);
  assert(
    trace && exactKeys(trace, ["passed", "receipt_id", "trace_id"]),
    "telemetry.trace_exported: exact receipt required",
  );
  assert(trace.passed === true && nonEmpty(trace.receipt_id), "telemetry.trace_exported: passed receipt required");
  assert(/^[0-9a-f]{32}$/u.test(String(trace.trace_id)), "telemetry.trace_exported: trace_id must be 32 lowercase hex characters");
  for (const field of ["error_captured", "alert_delivered", "request_correlation_verified"]) {
    passedReceipt(evidence[field], `telemetry.${field}`);
  }
}

function validateRestore(evidence) {
  assertCommon("restore", evidence);
  assert(
    exactKeys(evidence, [
      "schema_version",
      "commit",
      "environment",
      "provider",
      "collected_at",
      "backup_id",
      "backup_created_at",
      "encrypted",
      "retention_days",
      "source_region",
      "restore_region",
      "restore_completed_at",
      "source_row_count",
      "restored_row_count",
      "source_fingerprint",
      "restored_fingerprint",
      "migration_head",
      "rpo_minutes",
      "rto_minutes",
      "receipt_id",
    ]),
    "restore: unexpected or missing fields",
  );
  assert(nonEmpty(evidence.backup_id) && nonEmpty(evidence.receipt_id), "restore: backup_id and receipt_id are required");
  assertFresh("restore.backup_created_at", evidence.backup_created_at);
  assertFresh("restore.restore_completed_at", evidence.restore_completed_at);
  assert(
    Date.parse(evidence.backup_created_at) <= Date.parse(evidence.restore_completed_at),
    "restore: backup_created_at must not follow restore_completed_at",
  );
  assert(
    Date.parse(evidence.restore_completed_at) <= Date.parse(evidence.collected_at) + futureToleranceMs,
    "restore: restore_completed_at cannot be later than evidence collection",
  );
  assert(evidence.encrypted === true, "restore: encrypted must be true");
  assert(Number.isSafeInteger(evidence.retention_days) && evidence.retention_days >= 7, "restore: retention_days must be at least 7");
  assert(nonEmpty(evidence.source_region) && nonEmpty(evidence.restore_region), "restore: regions are required");
  assert(evidence.source_region !== evidence.restore_region, "restore: restore_region must be isolated from source_region");
  assert(Number.isSafeInteger(evidence.source_row_count) && evidence.source_row_count > 0, "restore: source_row_count must be positive");
  assert(evidence.restored_row_count === evidence.source_row_count, "restore: row counts differ");
  assert(/^[0-9a-f]{64}$/u.test(String(evidence.source_fingerprint)), "restore: source_fingerprint must be SHA-256");
  assert(evidence.restored_fingerprint === evidence.source_fingerprint, "restore: fingerprints differ");
  assert(evidence.migration_head === latestMigration, `restore: migration_head must equal ${latestMigration}`);
  assert(Number.isFinite(evidence.rpo_minutes) && evidence.rpo_minutes >= 0, "restore: rpo_minutes must be non-negative");
  assert(Number.isFinite(evidence.rto_minutes) && evidence.rto_minutes > 0, "restore: rto_minutes must be positive");
}

function validateOrganisers(evidence) {
  assertCommon("organisers", evidence);
  assert(
    exactKeys(evidence, [
      "schema_version",
      "commit",
      "environment",
      "provider",
      "collected_at",
      "reviews",
    ]),
    "organisers: unexpected or missing fields",
  );
  assert(Array.isArray(evidence.reviews) && evidence.reviews.length >= 2, "organisers: at least two reviews are required");
  const scopes = new Set();
  const reviewerIds = new Set();
  for (const [index, raw] of evidence.reviews.entries()) {
    const review = record(raw);
    const name = `organisers.reviews[${index}]`;
    assert(
      review &&
        exactKeys(review, [
          "reviewer_id_hash",
          "scope",
          "organisation_type",
          "reviewed_at",
          "attestation_id",
          "tasks",
          "blocking_findings",
          "verdict",
        ]),
      `${name}: unexpected or missing fields`,
    );
    assert(/^[0-9a-f]{64}$/u.test(String(review.reviewer_id_hash)), `${name}: reviewer_id_hash must be SHA-256`);
    assert(!reviewerIds.has(review.reviewer_id_hash), `${name}: reviewer must be unique`);
    reviewerIds.add(review.reviewer_id_hash);
    assert(review.scope === "local" || review.scope === "national", `${name}: scope must be local or national`);
    scopes.add(review.scope);
    assert(nonEmpty(review.organisation_type) && nonEmpty(review.attestation_id), `${name}: organisation_type and attestation_id required`);
    assertFresh(`${name}.reviewed_at`, review.reviewed_at);
    assert(
      Date.parse(review.reviewed_at) <= Date.parse(evidence.collected_at) + futureToleranceMs,
      `${name}: reviewed_at cannot be later than evidence collection`,
    );
    const tasks = record(review.tasks);
    assert(
      tasks && exactKeys(tasks, ["assisted_setup", "format_selection", "schedule_generation", "lock_or_move", "publication"]),
      `${name}.tasks: exact task set required`,
    );
    for (const [task, passed] of Object.entries(tasks)) assert(passed === true, `${name}.tasks.${task}: must pass`);
    assert(Array.isArray(review.blocking_findings) && review.blocking_findings.length === 0, `${name}: blocking_findings must be empty`);
    assert(review.verdict === "PASS", `${name}: verdict must be PASS`);
  }
  assert(scopes.has("local") && scopes.has("national"), "organisers: one local and one national review are required");
}

const specifications = [
  ["oidc.json", validateOidc],
  ["cdn.json", validateCdn],
  ["telemetry.json", validateTelemetry],
  ["restore.json", validateRestore],
  ["organisers.json", validateOrganisers],
];

async function main() {
  assert(Number.isFinite(maximumAgeDays) && maximumAgeDays >= 1, "GATE_B_EXTERNAL_MAX_AGE_DAYS must be at least 1");
  const migrations = (await readdir(migrationsDirectory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort();
  latestMigration = migrations.at(-1) || "";
  assert(nonEmpty(latestMigration), `No migrations found in ${migrationsDirectory}`);

  const results = [];
  for (const [fileName, validate] of specifications) {
    const filePath = path.join(evidenceDirectory, fileName);
    const source = await readFile(filePath, "utf8").catch(() => null);
    assert(source !== null, `${fileName}: evidence file is missing from ${evidenceDirectory}`);
    const evidence = JSON.parse(source);
    assertNoSecrets(evidence, fileName);
    validate(evidence);
    results.push({ file: fileName, sha256: sha256(source), collected_at: evidence.collected_at, provider: evidence.provider });
    process.stdout.write(`PASS ${fileName}\n`);
  }

  const summary = {
    schema_version: 1,
    commit,
    migration_head: latestMigration,
    validated_at: new Date().toISOString(),
    maximum_age_days: maximumAgeDays,
    verdict: "PASS",
    evidence: results,
  };
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  await writeFile(
    path.join(outputDirectory, "summary.md"),
    `# Gate B external evidence\n\n- Commit: \`${commit}\`\n- Migration head: \`${latestMigration}\`\n- Verdict: **PASS**\n- Validated: ${summary.validated_at}\n- Evidence files: ${results.length}\n\n${results.map((result) => `- \`${result.file}\`: ${result.provider}; ${result.collected_at}; SHA-256 \`${result.sha256}\``).join("\n")}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(`Gate B external evidence verdict: PASS\nEvidence: ${outputDirectory}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
