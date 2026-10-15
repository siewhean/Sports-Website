import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { certifyGateFMigrations } from "./certify-gate-f-migrations.mjs";
import { runGateFRollbackDrill } from "./run-gate-f-rollback-drill.mjs";
import { runGateFBackupRestoreAudit } from "./run-gate-f-backup-restore-audit.mjs";
import { runGateFCachePurgeAudit } from "./run-gate-f-cache-purge.mjs";
import { runGateFOpsAudit } from "./run-gate-f-ops-audit.mjs";
import { runGateFRecertifications } from "./run-gate-f-recertifications.mjs";
import { runGateFProductionSimulation } from "./run-gate-f-production-simulation.mjs";
import { runGateFDrills } from "./run-gate-f-drills.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

async function withArtifacts(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "matchday-gate-f-test-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("certifyGateFMigrations verifies expand-contract compliance", async () => {
  await withArtifacts(async (artifactsDir) => {
    const res = await certifyGateFMigrations(SHA, { artifactsDir });
    assert.equal(res.verdict, "PASS");
    assert.equal(res.expand_contract_compliant, true);
  });
});

test("runGateFRollbackDrill stays PENDING without external evidence and does not report fake execution", async () => {
  await withArtifacts(async (artifactsDir) => {
    const res = await runGateFRollbackDrill(SHA, { artifactsDir });
    assert.equal(res.verdict, "PENDING");
    assert.equal(res.drill_executed, false);
    assert.equal(res.simulation_result, "NOT_EXECUTED_PENDING_PRODUCTION_DRILL");
    assert.equal(res.scoring_availability, "UNTESTED_PENDING_PRODUCTION_RUN");
  });
});

// Temporary unit fixtures exercise validation only; they are not production receipts.
async function productionFixture(artifactsDir) {
  const now = Date.now();
  const at = (minutesBefore) => new Date(now - minutesBefore * 60000).toISOString();
  const files = [];
  for (const kind of ["backup_artifact", "storage", "restore", "integrity", "authorization", "recovery"]) {
    const bytes = Buffer.from(`unit fixture ${kind}`);
    await writeFile(path.join(artifactsDir, `${kind}.receipt`), bytes);
    files.push({
      kind,
      path: `${kind}.receipt`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      captured_at: at(1),
    });
  }
  const evidence = {
    schema_version: "production-backup-v1",
    evidence_class: "production_operator_capture",
    candidate_sha: SHA,
    operator: { identity: "designated-operator", owner: "infrastructure-owner" },
    authorization: { scope: "backup_and_isolated_restore_only", reference: "owner-authorization-reference" },
    source: {
      environment: "production",
      database_id: "production-db-identity",
      host_id: "production-host-identity",
      deployed_sha: "a".repeat(40),
      observed_at: at(8),
    },
    backup: {
      id: "backup-identity",
      size_bytes: Buffer.byteLength("unit fixture backup_artifact"),
      sha256: files[0].sha256,
      format: "pg_dump_custom",
      postgresql_version: "18.4",
      created_at: at(6),
      recovered_through_at: at(7),
      storage: {
        class: "offhost_encrypted_object",
        reference: "storage-reference",
        off_host: true,
        encrypted: true,
        encryption_reference: "key-reference",
        access_control_reference: "restricted-policy-reference",
        retention_days: 7,
        retention_reference: "retention-policy-reference",
      },
    },
    restore: {
      source_backup_id: "backup-identity",
      source_backup_sha256: files[0].sha256,
      checksum_verified: true,
      isolated: true,
      environment: "isolated_restore",
      database_id: "isolated-db-identity",
      host_id: "isolated-host-identity",
      started_at: at(5),
      completed_at: at(3),
      integrity: {
        restore_completed: "PASS",
        migration_ledger: "PASS",
        schema: "PASS",
        constraints: "PASS",
        representative_reads: "PASS",
        application_schema_compatible: "PASS",
        source_fingerprint_sha256: "b".repeat(64),
        restore_fingerprint_sha256: "b".repeat(64),
        snapshot_reference: "consistent-snapshot-reference",
      },
    },
    recovery: {
      measured_rto_seconds: 120,
      measured_rpo_seconds: 60,
      measurement_reference: "recovery-capture-reference",
    },
    captured_at: at(1),
    evidence_files: files,
  };
  const evidenceFile = path.join(artifactsDir, "production-evidence.json");
  await writeFile(evidenceFile, JSON.stringify(evidence));
  return { evidence, evidenceFile };
}

