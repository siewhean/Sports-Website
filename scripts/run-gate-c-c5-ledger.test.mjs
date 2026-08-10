import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  approvedGateCC5Profile,
  assertSanitisedGateCC5Text,
  canonicalGateCC5BrowserArgv,
  canonicalGateCC5C4Argv,
  canonicalGateCC5IntegratedArgv,
  countGateCC5Skips,
  assertNoGateCC5Secrets,
  executeCommandsStopFirst,
  gateCC5BrowserProjects,
  gateCC5DeviceClasses,
  gateCC5ControlledFailures,
  gateCC5WorkloadOperations,
  parseCanonicalArgv,
  parseSafeArgv,
  requiredGateCC5Commands,
  validateGateCC5ApprovedProfile,
  validateGateCC5CacheReceipts,
  validateGateCC5Certification,
  validateGateCC5IntegratedRunReceipt,
  validateGateCC5PhysicalDeviceReceipts,
  validateGateCC5TargetReceipt,
  verifyGateCC5SealedTree,
  writeAndVerifyGateCC5Seal,
} from "./run-gate-c-c5-ledger.mjs";

const sourceSha = "a".repeat(40);
const uniqueHash = (value) => createHash("sha256").update(value).digest("hex");
const profile = () => structuredClone(approvedGateCC5Profile);
const allPass = (value = {}) => ({ status: "passed", failed_count: 0, skipped_count: 0, sealed: true, ...value });

function targetReceipt() {
  return allPass({
    artifact_kind: "gate-c-c5-target-attestation",
    source_sha: sourceSha,
    environment: "staging",
    production: false,
    shared: false,
    dedicated_drill_processes: true,
    shared_physical_device_session: false,
    deployment: {
      source_sha: sourceSha,
      build_id_sha256: uniqueHash("build"),
      service_revision_sha256: uniqueHash("service"),
      ingress_origin_sha256: uniqueHash("ingress"),
    },
    postgresql: { identifier_sha256: uniqueHash("target-postgres"), disposable: true },
    redis: { namespace_sha256: uniqueHash("target-redis"), disposable: true },
  });
}

function deviceReceipt(platform, planHash) {
  return {
    artifact_kind: "gate-c-c5-physical-device-receipt",
    source_sha: sourceSha,
    deployment_sha: sourceSha,
    profile_id: approvedGateCC5Profile.profileId,
    workload_plan_sha256: planHash,
    platform,
    trusted_https: true,
    device_identifier_sha256: uniqueHash(`${platform}-device`),
    scenarios: Object.fromEntries(
      [
        "sign_in_and_scoring_preparation",
        "online_score_and_reversal",
        "offline_queueing",
        "refresh_and_browser_restart",
        "ordered_replay_and_duplicate_fencing",
        "pending_finalisation",
        "stale_generation_takeover_read_only",
        "sanitised_export",
        "final_public_projection",
      ].map((name) => [name, "PASS"]),
    ),
    skipped_count: 0,
    console_errors: 0,
    network_errors: 0,
    service_worker_errors: 0,
    synchronisation_errors: 0,
    evidence_sha256: uniqueHash(`${platform}-evidence`),
  };
}

function integratedReceipt(runNumber, planHash) {
  const operations = Object.fromEntries(
    gateCC5WorkloadOperations.map((operation) => {
      const convergence = operation === "public_result_convergence";
      const samples = convergence ? 300 : 150;
      const workerCount = ["score_event_acknowledgement", "lease_takeover"].includes(operation)
        ? 2
        : operation === "repair_publication"
          ? 5
          : 150;
      return [
        operation,
        {
          operation,
          sourceSha,
          workerCount,
          timeoutCount: 0,
          elapsedMs: 3_600_000,
          scheduledCadenceMs: convergence ? null : 1_000,
          convergenceWaveCount: convergence ? 2 : 0,
          convergenceSamplesPerWave: convergence ? 150 : 0,
          summary: {
            sampleCount: samples,
            successfulCount: samples,
            expectedFailureCount: 0,
            unexpectedFailureCount: 0,
            errorRate: 0,
            p50Ms: 1,
            p95Ms: 2,
            p99Ms: 3,
            maxMs: 4,
          },
          correctness: { passed: true },
        },
      ];
    }),
  );
  return {
    artifact_kind: "gate-c-c5-integrated-workload-receipt",
    source_sha: sourceSha,
    profile_id: approvedGateCC5Profile.profileId,
    approval_reference_sha256: uniqueHash(approvedGateCC5Profile.approval.reference),
    workload_plan_sha256: planHash,
    minimum_samples_per_operation: 150,
    duration_ms: 18_000_000,
    operations,
    controlled_failures: gateCC5ControlledFailures.map((fault) => ({
      fault,
      injector: "command",
      injection_evidence_sha256: uniqueHash(`${runNumber}-${fault}-injection`),
      recovery_evidence_sha256: uniqueHash(`${runNumber}-${fault}-recovery`),
      cleanup_evidence_sha256: uniqueHash(`${runNumber}-${fault}-cleanup`),
      recovery_observed: true,
      cleanup_observed: true,
      recovery_oracle: "safe_recovery",
    })),
    postgresql_identifier_sha256: uniqueHash(`${runNumber}-postgres`),
    redis_namespace_sha256: uniqueHash(`${runNumber}-redis`),
  };
}

