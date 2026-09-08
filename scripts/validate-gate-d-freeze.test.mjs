import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GATE_D_FREEZE_SCHEMA_VERSION,
  REQUIRED_HOSTED_CI_JOBS,
  REQUIRED_HUMAN_EVIDENCE,
  validateGateDFreeze,
} from "./validate-gate-d-freeze.mjs";

const CANDIDATE_SHA = "0123456789abcdef0123456789abcdef01234567";

function evidenceItem(overrides = {}) {
  return {
    status: "PASS",
    completed_at: "2026-09-02T12:00:00.000Z",
    evidence_ref: "controlled-evidence://gate-d/example",
    ...overrides,
  };
}

function validCertification() {
  return {
    schema_version: GATE_D_FREEZE_SCHEMA_VERSION,
    gate: "D",
    candidate_sha: CANDIDATE_SHA,
    hosted_ci: {
      run_id: 123456,
      head_sha: CANDIDATE_SHA,
      conclusion: "PASS",
      jobs: Object.fromEntries(REQUIRED_HOSTED_CI_JOBS.map((job) => [job, "PASS"])),
    },
    human_evidence: Object.fromEntries(REQUIRED_HUMAN_EVIDENCE.map((key) => [key, evidenceItem()])),
  };
}

async function withCertification(mutator, run) {
  const root = await mkdtemp(path.join(tmpdir(), "matchday-gate-d-freeze-test-"));
  const certificationFile = path.join(root, "gate-d-certification.json");
  const certification = validCertification();
  certification.human_evidence.critical_high_defects = evidenceItem({ critical_open: 0, high_open: 0 });
  certification.human_evidence.independent_review = evidenceItem({ verdict: "PASS", reviewer: "Independent QA" });
  mutator?.(certification);
  await writeFile(certificationFile, JSON.stringify(certification), "utf8");
  try {
    return await run({ root, certificationFile });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const validStaging = async () => ({ valid: true, passed: 3, failed: [] });

test("accepts exact-SHA staging, hosted CI, human and pilot evidence", async () => {
  await withCertification(undefined, async ({ root, certificationFile }) => {
    const report = await validateGateDFreeze(CANDIDATE_SHA, {
      rootDir: root,
      certificationFile,
      stagingValidator: validStaging,
    });
    assert.equal(report.valid, true);
    assert.equal(report.hosted_ci_run_id, 123456);
    assert.equal(report.staging_receipts, 3);
    assert.equal(report.human_evidence_items, REQUIRED_HUMAN_EVIDENCE.length);
  });
});

test("fails closed when controlled-staging receipts are not valid", async () => {
  await withCertification(undefined, async ({ root, certificationFile }) => {
    await assert.rejects(
      validateGateDFreeze(CANDIDATE_SHA, {
        rootDir: root,
        certificationFile,
        stagingValidator: async () => ({ valid: false, failed: [{ error: "missing receipt" }] }),
      }),
      /controlled-staging evidence is not valid/u,
    );
  });
});

test("rejects certification and hosted CI SHA mismatches", async () => {
  await withCertification(
    (certification) => {
      certification.hosted_ci.head_sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    },
    async ({ root, certificationFile }) => {
      await assert.rejects(
        validateGateDFreeze(CANDIDATE_SHA, {
          rootDir: root,
          certificationFile,
          stagingValidator: validStaging,
        }),
        /hosted CI head SHA mismatch/u,
      );
    },
  );
});

test("rejects pending or follow-up human evidence", async () => {
  await withCertification(
    (certification) => {
      certification.human_evidence.budget_android.status = "PENDING";
    },
    async ({ root, certificationFile }) => {
      await assert.rejects(
        validateGateDFreeze(CANDIDATE_SHA, {
          rootDir: root,
          certificationFile,
          stagingValidator: validStaging,
        }),
        /budget_android\.status must be exactly PASS/u,
      );
    },
  );

  await withCertification(
    (certification) => {
      certification.human_evidence.independent_review.verdict = "PASS WITH FOLLOW-UP";
    },
    async ({ root, certificationFile }) => {
      await assert.rejects(
        validateGateDFreeze(CANDIDATE_SHA, {
          rootDir: root,
          certificationFile,
          stagingValidator: validStaging,
        }),
        /independent reviewer verdict must be exactly PASS/u,
      );
    },
  );
});

test("rejects any open Critical or High pilot defect", async () => {
  await withCertification(
    (certification) => {
      certification.human_evidence.critical_high_defects.high_open = 1;
    },
    async ({ root, certificationFile }) => {
      await assert.rejects(
        validateGateDFreeze(CANDIDATE_SHA, {
          rootDir: root,
          certificationFile,
          stagingValidator: validStaging,
        }),
        /zero open Critical and High/u,
      );
    },
  );
});

test("requires non-empty evidence references for every physical or human gate", async () => {
  await withCertification(
    (certification) => {
      certification.human_evidence.incident_tabletop.evidence_ref = "";
    },
    async ({ root, certificationFile }) => {
      await assert.rejects(
        validateGateDFreeze(CANDIDATE_SHA, {
          rootDir: root,
          certificationFile,
          stagingValidator: validStaging,
        }),
        /incident_tabletop\.evidence_ref is required/u,
      );
    },
  );
});
