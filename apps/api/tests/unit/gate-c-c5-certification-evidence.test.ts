import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { C5ControlledFailure, C5WorkloadOperation } from "@matchday/observability";
import {
  collectGateCC5RetainedArtifacts,
  collectGateCC5CacheLifecycleReceipt,
  collectGateCC5GrafanaReceipt,
  gateCC5WorkloadPlanSha256,
  validateGateCC5CacheLifecycleReceipt,
  validateGateCC5CacheLifecycleReceipts,
  validateGateCC5EvidenceManifest,
  validateGateCC5GrafanaReceipt,
  validateGateCC5GrafanaReceipts,
  validateGateCC5PhysicalDeviceReceipt,
  validateGateCC5PhysicalDeviceReceipts,
  verifyGateCC5EvidenceSeal,
  writeGateCC5EvidenceManifestAndSeal,
} from "../../scripts/gate-c-c5-certification-evidence.js";

const temporaryDirectories: string[] = [];
const sourceSha = "a".repeat(40);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const plan = {
  profile: {
    profileId: "c5-pilot-2026-001",
    durationSeconds: 3_600,
    scorekeeperCount: 2,
    publicReaderCount: 150,
    organiserWorkerCount: 5,
    approval: {
      owner: "Siew Hean, Tournament Director",
      approvedAtUtc: "2026-07-04T08:30:00Z",
      reference: "C5-PILOT-APPROVAL-2026-001",
    },
  },
  minimumSamplesPerOperation: 150,
  maximumSamplesPerOperation: {
    score_event_acknowledgement: 7_200,
    public_result_convergence: 300,
    public_current_conditional_read: 540_000,
    lease_takeover: 7_200,
    repair_publication: 18_000,
  },
  maximumSamplesPerWorkerPerSecond: 1,
  convergencePolicy: { waveCount: 2, samplesPerWave: 150 },
} as const;
const expected = { sourceSha, plan };
const planHash = gateCC5WorkloadPlanSha256(plan);
const operation = (name: C5WorkloadOperation, p95Ms: number) => ({
  operation: name,
  sourceSha,
  workerCount:
    name === "repair_publication"
      ? 5
      : name === "public_result_convergence" || name === "public_current_conditional_read"
        ? 150
        : 2,
  timeoutCount: 0,
  elapsedMs: 3_600_000,
  scheduledCadenceMs: name === "public_result_convergence" ? null : (1_000 as const),
  convergenceWaveCount: name === "public_result_convergence" ? (2 as const) : (0 as const),
  convergenceSamplesPerWave: name === "public_result_convergence" ? (150 as const) : (0 as const),
  summary: {
    sampleCount: name === "public_result_convergence" ? 300 : 150,
    successfulCount: name === "public_result_convergence" ? 300 : 150,
    expectedFailureCount: 0,
    unexpectedFailureCount: 0,
    errorRate: 0,
    p50Ms: 10,
    p95Ms,
    p99Ms: p95Ms,
    maxMs: p95Ms,
  },
  correctness: { passed: true },
});
const workloadReceipt = () => ({
  artifact_kind: "gate-c-c5-integrated-workload-receipt" as const,
  source_sha: sourceSha,
  profile_id: plan.profile.profileId,
  approval_reference_sha256: sha(plan.profile.approval.reference),
  workload_plan_sha256: planHash,
  minimum_samples_per_operation: 150,
  duration_ms: 18_000_000,
  operations: {
    score_event_acknowledgement: operation("score_event_acknowledgement", 500),
    public_result_convergence: operation("public_result_convergence", 2_000),
    public_current_conditional_read: operation("public_current_conditional_read", 500),
    lease_takeover: operation("lease_takeover", 2_000),
    repair_publication: operation("repair_publication", 2_000),
  },
  controlled_failures: (
    [
      "postgres_interruption",
      "redis_interruption",
      "api_interruption",
      "web_interruption",
      "worker_interruption",
      "latency",
      "connection_pressure",
      "outbox_delay",
      "disk_pressure",
      "pdf_failure",
      "backup_restore",
      "projection_regeneration",
    ] as const satisfies readonly C5ControlledFailure[]
  ).map((fault) => ({
    fault,
    injector: "command" as const,
    injection_evidence_sha256: "d".repeat(64),
    recovery_evidence_sha256: "e".repeat(64),
    cleanup_evidence_sha256: "f".repeat(64),
    recovery_observed: true as const,
    cleanup_observed: true as const,
    recovery_oracle: `recovered_${fault}`,
  })),
  postgresql_identifier_sha256: "1".repeat(64),
  redis_namespace_sha256: "2".repeat(64),
});
const scenarios = {
  sign_in_and_scoring_preparation: "PASS",
  online_score_and_reversal: "PASS",
  offline_queueing: "PASS",
  refresh_and_browser_restart: "PASS",
  ordered_replay_and_duplicate_fencing: "PASS",
  pending_finalisation: "PASS",
  stale_generation_takeover_read_only: "PASS",
  sanitised_export: "PASS",
  final_public_projection: "PASS",
} as const;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function physical(platform: "iphone" | "ipad" | "budget_android", evidence = sha(`${platform}-evidence`)) {
  return {
    artifact_kind: "gate-c-c5-physical-device-receipt",
    source_sha: sourceSha,
    deployment_sha: sourceSha,
    profile_id: plan.profile.profileId,
    workload_plan_sha256: planHash,
    platform,
    device_identifier_sha256: sha(`${platform}-device`),
    trusted_https: true,
    scenarios,
    skipped_count: 0,
    console_errors: 0,
    network_errors: 0,
    service_worker_errors: 0,
    synchronisation_errors: 0,
    evidence_sha256: evidence,
  } as const;
}