function browserReport() {
  return {
    config: { metadata: { sourceSha } },
    suites: [
      {
        specs: [
          {
            tests: gateCC5BrowserProjects.map((projectName) => ({
              projectName,
              status: "expected",
              results: [{ status: "passed" }],
            })),
          },
        ],
      },
    ],
  };
}

function cacheReceipts(planHash) {
  return [1, 2].map((run_ordinal) => ({
    artifact_kind: "gate-c-c5-cache-lifecycle-receipt",
    source_sha: sourceSha,
    deployment_sha: sourceSha,
    profile_id: approvedGateCC5Profile.profileId,
    workload_plan_sha256: planHash,
    run_ordinal,
    fixture_identifier_sha256: uniqueHash(`fixture-${run_ordinal}`),
    public_url_sha256: uniqueHash(`url-${run_ordinal}`),
    edge_origin_sha256: uniqueHash(`edge-origin-${run_ordinal}`),
    edge_path_query_sha256: uniqueHash(`path-query-${run_ordinal}`),
    initial_cache_status: "MISS",
    repeated_cache_status: "HIT",
    public_cache_control_observed: true,
    last_modified_before_utc: "2026-08-10T00:00:00.000Z",
    origin_url_sha256: uniqueHash(`origin-url-${run_ordinal}`),
    origin_api_origin_sha256: uniqueHash(`origin-api-origin-${run_ordinal}`),
    origin_path_query_sha256: uniqueHash(`path-query-${run_ordinal}`),
    origin_request_method: "GET",
    origin_conditional_status: 304,
    origin_etag_sha256: uniqueHash(`before-${run_ordinal}`),
    origin_last_modified_utc: "2026-08-10T00:00:00.000Z",
    origin_publication_version: 1,
    origin_publication_version_header_sha256: uniqueHash("1"),
    publication_kind: "result",
    previous_publication_version: 1,
    published_version: 2,
    purge_job_status: "completed",
    purge_job_identifier_sha256: uniqueHash(`purge-${run_ordinal}`),
    purge_bridge_status: 204,
    fresh_cache_status: "MISS",
    fresh_publication_version: 2,
    stable_cache_status: "HIT",
    etag_before_sha256: uniqueHash(`before-${run_ordinal}`),
    etag_after_sha256: uniqueHash(`after-${run_ordinal}`),
    organiser_private: true,
    session_private: true,
    draft_private: true,
    skipped_count: 0,
    evidence_sha256: uniqueHash(`cache-evidence-${run_ordinal}`),
  }));
}

function grafanaReceipts(planHash) {
  return [1, 2].map((run_ordinal) => ({
    artifact_kind: "gate-c-c5-grafana-receipt",
    source_sha: sourceSha,
    deployment_sha: sourceSha,
    profile_id: approvedGateCC5Profile.profileId,
    workload_plan_sha256: planHash,
    run_ordinal,
    correlation_id: `correlation-${run_ordinal}`,
    window_started_at_utc: "2026-08-10T00:00:00.000Z",
    window_ended_at_utc: "2026-08-10T01:00:00.000Z",
    workload_visible: true,
    fault_visible: true,
    recovery_visible: true,
    alert_routed: true,
    alert_recovered: true,
    skipped_count: 0,
    evidence_sha256: uniqueHash(`grafana-${run_ordinal}`),
  }));
}

function commandReceipts(runNumber) {
  const entries = [
    ...requiredGateCC5Commands,
    { label: "gate-c-c4-real-boundary", command: canonicalGateCC5C4Argv[0], args: canonicalGateCC5C4Argv.slice(1) },
    {
      label: "gate-c-c5-browser-matrix",
      command: canonicalGateCC5BrowserArgv[0],
      args: canonicalGateCC5BrowserArgv.slice(1),
    },
    {
      label: "gate-c-c5-integrated",
      command: canonicalGateCC5IntegratedArgv[0],
      args: canonicalGateCC5IntegratedArgv.slice(1),
    },
  ];
  return entries.map((entry) => ({
    label: `run-${runNumber}-${entry.label}`,
    command: [entry.command, ...entry.args].join(" "),
    exit_code: 0,
    failed_count: 0,
    skipped_count: 0,
    log_sha256: uniqueHash(`${runNumber}-${entry.label}-log`),
  }));
}

