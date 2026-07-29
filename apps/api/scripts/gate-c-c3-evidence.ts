import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export const gateCC3Projects = [
  "gate-c-c3-phone-chromium",
  "gate-c-c3-phone-webkit",
  "gate-c-c3-desktop-chromium",
  "gate-c-c3-desktop-webkit",
  "gate-c-c3-desktop-firefox",
] as const;

export type GateCC3Project = (typeof gateCC3Projects)[number];

export function createGateCC3ControllableClock(systemNow: () => number = Date.now): {
  now(): Date;
  set(value: string): void;
  reset(): void;
} {
  let override: number | null = null;
  return {
    now: () => new Date(override ?? systemNow()),
    set(value) {
      const parsed = Date.parse(value);
      if (!Number.isFinite(parsed)) throw new Error("Gate C C3 clock override must be a valid timestamp");
      override = parsed;
    },
    reset() {
      override = null;
    },
  };
}

export const gateCC3Scenarios = [
  "online_preparation",
  "offline_event_and_local_reversal",
  "page_refresh",
  "browser_restart",
  "strict_ordered_replay",
  "lost_response_idempotency",
  "pending_finalisation",
  "sequence_divergence",
  "stale_generation_takeover",
  "expiry_and_revocation",
  "four_hour_recording_boundary",
  "sign_out_with_unresolved_queue",
  "sanitised_export",
  "storage_corruption",
  "service_worker_update",
] as const;

export type GateCC3Scenario = (typeof gateCC3Scenarios)[number];

export const gateCC3ScenarioAssertions: Readonly<Record<GateCC3Scenario, readonly string[]>> = {
  online_preparation: ["authority_issued", "worker_ready"],
  offline_event_and_local_reversal: ["event_queued", "local_reversal_queued"],
  page_refresh: ["queue_recovered"],
  browser_restart: ["persistent_profile_relaunched", "queue_recovered"],
  strict_ordered_replay: ["contiguous_order", "one_at_a_time"],
  lost_response_idempotency: ["duplicate_receipt", "no_duplicate_mutation"],
  pending_finalisation: ["local_pending", "publication_acknowledged"],
  sequence_divergence: ["queue_retained", "replay_stopped"],
  stale_generation_takeover: ["queue_retained", "takeover_conflict"],
  expiry_and_revocation: ["expired_read_only", "revoked_read_only"],
  four_hour_recording_boundary: ["at_boundary_blocked", "before_allowed", "grace_transmission_only"],
  sign_out_with_unresolved_queue: ["export_before_discard", "signout_intercepted"],
  sanitised_export: ["deterministic_hash", "secret_scan_clean"],
  storage_corruption: ["cache_loss_recovered", "corruption_visible", "indexeddb_loss_safe"],
  service_worker_update: ["safe_activation", "update_deferred"],
};

export const gateCC3ScenarioObservationKeys: Readonly<Record<GateCC3Scenario, readonly string[]>> = {
  online_preparation: ["service_worker_version", "queue_count"],
  offline_event_and_local_reversal: ["queued_command_count", "local_reversal_count"],
  page_refresh: ["recovered_command_count", "refresh_mechanism", "performance_navigation_type"],
  browser_restart: ["recovered_command_count", "persistent_profile_reused"],
  strict_ordered_replay: ["replayed_command_count", "maximum_concurrent_requests", "replay_client_id_sha256"],
  lost_response_idempotency: ["duplicate_receipt_sha256", "mutation_count"],
  pending_finalisation: ["local_status", "confirmed_result_version"],
  sequence_divergence: ["conflict_code", "retained_command_count"],
  stale_generation_takeover: ["conflict_code", "retained_command_count"],
  expiry_and_revocation: ["expired_state", "revoked_state"],
  four_hour_recording_boundary: ["before_boundary_allowed", "at_boundary_blocked", "grace_replay_only"],
  sign_out_with_unresolved_queue: ["signout_intercepted", "export_sha256"],
  sanitised_export: ["export_sha256", "sensitive_data_scan_clean"],
  storage_corruption: ["conflict_code", "retained_command_count"],
  service_worker_update: [
    "active_version",
    "waiting_version",
    "activation_deferred",
    "preparation_after_controller_change",
  ],
};

