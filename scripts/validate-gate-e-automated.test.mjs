import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GATE_E_ASSURANCE_PROFILE,
  GATE_E_SCHEMA_VERSION,
  REQUIRED_HOSTED_CI_JOBS,
  REQUIRED_WAIVERS,
  validateGateEAutomated,
} from "./validate-gate-e-automated.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const HASH = "a".repeat(64);

function receipt(qaItem, verdict) {
  return { qa_item: qaItem, candidate_sha: SHA, verdict, receipt_sha256: HASH };
}

async function withEvidence(mutator, run) {
  const root = await mkdtemp(path.join(tmpdir(), "matchday-gate-e-"));
  const artifactsDir = path.join(root, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  const files = {
    "gate-e-certification.json": {
      schema_version: GATE_E_SCHEMA_VERSION,
      gate: "E",
      assurance_profile: GATE_E_ASSURANCE_PROFILE,
      candidate_sha: SHA,
      hosted_ci: {
        run_id: 123,
        head_sha: SHA,
        conclusion: "PASS",
        jobs: Object.fromEntries(REQUIRED_HOSTED_CI_JOBS.map((job) => [job, "PASS"])),
      },
      controlled_qualification: { run_id: 456, candidate_sha: SHA, conclusion: "PASS" },
      human_waivers: Object.fromEntries(REQUIRED_WAIVERS.map((key) => [key, "WAIVED_NOT_EXECUTED"])),
    },
    "gate-e-slo-validation.json": {
      ...receipt("QA-024", "PASS"),
      metrics: {
        scoring_peak_2x_p95_ms: 400,
        public_projection_peak_2x_p95_ms: 200,
        result_propagation_p95_ms: 150,
        scoring_error_rate: 0,
        public_projection_error_rate: 0,
        result_propagation_error_rate: 0,
      },
    },
    "gate-e-seo-audit.json": receipt("QA-028", "PASS"),
    "gate-e-email-deliverability.json": receipt("QA-030", "PASS"),
    "gate-e-security-automation.json": {
      ...receipt("QA-029-AUTOMATED", "PASS_AUTOMATED_SCOPE"),
      independent_manual_pentest: "WAIVED_NOT_EXECUTED",
    },
    "gate-e-legal-package.json": {
      ...receipt("QA-027", "PASS_TECHNICAL_PACKAGE_WITH_GATE_F_DEFERMENT"),
      formal_authorised_legal_approval: "DEFERRED_TO_GATE_F_BY_ADR_0003",
    },
  };
  mutator?.(files);
  await Promise.all(Object.entries(files).map(([name, value]) => writeFile(path.join(artifactsDir, name), JSON.stringify(value), "utf8")));
  try {
    return await run({ artifactsDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("accepts exact-SHA automated Gate E evidence with explicit waivers", async () => {
  await withEvidence(undefined, async ({ artifactsDir }) => {
    const report = await validateGateEAutomated(SHA, { artifactsDir });
    assert.equal(report.valid, true);
    assert.equal(report.gate, "E");
    assert.equal(report.waived_human_items, REQUIRED_WAIVERS.length);
  });
});

test("rejects a fake PASS for a waived human requirement", async () => {
  await withEvidence(
    (files) => {
      files["gate-e-certification.json"].human_waivers.national_parallel_pilot = "PASS";
    },
    async ({ artifactsDir }) => {
      await assert.rejects(validateGateEAutomated(SHA, { artifactsDir }), /national_parallel_pilot.*WAIVED_NOT_EXECUTED/u);
    },
  );
});

test("rejects an out-of-budget scoring SLO", async () => {
  await withEvidence(
    (files) => {
      files["gate-e-slo-validation.json"].metrics.scoring_peak_2x_p95_ms = 500;
    },
    async ({ artifactsDir }) => {
      await assert.rejects(validateGateEAutomated(SHA, { artifactsDir }), /out-of-budget p95/u);
    },
  );
});

test("rejects SHA mismatch", async () => {
  await withEvidence(
    (files) => {
      files["gate-e-seo-audit.json"].candidate_sha = "f".repeat(40);
    },
    async ({ artifactsDir }) => {
      await assert.rejects(validateGateEAutomated(SHA, { artifactsDir }), /QA-028\.candidate_sha mismatch/u);
    },
  );
});

test("rejects missing Gate F legal deferment", async () => {
  await withEvidence(
    (files) => {
      files["gate-e-legal-package.json"].formal_authorised_legal_approval = "PASS";
    },
    async ({ artifactsDir }) => {
      await assert.rejects(validateGateEAutomated(SHA, { artifactsDir }), /legal approval disposition/u);
    },
  );
});
