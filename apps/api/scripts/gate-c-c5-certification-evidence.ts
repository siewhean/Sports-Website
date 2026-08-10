import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { C5ApprovedWorkloadPlan } from "@matchday/observability";
import { validateGateCC5Receipt } from "./gate-c-c5-evidence.js";

const SHA40 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_CODE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,199}$/u;
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const PHYSICAL_PLATFORMS = ["iphone", "ipad", "budget_android"] as const;
const PHYSICAL_SCENARIOS = [
  "sign_in_and_scoring_preparation",
  "online_score_and_reversal",
  "offline_queueing",
  "refresh_and_browser_restart",
  "ordered_replay_and_duplicate_fencing",
  "pending_finalisation",
  "stale_generation_takeover_read_only",
  "sanitised_export",
  "final_public_projection",
] as const;
const APPROVED_C5_PLAN = {
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

export type GateCC5PhysicalPlatform = (typeof PHYSICAL_PLATFORMS)[number];
export type GateCC5EvidenceBinding = Readonly<{
  sourceSha: string;
  plan: C5ApprovedWorkloadPlan;
}>;

export type GateCC5PhysicalDeviceReceipt = Readonly<{
  artifact_kind: "gate-c-c5-physical-device-receipt";
  source_sha: string;
  deployment_sha: string;
  profile_id: string;
  workload_plan_sha256: string;
  platform: GateCC5PhysicalPlatform;
  device_identifier_sha256: string;
  trusted_https: true;
  scenarios: Readonly<Record<(typeof PHYSICAL_SCENARIOS)[number], "PASS">>;
  skipped_count: 0;
  console_errors: 0;
  network_errors: 0;
  service_worker_errors: 0;
  synchronisation_errors: 0;
  evidence_sha256: string;
}>;

export type GateCC5CacheLifecycleReceipt = Readonly<{
  artifact_kind: "gate-c-c5-cache-lifecycle-receipt";
  source_sha: string;
  deployment_sha: string;
  profile_id: string;
  workload_plan_sha256: string;
  run_ordinal: 1 | 2;
  fixture_identifier_sha256: string;
  public_url_sha256: string;
  edge_origin_sha256: string;
  edge_path_query_sha256: string;
  initial_cache_status: "MISS";
  repeated_cache_status: "HIT";
  public_cache_control_observed: true;
  etag_before_sha256: string;
  last_modified_before_utc: string;
  origin_url_sha256: string;
  origin_api_origin_sha256: string;
  origin_path_query_sha256: string;
  origin_request_method: "GET";
  origin_conditional_status: 304;
  origin_etag_sha256: string;
  origin_last_modified_utc: string;
  origin_publication_version: number;
  origin_publication_version_header_sha256: string;
  publication_kind: "result" | "schedule";
  previous_publication_version: number;
  published_version: number;
  purge_job_status: "completed";
  purge_job_identifier_sha256: string;
  purge_bridge_status: 204;
  fresh_cache_status: "MISS";
  fresh_publication_version: number;
  stable_cache_status: "HIT";
  etag_after_sha256: string;
  organiser_private: true;
  session_private: true;
  draft_private: true;
  skipped_count: 0;
  evidence_sha256: string;
}>;

export type GateCC5GrafanaReceipt = Readonly<{
  artifact_kind: "gate-c-c5-grafana-receipt";
  source_sha: string;
  deployment_sha: string;
  profile_id: string;
  workload_plan_sha256: string;
  run_ordinal: 1 | 2;
  correlation_id: string;
  window_started_at_utc: string;
  window_ended_at_utc: string;
  workload_visible: true;
  fault_visible: true;
  recovery_visible: true;
  alert_routed: true;
  alert_recovered: true;
  skipped_count: 0;
  evidence_sha256: string;
}>;

export type GateCC5ArtifactEntry = Readonly<{ path: string; bytes: number; sha256: string }>;

export type GateCC5EvidenceManifest = Readonly<{
  schema_version: 1;
  artifact_kind: "gate-c-c5-certification-evidence-manifest";
  source_sha: string;
  profile_id: string;
  workload_plan_sha256: string;
  workload_receipt_sha256: string;
  generated_at_utc: string;
  physical_devices: readonly GateCC5PhysicalDeviceReceipt[];
  cache_lifecycle: readonly GateCC5CacheLifecycleReceipt[];
  grafana: readonly GateCC5GrafanaReceipt[];
  artifacts: readonly GateCC5ArtifactEntry[];
  skipped_count: 0;
  final_status: "PASS";
}>;

export type GateCC5EvidenceSeal = Readonly<{
  schema_version: 1;
  artifact_kind: "gate-c-c5-certification-evidence-seal";
  source_sha: string;
  manifest_sha256: string;
  entries: readonly GateCC5ArtifactEntry[];
  tree_sha256: string;
}>;

export type GateCC5CacheCollectionResult = Readonly<{
  receipt: GateCC5CacheLifecycleReceipt;
  evidenceBytes: Buffer;
}>;

export type GateCC5GrafanaCollectionResult = Readonly<{
  receipt: GateCC5GrafanaReceipt;
  evidenceBytes: Buffer;
}>;

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Gate C C5 evidence contains an unsupported value");
  return encoded;
}

export function gateCC5WorkloadPlanSha256(plan: C5ApprovedWorkloadPlan): string {
  return hash(stableJson(plan));
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? (value as Record<string, unknown>) : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`Gate C C5 ${label} has unsupported or missing fields`);
  }
}