function certification() {
  const approvedProfile = profile();
  const profileSha256 = validateGateCC5ApprovedProfile(approvedProfile);
  return {
    schema_version: 1,
    artifact_kind: "gate-c-c5-exact-sha-ledger",
    source_sha: sourceSha,
    execution_sha256: uniqueHash("execution"),
    review_bundle_sha256: uniqueHash("review-bundle"),
    environment: { node_version: "v24.18.0", pnpm_version: "10.33.0" },
    approved_profile: approvedProfile,
    approved_profile_sha256: profileSha256,
    targets: targetReceipt(),
    physical_devices: gateCC5DeviceClasses.map((platform) => deviceReceipt(platform, profileSha256)),
    runs: [1, 2].map((run_number) => ({
      run_number,
      commands: commandReceipts(run_number),
      integrated_receipt: integratedReceipt(run_number, profileSha256),
      browser_report: browserReport(),
    })),
    cache: cacheReceipts(profileSha256),
    grafana: grafanaReceipts(profileSha256),
    independent_qa: {
      artifact_kind: "gate-c-c5-independent-qa-receipt",
      source_sha: sourceSha,
      p0_count: 0,
      p1_count: 0,
      verdict: "PASS",
      reviewed_bundle_sha256: uniqueHash("review-bundle"),
      reviewer_agent_sha256: uniqueHash("reviewer"),
      evidence_sha256: uniqueHash("qa-evidence"),
    },
  };
}

test("approved C5 profile is strict and hash-bound", () => {
  assert.match(validateGateCC5ApprovedProfile(profile()), /^[a-f0-9]{64}$/u);
  assert.throws(
    () => validateGateCC5ApprovedProfile({ ...profile(), durationSeconds: 3599 }),
    /does not exactly match/u,
  );
  assert.throws(() => validateGateCC5ApprovedProfile({ ...profile(), extra: true }), /unsupported fields/u);
});

test("target validation rejects production, shared, non-disposable, and wrong-SHA targets", () => {
  assert.equal(validateGateCC5TargetReceipt(targetReceipt(), sourceSha).environment, "staging");
  assert.throws(
    () => validateGateCC5TargetReceipt({ ...targetReceipt(), production: true }, sourceSha),
    /non-production/u,
  );
  assert.throws(() => validateGateCC5TargetReceipt({ ...targetReceipt(), shared: true }, sourceSha), /dedicated/u);
  const retained = targetReceipt();
  retained.redis.disposable = false;
  assert.throws(() => validateGateCC5TargetReceipt(retained, sourceSha), /disposable/u);
  assert.throws(
    () => validateGateCC5TargetReceipt({ ...targetReceipt(), source_sha: "b".repeat(40) }, sourceSha),
    /exact-SHA/u,
  );
});

test("physical device validation requires distinct iPhone, iPad, and budget Android identities", () => {
  const planHash = validateGateCC5ApprovedProfile(profile());
  const receipts = gateCC5DeviceClasses.map((platform) => deviceReceipt(platform, planHash));
  assert.equal(validateGateCC5PhysicalDeviceReceipts(receipts, sourceSha).length, 3);
  assert.throws(() => validateGateCC5PhysicalDeviceReceipts(receipts.slice(1), sourceSha), /exactly three/u);
  const duplicate = receipts.map((receipt) => ({ ...receipt }));
  duplicate[2].device_identifier_sha256 = duplicate[0].device_identifier_sha256;
  assert.throws(() => validateGateCC5PhysicalDeviceReceipts(duplicate, sourceSha), /distinct/u);
  assert.throws(
    () =>
      validateGateCC5PhysicalDeviceReceipts([{ ...receipts[0], skipped_count: 1 }, ...receipts.slice(1)], sourceSha),
    /failures or skips/u,
  );
});