export const gateCC3RequiredScreenshotPaths = [
  "screenshots/offline-ready.png",
  "screenshots/offline-two-pending.png",
  "screenshots/offline-browser-restart.png",
  "screenshots/offline-replay-complete.png",
] as const;

const sha256Pattern = /^[a-f0-9]{64}$/u;

type ProjectReceipt = {
  artifact_kind: "gate-c-c3-project-evidence";
  source_sha: string;
  project_name: GateCC3Project;
  pass_count: number;
  failed_count: 0;
  skipped_count: 0;
  postgresql: { identifier_sha256: string };
  redis: {
    namespace_sha256: string;
    initial_owned_key_count: 0;
    final_owned_key_count: 0;
    unrelated_guard_preserved: true;
  };
  browser_profile_sha256: string;
  browser_version: string;
  indexeddb_schema_version: 1;
  service_worker_version: string;
  screenshot_paths: string[];
  scenarios: Array<{
    scenario: GateCC3Scenario;
    status: "passed";
    receipt_sha256: string;
  }>;
  artifact_hashes: Array<{ path: string; sha256: string; size_bytes: number }>;
};

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((item) => actual.includes(item))
  );
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
}

export function parseGateCC3Discovery(output: string): Map<GateCC3Project, number> {
  const counts = new Map<GateCC3Project, number>();
  for (const project of gateCC3Projects) {
    const escaped = project.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const count = [...output.matchAll(new RegExp(`\\[${escaped}\\]`, "gu"))].length;
    if (count < 1) throw new Error(`Gate C C3 Playwright discovery found no tests for ${project}`);
    counts.set(project, count);
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const reported = Number(output.match(/Total:\s+(\d+)\s+tests?/u)?.[1] ?? "0");
  if (reported !== total) throw new Error(`Gate C C3 discovery total ${reported} does not match ${total}`);
  return counts;
}

export function validateGateCC3ProjectReceipt(
  receipt: unknown,
  expectedSourceSha: string,
  expectedProject: GateCC3Project,
  expectedPassCount: number,
): ProjectReceipt {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error(`${expectedProject} emitted no project evidence`);
  }
  const candidate = receipt as Partial<ProjectReceipt>;
  if (
    candidate.artifact_kind !== "gate-c-c3-project-evidence" ||
    candidate.source_sha !== expectedSourceSha ||
    candidate.project_name !== expectedProject ||
    candidate.pass_count !== expectedPassCount ||
    candidate.failed_count !== 0 ||
    candidate.skipped_count !== 0
  ) {
    throw new Error(`${expectedProject} evidence is not an all-pass exact-SHA receipt`);
  }
  assertHash(candidate.postgresql?.identifier_sha256, `${expectedProject} PostgreSQL isolation`);
  assertHash(candidate.redis?.namespace_sha256, `${expectedProject} Redis isolation`);
  assertHash(candidate.browser_profile_sha256, `${expectedProject} browser profile`);
  if (
    candidate.redis?.initial_owned_key_count !== 0 ||
    candidate.redis.final_owned_key_count !== 0 ||
    candidate.redis.unrelated_guard_preserved !== true ||
    !candidate.browser_version?.trim() ||
    candidate.indexeddb_schema_version !== 1 ||
    !/^(?:matchday|gate-c)-[a-z0-9-]+-v\d+$/u.test(candidate.service_worker_version ?? "")
  ) {
    throw new Error(`${expectedProject} isolation or browser receipt is incomplete`);
  }
  if (!sameSet(candidate.screenshot_paths ?? [], gateCC3RequiredScreenshotPaths)) {
    throw new Error(`${expectedProject} does not retain the canonical success screenshot set`);
  }
  if (
    !Array.isArray(candidate.scenarios) ||
    !sameSet(
      candidate.scenarios.map((item) => item.scenario),
      gateCC3Scenarios,
    )
  ) {
    throw new Error(`${expectedProject} does not prove every required offline scenario exactly once`);
  }
  const scenarioHashes = new Set<string>();
  for (const scenario of candidate.scenarios) {
    if (scenario.status !== "passed") throw new Error(`${expectedProject}/${scenario.scenario} did not pass`);
    assertHash(scenario.receipt_sha256, `${expectedProject}/${scenario.scenario} receipt`);
    scenarioHashes.add(scenario.receipt_sha256);
  }
  if (!Array.isArray(candidate.artifact_hashes) || candidate.artifact_hashes.length < 1) {
    throw new Error(`${expectedProject} has no retained artifact hashes`);
  }
  for (const artifact of candidate.artifact_hashes) {
    if (
      !artifact.path ||
      artifact.path.startsWith("/") ||
      artifact.path.split(/[\\/]/u).includes("..") ||
      !Number.isSafeInteger(artifact.size_bytes) ||
      artifact.size_bytes < 1
    ) {
      throw new Error(`${expectedProject} has an invalid retained artifact path or size`);
    }
    assertHash(artifact.sha256, `${expectedProject}/${artifact.path}`);
  }
  const artifactHashes = new Set(candidate.artifact_hashes.map((artifact) => artifact.sha256));
  if (
    scenarioHashes.size !== gateCC3Scenarios.length ||
    [...scenarioHashes].some((receiptHash) => !artifactHashes.has(receiptHash))
  ) {
    throw new Error(`${expectedProject} scenario receipts are reused or not bound to retained artifacts`);
  }
  assertNoSecretLikeMaterial(candidate);
  return candidate as ProjectReceipt;
}

