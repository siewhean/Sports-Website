import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { runGateFOpsAudit } from "./run-gate-f-ops-audit.mjs";
import { runGateFRecertifications } from "./run-gate-f-recertifications.mjs";
const SHA = "a".repeat(40);
async function fixtures(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "matchday-ops-evidence-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function evidence(dir, fields, kind = "provider_capture") {
  const content = Buffer.from("isolated unit fixture; never production evidence");
  await writeFile(path.join(dir, "capture.txt"), content);
  const file = path.join(dir, "receipt.json");
  await writeFile(
    file,
    JSON.stringify({
      schema_version: "unit-fixture",
      evidence_class: kind === "test_log" ? "HOSTED_CI" : "PROVIDER_RECEIPT",
      candidate_sha: SHA,
      environment: kind === "test_log" ? "ci" : "production",
      hostname: "production.example",
      observed_at: new Date().toISOString(),
      evidence_files: [
        {
          kind,
          path: "capture.txt",
          sha256: createHash("sha256").update(content).digest("hex"),
          captured_at: new Date().toISOString(),
        },
      ],
      ...fields,
    }),
  );
  return file;
}
const dashboard = {
  dashboard_id: "dashboard-fixture",
  observed_metrics: ["api_latency", "error_rate", "queue_depth", "active_scoring_sessions", "public_reads"],
  availability_observed_percent: 99.95,
  scoring_p95_observed_ms: 100,
  public_read_p95_observed_ms: 100,
  result_propagation_observed_ms: 100,
  observation_sample_count: 50,
  observation_window: {
    started_at: new Date(Date.now() - 60000).toISOString(),
    completed_at: new Date(Date.now() - 1000).toISOString(),
  },
};
test("dashboard evidence cannot certify independent probes; invalid numeric/window data fails closed", async () =>
  fixtures(async (dir) => {
    const sloEvidenceFile = await evidence(dir, dashboard);
    const result = await runGateFOpsAudit(SHA, { artifactsDir: dir, sloEvidenceFile });
    assert.equal(result.sloBaseline.verdict, "PASS");
    assert.equal(result.sloBaseline.operational_status, "VERIFIED");
    assert.equal(result.syntheticProbes.verdict, "PENDING");
    for (const fields of [
      { scoring_p95_observed_ms: -1 },
      { public_read_p95_observed_ms: "100" },
      { result_propagation_observed_ms: 2001 },
      { observation_sample_count: 0 },
      { observation_window: {} },
      { observed_metrics: [] },
    ]) {
      const file = await evidence(dir, { ...dashboard, ...fields });
      const invalid = await runGateFOpsAudit(SHA, { artifactsDir: dir, sloEvidenceFile: file });
      assert.equal(invalid.sloBaseline.verdict, "PENDING");
      assert(invalid.sloBaseline.pending_reasons.length > 0);
    }
  }));
test("claimed monitoring success without retained capture or wrong candidate is rejected", async () =>
  fixtures(async (dir) => {
    for (const fields of [{ evidence_files: [] }, { candidate_sha: "b".repeat(40) }]) {
      const file = await evidence(dir, { ...dashboard, ...fields });
      const result = await runGateFOpsAudit(SHA, { artifactsDir: dir, sloEvidenceFile: file });
      assert.equal(result.sloBaseline.verdict, "PENDING");
    }
  }));
test("synthetic evidence requires every external target at required interval", async () =>
  fixtures(async (dir) => {
    const probes = ["homepage", "health_ready", "meta_build", "public_competition_read"].map((name) => ({
      name,
      external: true,
      status: 200,
      interval_sec: name === "health_ready" ? 30 : 60,
      provider_monitor_id: name,
      target_url:
        "https://matchday.poladex.shop" +
        {
          homepage: "/",
          health_ready: "/health/ready",
          meta_build: "/api/v1/meta/build",
          public_competition_read: "/api/v1/competitions/fixture",
        }[name],
      observed_candidate_sha: SHA,
      observed_competition_id: "fixture",
    }));
    const file = await evidence(dir, { probes, serving_sha: SHA, public_competition_id: "fixture" });
    assert.equal(
      (await runGateFOpsAudit(SHA, { artifactsDir: dir, syntheticEvidenceFile: file })).syntheticProbes.verdict,
      "PASS",
    );
    for (const bad of [
      probes.slice(1),
      probes.map((p) => ({ ...p, interval_sec: 300 })),
      probes.map((p) => ({ ...p, external: false })),
      probes.map((p) => ({ ...p, target_url: "https://matchday.poladex.shop/not-a-probe" })),
      probes.map((p) => ({ ...p, observed_candidate_sha: "b".repeat(40) })),
    ]) {
      const file = await evidence(dir, { probes: bad, serving_sha: SHA, public_competition_id: "fixture" });
      assert.equal(
        (await runGateFOpsAudit(SHA, { artifactsDir: dir, syntheticEvidenceFile: file })).syntheticProbes.verdict,
        "PENDING",
      );
    }
  }));