function cache(run: 1 | 2, evidence = sha(`cache-${run}-evidence`)) {
  return {
    artifact_kind: "gate-c-c5-cache-lifecycle-receipt",
    source_sha: sourceSha,
    deployment_sha: sourceSha,
    profile_id: plan.profile.profileId,
    workload_plan_sha256: planHash,
    run_ordinal: run,
    fixture_identifier_sha256: sha(`fixture-${run}`),
    public_url_sha256: sha(`public-url-${run}`),
    edge_origin_sha256: sha(`edge-origin-${run}`),
    edge_path_query_sha256: sha(`path-query-${run}`),
    initial_cache_status: "MISS",
    repeated_cache_status: "HIT",
    public_cache_control_observed: true,
    etag_before_sha256: sha(`etag-before-${run}`),
    last_modified_before_utc: "2026-08-10T00:00:00.000Z",
    origin_url_sha256: sha(`origin-url-${run}`),
    origin_api_origin_sha256: sha(`origin-api-origin-${run}`),
    origin_path_query_sha256: sha(`path-query-${run}`),
    origin_request_method: "GET",
    origin_conditional_status: 304,
    origin_etag_sha256: sha(`etag-before-${run}`),
    origin_last_modified_utc: "2026-08-10T00:00:00.000Z",
    origin_publication_version: 4,
    origin_publication_version_header_sha256: sha("4"),
    publication_kind: "result",
    previous_publication_version: 4,
    published_version: 5,
    purge_job_status: "completed",
    purge_job_identifier_sha256: sha(`purge-${run}`),
    purge_bridge_status: 204,
    fresh_cache_status: "MISS",
    fresh_publication_version: 5,
    stable_cache_status: "HIT",
    etag_after_sha256: sha(`etag-after-${run}`),
    organiser_private: true,
    session_private: true,
    draft_private: true,
    skipped_count: 0,
    evidence_sha256: evidence,
  } as const;
}