test("backup audit without evidence stays pending and removes stale synthetic DR PASS", async () => {
  await withArtifacts(async (artifactsDir) => {
    await writeFile(path.join(artifactsDir, "gate-f-disaster-recovery.json"), '{"verdict":"PASS"}');
    const receipt = await runGateFBackupRestoreAudit(SHA, { artifactsDir });
    assert.equal(receipt.verdict, "PENDING");
    assert.equal(receipt.measured_rto_seconds, undefined);
    assert.equal(
      JSON.parse(await readFile(path.join(artifactsDir, "gate-f-disaster-recovery.json"))).verdict,
      "PENDING",
    );
  });
});

test("backup audit rejects missing production fields and legacy synthetic defaults", async () => {
  await withArtifacts(async (artifactsDir) => {
    const { evidence, evidenceFile } = await productionFixture(artifactsDir);
    delete evidence.operator;
    await writeFile(evidenceFile, JSON.stringify(evidence));
    assert.equal((await runGateFBackupRestoreAudit(SHA, { artifactsDir, evidenceFile })).verdict, "PENDING");
    await writeFile(
      evidenceFile,
      JSON.stringify({
        candidate_sha: SHA,
        backup_schedule: "daily_full_plus_15m_wal",
        encrypted_at_rest: true,
        verdict: "PASS",
        measured_rto_seconds: 45,
      }),
    );
    assert.equal((await runGateFBackupRestoreAudit(SHA, { artifactsDir, evidenceFile })).verdict, "PENDING");
  });
});

test("backup audit validates exact independent evidence references without inventing DR proof", async () => {
  await withArtifacts(async (artifactsDir) => {
    const { evidenceFile } = await productionFixture(artifactsDir);
    const receipt = await runGateFBackupRestoreAudit(SHA, { artifactsDir, evidenceFile });
    assert.equal(receipt.verdict, "PASS");
    assert.equal(receipt.verified_evidence_files.length, 6);
    assert.equal(receipt.observations.source.deployed_sha, "a".repeat(40));
    assert.notEqual(receipt.observations.source.deployed_sha, receipt.candidate_sha);
    assert.equal(
      JSON.parse(await readFile(path.join(artifactsDir, "gate-f-disaster-recovery.json"))).verdict,
      "PENDING",
    );
  });
});

test("backup audit rejects tampered files, checksum, failed restore, SHA drift and invalid chronology", async () => {
  for (const mutate of [
    (e) => {
      e.backup.created_at = new Date(Date.now() - 48 * 3600000).toISOString();
    },
    (e) => {
      e.backup.sha256 = "invalid";
    },
    (e) => {
      e.restore.integrity.constraints = "FAIL";
    },
    (e) => {
      e.candidate_sha = "a".repeat(40);
    },
    (e) => {
      e.restore.completed_at = e.restore.started_at;
    },
    (e) => {
      e.backup.size_bytes += 1;
    },
    (e) => {
      e.restore.integrity.restore_fingerprint_sha256 = "c".repeat(64);
    },
    (e) => {
      e.restore.source_backup_id = "different-backup";
    },
    (e) => {
      e.backup.storage.encrypted = false;
    },
    (e) => {
      e.evidence_files[1].sha256 = "c".repeat(64);
    },
    (e) => {
      e.recovery.measured_rto_seconds = 45;
    },
    (e) => {
      e.restore.database_id = e.source.database_id;
    },
  ]) {
    await withArtifacts(async (artifactsDir) => {
      const { evidence, evidenceFile } = await productionFixture(artifactsDir);
      mutate(evidence);
      await writeFile(evidenceFile, JSON.stringify(evidence));
      assert.equal((await runGateFBackupRestoreAudit(SHA, { artifactsDir, evidenceFile })).verdict, "PENDING");
    });
  }
});