export function assertNoSecretLikeMaterial(value: unknown, path: readonly string[] = []): void {
  if (typeof value === "string") {
    assertNoSecretLikeText(value, path.join(".") || "<root>");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretLikeMaterial(item, [...path, String(index)]));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const fieldPath = [...path, key];
    if (/(?:^|_)(?:token|secret|password|cookie|authorization|access_url|raw_device_id|client_ip)(?:_|$)/iu.test(key)) {
      throw new Error(`Secret-like evidence field is forbidden: ${fieldPath.join(".")}`);
    }
    if (typeof item === "string") {
      assertNoSecretLikeText(item, fieldPath.join("."));
    } else {
      assertNoSecretLikeMaterial(item, fieldPath);
    }
  }
}

export function assertNoSecretLikeText(value: string, label: string): void {
  const forbiddenPatterns: ReadonlyArray<readonly [string, RegExp]> = [
    ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu],
    ["bearer-credential", /bearer\s+[a-z0-9._~+/=-]+/iu],
    ["credential-header", /(?:authorization|proxy-authorization|set-cookie|x-api-key|api[_-]?key)\s*[:=]\s*[^\s,;]+/iu],
    ["jwt", /eyJ[a-z0-9_-]{8,}\.eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}/iu],
    ["postgres-credential-url", /postgres(?:ql)?:\/\/[^/\s]+:[^@\s]+@/iu],
    ["redis-credential-url", /redis:\/\/[^/\s]+:[^@\s]+@/iu],
    ["access-fragment", /#access=/iu],
    ["offline-grant-cookie", /__Secure-matchday-offline-grant/iu],
  ];
  const matched = forbiddenPatterns.find(([, pattern]) => pattern.test(value));
  if (matched) {
    throw new Error(`Secret-like evidence value is forbidden (${matched[0]}): ${label}`);
  }
}

export async function verifyGateCC3SafeArtifactTree(directory: string): Promise<void> {
  const canonicalRoot = await realpath(directory);
  for (const relative of await retainedRelativeFiles(canonicalRoot)) {
    if (/\.(?:zip|har|webm|mp4|mov|mkv)$/iu.test(relative)) {
      throw new Error(`Gate C C3 forbids credential-bearing capture artifacts: ${relative}`);
    }
    assertNoSecretLikeText(relative, `${relative} path`);
    if (!/\.(?:json|txt|log|md|html?|xml|css|m?js|cjs|ts|tsx|yaml|yml)$/iu.test(relative)) continue;
    assertNoSecretLikeText(await readFile(path.join(canonicalRoot, relative), "utf8"), relative);
  }
}