function assertBinding(value: Record<string, unknown>, expected: GateCC5EvidenceBinding, label: string): void {
  if (stableJson(expected.plan) !== stableJson(APPROVED_C5_PLAN)) {
    throw new Error("Gate C C5 evidence requires the unchanged approved pilot workload plan");
  }
  if (
    !SHA40.test(expected.sourceSha) ||
    value.source_sha !== expected.sourceSha ||
    value.deployment_sha !== expected.sourceSha
  ) {
    throw new Error(`Gate C C5 ${label} is not bound to the exact deployed source SHA`);
  }
  if (
    value.profile_id !== expected.plan.profile.profileId ||
    value.workload_plan_sha256 !== gateCC5WorkloadPlanSha256(expected.plan)
  ) {
    throw new Error(`Gate C C5 ${label} is not bound to the approved workload profile`);
  }
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`Gate C C5 ${label} must be a SHA-256`);
}

function validUtc(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

const physicalKeys = [
  "artifact_kind",
  "source_sha",
  "deployment_sha",
  "profile_id",
  "workload_plan_sha256",
  "platform",
  "device_identifier_sha256",
  "trusted_https",
  "scenarios",
  "skipped_count",
  "console_errors",
  "network_errors",
  "service_worker_errors",
  "synchronisation_errors",
  "evidence_sha256",
] as const;

export function validateGateCC5PhysicalDeviceReceipt(
  value: unknown,
  expected: GateCC5EvidenceBinding & Readonly<{ platform: GateCC5PhysicalPlatform }>,
): GateCC5PhysicalDeviceReceipt {
  const receipt = record(value);
  if (!receipt) throw new Error("Gate C C5 physical-device receipt must be an object");
  exactKeys(receipt, physicalKeys, "physical-device receipt");
  assertBinding(receipt, expected, "physical-device receipt");
  const scenarios = record(receipt.scenarios);
  if (!scenarios) throw new Error("Gate C C5 physical-device scenarios must be an object");
  exactKeys(scenarios, PHYSICAL_SCENARIOS, "physical-device scenarios");
  if (
    receipt.artifact_kind !== "gate-c-c5-physical-device-receipt" ||
    receipt.platform !== expected.platform ||
    receipt.trusted_https !== true ||
    PHYSICAL_SCENARIOS.some((scenario) => scenarios[scenario] !== "PASS") ||
    receipt.skipped_count !== 0 ||
    receipt.console_errors !== 0 ||
    receipt.network_errors !== 0 ||
    receipt.service_worker_errors !== 0 ||
    receipt.synchronisation_errors !== 0
  ) {
    throw new Error(`Gate C C5 ${expected.platform} receipt has failures, skips, or incomplete trusted-HTTPS proof`);
  }
  assertHash(receipt.device_identifier_sha256, `${expected.platform} device identifier`);
  assertHash(receipt.evidence_sha256, `${expected.platform} evidence`);
  return receipt as GateCC5PhysicalDeviceReceipt;
}

export function validateGateCC5PhysicalDeviceReceipts(
  values: unknown,
  expected: GateCC5EvidenceBinding,
): readonly GateCC5PhysicalDeviceReceipt[] {
  if (!Array.isArray(values) || values.length !== PHYSICAL_PLATFORMS.length) {
    throw new Error("Gate C C5 requires distinct iPhone, iPad, and budget Android receipts");
  }
  const receipts = PHYSICAL_PLATFORMS.map((platform) => {
    const matches = values.filter((value) => record(value)?.platform === platform);
    if (matches.length !== 1) throw new Error(`Gate C C5 requires exactly one ${platform} receipt`);
    return validateGateCC5PhysicalDeviceReceipt(matches[0], { ...expected, platform });
  });
  if (new Set(receipts.map((receipt) => receipt.device_identifier_sha256)).size !== receipts.length) {
    throw new Error("Gate C C5 physical-device receipts reuse a device identity");
  }
  return receipts;
}

const cacheKeys = [
  "artifact_kind",
  "source_sha",
  "deployment_sha",
  "profile_id",
  "workload_plan_sha256",
  "run_ordinal",
  "fixture_identifier_sha256",
  "public_url_sha256",
  "edge_origin_sha256",
  "edge_path_query_sha256",
  "initial_cache_status",
  "repeated_cache_status",
  "public_cache_control_observed",
  "etag_before_sha256",
  "last_modified_before_utc",
  "origin_url_sha256",
  "origin_api_origin_sha256",
  "origin_path_query_sha256",
  "origin_request_method",
  "origin_conditional_status",
  "origin_etag_sha256",
  "origin_last_modified_utc",
  "origin_publication_version",
  "origin_publication_version_header_sha256",
  "publication_kind",
  "previous_publication_version",
  "published_version",
  "purge_job_status",
  "purge_job_identifier_sha256",
  "purge_bridge_status",
  "fresh_cache_status",
  "fresh_publication_version",
  "stable_cache_status",
  "etag_after_sha256",
  "organiser_private",
  "session_private",
  "draft_private",
  "skipped_count",
  "evidence_sha256",
] as const;

export function validateGateCC5CacheLifecycleReceipt(
  value: unknown,
  expected: GateCC5EvidenceBinding,
): GateCC5CacheLifecycleReceipt {
  const receipt = record(value);
  if (!receipt) throw new Error("Gate C C5 cache-lifecycle receipt must be an object");
  exactKeys(receipt, cacheKeys, "cache-lifecycle receipt");
  assertBinding(receipt, expected, "cache-lifecycle receipt");
  for (const key of [
    "fixture_identifier_sha256",
    "public_url_sha256",
    "edge_origin_sha256",
    "edge_path_query_sha256",
    "etag_before_sha256",
    "origin_url_sha256",
    "origin_api_origin_sha256",
    "origin_path_query_sha256",
    "origin_etag_sha256",
    "origin_publication_version_header_sha256",
    "etag_after_sha256",
    "purge_job_identifier_sha256",
    "evidence_sha256",
  ] as const) {
    assertHash(receipt[key], `cache ${key}`);
  }
  const previous = receipt.previous_publication_version;
  const published = receipt.published_version;
  if (
    receipt.artifact_kind !== "gate-c-c5-cache-lifecycle-receipt" ||
    (receipt.run_ordinal !== 1 && receipt.run_ordinal !== 2) ||
    receipt.initial_cache_status !== "MISS" ||
    receipt.repeated_cache_status !== "HIT" ||
    receipt.public_cache_control_observed !== true ||
    !validUtc(receipt.last_modified_before_utc) ||
    receipt.origin_conditional_status !== 304 ||
    receipt.origin_request_method !== "GET" ||
    !validUtc(receipt.origin_last_modified_utc) ||
    receipt.origin_etag_sha256 !== receipt.etag_before_sha256 ||
    receipt.origin_last_modified_utc !== receipt.last_modified_before_utc ||
    receipt.origin_api_origin_sha256 === receipt.edge_origin_sha256 ||
    receipt.origin_path_query_sha256 !== receipt.edge_path_query_sha256 ||
    (receipt.publication_kind !== "result" && receipt.publication_kind !== "schedule") ||
    !Number.isSafeInteger(previous) ||
    !Number.isSafeInteger(published) ||
    (previous as number) < 0 ||
    (published as number) !== (previous as number) + 1 ||
    receipt.origin_publication_version !== previous ||
    receipt.origin_publication_version_header_sha256 !== hash(String(previous)) ||
    receipt.purge_job_status !== "completed" ||
    receipt.purge_bridge_status !== 204 ||
    receipt.fresh_cache_status !== "MISS" ||
    receipt.fresh_publication_version !== published ||
    receipt.stable_cache_status !== "HIT" ||
    receipt.etag_before_sha256 === receipt.etag_after_sha256 ||
    receipt.organiser_private !== true ||
    receipt.session_private !== true ||
    receipt.draft_private !== true ||
    receipt.skipped_count !== 0
  ) {
    throw new Error("Gate C C5 cache lifecycle did not prove MISS/HIT, exact publication, purge, and fresh HIT");
  }
  return receipt as GateCC5CacheLifecycleReceipt;
}

export function validateGateCC5CacheLifecycleReceipts(
  values: unknown,
  expected: GateCC5EvidenceBinding,
): readonly GateCC5CacheLifecycleReceipt[] {
  if (!Array.isArray(values) || values.length !== 2)
    throw new Error("Gate C C5 requires cache lifecycle evidence from both ledger runs");
  const receipts = [1, 2].map((run) => {
    const matches = values.filter((value) => record(value)?.run_ordinal === run);
    if (matches.length !== 1) throw new Error(`Gate C C5 requires exactly one cache receipt for run ${run}`);
    return validateGateCC5CacheLifecycleReceipt(matches[0], expected);
  });
  if (new Set(receipts.map((receipt) => receipt.fixture_identifier_sha256)).size !== 2) {
    throw new Error("Gate C C5 cache lifecycle receipts reuse a fixture");
  }
  return receipts;
}

function requiredResponseHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (!value?.trim()) throw new Error(`Gate C C5 cache response is missing ${name}`);
  return value;
}