function grafana(run: 1 | 2, evidence = sha(`grafana-${run}-evidence`)) {
  return {
    artifact_kind: "gate-c-c5-grafana-receipt",
    source_sha: sourceSha,
    deployment_sha: sourceSha,
    profile_id: plan.profile.profileId,
    workload_plan_sha256: planHash,
    run_ordinal: run,
    correlation_id: `c5-run-${run}`,
    window_started_at_utc: "2026-08-10T00:00:00.000Z",
    window_ended_at_utc: "2026-08-10T01:00:00.000Z",
    workload_visible: true,
    fault_visible: true,
    recovery_visible: true,
    alert_routed: true,
    alert_recovered: true,
    skipped_count: 0,
    evidence_sha256: evidence,
  } as const;
}

describe("Gate C C5 certification evidence contracts", () => {
  it("requires three distinct exact-SHA physical devices and every journey with no skips", () => {
    const receipts = [physical("budget_android"), physical("iphone"), physical("ipad")];
    expect(validateGateCC5PhysicalDeviceReceipts(receipts, expected).map((receipt) => receipt.platform)).toEqual([
      "iphone",
      "ipad",
      "budget_android",
    ]);
    expect(validateGateCC5PhysicalDeviceReceipt(receipts[1]!, { ...expected, platform: "iphone" })).toBe(receipts[1]);

    expect(() => validateGateCC5PhysicalDeviceReceipts([receipts[0], receipts[1]], expected)).toThrow("iPhone, iPad");
    expect(() =>
      validateGateCC5PhysicalDeviceReceipts(
        [
          receipts[0],
          receipts[1],
          { ...receipts[2]!, device_identifier_sha256: receipts[1]!.device_identifier_sha256 },
        ],
        expected,
      ),
    ).toThrow("reuse a device identity");
    expect(() =>
      validateGateCC5PhysicalDeviceReceipt({ ...receipts[1]!, skipped_count: 1 }, { ...expected, platform: "iphone" }),
    ).toThrow("failures, skips");
    expect(() =>
      validateGateCC5PhysicalDeviceReceipt(
        { ...receipts[1]!, source_sha: "b".repeat(40) },
        { ...expected, platform: "iphone" },
      ),
    ).toThrow("exact deployed source SHA");
    expect(() =>
      validateGateCC5PhysicalDeviceReceipt(receipts[1]!, {
        sourceSha,
        plan: { ...plan, maximumSamplesPerWorkerPerSecond: 2 },
        platform: "iphone",
      }),
    ).toThrow("unchanged approved pilot workload plan");
  });

  it("requires two isolated cache proofs with exact version, purge completion, and a fresh HIT", () => {
    const receipts = [cache(2), cache(1)];
    expect(validateGateCC5CacheLifecycleReceipts(receipts, expected).map((receipt) => receipt.run_ordinal)).toEqual([
      1, 2,
    ]);
    expect(validateGateCC5CacheLifecycleReceipt(receipts[1]!, expected)).toBe(receipts[1]);
    expect(() =>
      validateGateCC5CacheLifecycleReceipt({ ...receipts[1]!, fresh_publication_version: 6 }, expected),
    ).toThrow("MISS/HIT");
    expect(() =>
      validateGateCC5CacheLifecycleReceipt({ ...receipts[1]!, purge_job_status: "queued" }, expected),
    ).toThrow("MISS/HIT");
    expect(() =>
      validateGateCC5CacheLifecycleReceipts(
        [cache(1), { ...cache(2), fixture_identifier_sha256: cache(1).fixture_identifier_sha256 }],
        expected,
      ),
    ).toThrow("reuse a fixture");
    expect(() =>
      validateGateCC5CacheLifecycleReceipt(
        { ...receipts[1]!, origin_api_origin_sha256: receipts[1]!.edge_origin_sha256 },
        expected,
      ),
    ).toThrow("MISS/HIT");
    expect(() =>
      validateGateCC5CacheLifecycleReceipt({ ...receipts[1]!, origin_publication_version: 3 }, expected),
    ).toThrow("MISS/HIT");
  });

  it("requires exact-run Grafana workload, drill, recovery, and alert evidence", () => {
    const receipts = [grafana(1), grafana(2)];
    expect(validateGateCC5GrafanaReceipts(receipts, expected)).toHaveLength(2);
    expect(validateGateCC5GrafanaReceipt(receipts[0]!, expected)).toBe(receipts[0]);
    expect(() => validateGateCC5GrafanaReceipt({ ...receipts[0]!, alert_recovered: false }, expected)).toThrow(
      "incomplete workload",
    );
    expect(() =>
      validateGateCC5GrafanaReceipts(
        [receipts[0], { ...receipts[1]!, correlation_id: receipts[0]!.correlation_id }],
        expected,
      ),
    ).toThrow("reuse a correlation ID");
  });

  it("collects the live cache sequence and private-route policy instead of trusting caller statuses", async () => {
    const publicHeaders = (cacheStatus: "MISS" | "HIT", version: number, etag: string) => ({
      "x-vercel-cache": cacheStatus,
      "x-matchday-result-version": String(version),
      etag,
      "last-modified": "Sun, 10 Aug 2026 00:00:00 GMT",
      "cache-control": "public, max-age=60",
    });
    const responses = [
      new Response("{}", { status: 200, headers: publicHeaders("MISS", 4, "before") }),
      new Response("{}", { status: 200, headers: publicHeaders("HIT", 4, "before") }),
      new Response(null, {
        status: 304,
        headers: {
          etag: "before",
          "last-modified": "Sun, 10 Aug 2026 00:00:00 GMT",
          "x-matchday-result-version": "4",
        },
      }),
      new Response("{}", { status: 200, headers: publicHeaders("MISS", 5, "after") }),
      new Response("{}", { status: 200, headers: publicHeaders("HIT", 5, "after") }),
      ...Array.from(
        { length: 3 },
        () => new Response("{}", { status: 401, headers: { "cache-control": "private, no-store" } }),
      ),
    ];
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ? { url: url.toString(), init } : { url: url.toString() });
      return responses.shift() ?? new Response(null, { status: 500 });
    }) as typeof fetch;
    const result = await collectGateCC5CacheLifecycleReceipt({
      expected,
      runOrdinal: 1,
      fixtureIdentifier: "c5-fixture-run-1",
      publicUrl: "https://c5-staging.example/public",
      originRequest: { url: "https://render-origin.example/public", init: { headers: { "x-origin-proof": "c5" } } },
      publicationKind: "result",
      privateRequests: {
        organiser: { url: "https://c5-staging.example/organiser" },
        session: { url: "https://c5-staging.example/session" },
        draft: { url: "https://c5-staging.example/draft" },
      },
      publish: async () => ({ publishedVersion: 5 }),
      awaitPurge: async () => ({ status: "completed", jobIdentifier: "purge-job-1", bridgeStatus: 204 }),
      fetchImpl,
    });
    expect(result.receipt.fresh_publication_version).toBe(5);
    expect(result.receipt.origin_url_sha256).toBe(sha("https://render-origin.example/public"));
    expect(result.receipt.origin_request_method).toBe("GET");
    expect(result.receipt.origin_publication_version).toBe(4);
    expect(result.receipt.origin_publication_version_header_sha256).toBe(sha("4"));
    expect(result.receipt.evidence_sha256).toBe(sha(result.evidenceBytes));
    expect(requests[2]?.url).toBe("https://render-origin.example/public");
    expect(new Headers(requests[2]?.init?.headers).get("if-none-match")).toBe("before");
    expect(responses).toHaveLength(0);
    await expect(
      collectGateCC5CacheLifecycleReceipt({
        expected,
        runOrdinal: 1,
        fixtureIdentifier: "c5-fixture-run-1",
        publicUrl: "https://c5-staging.example/public",
        originRequest: { url: "https://render-origin.example/public" },
        publicationKind: "result",
        privateRequests: { organiser: { url: "https://c5-staging.example/organiser" } } as never,
        publish: async () => ({ publishedVersion: 5 }),
        awaitPurge: async () => ({ status: "completed", jobIdentifier: "purge-job-1", bridgeStatus: 204 }),
        fetchImpl,
      }),
    ).rejects.toThrow("private-route requests");
    await expect(
      collectGateCC5CacheLifecycleReceipt({
        expected,
        runOrdinal: 1,
        fixtureIdentifier: "c5-fixture-run-1",
        publicUrl: "https://c5-staging.example/public",
        originRequest: { url: "https://c5-staging.example/api-origin" },
        publicationKind: "result",
        privateRequests: {
          organiser: { url: "https://c5-staging.example/organiser" },
          session: { url: "https://c5-staging.example/session" },
          draft: { url: "https://c5-staging.example/draft" },
        },
        publish: async () => ({ publishedVersion: 5 }),
        awaitPurge: async () => ({ status: "completed", jobIdentifier: "purge-job-1", bridgeStatus: 204 }),
        fetchImpl,
      }),
    ).rejects.toThrow("distinct trusted-HTTPS origin/API");
    await expect(
      collectGateCC5CacheLifecycleReceipt({
        expected,
        runOrdinal: 1,
        fixtureIdentifier: "c5-fixture-run-1",
        publicUrl: "https://c5-staging.example/public?division=one",
        originRequest: { url: "https://render-origin.example/different?division=one", init: { method: "POST" } },
        publicationKind: "result",
        privateRequests: {
          organiser: { url: "https://c5-staging.example/organiser" },
          session: { url: "https://c5-staging.example/session" },
          draft: { url: "https://c5-staging.example/draft" },
        },
        publish: async () => ({ publishedVersion: 5 }),
        awaitPurge: async () => ({ status: "completed", jobIdentifier: "purge-job-1", bridgeStatus: 204 }),
        fetchImpl,
      }),
    ).rejects.toThrow("bodyless GET to the identical canonical path/query");
    const wrongOriginResponses = [
      new Response("{}", { status: 200, headers: publicHeaders("MISS", 4, "before") }),
      new Response("{}", { status: 200, headers: publicHeaders("HIT", 4, "before") }),
      new Response("{}", { status: 200, headers: publicHeaders("MISS", 4, "before") }),
    ];
    await expect(
      collectGateCC5CacheLifecycleReceipt({
        expected,
        runOrdinal: 1,
        fixtureIdentifier: "c5-fixture-run-1",
        publicUrl: "https://c5-staging.example/public",
        originRequest: { url: "https://render-origin.example/public" },
        publicationKind: "result",
        privateRequests: {
          organiser: { url: "https://c5-staging.example/organiser" },
          session: { url: "https://c5-staging.example/session" },
          draft: { url: "https://c5-staging.example/draft" },
        },
        publish: async () => ({ publishedVersion: 5 }),
        awaitPurge: async () => ({ status: "completed", jobIdentifier: "purge-job-1", bridgeStatus: 204 }),
        fetchImpl: (async () => wrongOriginResponses.shift() ?? new Response(null, { status: 500 })) as typeof fetch,
      }),
    ).rejects.toThrow("origin/API ETag-bound conditional read");
    const wrongVersionResponses = [
      new Response("{}", { status: 200, headers: publicHeaders("MISS", 4, "before") }),
      new Response("{}", { status: 200, headers: publicHeaders("HIT", 4, "before") }),
      new Response(null, {
        status: 304,
        headers: {
          etag: "before",
          "last-modified": "Sun, 10 Aug 2026 00:00:00 GMT",
          "x-matchday-result-version": "3",
        },
      }),
    ];
    await expect(
      collectGateCC5CacheLifecycleReceipt({
        expected,
        runOrdinal: 1,
        fixtureIdentifier: "c5-fixture-run-1",
        publicUrl: "https://c5-staging.example/public",
        originRequest: { url: "https://render-origin.example/public" },
        publicationKind: "result",
        privateRequests: {
          organiser: { url: "https://c5-staging.example/organiser" },
          session: { url: "https://c5-staging.example/session" },
          draft: { url: "https://c5-staging.example/draft" },
        },
        publish: async () => ({ publishedVersion: 5 }),
        awaitPurge: async () => ({ status: "completed", jobIdentifier: "purge-job-1", bridgeStatus: 204 }),
        fetchImpl: (async () => wrongVersionResponses.shift() ?? new Response(null, { status: 500 })) as typeof fetch,
      }),
    ).rejects.toThrow("exact 304 freshness metadata");
  });

  it("queries Grafana workload, fault, recovery, and alert surfaces and hashes actual responses", async () => {
    const queryKinds = ["workload", "fault", "recovery", "alert_routed", "alert_recovered"] as const;
    const responses = queryKinds.map(
      (kind) =>
        new Response(
          JSON.stringify({
            status: "success",
            data: {
              result: [{ metric: { correlation_id: "c5-run-2", evidence_kind: kind }, values: [[1_786_321_800, "1"]] }],
            },
          }),
          { status: 200 },
        ),
    );
    const result = await collectGateCC5GrafanaReceipt({
      expected,
      runOrdinal: 2,
      correlationId: "c5-run-2",
      windowStartedAtUtc: "2026-08-10T00:00:00.000Z",
      windowEndedAtUtc: "2026-08-10T01:00:00.000Z",
      queries: {
        workload: { url: "https://grafana.example/workload" },
        fault: { url: "https://grafana.example/fault" },
        recovery: { url: "https://grafana.example/recovery" },
        alert_routed: { url: "https://grafana.example/alert-routed" },
        alert_recovered: { url: "https://grafana.example/alert-recovered" },
      },
      fetchImpl: (async () => responses.shift() ?? new Response(null, { status: 500 })) as typeof fetch,
    });
    expect(result.receipt.workload_visible).toBe(true);
    expect(result.receipt.evidence_sha256).toBe(sha(result.evidenceBytes));
    expect(responses).toHaveLength(0);
  });

  it("rejects unrelated nonempty Grafana results and cannot infer both alert states from one query", async () => {
    const response = new Response(
      JSON.stringify({
        status: "success",
        data: {
          result: [
            { metric: { correlation_id: "another-run", evidence_kind: "workload" }, values: [[1_786_321_800, "1"]] },
          ],
        },
      }),
      { status: 200 },
    );
    await expect(
      collectGateCC5GrafanaReceipt({
        expected,
        runOrdinal: 1,
        correlationId: "c5-run-1",
        windowStartedAtUtc: "2026-08-10T00:00:00.000Z",
        windowEndedAtUtc: "2026-08-10T01:00:00.000Z",
        queries: {
          workload: { url: "https://grafana.example/workload" },
          fault: { url: "https://grafana.example/fault" },
          recovery: { url: "https://grafana.example/recovery" },
          alert_routed: { url: "https://grafana.example/alert-routed" },
          alert_recovered: { url: "https://grafana.example/alert-recovered" },
        },
        fetchImpl: (async () => response.clone()) as typeof fetch,
      }),
    ).rejects.toThrow("unrelated to the exact run");
    await expect(
      collectGateCC5GrafanaReceipt({
        expected,
        runOrdinal: 1,
        correlationId: "c5-run-1",
        windowStartedAtUtc: "2026-08-10T00:00:00.000Z",
        windowEndedAtUtc: "2026-08-10T01:00:00.000Z",
        queries: { workload: { url: "https://grafana.example/workload" } } as never,
        fetchImpl: (async () => response.clone()) as typeof fetch,
      }),
    ).rejects.toThrow("Grafana queries");
  });
});