test("backup audit rejects local, test and simulation provenance", async () => {
  for (const mutate of [
    (e) => {
      e.evidence_class = "simulation";
    },
    (e) => {
      e.source.environment = "test";
    },
    (e) => {
      e.synthetic = true;
    },
    (e) => {
      e.source.database_id = "matchday_backup_test_123_456_789";
    },
    (e) => {
      e.source.host_id = "127.0.0.1";
    },
    (e) => {
      e.restore.environment = "production";
    },
  ]) {
    await withArtifacts(async (artifactsDir) => {
      const { evidence, evidenceFile } = await productionFixture(artifactsDir);
      mutate(evidence);
      await writeFile(evidenceFile, JSON.stringify(evidence));
      assert.equal((await runGateFBackupRestoreAudit(SHA, { artifactsDir, evidenceFile })).verdict, "PENDING");
    });
  }
});

test("malformed or unreadable evidence never passes", async () => {
  await withArtifacts(async (artifactsDir) => {
    const evidenceFile = path.join(artifactsDir, "missing.json");
    assert.equal((await runGateFBackupRestoreAudit(SHA, { artifactsDir, evidenceFile })).verdict, "PENDING");
    await writeFile(evidenceFile, "not-json");
    assert.equal((await runGateFBackupRestoreAudit(SHA, { artifactsDir, evidenceFile })).verdict, "PENDING");
  });
});

test("runGateFProductionSimulation executes all components", async () => {
  await withArtifacts(async (artifactsDir) => {
    const res = await runGateFProductionSimulation(SHA, { artifactsDir });
    assert.equal(res.verdict, "PENDING");
    assert.equal(res.production_certification, false);
    assert.equal(res.components.migration_expand_contract, "PASS");
    assert.equal(res.components.zero_downtime_rollback, "PENDING");
    assert.equal(res.components.backup_restore, "PENDING");
  });
});

test("local aggregate never certifies production even with valid backup input", async () => {
  await withArtifacts(async (artifactsDir) => {
    const { evidenceFile } = await productionFixture(artifactsDir);
    const receipt = await runGateFProductionSimulation(SHA, { artifactsDir, backupEvidenceFile: evidenceFile });
    assert.equal(receipt.components.backup_restore, "PASS");
    assert.equal(receipt.verdict, "PENDING");
    assert.equal(receipt.production_certification, false);
  });
});

test("backup audit rejects symlink and hard-link aliases of the same physical evidence", async () => {
  for (const alias of [symlink, link]) {
    await withArtifacts(async (artifactsDir) => {
      const { evidence, evidenceFile } = await productionFixture(artifactsDir);
      const original = evidence.evidence_files.find((file) => file.kind === "storage");
      const reused = evidence.evidence_files.find((file) => file.kind === "restore");
      await alias(path.join(artifactsDir, original.path), path.join(artifactsDir, "aliased-capture"));
      reused.path = "aliased-capture";
      reused.sha256 = original.sha256;
      await writeFile(evidenceFile, JSON.stringify(evidence));
      const receipt = await runGateFBackupRestoreAudit(SHA, { artifactsDir, evidenceFile });
      assert.equal(receipt.verdict, "PENDING");
      assert.ok(receipt.pending_reasons.includes("distinct_physical_evidence_file.restore"));
    });
  }
});