function responseVersion(response: Response, publicationKind: "result" | "schedule"): number {
  const value = Number(requiredResponseHeader(response, `x-matchday-${publicationKind}-version`));
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Gate C C5 cache response has an invalid publication version");
  return value;
}

function assertCacheResponse(response: Response, status: number, cacheStatus: "MISS" | "HIT", label: string): void {
  if (response.status !== status || response.headers.get("x-vercel-cache") !== cacheStatus) {
    throw new Error(`Gate C C5 ${label} did not return HTTP ${status} with x-vercel-cache ${cacheStatus}`);
  }
}

/**
 * Captures the live edge lifecycle. Publishing and BullMQ observation remain
 * deployment-specific callbacks, but every HTTP/cache assertion is performed
 * here and only sanitised hashes are returned for retention.
 */
export async function collectGateCC5CacheLifecycleReceipt(
  input: Readonly<{
    expected: GateCC5EvidenceBinding;
    runOrdinal: 1 | 2;
    fixtureIdentifier: string;
    publicUrl: string | URL;
    originRequest: Readonly<{ url: string | URL; init?: RequestInit }>;
    publicationKind: "result" | "schedule";
    privateRequests: Readonly<
      Record<"organiser" | "session" | "draft", Readonly<{ url: string | URL; init?: RequestInit }>>
    >;
    publish: () => Promise<Readonly<{ publishedVersion: number }>>;
    awaitPurge: () => Promise<Readonly<{ status: "completed"; jobIdentifier: string; bridgeStatus: 204 }>>;
    fetchImpl?: typeof fetch;
  }>,
): Promise<GateCC5CacheCollectionResult> {
  if (!SAFE_CODE.test(input.fixtureIdentifier)) throw new Error("Gate C C5 cache fixture identifier is unsafe");
  const privateRequests = record(input.privateRequests);
  if (!privateRequests) throw new Error("Gate C C5 cache private-route requests must be an object");
  exactKeys(privateRequests, ["organiser", "session", "draft"], "cache private-route requests");
  const fetcher = input.fetchImpl ?? fetch;
  const publicUrl = new URL(input.publicUrl);
  if (publicUrl.protocol !== "https:") throw new Error("Gate C C5 cache collector requires trusted HTTPS");
  const originUrl = new URL(input.originRequest.url);
  const configuredOriginMethod = input.originRequest.init?.method;
  const originMethod = "GET";
  if (
    originUrl.protocol !== "https:" ||
    originUrl.origin === publicUrl.origin ||
    (configuredOriginMethod !== undefined && configuredOriginMethod !== "GET") ||
    (input.originRequest.init?.body !== undefined && input.originRequest.init.body !== null) ||
    originUrl.pathname !== publicUrl.pathname ||
    originUrl.search !== publicUrl.search
  ) {
    throw new Error(
      "Gate C C5 cache collector requires a bodyless GET to the identical canonical path/query on a distinct trusted-HTTPS origin/API",
    );
  }
  const initial = await fetcher(publicUrl, { headers: { accept: "application/json" } });
  assertCacheResponse(initial, 200, "MISS", "initial public read");
  const beforeVersion = responseVersion(initial, input.publicationKind);
  const beforeEtag = requiredResponseHeader(initial, "etag");
  const beforeLastModified = requiredResponseHeader(initial, "last-modified");
  const cacheControl = requiredResponseHeader(initial, "cache-control");
  if (!/\bpublic\b/iu.test(cacheControl)) throw new Error("Gate C C5 public projection is not publicly cacheable");
  await initial.arrayBuffer();
  const repeated = await fetcher(publicUrl, { headers: { accept: "application/json" } });
  assertCacheResponse(repeated, 200, "HIT", "repeated public read");
  if (
    responseVersion(repeated, input.publicationKind) !== beforeVersion ||
    requiredResponseHeader(repeated, "etag") !== beforeEtag
  ) {
    throw new Error("Gate C C5 repeated cache HIT changed the public projection");
  }
  await repeated.arrayBuffer();
  const originHeaders = new Headers(input.originRequest.init?.headers);
  originHeaders.set("if-none-match", beforeEtag);
  const originConditional = await fetcher(originUrl, { ...input.originRequest.init, headers: originHeaders });
  const originEtag = requiredResponseHeader(originConditional, "etag");
  const originLastModified = requiredResponseHeader(originConditional, "last-modified");
  const originVersionHeader = requiredResponseHeader(originConditional, `x-matchday-${input.publicationKind}-version`);
  const originVersion = Number(originVersionHeader);
  if (
    originConditional.status !== 304 ||
    originEtag !== beforeEtag ||
    new Date(originLastModified).toISOString() !== new Date(beforeLastModified).toISOString() ||
    !Number.isSafeInteger(originVersion) ||
    originVersion !== beforeVersion
  ) {
    throw new Error("Gate C C5 origin/API ETag-bound conditional read did not return the exact 304 freshness metadata");
  }
  const publication = await input.publish();
  if (publication.publishedVersion !== beforeVersion + 1)
    throw new Error("Gate C C5 publication did not advance the exact version by one");
  const purge = await input.awaitPurge();
  if (purge.status !== "completed" || purge.bridgeStatus !== 204 || !SAFE_CODE.test(purge.jobIdentifier)) {
    throw new Error("Gate C C5 BullMQ purge did not complete through the authenticated bridge");
  }
  const fresh = await fetcher(publicUrl, { headers: { accept: "application/json" } });
  assertCacheResponse(fresh, 200, "MISS", "fresh public read");
  const freshVersion = responseVersion(fresh, input.publicationKind);
  const afterEtag = requiredResponseHeader(fresh, "etag");
  if (freshVersion !== publication.publishedVersion || afterEtag === beforeEtag) {
    throw new Error("Gate C C5 fresh projection is not the exact published version");
  }
  await fresh.arrayBuffer();
  const stable = await fetcher(publicUrl, { headers: { accept: "application/json" } });
  assertCacheResponse(stable, 200, "HIT", "stable public read");
  if (
    responseVersion(stable, input.publicationKind) !== publication.publishedVersion ||
    requiredResponseHeader(stable, "etag") !== afterEtag
  ) {
    throw new Error("Gate C C5 stable HIT is not the fresh public projection");
  }
  await stable.arrayBuffer();
  for (const [kind, request] of Object.entries(input.privateRequests)) {
    const response = await fetcher(request.url, request.init);
    const privateCacheControl = response.headers.get("cache-control") ?? "";
    if (response.headers.get("x-vercel-cache") === "HIT" || !/\b(?:private|no-store)\b/iu.test(privateCacheControl)) {
      throw new Error(`Gate C C5 ${kind} route is shared-cacheable`);
    }
    await response.arrayBuffer();
  }
  const trace = {
    run_ordinal: input.runOrdinal,
    fixture_identifier_sha256: hash(input.fixtureIdentifier),
    public_url_sha256: hash(publicUrl.toString()),
    edge_origin_sha256: hash(publicUrl.origin),
    edge_path_query_sha256: hash(`${publicUrl.pathname}${publicUrl.search}`),
    origin_url_sha256: hash(originUrl.toString()),
    origin_api_origin_sha256: hash(originUrl.origin),
    origin_path_query_sha256: hash(`${originUrl.pathname}${originUrl.search}`),
    origin_request_method: originMethod,
    before_version: beforeVersion,
    published_version: publication.publishedVersion,
    purge_job_identifier_sha256: hash(purge.jobIdentifier),
    purge_bridge_status: purge.bridgeStatus,
    cache_sequence: ["MISS", "HIT", "MISS", "HIT"],
    origin_conditional_status: originConditional.status,
    origin_etag_sha256: hash(originEtag),
    origin_last_modified_utc: new Date(originLastModified).toISOString(),
    origin_publication_version: originVersion,
    origin_publication_version_header_sha256: hash(originVersionHeader),
  };
  const evidenceBytes = Buffer.from(`${JSON.stringify(trace, null, 2)}\n`, "utf8");
  const receipt = validateGateCC5CacheLifecycleReceipt(
    {
      artifact_kind: "gate-c-c5-cache-lifecycle-receipt",
      source_sha: input.expected.sourceSha,
      deployment_sha: input.expected.sourceSha,
      profile_id: input.expected.plan.profile.profileId,
      workload_plan_sha256: gateCC5WorkloadPlanSha256(input.expected.plan),
      run_ordinal: input.runOrdinal,
      fixture_identifier_sha256: hash(input.fixtureIdentifier),
      public_url_sha256: hash(publicUrl.toString()),
      edge_origin_sha256: hash(publicUrl.origin),
      edge_path_query_sha256: hash(`${publicUrl.pathname}${publicUrl.search}`),
      initial_cache_status: "MISS",
      repeated_cache_status: "HIT",
      public_cache_control_observed: true,
      etag_before_sha256: hash(beforeEtag),
      last_modified_before_utc: new Date(beforeLastModified).toISOString(),
      origin_url_sha256: hash(originUrl.toString()),
      origin_api_origin_sha256: hash(originUrl.origin),
      origin_path_query_sha256: hash(`${originUrl.pathname}${originUrl.search}`),
      origin_request_method: "GET",
      origin_conditional_status: 304,
      origin_etag_sha256: hash(originEtag),
      origin_last_modified_utc: new Date(originLastModified).toISOString(),
      origin_publication_version: originVersion,
      origin_publication_version_header_sha256: hash(originVersionHeader),
      publication_kind: input.publicationKind,
      previous_publication_version: beforeVersion,
      published_version: publication.publishedVersion,
      purge_job_status: "completed",
      purge_job_identifier_sha256: hash(purge.jobIdentifier),
      purge_bridge_status: 204,
      fresh_cache_status: "MISS",
      fresh_publication_version: freshVersion,
      stable_cache_status: "HIT",
      etag_after_sha256: hash(afterEtag),
      organiser_private: true,
      session_private: true,
      draft_private: true,
      skipped_count: 0,
      evidence_sha256: hash(evidenceBytes),
    },
    input.expected,
  );
  return { receipt, evidenceBytes };
}