describe("Gate C C5 retained evidence and final seal", () => {
  it("rehashes regular files and rejects symlinks, oversized files, secrets, and topology", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gate-c-c5-artifacts-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "clean.log"), "status=PASS\n", "utf8");
    expect(await collectGateCC5RetainedArtifacts(root)).toEqual([
      { path: "clean.log", bytes: 12, sha256: sha("status=PASS\n") },
    ]);

    await symlink(path.join(root, "clean.log"), path.join(root, "linked.log"));
    await expect(collectGateCC5RetainedArtifacts(root)).rejects.toThrow("symlink");
    await rm(path.join(root, "linked.log"));
    await writeFile(path.join(root, "topology.log"), "redis://cache.internal:6379", "utf8");
    await expect(collectGateCC5RetainedArtifacts(root)).rejects.toThrow("sensitive topology");
    await rm(path.join(root, "topology.log"));
    await writeFile(path.join(root, "secret.json"), '{"api_key":"unsafe"}', "utf8");
    await expect(collectGateCC5RetainedArtifacts(root)).rejects.toThrow("credentials");
    await rm(path.join(root, "secret.json"));
    await writeFile(
      path.join(root, "secret.env"),
      'API_KEY=unsafe\nCookie: session=unsafe\nX-API-Key: unsafe\n{"access_token":"unsafe","refresh_token":"unsafe"}',
      "utf8",
    );
    await expect(collectGateCC5RetainedArtifacts(root)).rejects.toThrow("credentials");
    await rm(path.join(root, "secret.env"));
    await writeFile(path.join(root, "oversized.bin"), Buffer.alloc(5 * 1024 * 1024 + 1));
    await expect(collectGateCC5RetainedArtifacts(root)).rejects.toThrow("exceeds 5 MiB");
  });

  it("writes a hash-bound manifest and immutable final tree seal, then reopens both", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gate-c-c5-seal-"));
    temporaryDirectories.push(root);
    const retained = {
      workload: `${JSON.stringify(workloadReceipt(), null, 2)}\n`,
      iphone: "iphone evidence bytes",
      ipad: "ipad evidence bytes",
      android: "android evidence bytes",
      cache1: "cache one evidence bytes",
      cache2: "cache two evidence bytes",
      grafana1: "grafana one evidence bytes",
      grafana2: "grafana two evidence bytes",
    };
    await Promise.all(
      Object.entries(retained).map(([name, bytes]) => writeFile(path.join(root, `${name}.log`), bytes, "utf8")),
    );
    const physicalDevices = [
      physical("iphone", sha(retained.iphone)),
      physical("ipad", sha(retained.ipad)),
      physical("budget_android", sha(retained.android)),
    ];
    const cacheLifecycle = [cache(1, sha(retained.cache1)), cache(2, sha(retained.cache2))];
    const grafanaReceipts = [grafana(1, sha(retained.grafana1)), grafana(2, sha(retained.grafana2))];
    const result = await writeGateCC5EvidenceManifestAndSeal({
      evidenceRoot: root,
      expected,
      physicalDevices,
      cacheLifecycle,
      grafana: grafanaReceipts,
      generatedAtUtc: "2026-08-10T02:00:00.000Z",
    });
    expect(
      validateGateCC5EvidenceManifest(JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")), expected),
    ).toEqual(result.manifest);
    expect(result.seal.entries.some((entry) => entry.path === "manifest.json")).toBe(true);
    expect(result.seal.tree_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(await verifyGateCC5EvidenceSeal(root, { sourceSha })).toEqual(result.seal);
    expect((await lstat(path.join(root, "seal.json"))).mode & 0o222).toBe(0);
    expect((await lstat(root)).mode & 0o222).toBe(0);
    await expect(
      writeGateCC5EvidenceManifestAndSeal({
        evidenceRoot: root,
        expected,
        physicalDevices,
        cacheLifecycle,
        grafana: grafanaReceipts,
      }),
    ).rejects.toThrow("already sealed");
    await chmod(root, 0o755);
  });

  it("refuses a manifest without one semantically valid retained workload receipt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gate-c-c5-missing-bytes-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "only.log"), "unrelated", "utf8");
    await expect(
      writeGateCC5EvidenceManifestAndSeal({
        evidenceRoot: root,
        expected,
        physicalDevices: [physical("iphone"), physical("ipad"), physical("budget_android")],
        cacheLifecycle: [cache(1), cache(2)],
        grafana: [grafana(1), grafana(2)],
      }),
    ).rejects.toThrow("semantically valid retained workload receipt");
  });
});
