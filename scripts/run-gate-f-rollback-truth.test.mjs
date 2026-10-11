import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { runGateFRollbackDrill } from "./run-gate-f-rollback-drill.mjs";

const SHA = "a".repeat(40);
const PREVIOUS = "b".repeat(40);
const at = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();
async function inDirectory(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "rollback-truth-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
// Unit validation fixtures are not production certification evidence.
async function fixture(dir, mutate = () => {}) {
  const metadata = {
    schema_version: "1",
    evidence_class: "OPERATOR_CAPTURE",
    environment: "production",
    source: { host_id: "production-instance" },
    candidate_sha: SHA,
    captured_at: at(1),
  };
  const capture = {
    ...metadata,
    rollback_drill_id: "fixture-drill",
    observed_result: "PASS",
    scoring_availability: "PRESERVED",
    observed_steps: [
      { step: "baseline_health_check", status: "HEALTHY", active_version: SHA, observed_at: at(10) },
      { step: "canary_failure_injection", status: "DETECTED", injected_error: "HEALTH_TIMEOUT", observed_at: at(8) },
      {
        step: "automated_rollback_trigger",
        status: "COMPLETED",
        action: "RESTORE_PREVIOUS_REVISION",
        restored_version: PREVIOUS,
        observed_at: at(6),
      },
      { step: "post_rollback_health_check", status: "HEALTHY", active_version: PREVIOUS, observed_at: at(4) },
    ],
    scoring_checks: [
      { availability: "AVAILABLE", observed_at: at(11) },
      { availability: "AVAILABLE", observed_at: at(3) },
    ],
  };
  const envelope = {
    ...metadata,
    rollback_drill_id: "envelope-claim",
    simulated_or_observed_result: "PASS",
    scoring_availability: "PRESERVED",
  };
  mutate(capture, envelope);
  const raw = JSON.stringify(capture);
  await writeFile(path.join(dir, "capture.json"), raw);
  envelope.evidence_files ??= [
    {
      kind: "rollback_observations",
      path: "capture.json",
      sha256: createHash("sha256").update(raw).digest("hex"),
      captured_at: at(1),
    },
  ];
  const evidenceFile = path.join(dir, "envelope.json");
  await writeFile(evidenceFile, JSON.stringify(envelope));
  return { evidenceFile, capture };
}

test("missing production proof never invents observed health, scoring, or rollback duration", () =>
  inDirectory(async (dir) => {
    const result = await runGateFRollbackDrill(SHA, { artifactsDir: dir });
    assert.equal(result.verdict, "PENDING");
    assert.equal(result.scoring_availability, "UNKNOWN");
    assert.equal(result.simulation_result, "SIMULATION_PASS");
    assert.equal(result.simulation_scope, "SOURCE_SEQUENCE_ONLY");
    assert.ok(
      result.simulation_steps.every((step) => step.execution === "NOT_EXECUTED" && !step.status && !step.duration_ms),
    );
    assert.equal(result.production_observations, undefined);
  }));

test("summary-only envelope cannot certify rollback", () =>
  inDirectory(async (dir) => {
    const { evidenceFile } = await fixture(dir, (_, envelope) => {
      envelope.evidence_files = [];
    });
    const result = await runGateFRollbackDrill(SHA, { artifactsDir: dir, evidenceFile });
    assert.equal(result.verdict, "PENDING");
    assert.ok(result.pending_reasons.includes("evidence_files_missing"));
  }));

test("valid retained capture supplies the production observation fields", () =>
  inDirectory(async (dir) => {
    const { evidenceFile, capture } = await fixture(dir);
    const result = await runGateFRollbackDrill(SHA, { artifactsDir: dir, rollbackEvidenceFile: evidenceFile });
    assert.equal(result.verdict, "PASS");
    assert.deepEqual(result.production_observations, capture);
    assert.equal(result.verified_evidence_files.length, 1);
    assert.equal(result.scoring_availability, "PRESERVED");
  }));

for (const [name, mutate, error] of [
  [
    "wrong exact SHA",
    (c) => {
      c.candidate_sha = PREVIOUS;
    },
    "rollback_observations.candidate_sha_mismatch",
  ],
  [
    "simulation provenance",
    (c) => {
      c.simulated = true;
    },
    "rollback_observations.nonproduction_or_synthetic_marker",
  ],
  [
    "staging provenance",
    (c) => {
      c.environment = "staging";
    },
    "rollback_observations.production_environment_required",
  ],
  [
    "absent observed steps",
    (c) => {
      delete c.observed_steps;
    },
    "observed_steps_required",
  ],
  [
    "wrong restored revision",
    (c) => {
      c.observed_steps[3].active_version = SHA;
    },
    "restored_revision_health_required",
  ],
  [
    "missing scoring captures",
    (c) => {
      delete c.scoring_checks;
    },
    "observed_scoring_checks_required",
  ],
  [
    "failed actual observation despite passing envelope",
    (c) => {
      c.observed_result = "FAIL";
    },
    "observed_rollback_not_pass",
  ],
  [
    "future step",
    (c) => {
      c.observed_steps[3].observed_at = new Date(Date.now() + 60000).toISOString();
    },
    "observed_steps_order_or_timestamp_invalid",
  ],
  [
    "tampered retained capture",
    (_, e) => {
      e.evidence_files = [
        { kind: "rollback_observations", path: "capture.json", sha256: "0".repeat(64), captured_at: at(1) },
      ];
    },
    "evidence_file_checksum_mismatch.rollback_observations",
  ],
]) {
  test(`${name} remains PENDING`, () =>
    inDirectory(async (dir) => {
      const { evidenceFile } = await fixture(dir, mutate);
      const result = await runGateFRollbackDrill(SHA, { artifactsDir: dir, evidenceFile });
      assert.equal(result.verdict, "PENDING");
      assert.equal(result.scoring_availability, "UNKNOWN");
      assert.ok(result.pending_reasons.includes(error), JSON.stringify(result.pending_reasons));
    }));
}
