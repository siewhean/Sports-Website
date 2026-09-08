import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateGateF } from "./validate-gate-f.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

async function withArtifacts(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "matchday-validate-gate-f-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("validateGateF accepts valid certificate and simulation", async () => {
  await withArtifacts(async (artifactsDir) => {
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
        jobs: {
          secrets: "PASS",
          "quality-fast": "PASS",
          integration: "PASS",
          "browser-e2e": "PASS",
          "gate-d-real-e2e": "PASS",
        },
      },
      simulation: { conclusion: "PASS" },
      human_waivers: {
        independent_manual_pentest: "WAIVED_NOT_EXECUTED",
        independent_gate_f_reviewer: "WAIVED_NOT_EXECUTED",
        physical_device_matrix_session: "WAIVED_NOT_EXECUTED",
        human_screen_reader_audit: "WAIVED_NOT_EXECUTED",
        live_organiser_pilot_observation: "WAIVED_NOT_EXECUTED",
      },
      legal_approval: "DEFERRED_TO_FIRST_COMMERCIAL_RELEASE",
    };

    const sim = {
      candidate_sha: SHA,
      verdict: "PASS",
      receipt_sha256: "a".repeat(64),
    };

    await writeFile(path.join(artifactsDir, "gate-f-certification.json"), JSON.stringify(cert));
    await writeFile(path.join(artifactsDir, "gate-f-production-simulation.json"), JSON.stringify(sim));

    const res = await validateGateF(SHA, { artifactsDir });
    assert.equal(res.valid, true);
    assert.equal(res.production_hostname, "matchday.poladex.shop");
  });
});

test("validateGateF rejects SHA mismatch", async () => {
  await withArtifacts(async (artifactsDir) => {
    const cert = {
      schema_version: "2026.09.gate-f-production",
      gate: "F",
      assurance_profile: "automated-only-owner-waived-v2",
      candidate_sha: "ffffffffffffffffffffffffffffffffffffffff",
      production_deployment: {
        hostname: "matchday.poladex.shop",
        deployed_sha: "ffffffffffffffffffffffffffffffffffffffff",
        environment: "production",
        conclusion: "PASS",
      },
      hosted_ci: {
        run_id: 12345,
        head_sha: "ffffffffffffffffffffffffffffffffffffffff",
        conclusion: "PASS",
        jobs: {
          secrets: "PASS",
          "quality-fast": "PASS",
          integration: "PASS",
          "browser-e2e": "PASS",
          "gate-d-real-e2e": "PASS",
        },
      },
      human_waivers: {
        independent_manual_pentest: "WAIVED_NOT_EXECUTED",
        independent_gate_f_reviewer: "WAIVED_NOT_EXECUTED",
        physical_device_matrix_session: "WAIVED_NOT_EXECUTED",
        human_screen_reader_audit: "WAIVED_NOT_EXECUTED",
        live_organiser_pilot_observation: "WAIVED_NOT_EXECUTED",
      },
      legal_approval: "DEFERRED_TO_FIRST_COMMERCIAL_RELEASE",
    };

    const sim = {
      candidate_sha: SHA,
      verdict: "PASS",
      receipt_sha256: "a".repeat(64),
    };

    await writeFile(path.join(artifactsDir, "gate-f-certification.json"), JSON.stringify(cert));
    await writeFile(path.join(artifactsDir, "gate-f-production-simulation.json"), JSON.stringify(sim));

    await assert.rejects(async () => validateGateF(SHA, { artifactsDir }), /mismatch/);
  });
});