test("cache purge audit returns PENDING without external evidence and validates external provider receipts", async () => {
  await withArtifacts(async (artifactsDir) => {
    const unverified = await runGateFCachePurgeAudit(SHA, { artifactsDir });
    assert.equal(unverified.verdict, "PENDING");
    assert.equal(unverified.protocol_verification, "NOT_EXECUTED");

    const validEvidence = {
      schema_version: "2026.09.edge-purge-v1",
      evidence_class: "PROVIDER_RECEIPT",
      candidate_sha: SHA,
      environment: "production",
      observed_at: new Date().toISOString(),
      provider: "fastly_or_cloudflare",
      purge_id: "purge_12345",
      purge_scope: "surrogate_keys",
      purge_result: "SUCCESS",
    };
    const evidenceFile = path.join(artifactsDir, "purge-evidence.json");
    await writeFile(evidenceFile, JSON.stringify(validEvidence));

    const verified = await runGateFCachePurgeAudit(SHA, { artifactsDir, evidenceFile });
    assert.equal(verified.verdict, "PASS");
    assert.equal(verified.protocol_verification, "VERIFIED");
  });
});

test("ops audit returns PENDING for SLO, alert routing, cost controls and PENDING_IMPLEMENTATION for feature flags", async () => {
  await withArtifacts(async (artifactsDir) => {
    const res = await runGateFOpsAudit(SHA, { artifactsDir });
    assert.equal(res.sloBaseline.verdict, "PENDING");
    assert.equal(res.sloBaseline.protocol_verification, "NOT_EXECUTED");
    assert.equal(res.alertRouting.verdict, "PENDING");
    assert.equal(res.alertRouting.protocol_verification, "NOT_EXECUTED");
    assert.equal(res.costControls.verdict, "PENDING");
    assert.equal(res.costControls.protocol_verification, "NOT_EXECUTED");
    assert.equal(res.featureFlags.verdict, "PENDING_IMPLEMENTATION");
    assert.equal(res.featureFlags.admin_ui_present, false);
  });
});

test("recertifications audit returns PENDING for DNS/TLS, SEO, Email when external evidence is absent", async () => {
  await withArtifacts(async (artifactsDir) => {
    const res = await runGateFRecertifications(SHA, { artifactsDir });
    assert.equal(res.dnsTls.verdict, "PENDING");
    assert.equal(res.seo.verdict, "PENDING");
    assert.equal(res.email.verdict, "PENDING");
    assert.equal(res.security.verdict, "NOT_EXECUTED");
    assert.equal(res.security.dependency_audit, "NOT_EXECUTED");
    assert.equal(res.security.secret_scan, "NOT_EXECUTED");
    assert.equal(res.a11y.verdict, "NOT_EXECUTED");
    assert.equal(res.a11y.automated_axe_playwright, "NOT_EXECUTED");
    assert.equal(res.a11y.reduced_motion_contract, "NOT_EXECUTED");
    assert.equal(res.a11y.high_contrast_contract, "NOT_EXECUTED");
    assert.equal(res.legal.verdict, "PASS_TECHNICAL_PACKAGE_WITH_DEFERMENT");
  });
});

