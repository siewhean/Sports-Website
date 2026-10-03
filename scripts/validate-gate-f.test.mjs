import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateGateF, REQUIRED_HOSTED_CI_JOBS, REQUIRED_WAIVERS } from "./validate-gate-f.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2));

async function withArtifacts(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "matchday-validate-gate-f-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// These fabricated local fixtures exercise the validator, never certify a real production backup.
async function certificateFixture(artifactsDir) {
  const now = Date.now();
  const at = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const files = [];
  for (const kind of ["backup_artifact", "storage", "restore", "integrity", "authorization", "recovery"]) {
    const contents = Buffer.from(`Gate F ${kind} validator fixture bytes`);
    await writeFile(path.join(artifactsDir, kind), contents);
    files.push({ kind, path: kind, sha256: digest(contents), captured_at: at(6) });
  }
  const backupBytes = Buffer.from("Gate F backup_artifact validator fixture bytes");
  const backupHash = digest(backupBytes);
  const evidence = {
    schema_version: "production-backup-v1",
    evidence_class: "production_operator_capture",
    candidate_sha: SHA,
    operator: { identity: "operator@example.invalid", owner: "Infrastructure owner" },
    authorization: { scope: "backup_and_isolated_restore_only", reference: "owner-approval-reference" },
    source: {
      environment: "production",
      database_id: "production-db",
      host_id: "production-host",
      deployed_sha: SHA,
      observed_at: at(10),
    },
    backup: {
      id: "backup-identifier",
      size_bytes: backupBytes.length,
      sha256: backupHash,
      format: "postgresql_custom",
      postgresql_version: "18.4",
      created_at: at(9),
      recovered_through_at: at(10),
      storage: {
        class: "object_storage",
        reference: "restricted-backup-object",
        off_host: true,
        encrypted: true,
        encryption_reference: "managed-key-reference",
        access_control_reference: "restricted-policy-reference",
        retention_days: 30,
        retention_reference: "retention-policy-reference",
      },
    },
    restore: {
      source_backup_id: "backup-identifier",
      source_backup_sha256: backupHash,
      checksum_verified: true,
      isolated: true,
      environment: "isolated_restore",
      database_id: "isolated-db",
      host_id: "isolated-host",
      started_at: at(8),
      completed_at: at(7),
      integrity: {
        restore_completed: "PASS",
        migration_ledger: "PASS",
        schema: "PASS",
        constraints: "PASS",
        representative_reads: "PASS",
        application_schema_compatible: "PASS",
        source_fingerprint_sha256: "b".repeat(64),
        restore_fingerprint_sha256: "b".repeat(64),
        snapshot_reference: "consistent-source-snapshot",
      },
    },
    recovery: {
      measured_rto_seconds: 60,
      measured_rpo_seconds: 60,
      measurement_reference: "recovery-observation-reference",
    },
    captured_at: at(6),
    evidence_files: files,
  };
  const evidenceFile = path.join(artifactsDir, "operator-backup.json");
  const cert = {
    schema_version: "2026.09.gate-f-production",
    gate: "F",
    assurance_profile: "automated-only-owner-waived-v2",
    candidate_sha: SHA,
    production_deployment: {
      hostname: "matchday.poladex.shop",
      deployed_sha: SHA,
      environment: "production",
      conclusion: "PASS",
    },
    hosted_ci: {
      run_id: 12345,
      head_sha: SHA,
      conclusion: "PASS",
      jobs: Object.fromEntries(REQUIRED_HOSTED_CI_JOBS.map((job) => [job, "PASS"])),
    },
    backup_restore: {
      conclusion: "PASS",
      evidence_reference: evidenceFile,
      evidence_sha256: "",
      production_operator_review: "PASS",
    },
    human_waivers: Object.fromEntries(REQUIRED_WAIVERS.map((waiver) => [waiver, "WAIVED_NOT_EXECUTED"])),
    legal_approval: "DEFERRED_TO_FIRST_COMMERCIAL_RELEASE",
  };
  const receipt = {
    candidate_sha: SHA,
    verdict: "PASS",
    evidence_scope: "production_backup_and_isolated_restore",
    input_evidence_sha256: "",
    evidence_reference: evidenceFile,
    generated_at: at(1),
  };
  async function persist() {
    const raw = JSON.stringify(evidence, null, 2);
    await writeFile(evidenceFile, raw);
    cert.backup_restore.evidence_sha256 = digest(raw);
    receipt.input_evidence_sha256 = digest(raw);
    delete receipt.receipt_sha256;
    receipt.receipt_sha256 = digest(JSON.stringify(receipt, null, 2));
    await writeJson(path.join(artifactsDir, "gate-f-certification.json"), cert);
    await writeJson(path.join(artifactsDir, "gate-f-backup-restore.json"), receipt);
    await writeJson(path.join(artifactsDir, "gate-f-production-simulation.json"), {
      candidate_sha: SHA,
      verdict: "PASS",
      receipt_sha256: "a".repeat(64),
    });
  }
  await persist();
  return { cert, receipt, evidence, evidenceFile, persist };
}

test("validateGateF accepts internally consistent backup evidence fixtures", async () => {
  await withArtifacts(async (artifactsDir) => {
    await certificateFixture(artifactsDir);
    const result = await validateGateF(SHA, { artifactsDir });
    assert.equal(result.valid, true);
    assert.equal(result.production_hostname, "matchday.poladex.shop");
  });
});

test("validateGateF rejects candidate SHA mismatch", async () => {
  await withArtifacts(async (artifactsDir) => {
    const fixture = await certificateFixture(artifactsDir);
    fixture.cert.candidate_sha = "f".repeat(40);
    await fixture.persist();
    await assert.rejects(validateGateF(SHA, { artifactsDir }), /mismatch/);
  });
});

for (const kind of [
  "missing declaration",
  "missing receipt",
  "missing evidence",
  "synthetic evidence",
  "local source",
  "stale receipt",
  "stale backup",
  "pending operator review",
  "failed CI",
  "missing waiver",
  "fake checksum",
  "stale candidate",
  "altered backup bytes",
]) {
  test(`validateGateF rejects ${kind} even when simulation claims PASS`, async () => {
    await withArtifacts(async (artifactsDir) => {
      const fixture = await certificateFixture(artifactsDir);
      if (kind === "missing declaration") delete fixture.cert.backup_restore;
      if (kind === "synthetic evidence") fixture.evidence.synthetic = true;
      if (kind === "local source") fixture.evidence.source.host_id = "127.0.0.1";
      if (kind === "stale receipt") fixture.receipt.generated_at = "2020-01-01T00:00:00.000Z";
      if (kind === "stale candidate") fixture.evidence.candidate_sha = "f".repeat(40);
      if (kind === "stale backup") {
        fixture.evidence.backup.created_at = "2020-01-01T00:00:00.000Z";
        fixture.evidence.backup.recovered_through_at = "2019-12-31T23:59:00.000Z";
        fixture.evidence.source.observed_at = "2019-12-31T23:59:00.000Z";
      }
      if (kind === "pending operator review") fixture.cert.backup_restore.production_operator_review = "PENDING";
      if (kind === "failed CI") fixture.cert.hosted_ci.jobs.integration = "FAIL";
      if (kind === "missing waiver") delete fixture.cert.human_waivers.independent_manual_pentest;
      if (kind !== "missing declaration") await fixture.persist();
      else await writeJson(path.join(artifactsDir, "gate-f-certification.json"), fixture.cert);
      if (kind === "missing receipt") await rm(path.join(artifactsDir, "gate-f-backup-restore.json"));
      if (kind === "missing evidence") await rm(fixture.evidenceFile);
      if (kind === "fake checksum") {
        fixture.receipt.receipt_sha256 = "c".repeat(64);
        await writeJson(path.join(artifactsDir, "gate-f-backup-restore.json"), fixture.receipt);
      }
      if (kind === "altered backup bytes")
        await writeFile(path.join(artifactsDir, "backup_artifact"), "tampered backup");
      await assert.rejects(validateGateF(SHA, { artifactsDir }));
    });
  });
}

for (const declaration of [
  { production_certification: false },
  { simulation_environment: "isolated_staging_simulation_stack" },
  { pending_reasons: ["simulation_is_not_production_certification"] },
]) {
  test(`validateGateF rejects simulation-only declaration ${JSON.stringify(declaration)} with valid backup evidence`, async () => {
    await withArtifacts(async (artifactsDir) => {
      await certificateFixture(artifactsDir);
      await writeJson(path.join(artifactsDir, "gate-f-production-simulation.json"), {
        candidate_sha: SHA,
        verdict: "PASS",
        receipt_sha256: "a".repeat(64),
        ...declaration,
      });
      await assert.rejects(validateGateF(SHA, { artifactsDir }), /Simulation-only evidence/);
    });
  });
}

test("validateGateF rejects certification declaring simulation-only evidence", async () => {
  await withArtifacts(async (artifactsDir) => {
    const fixture = await certificateFixture(artifactsDir);
    fixture.cert.simulation = { conclusion: "PASS", production_certification: false };
    await fixture.persist();
    await assert.rejects(validateGateF(SHA, { artifactsDir }), /Simulation-only evidence/);
  });
});