const grafanaKeys = [
  "artifact_kind",
  "source_sha",
  "deployment_sha",
  "profile_id",
  "workload_plan_sha256",
  "run_ordinal",
  "correlation_id",
  "window_started_at_utc",
  "window_ended_at_utc",
  "workload_visible",
  "fault_visible",
  "recovery_visible",
  "alert_routed",
  "alert_recovered",
  "skipped_count",
  "evidence_sha256",
] as const;

export function validateGateCC5GrafanaReceipt(value: unknown, expected: GateCC5EvidenceBinding): GateCC5GrafanaReceipt {
  const receipt = record(value);
  if (!receipt) throw new Error("Gate C C5 Grafana receipt must be an object");
  exactKeys(receipt, grafanaKeys, "Grafana receipt");
  assertBinding(receipt, expected, "Grafana receipt");
  if (
    receipt.artifact_kind !== "gate-c-c5-grafana-receipt" ||
    (receipt.run_ordinal !== 1 && receipt.run_ordinal !== 2) ||
    typeof receipt.correlation_id !== "string" ||
    !SAFE_CODE.test(receipt.correlation_id) ||
    !validUtc(receipt.window_started_at_utc) ||
    !validUtc(receipt.window_ended_at_utc) ||
    Date.parse(receipt.window_ended_at_utc as string) <= Date.parse(receipt.window_started_at_utc as string) ||
    receipt.workload_visible !== true ||
    receipt.fault_visible !== true ||
    receipt.recovery_visible !== true ||
    receipt.alert_routed !== true ||
    receipt.alert_recovered !== true ||
    receipt.skipped_count !== 0
  ) {
    throw new Error("Gate C C5 Grafana receipt has incomplete workload, fault, recovery, or alert evidence");
  }
  assertHash(receipt.evidence_sha256, "Grafana evidence");
  return receipt as GateCC5GrafanaReceipt;
}