test("evidence validator rejects synthetic markers, wrong SHA, wrong env, and stale timestamps", async () => {
  await withArtifacts(async (artifactsDir) => {
    // 1. Synthetic marker
    const syntheticEvidence = {
      schema_version: "v1",
      evidence_class: "PROVIDER_RECEIPT",
      candidate_sha: SHA,
      environment: "production",
      observed_at: new Date().toISOString(),
      synthetic: true,
    };
    const synFile = path.join(artifactsDir, "syn.json");
    await writeFile(synFile, JSON.stringify(syntheticEvidence));
    const synResult = await runGateFCachePurgeAudit(SHA, { artifactsDir, evidenceFile: synFile });
    assert.equal(synResult.verdict, "PENDING");

    // 2. Wrong SHA
    const wrongShaEvidence = {
      schema_version: "v1",
      evidence_class: "PROVIDER_RECEIPT",
      candidate_sha: "a".repeat(40),
      environment: "production",
      observed_at: new Date().toISOString(),
    };
    const shaFile = path.join(artifactsDir, "wrong-sha.json");
    await writeFile(shaFile, JSON.stringify(wrongShaEvidence));
    const shaResult = await runGateFCachePurgeAudit(SHA, { artifactsDir, evidenceFile: shaFile });
    assert.equal(shaResult.verdict, "PENDING");

    // 3. Staging/non-production environment
    const stagingEvidence = {
      schema_version: "v1",
      evidence_class: "PROVIDER_RECEIPT",
      candidate_sha: SHA,
      environment: "staging",
      observed_at: new Date().toISOString(),
    };
    const stgFile = path.join(artifactsDir, "staging.json");
    await writeFile(stgFile, JSON.stringify(stagingEvidence));
    const stgResult = await runGateFCachePurgeAudit(SHA, { artifactsDir, evidenceFile: stgFile });
    assert.equal(stgResult.verdict, "PENDING");

    // 4. Stale timestamp (older than 24 hours)
    const staleEvidence = {
      schema_version: "v1",
      evidence_class: "PROVIDER_RECEIPT",
      candidate_sha: SHA,
      environment: "production",
      observed_at: "2020-01-01T00:00:00.000Z",
    };
    const staleFile = path.join(artifactsDir, "stale.json");
    await writeFile(staleFile, JSON.stringify(staleEvidence));
    const staleResult = await runGateFCachePurgeAudit(SHA, { artifactsDir, evidenceFile: staleFile });
    assert.equal(staleResult.verdict, "PENDING");
  });
});

test("runGateFDrills derives dynamic verdict and preserves audit integrity without external evidence", async () => {
  const result = await runGateFDrills(SHA);
  assert.equal(result.verdict, "CONFIG_AND_CONTRACT_AUDIT_PASS_PRODUCTION_DRILLS_PENDING");
  assert.equal(result.drills.zero_downtime_rollback.drill_executed, false);
  assert.equal(result.drills.zero_downtime_rollback.verdict, "PENDING");
  assert.equal(result.drills.backup_restore.verdict, "PENDING");
  assert.equal(result.drills.edge_cache_purge.verdict, "PENDING");
  assert.equal(result.status_summary.zero_downtime_rollback, "NOT_EXECUTED_PENDING_PRODUCTION_RUN");
  assert.equal(result.status_summary.edge_cache_purge, "CONFIG_AUDIT_ONLY_PURGE_NOT_EXECUTED");
  assert.equal(typeof result.content_fingerprint_sha256, "string");
  assert.equal(result.content_fingerprint_sha256.length, 64);
});

test("runGateFDrills rejects malformed candidate SHA", async () => {
  await assert.rejects(
    async () => runGateFDrills("invalid-sha"),
    /Gate F drills require an exact 40-character candidate SHA/,
  );
});

test("runGateFDrills produces FAIL overall verdict when any drill reports FAIL", async () => {
  await withArtifacts(async (artifactsDir) => {
    const failedRollbackEvidence = {
      schema_version: "2026.09.rollback-drill-v1",
      evidence_class: "PROVIDER_RECEIPT",
      candidate_sha: SHA,
      environment: "production",
      observed_at: new Date().toISOString(),
      rollback_drill_id: "drill-failed-123",
      simulated_or_observed_result: "FAIL",
      scoring_availability: "COMPROMISED",
    };
    const evidenceFile = path.join(artifactsDir, "rollback-fail.json");
    await writeFile(evidenceFile, JSON.stringify(failedRollbackEvidence));

    const result = await runGateFDrills(SHA, { rollbackEvidenceFile: evidenceFile });
    assert.equal(result.drills.zero_downtime_rollback.verdict, "FAIL");
    assert.equal(result.status_summary.zero_downtime_rollback, "FAIL");
    assert.equal(result.verdict, "FAIL");
  });
});