test("integrated receipt requires five one-hour operations and all twelve controlled failures", () => {
  const profileHash = validateGateCC5ApprovedProfile(profile());
  const receipt = integratedReceipt(1, profileHash);
  assert.equal(validateGateCC5IntegratedRunReceipt(receipt, sourceSha, 1, profileHash), receipt);
  const missing = structuredClone(receipt);
  delete missing.operations.repair_publication;
  assert.throws(
    () => validateGateCC5IntegratedRunReceipt(missing, sourceSha, 1, profileHash),
    /missing or unsupported|failed repair_publication/u,
  );
  const skipped = structuredClone(receipt);
  skipped.operations.score_event_acknowledgement.timeoutCount = 1;
  assert.throws(() => validateGateCC5IntegratedRunReceipt(skipped, sourceSha, 1, profileHash), /failed score/u);
  const missingFault = structuredClone(receipt);
  missingFault.controlled_failures.pop();
  assert.throws(
    () => validateGateCC5IntegratedRunReceipt(missingFault, sourceSha, 1, profileHash),
    /missing controlled/u,
  );
  const invalidInjector = structuredClone(receipt);
  invalidInjector.controlled_failures[0].injector = "not_permitted";
  assert.throws(
    () => validateGateCC5IntegratedRunReceipt(invalidInjector, sourceSha, 1, profileHash),
    /controlled failure is incomplete/u,
  );
  const missingMetric = structuredClone(receipt);
  delete missingMetric.operations.public_current_conditional_read.summary.p95Ms;
  assert.throws(
    () => validateGateCC5IntegratedRunReceipt(missingMetric, sourceSha, 1, profileHash),
    /failed public_current/u,
  );
});

test("cache lifecycle receipts require canonical fields and safe-integer publication versions", () => {
  const planHash = validateGateCC5ApprovedProfile(profile());
  const receipts = cacheReceipts(planHash);
  assert.equal(validateGateCC5CacheReceipts(receipts, sourceSha, planHash), receipts);
  const concatenating = structuredClone(receipts);
  concatenating[0].previous_publication_version = "1";
  concatenating[0].published_version = "11";
  concatenating[0].fresh_publication_version = "11";
  assert.throws(
    () => validateGateCC5CacheReceipts(concatenating, sourceSha, planHash),
    /cache lifecycle receipt 1 is incomplete/u,
  );
  const unsupported = structuredClone(receipts);
  unsupported[0].raw_origin = "redacted";
  assert.throws(() => validateGateCC5CacheReceipts(unsupported, sourceSha, planHash), /missing or unsupported fields/u);
  const unrelatedOrigin = structuredClone(receipts);
  unrelatedOrigin[0].origin_etag_sha256 = uniqueHash("unrelated-origin-etag");
  assert.throws(
    () => validateGateCC5CacheReceipts(unrelatedOrigin, sourceSha, planHash),
    /cache lifecycle receipt 1 is incomplete/u,
  );
  const sameOrigin = structuredClone(receipts);
  sameOrigin[0].origin_api_origin_sha256 = sameOrigin[0].edge_origin_sha256;
  assert.throws(
    () => validateGateCC5CacheReceipts(sameOrigin, sourceSha, planHash),
    /cache lifecycle receipt 1 is incomplete/u,
  );
});

test("certification rejects wrong toolchains, one run, and reused isolation", () => {
  const manifest = certification();
  assert.equal(validateGateCC5Certification(manifest, sourceSha), manifest);
  assert.throws(
    () =>
      validateGateCC5Certification(
        { ...manifest, environment: { ...manifest.environment, node_version: "v24.18.1" } },
        sourceSha,
      ),
    /Node v24.18.0/u,
  );
  assert.throws(
    () => validateGateCC5Certification({ ...manifest, runs: manifest.runs.slice(0, 1) }, sourceSha),
    /exactly two/u,
  );
  const reused = structuredClone(manifest);
  reused.runs[1].integrated_receipt.redis_namespace_sha256 = reused.runs[0].integrated_receipt.redis_namespace_sha256;
  assert.throws(() => validateGateCC5Certification(reused, sourceSha), /reused PostgreSQL or Redis/u);
  assert.throws(() => validateGateCC5Certification(manifest, "short"), /full source SHA/u);
  const failedQa = structuredClone(manifest);
  failedQa.independent_qa.p1_count = 1;
  assert.throws(() => validateGateCC5Certification(failedQa, sourceSha), /independent QA/u);
});

test("command argv must be explicit and cannot invoke a shell command string", () => {
  assert.deepEqual(parseSafeArgv('["pnpm","test:e2e:phase4:real"]', "COMMAND"), {
    command: "pnpm",
    args: ["test:e2e:phase4:real"],
  });
  assert.throws(() => parseSafeArgv('["bash","-c","do something"]', "COMMAND"), /shell wrapper/u);
  assert.throws(() => parseSafeArgv('"pnpm test"', "COMMAND"), /argv array/u);
  assert.throws(() => parseSafeArgv('["pnpm",2]', "COMMAND"), /array of strings/u);
  assert.deepEqual(parseCanonicalArgv(JSON.stringify(canonicalGateCC5C4Argv), "COMMAND", canonicalGateCC5C4Argv), {
    command: "pnpm",
    args: ["test:e2e:phase4:real"],
  });
  assert.throws(() => parseCanonicalArgv('["/usr/bin/true"]', "COMMAND", canonicalGateCC5C4Argv), /canonical command/u);
});