export async function verifyGateCC3ArtifactHashes(
  retainedDirectory: string,
  artifacts: ReadonlyArray<{ path: string; sha256: string; size_bytes: number }>,
): Promise<void> {
  const canonicalRoot = await realpath(retainedDirectory);
  for (const artifact of artifacts) {
    const absolute = path.resolve(canonicalRoot, artifact.path);
    if (!absolute.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new Error(`Gate C C3 artifact escaped its retained directory: ${artifact.path}`);
    }
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Gate C C3 artifact must be a retained regular file: ${artifact.path}`);
    }
    const canonicalFile = await realpath(absolute);
    if (!canonicalFile.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new Error(`Gate C C3 artifact traverses a symlink: ${artifact.path}`);
    }
    const bytes = await readFile(canonicalFile);
    assertNoSecretLikeText(bytes.toString("utf8"), artifact.path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== artifact.sha256 || metadata.size !== artifact.size_bytes) {
      throw new Error(`Gate C C3 artifact hash or size differs from retained bytes: ${artifact.path}`);
    }
  }
  const listedPaths = new Set(artifacts.map((artifact) => artifact.path));
  const unlisted = (await retainedRelativeFiles(canonicalRoot)).filter((relative) => !listedPaths.has(relative));
  for (const relative of unlisted) {
    const bytes = await readFile(path.join(canonicalRoot, relative));
    assertNoSecretLikeText(bytes.toString("utf8"), relative);
    let kind = "";
    try {
      kind = (JSON.parse(bytes.toString("utf8")) as { artifact_kind?: string }).artifact_kind ?? "";
    } catch {
      // An unlisted binary or malformed file is never admissible evidence.
    }
    if (!(relative === "project-evidence.json" && kind === "gate-c-c3-project-evidence")) {
      throw new Error(`Gate C C3 retained file is not hash-bound by the receipt: ${relative}`);
    }
  }
}

async function retainedRelativeFiles(directory: string, relative = ""): Promise<string[]> {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Gate C C3 evidence must not contain symlinks: ${child}`);
    if (entry.isDirectory()) files.push(...(await retainedRelativeFiles(directory, child)));
    else if (entry.isFile()) files.push(child.split(path.sep).join("/"));
  }
  return files.sort();
}

export async function verifyGateCC3ScenarioArtifacts(
  retainedDirectory: string,
  receipt: ProjectReceipt,
): Promise<void> {
  const canonicalRoot = await realpath(retainedDirectory);
  for (const scenario of receipt.scenarios) {
    const artifact = receipt.artifact_hashes.find((candidate) => candidate.sha256 === scenario.receipt_sha256);
    if (!artifact) throw new Error(`${receipt.project_name}/${scenario.scenario} has no retained scenario receipt`);
    const expectedPath = `scenarios/${scenario.scenario}.json`;
    if (artifact.path !== expectedPath) {
      throw new Error(`${receipt.project_name}/${scenario.scenario} receipt has a non-canonical path`);
    }
    const document = JSON.parse(await readFile(path.join(canonicalRoot, artifact.path), "utf8")) as Record<
      string,
      unknown
    >;
    if (
      document.artifact_kind !== "gate-c-c3-scenario-receipt" ||
      document.source_sha !== receipt.source_sha ||
      document.owner_kind !== "project" ||
      document.owner_name !== receipt.project_name ||
      document.scenario !== scenario.scenario ||
      document.status !== "passed" ||
      !Number.isFinite(Date.parse(String(document.observed_at ?? ""))) ||
      !sameSet(
        Array.isArray(document.assertions) ? document.assertions.map(String) : [],
        gateCC3ScenarioAssertions[scenario.scenario],
      ) ||
      !document.observations ||
      typeof document.observations !== "object" ||
      Array.isArray(document.observations) ||
      !sameSet(Object.keys(document.observations), gateCC3ScenarioObservationKeys[scenario.scenario])
    ) {
      throw new Error(`${receipt.project_name}/${scenario.scenario} scenario receipt is not canonical`);
    }
    assertNoSecretLikeMaterial(document);
  }
}