test("global alert acknowledgement cannot stand in for four actual route receipts", async () =>
  fixtures(async (dir) => {
    const common = { alert_drill_id: "drill", all_routes_verified: true, delivery_acknowledged: true };
    let file = await evidence(dir, common);
    assert.equal(
      (await runGateFOpsAudit(SHA, { artifactsDir: dir, alertEvidenceFile: file })).alertRouting.verdict,
      "PENDING",
    );
    file = await evidence(dir, {
      ...common,
      routes: ["service_unavailable", "scoring_latency_breach", "worker_dead", "backup_failed"].map((condition) => ({
        condition,
        delivery_acknowledged: true,
        receipt_id: condition,
      })),
    });
    assert.equal(
      (await runGateFOpsAudit(SHA, { artifactsDir: dir, alertEvidenceFile: file })).alertRouting.verdict,
      "PASS",
    );
  }));
test("recertification does not invent automated tests, retention, or zero defects", async () =>
  fixtures(async (dir) => {
    const result = await runGateFRecertifications(SHA, { artifactsDir: dir });
    assert.equal(result.security.verdict, "PENDING_TEST_EVIDENCE");
    assert.equal(result.security.critical_defects, null);
    assert.equal(result.security.high_defects, null);
    assert.equal(result.a11y.automated_axe_playwright, "PENDING_TEST_EVIDENCE");
    assert.equal(result.legal.data_retention_implemented, null);
    assert.equal(result.legal.formal_authorised_legal_approval, "DEFERRED_TO_FIRST_COMMERCIAL_RELEASE");
    assert.equal(result.security.independent_manual_pentest, "WAIVED_NOT_EXECUTED");
    assert.equal(result.email.template_tests, "PENDING_TEST_EVIDENCE");
  }));
test("retained exact-SHA automated checks certify source scope only", async () =>
  fixtures(async (dir) => {
    const checks = Object.fromEntries(
      Object.entries({
        security: ["dependency_audit", "secret_scan", "security_headers"],
        accessibility: ["automated_axe_playwright", "reduced_motion_contract", "high_contrast_contract"],
        privacy: ["policy_source", "terms_source", "cookies_source", "data_retention", "data_export", "data_deletion"],
        email: ["templates"],
      }).map(([k, keys]) => [k, Object.fromEntries(keys.map((key) => [key, "PASS"]))]),
    );
    const automatedEvidenceFile = await evidence(dir, { checks }, "test_log");
    const result = await runGateFRecertifications(SHA, { artifactsDir: dir, automatedEvidenceFile });
    assert.equal(result.security.verdict, "PASS_AUTOMATED_SCOPE");
    assert.equal(result.security.critical_defects, null);
    assert.equal(result.a11y.verdict, "PASS_AUTOMATED_SCOPE");
    assert.equal(result.legal.verdict, "PASS_TECHNICAL_PACKAGE_WITH_DEFERMENT");
    assert.equal(result.security.verified_evidence_files.length, 1);
    assert.match(result.security.input_evidence_sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.dnsTls.verdict, "PENDING");
    assert.equal(result.email.verdict, "PENDING");
  }));
test("malformed caller candidate SHA never silently resolves to HEAD", async () => {
  await assert.rejects(runGateFOpsAudit("not-a-sha"), /exact 40-character/);
  await assert.rejects(runGateFRecertifications("not-a-sha"), /exact 40-character/);
});

test("email provider proof cannot certify missing source template tests", async () =>
  fixtures(async (dir) => {
    const emailEvidenceFile = await evidence(dir, {
      provider: "resend_transactional",
      domain: "matchday.poladex.shop",
      spf: "PASS",
      dkim: "PASS",
      dmarc: "PASS",
      bounce_handling: "PASS",
    });
    const result = await runGateFRecertifications(SHA, { artifactsDir: dir, emailEvidenceFile });
    assert.equal(result.email.verdict, "PENDING");
    assert.equal(result.email.template_tests, "PENDING_TEST_EVIDENCE");
    assert(result.email.pending_reasons.includes("exact_sha_email_template_test_log_required"));
  }));