export function validateGateCC5GrafanaReceipts(
  values: unknown,
  expected: GateCC5EvidenceBinding,
): readonly GateCC5GrafanaReceipt[] {
  if (!Array.isArray(values) || values.length !== 2)
    throw new Error("Gate C C5 requires Grafana evidence from both ledger runs");
  const receipts = [1, 2].map((run) => {
    const matches = values.filter((value) => record(value)?.run_ordinal === run);
    if (matches.length !== 1) throw new Error(`Gate C C5 requires exactly one Grafana receipt for run ${run}`);
    return validateGateCC5GrafanaReceipt(matches[0], expected);
  });
  if (new Set(receipts.map((receipt) => receipt.correlation_id)).size !== 2) {
    throw new Error("Gate C C5 Grafana receipts reuse a correlation ID");
  }
  return receipts;
}

function validateGrafanaQueryPayload(
  value: unknown,
  expected: Readonly<{ kind: string; correlationId: string; startedAtMs: number; endedAtMs: number }>,
): void {
  const payload = record(value);
  const data = payload ? record(payload.data) : null;
  const results = data?.result;
  if (payload?.status !== "success" || !Array.isArray(results) || results.length === 0) {
    throw new Error(`Gate C C5 Grafana ${expected.kind} query returned no exact-run evidence`);
  }
  let observed = false;
  for (const result of results) {
    const series = record(result);
    const metric = series ? record(series.metric) : null;
    if (metric?.correlation_id !== expected.correlationId || metric.evidence_kind !== expected.kind) continue;
    const samples = Array.isArray(series?.values) ? series.values : series?.value ? [series.value] : [];
    for (const sample of samples) {
      if (!Array.isArray(sample) || sample.length !== 2) continue;
      const timestampMs = Number(sample[0]) * 1_000;
      const sampleValue = Number(sample[1]);
      if (
        Number.isFinite(timestampMs) &&
        timestampMs >= expected.startedAtMs &&
        timestampMs <= expected.endedAtMs &&
        Number.isFinite(sampleValue) &&
        sampleValue > 0
      )
        observed = true;
    }
  }
  if (!observed)
    throw new Error(`Gate C C5 Grafana ${expected.kind} query is unrelated to the exact run or time window`);
}

