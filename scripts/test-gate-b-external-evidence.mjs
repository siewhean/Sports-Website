#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = process.cwd();
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const migrations = (await readdir(path.join(root, "packages/database/migrations")))
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
  .sort();
const latestMigration = migrations.at(-1);
if (!latestMigration) throw new Error("Expected at least one migration for the external evidence self-test");
const collectedAt = new Date().toISOString();
const reviewerA = "a".repeat(64);
const reviewerB = "b".repeat(64);
const fingerprint = "c".repeat(64);

function common(provider) {
  return { schema_version: 1, commit, environment: "staging", provider, collected_at: collectedAt };
}

function receipt(id) {
  return { passed: true, receipt_id: id };
}

function bundle() {
  return {
    "oidc.json": {
      ...common("synthetic-oidc"),
      issuer: "https://identity.example.test",
      authorization_code_pkce: receipt("oidc-code"),
      hosted_recovery_delivery: receipt("oidc-recovery"),
      password_change_revocation: receipt("oidc-password"),
      sid_revocation: receipt("oidc-sid"),
      signed_event_verified: receipt("oidc-signed"),
      event_replay_rejected: receipt("oidc-replay"),
    },
    "cdn.json": {
      ...common("synthetic-cdn"),
      public_url: "https://matchday.example.test",
      tls_valid: true,
      brotli: true,
      first_cache_status: "MISS",
      second_cache_status: "HIT",
      private_response_bypassed_shared_cache: true,
      avif_negotiated: true,
      webp_negotiated: true,
      purge: { passed: true, receipt_id: "cdn-purge", published_version: 2, purged_at: collectedAt },
    },
    "telemetry.json": {
      ...common("synthetic-telemetry"),
      trace_exported: { passed: true, receipt_id: "trace-receipt", trace_id: "d".repeat(32) },
      error_captured: receipt("error-receipt"),
      alert_delivered: receipt("alert-receipt"),
      request_correlation_verified: receipt("correlation-receipt"),
    },
    "restore.json": {
      ...common("synthetic-database"),
      backup_id: "backup-1",
      backup_created_at: collectedAt,
      encrypted: true,
      retention_days: 14,
      source_region: "region-a",
      restore_region: "region-b",
      restore_completed_at: collectedAt,
      source_row_count: 42,
      restored_row_count: 42,
      source_fingerprint: fingerprint,
      restored_fingerprint: fingerprint,
      migration_head: latestMigration,
      rpo_minutes: 5,
      rto_minutes: 12,
      receipt_id: "restore-receipt",
    },
    "organisers.json": {
      ...common("synthetic-attestation"),
      reviews: [
        {
          reviewer_id_hash: reviewerA,
          scope: "local",
          organisation_type: "independent organiser",
          reviewed_at: collectedAt,
          attestation_id: "organiser-local",
          tasks: {
            assisted_setup: true,
            format_selection: true,
            schedule_generation: true,
            lock_or_move: true,
            publication: true,
          },
          blocking_findings: [],
          verdict: "PASS",
        },
        {
          reviewer_id_hash: reviewerB,
          scope: "national",
          organisation_type: "national governing body",
          reviewed_at: collectedAt,
          attestation_id: "organiser-national",
          tasks: {
            assisted_setup: true,
            format_selection: true,
            schedule_generation: true,
            lock_or_move: true,
            publication: true,
          },
          blocking_findings: [],
          verdict: "PASS",
        },
      ],
    },
  };
}

async function writeBundle(directory, values) {
  await mkdir(directory, { recursive: true });
  await Promise.all(
    Object.entries(values).map(([file, value]) => writeFile(path.join(directory, file), `${JSON.stringify(value, null, 2)}\n`)),
  );
}

async function run(directory, summaryDirectory) {
  try {
    const result = await exec("node", ["scripts/verify-gate-b-external-evidence.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        GATE_B_EXTERNAL_EVIDENCE_DIR: directory,
        GATE_B_EXTERNAL_SUMMARY_DIR: summaryDirectory,
      },
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: Number(error.code) || 1,
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || ""),
    };
  }
}

const temporary = await mkdtemp(path.join(os.tmpdir(), "matchday-gate-b-external-self-test-"));
try {
  const validDirectory = path.join(temporary, "valid");
  const validSummary = path.join(temporary, "valid-summary");
  await writeBundle(validDirectory, bundle());
  const valid = await run(validDirectory, validSummary);
  assert.equal(valid.exitCode, 0, valid.stderr);
  assert.match(valid.stdout, /verdict: PASS/i);
  const summary = JSON.parse(await readFile(path.join(validSummary, "summary.json"), "utf8"));
  assert.equal(summary.verdict, "PASS");
  assert.equal(summary.migration_head, latestMigration);
  assert.equal(summary.evidence.length, 5);

  const wrongCommitDirectory = path.join(temporary, "wrong-commit");
  const wrongCommit = bundle();
  wrongCommit["cdn.json"].commit = "0".repeat(40);
  await writeBundle(wrongCommitDirectory, wrongCommit);
  const rejectedCommit = await run(wrongCommitDirectory, path.join(temporary, "wrong-summary"));
  assert.notEqual(rejectedCommit.exitCode, 0);
  assert.match(rejectedCommit.stderr, /evidence commit must equal/i);

  const secretDirectory = path.join(temporary, "secret");
  const secret = bundle();
  secret["telemetry.json"].api_token = "forbidden-value";
  await writeBundle(secretDirectory, secret);
  const rejectedSecret = await run(secretDirectory, path.join(temporary, "secret-summary"));
  assert.notEqual(rejectedSecret.exitCode, 0);
  assert.match(rejectedSecret.stderr, /secret-bearing fields are forbidden|unexpected or missing fields/i);

  const futureDirectory = path.join(temporary, "future");
  const future = bundle();
  future["cdn.json"].purge.purged_at = new Date(Date.now() + 60 * 60_000).toISOString();
  await writeBundle(futureDirectory, future);
  const rejectedFuture = await run(futureDirectory, path.join(temporary, "future-summary"));
  assert.notEqual(rejectedFuture.exitCode, 0);
  assert.match(rejectedFuture.stderr, /unexpectedly in the future|cannot be later than evidence collection/i);

  process.stdout.write("Gate B external evidence self-test passed.\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