test("command execution stops at the first failure", async () => {
  const observed = [];
  await assert.rejects(
    executeCommandsStopFirst([{ label: "first" }, { label: "failure" }, { label: "never" }], async (entry) => {
      observed.push(entry.label);
      if (entry.label === "failure") throw new Error("failed gate");
      return entry;
    }),
    /failed gate/u,
  );
  assert.deepEqual(observed, ["first", "failure"]);
});

test("skip detection recognises TAP and Playwright count orders", () => {
  assert.equal(countGateCC5Skips("2 skipped\nℹ skipped 3\n1 todo"), 6);
});

test("evidence recursively rejects secret-like keys and connection values", () => {
  assert.doesNotThrow(() => assertNoGateCC5Secrets({ identifier_sha256: uniqueHash("safe") }));
  assert.doesNotThrow(() => assertSanitisedGateCC5Text("HTTPS origin and Redis namespace hashes retained"));
  assert.throws(() => assertNoGateCC5Secrets({ access_token: "redacted" }), /field is forbidden/u);
  assert.throws(
    () => assertNoGateCC5Secrets({ note: "postgres://user:pass@example.invalid/db" }),
    /credentials or sensitive topology/u,
  );
  assert.throws(
    () => assertNoGateCC5Secrets({ note: "redis://cache.internal:6379" }),
    /credentials or sensitive topology/u,
  );
  assert.throws(
    () => assertNoGateCC5Secrets({ note: "probe reached 10.42.0.8" }),
    /credentials or sensitive topology/u,
  );
  assert.throws(() => assertNoGateCC5Secrets({ host: "db.internal" }), /field is forbidden/u);
});

test("tree sealing reopens hashes, rejects symlinks, and makes the bundle immutable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gate-c-c5-seal-"));
  await writeFile(path.join(directory, "receipt.json"), `${JSON.stringify({ status: "passed" })}\n`);
  const sealPath = await writeAndVerifyGateCC5Seal(directory, sourceSha);
  const seal = JSON.parse(await readFile(sealPath, "utf8"));
  assert.equal(seal.entries.length, 1);
  assert.match(seal.tree_sha256, /^[a-f0-9]{64}$/u);
  await assert.rejects(writeFile(path.join(directory, "receipt.json"), "changed", { flag: "w" }), /EACCES|EPERM/u);
  await assert.rejects(writeFile(path.join(directory, "new.json"), "{}"), /EACCES|EPERM/u);

  const linked = await mkdtemp(path.join(tmpdir(), "gate-c-c5-link-"));
  await writeFile(path.join(linked, "outside.json"), "{}");
  await mkdir(path.join(linked, "evidence"));
  await symlink(path.join(linked, "outside.json"), path.join(linked, "evidence", "receipt.json"));
  await assert.rejects(writeAndVerifyGateCC5Seal(path.join(linked, "evidence"), sourceSha), /symlink/u);

  const topology = await mkdtemp(path.join(tmpdir(), "gate-c-c5-topology-"));
  await writeFile(
    path.join(topology, "receipt.json"),
    `${JSON.stringify({ note: "https://c5-staging.example.invalid/private" })}\n`,
  );
  await assert.rejects(writeAndVerifyGateCC5Seal(topology, sourceSha), /credentials or sensitive topology/u);
  await chmod(directory, 0o755);
});

test("finalization verification rejects a prepared-review mutation", async () => {
  const prepared = await mkdtemp(path.join(tmpdir(), "gate-c-c5-prepared-"));
  const receiptPath = path.join(prepared, "review-preparation.json");
  await writeFile(receiptPath, `${JSON.stringify({ artifact_kind: "gate-c-c5-prepared-review" })}\n`);
  await writeAndVerifyGateCC5Seal(prepared, sourceSha);
  assert.equal((await verifyGateCC5SealedTree(prepared, sourceSha)).source_sha, sourceSha);
  await chmod(prepared, 0o755);
  await chmod(receiptPath, 0o644);
  await writeFile(receiptPath, `${JSON.stringify({ artifact_kind: "gate-c-c5-prepared-review", changed: true })}\n`);
  await assert.rejects(verifyGateCC5SealedTree(prepared, sourceSha), /mutable or invalid|changed after preparation/u);
});