/** Queries all four operational evidence surfaces and retains only digests. */
export async function collectGateCC5GrafanaReceipt(
  input: Readonly<{
    expected: GateCC5EvidenceBinding;
    runOrdinal: 1 | 2;
    correlationId: string;
    windowStartedAtUtc: string;
    windowEndedAtUtc: string;
    queries: Readonly<
      Record<
        "workload" | "fault" | "recovery" | "alert_routed" | "alert_recovered",
        Readonly<{ url: string | URL; init?: RequestInit }>
      >
    >;
    fetchImpl?: typeof fetch;
  }>,
): Promise<GateCC5GrafanaCollectionResult> {
  if (
    !SAFE_CODE.test(input.correlationId) ||
    !validUtc(input.windowStartedAtUtc) ||
    !validUtc(input.windowEndedAtUtc) ||
    Date.parse(input.windowEndedAtUtc) <= Date.parse(input.windowStartedAtUtc)
  ) {
    throw new Error("Gate C C5 Grafana collection window or correlation ID is invalid");
  }
  const fetcher = input.fetchImpl ?? fetch;
  const queryDigests: Record<string, string> = {};
  const startedAtMs = Date.parse(input.windowStartedAtUtc);
  const endedAtMs = Date.parse(input.windowEndedAtUtc);
  const queries = record(input.queries);
  if (!queries) throw new Error("Gate C C5 Grafana queries must be an object");
  exactKeys(queries, ["workload", "fault", "recovery", "alert_routed", "alert_recovered"], "Grafana queries");
  for (const [kind, query] of Object.entries(input.queries)) {
    const url = new URL(query.url);
    if (url.protocol !== "https:") throw new Error("Gate C C5 Grafana collector requires trusted HTTPS");
    const response = await fetcher(url, query.init);
    const bytes = Buffer.from(await response.arrayBuffer());
    let payload: unknown;
    try {
      payload = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`Gate C C5 Grafana ${kind} query returned invalid JSON`);
    }
    if (response.status !== 200) throw new Error(`Gate C C5 Grafana ${kind} query returned HTTP ${response.status}`);
    validateGrafanaQueryPayload(payload, { kind, correlationId: input.correlationId, startedAtMs, endedAtMs });
    queryDigests[kind] = hash(bytes);
  }
  const evidenceBytes = Buffer.from(
    `${JSON.stringify(
      {
        run_ordinal: input.runOrdinal,
        correlation_id: input.correlationId,
        window_started_at_utc: input.windowStartedAtUtc,
        window_ended_at_utc: input.windowEndedAtUtc,
        query_response_sha256: queryDigests,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const receipt = validateGateCC5GrafanaReceipt(
    {
      artifact_kind: "gate-c-c5-grafana-receipt",
      source_sha: input.expected.sourceSha,
      deployment_sha: input.expected.sourceSha,
      profile_id: input.expected.plan.profile.profileId,
      workload_plan_sha256: gateCC5WorkloadPlanSha256(input.expected.plan),
      run_ordinal: input.runOrdinal,
      correlation_id: input.correlationId,
      window_started_at_utc: input.windowStartedAtUtc,
      window_ended_at_utc: input.windowEndedAtUtc,
      workload_visible: true,
      fault_visible: true,
      recovery_visible: true,
      alert_routed: true,
      alert_recovered: true,
      skipped_count: 0,
      evidence_sha256: hash(evidenceBytes),
    },
    input.expected,
  );
  return { receipt, evidenceBytes };
}

function assertSanitised(content: Buffer, relativePath: string): void {
  const text = content.toString("utf8");
  const forbidden = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    /\b[a-z0-9-]*(?:authorization|api-key|token|secret|cookie)\s*:/iu,
    /\bbearer\s+[a-z0-9._~+/=-]+/iu,
    /"(?:[^"\r\n]*[_-])?(?:password|secret|token|cookie|api[_-]?key)(?:[_-][^"\r\n]*)?"\s*:/iu,
    /(?:^|\n)\s*[a-z0-9_]*(?:password|secret|token|cookie|api_key|access_key|private_key)[a-z0-9_]*\s*=/iu,
    /\b(?:postgres(?:ql)?|redis|rediss|amqp|https?):\/\//iu,
    /\b(?:localhost|127\.0\.0\.1|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/iu,
    /"(?:host|hostname|endpoint|database_url|redis_url)"\s*:/iu,
  ];
  if (forbidden.some((pattern) => pattern.test(text))) {
    throw new Error(`Gate C C5 retained artifact contains credentials or sensitive topology: ${relativePath}`);
  }
}

function safeRelative(relativePath: string): void {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.startsWith("../")
  ) {
    throw new Error("Gate C C5 retained artifact path is unsafe");
  }
}

async function collectDirectory(root: string, relative = ""): Promise<GateCC5ArtifactEntry[]> {
  const entries: GateCC5ArtifactEntry[] = [];
  for (const child of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const childRelative = relative ? `${relative}/${child.name}` : child.name;
    safeRelative(childRelative);
    const absolute = path.join(root, childRelative);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink())
      throw new Error(`Gate C C5 retained artifact tree contains a symlink: ${childRelative}`);
    if (metadata.isDirectory()) {
      entries.push(...(await collectDirectory(root, childRelative)));
      continue;
    }
    if (!metadata.isFile()) throw new Error(`Gate C C5 retained artifact is not a regular file: ${childRelative}`);
    if (metadata.size > MAX_ARTIFACT_BYTES)
      throw new Error(`Gate C C5 retained artifact exceeds 5 MiB: ${childRelative}`);
    const content = await readFile(absolute);
    assertSanitised(content, childRelative);
    entries.push({ path: childRelative, bytes: content.byteLength, sha256: hash(content) });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export async function collectGateCC5RetainedArtifacts(retainedRoot: string): Promise<readonly GateCC5ArtifactEntry[]> {
  const resolved = path.resolve(retainedRoot);
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Gate C C5 retained artifact root must be a real non-symlink directory");
  }
  const entries = await collectDirectory(await realpath(resolved));
  if (entries.length === 0) throw new Error("Gate C C5 retained artifact tree is empty");
  return entries;
}

async function sealEvidenceTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Gate C C5 evidence tree changed to contain a symlink during sealing");
    if (entry.isDirectory()) {
      await sealEvidenceTree(absolute);
      await chmod(absolute, 0o555);
    } else if (entry.isFile()) {
      await chmod(absolute, 0o444);
    } else {
      throw new Error("Gate C C5 evidence tree changed to contain a non-regular artifact during sealing");
    }
  }
}

export async function verifyGateCC5EvidenceSeal(
  evidenceRoot: string,
  expected: Readonly<{ sourceSha: string }>,
): Promise<GateCC5EvidenceSeal> {
  const root = await realpath(path.resolve(evidenceRoot));
  const sealBytes = await readFile(path.join(root, "seal.json"));
  let value: unknown;
  try {
    value = JSON.parse(sealBytes.toString("utf8"));
  } catch {
    throw new Error("Gate C C5 evidence seal is not valid JSON");
  }
  const seal = record(value);
  if (!seal) throw new Error("Gate C C5 evidence seal must be an object");
  exactKeys(
    seal,
    ["schema_version", "artifact_kind", "source_sha", "manifest_sha256", "entries", "tree_sha256"],
    "evidence seal",
  );
  if (
    seal.schema_version !== 1 ||
    seal.artifact_kind !== "gate-c-c5-certification-evidence-seal" ||
    seal.source_sha !== expected.sourceSha ||
    !SHA40.test(expected.sourceSha)
  ) {
    throw new Error("Gate C C5 evidence seal is not exact-SHA bound");
  }
  assertHash(seal.manifest_sha256, "evidence seal manifest hash");
  assertHash(seal.tree_sha256, "evidence seal tree hash");
  const actualEntries = (await collectGateCC5RetainedArtifacts(root)).filter((entry) => entry.path !== "seal.json");
  if (stableJson(seal.entries) !== stableJson(actualEntries) || hash(stableJson(actualEntries)) !== seal.tree_sha256) {
    throw new Error("Gate C C5 retained evidence tree does not match its final seal");
  }
  if (hash(await readFile(path.join(root, "manifest.json"))) !== seal.manifest_sha256) {
    throw new Error("Gate C C5 evidence manifest does not match its final seal");
  }
  return seal as GateCC5EvidenceSeal;
}

const manifestKeys = [
  "schema_version",
  "artifact_kind",
  "source_sha",
  "profile_id",
  "workload_plan_sha256",
  "workload_receipt_sha256",
  "generated_at_utc",
  "physical_devices",
  "cache_lifecycle",
  "grafana",
  "artifacts",
  "skipped_count",
  "final_status",
] as const;

export function validateGateCC5EvidenceManifest(
  value: unknown,
  expected: GateCC5EvidenceBinding,
): GateCC5EvidenceManifest {
  const manifest = record(value);
  if (!manifest) throw new Error("Gate C C5 evidence manifest must be an object");
  exactKeys(manifest, manifestKeys, "evidence manifest");
  if (
    manifest.schema_version !== 1 ||
    manifest.artifact_kind !== "gate-c-c5-certification-evidence-manifest" ||
    manifest.source_sha !== expected.sourceSha ||
    manifest.profile_id !== expected.plan.profile.profileId ||
    manifest.workload_plan_sha256 !== gateCC5WorkloadPlanSha256(expected.plan) ||
    !validUtc(manifest.generated_at_utc) ||
    manifest.skipped_count !== 0 ||
    manifest.final_status !== "PASS"
  ) {
    throw new Error("Gate C C5 evidence manifest is not complete and exact-SHA bound");
  }
  assertHash(manifest.workload_receipt_sha256, "workload receipt evidence");
  validateGateCC5PhysicalDeviceReceipts(manifest.physical_devices, expected);
  validateGateCC5CacheLifecycleReceipts(manifest.cache_lifecycle, expected);
  validateGateCC5GrafanaReceipts(manifest.grafana, expected);
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0)
    throw new Error("Gate C C5 evidence manifest has no retained artifacts");
  const paths = new Set<string>();
  for (const value of manifest.artifacts) {
    const entry = record(value);
    if (!entry) throw new Error("Gate C C5 evidence manifest has an invalid artifact entry");
    exactKeys(entry, ["path", "bytes", "sha256"], "artifact entry");
    if (typeof entry.path !== "string") throw new Error("Gate C C5 artifact entry path must be a string");
    safeRelative(entry.path);
    if (paths.has(entry.path)) throw new Error("Gate C C5 evidence manifest repeats an artifact path");
    paths.add(entry.path);
    if (
      !Number.isSafeInteger(entry.bytes) ||
      (entry.bytes as number) < 0 ||
      (entry.bytes as number) > MAX_ARTIFACT_BYTES
    ) {
      throw new Error("Gate C C5 evidence manifest has an invalid artifact size");
    }
    assertHash(entry.sha256, "artifact entry hash");
  }
  return manifest as GateCC5EvidenceManifest;
}

export async function writeGateCC5EvidenceManifestAndSeal(
  input: Readonly<{
    evidenceRoot: string;
    expected: GateCC5EvidenceBinding;
    physicalDevices: unknown;
    cacheLifecycle: unknown;
    grafana: unknown;
    generatedAtUtc?: string;
  }>,
): Promise<Readonly<{ manifest: GateCC5EvidenceManifest; seal: GateCC5EvidenceSeal }>> {
  const requestedRoot = path.resolve(input.evidenceRoot);
  await mkdir(requestedRoot, { recursive: true });
  const rootMetadata = await lstat(requestedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Gate C C5 evidence root must be a real non-symlink directory");
  }
  const root = await realpath(requestedRoot);
  const physicalDevices = validateGateCC5PhysicalDeviceReceipts(input.physicalDevices, input.expected);
  const cacheLifecycle = validateGateCC5CacheLifecycleReceipts(input.cacheLifecycle, input.expected);
  const grafana = validateGateCC5GrafanaReceipts(input.grafana, input.expected);
  const existing = await readdir(root);
  if (existing.includes("manifest.json") || existing.includes("seal.json"))
    throw new Error("Gate C C5 evidence bundle is already sealed");
  const artifacts = await collectGateCC5RetainedArtifacts(root);
  const workloadCandidates: Readonly<{ receipt: unknown; sha256: string }>[] = [];
  for (const artifact of artifacts) {
    const bytes = await readFile(path.join(root, artifact.path));
    let candidate: unknown;
    try {
      candidate = JSON.parse(bytes.toString("utf8"));
    } catch {
      continue;
    }
    if (record(candidate)?.artifact_kind !== "gate-c-c5-integrated-workload-receipt") continue;
    validateGateCC5Receipt(candidate, input.expected);
    workloadCandidates.push({ receipt: candidate, sha256: artifact.sha256 });
  }
  if (workloadCandidates.length !== 1) {
    throw new Error("Gate C C5 evidence bundle requires exactly one semantically valid retained workload receipt");
  }
  const workloadReceiptSha256 = workloadCandidates[0]!.sha256;
  const retainedHashes = new Set(artifacts.map((artifact) => artifact.sha256));
  const referencedHashes = [
    workloadReceiptSha256,
    ...physicalDevices.map((receipt) => receipt.evidence_sha256),
    ...cacheLifecycle.map((receipt) => receipt.evidence_sha256),
    ...grafana.map((receipt) => receipt.evidence_sha256),
  ];
  if (referencedHashes.some((digest) => !retainedHashes.has(digest))) {
    throw new Error("Gate C C5 evidence receipt references bytes not retained in the final bundle");
  }
  const manifest = validateGateCC5EvidenceManifest(
    {
      schema_version: 1,
      artifact_kind: "gate-c-c5-certification-evidence-manifest",
      source_sha: input.expected.sourceSha,
      profile_id: input.expected.plan.profile.profileId,
      workload_plan_sha256: gateCC5WorkloadPlanSha256(input.expected.plan),
      workload_receipt_sha256: workloadReceiptSha256,
      generated_at_utc: input.generatedAtUtc ?? new Date().toISOString(),
      physical_devices: physicalDevices,
      cache_lifecycle: cacheLifecycle,
      grafana,
      artifacts,
      skipped_count: 0,
      final_status: "PASS",
    },
    input.expected,
  );
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  const manifestBytes = await readFile(manifestPath);
  const entries = await collectGateCC5RetainedArtifacts(root);
  const treeSha256 = hash(stableJson(entries));
  const seal: GateCC5EvidenceSeal = {
    schema_version: 1,
    artifact_kind: "gate-c-c5-certification-evidence-seal",
    source_sha: input.expected.sourceSha,
    manifest_sha256: hash(manifestBytes),
    entries,
    tree_sha256: treeSha256,
  };
  const sealPath = path.join(root, "seal.json");
  await writeFile(sealPath, `${JSON.stringify(seal, null, 2)}\n`, { flag: "wx" });
  await verifyGateCC5EvidenceSeal(root, { sourceSha: input.expected.sourceSha });
  await sealEvidenceTree(root);
  await chmod(root, 0o555);
  return { manifest, seal };
}
