import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { certifyGateFMigrations } from "./certify-gate-f-migrations.mjs";
import { runGateFRollbackDrill } from "./run-gate-f-rollback-drill.mjs";
import { runGateFBackupRestoreAudit } from "./run-gate-f-backup-restore-audit.mjs";
import { runGateFCachePurgeAudit } from "./run-gate-f-cache-purge.mjs";
import { runGateFOpsAudit } from "./run-gate-f-ops-audit.mjs";
import { runGateFRecertifications } from "./run-gate-f-recertifications.mjs";
import { runGateFProductionSimulation } from "./run-gate-f-production-simulation.mjs";

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

test("runGateFRollbackDrill verifies automated rollback steps", async () => {
  await withArtifacts(async (artifactsDir) => {
    const res = await runGateFRollbackDrill(SHA, { artifactsDir });
    assert.equal(res.verdict, "PASS");
    assert.equal(res.scoring_availability, "PRESERVED");
  });
});

test("runGateFBackupRestoreAudit verifies RTO/RPO budgets", async () => {
  await withArtifacts(async (artifactsDir) => {
    const res = await runGateFBackupRestoreAudit(SHA, { artifactsDir });
    assert.equal(res.verdict, "PASS");
    assert.ok(res.measured_rto_seconds <= 60);
  });
});

test("runGateFProductionSimulation executes all components", async () => {
  await withArtifacts(async (artifactsDir) => {
    const res = await runGateFProductionSimulation(SHA, { artifactsDir });
    assert.equal(res.verdict, "PASS");
    assert.equal(res.components.migration_expand_contract, "PASS");
    assert.equal(res.components.zero_downtime_rollback, "PASS");
    assert.equal(res.components.backup_restore, "PASS");
  });
});
