import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const REQUIRED_PHYSICAL_SCENARIOS = [
  "online_preparation",
  "offline_event_and_local_reversal",
  "page_refresh",
  "browser_restart",
  "strict_ordered_replay",
  "pending_finalisation",
  "stale_generation_takeover",
  "sanitised_export",
] as const;
export type PhysicalScenarioName = (typeof REQUIRED_PHYSICAL_SCENARIOS)[number];
type Sha256 = string;
export type RawPhysicalDevicePayload = Readonly<{
  source_sha: string;
  platform: "ios" | "android";
  device_model: string;
  os_version: string;
  browser_name: string;
  browser_version: string;
  capture_id: string;
  collector: string;
  collection_method: "physical_device_manual" | "device_farm";
  device_run_id: string;
  captured_at: string;
  collected_at: string;
  trusted_https_origin: string;
  tester_attestation: string;
  deployment_id: string;
  build_id: string;
  route_manifest_sha256: Sha256;
  scenarios: readonly Readonly<{
    scenario: PhysicalScenarioName;
    status: "passed" | "failed";
    observed_at: string;
    assertions: readonly string[];
    observations: Record<string, unknown>;
    raw_trace_sha256: Sha256;
    raw_trace_events: readonly unknown[];
  }>[];
}>;
type DeploymentReceipt = {
  source_sha?: string;
  candidate_sha?: string;
  git_commit_sha?: string;
  deployment_id?: string;
  build_id?: string;
  state?: string;
  url?: string;
};
type ApprovedRouteManifest = {
  artifact_kind: "gate-c-c3-approved-route-manifest";
  source_sha: string;
  deployment_id: string;
  build_id: string;
  trusted_https_origin: string;
  routes: readonly string[];
};
type EvidenceBindings = {
  deployment: DeploymentReceipt;
  approvedRouteManifest: ApprovedRouteManifest;
  routeManifestSha256: Sha256;
};

function sha256(value: Buffer | string): Sha256 {
  return createHash("sha256").update(value).digest("hex");
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function assertSha(value: unknown, field: string): asserts value is Sha256 {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error(`${field} must be a lowercase SHA-256`);
}
function assertTimestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${field} must be a valid ISO timestamp`);
}

export function validateRawPhysicalPayload(payload: RawPhysicalDevicePayload, sourceSha: string): void {
  if (payload.source_sha !== sourceSha || !/^[a-f0-9]{40}$/u.test(sourceSha))
    throw new Error("physical receipt source_sha must exactly match the immutable candidate SHA");
  if (
    !["ios", "android"].includes(payload.platform) ||
    !payload.device_model ||
    !payload.os_version ||
    !payload.browser_name ||
    !payload.browser_version
  )
    throw new Error("missing valid device metadata");
  if (
    !payload.capture_id ||
    !payload.collector ||
    !payload.device_run_id ||
    !["physical_device_manual", "device_farm"].includes(payload.collection_method)
  )
    throw new Error("missing physical-device provenance");
  assertTimestamp(payload.captured_at, "captured_at");
  assertTimestamp(payload.collected_at, "collected_at");
  if (!payload.trusted_https_origin.startsWith("https://") || payload.tester_attestation.length < 10)
    throw new Error("invalid HTTPS origin or tester attestation");
  if (!/^dpl_[A-Za-z0-9]+$/u.test(payload.deployment_id) || !payload.build_id.trim())
    throw new Error("physical receipt must identify READY deployment and build");
  assertSha(payload.route_manifest_sha256, "route_manifest_sha256");
  if (payload.scenarios.length !== REQUIRED_PHYSICAL_SCENARIOS.length)
    throw new Error("physical receipt must contain each required scenario exactly once");
  const seen = new Set<PhysicalScenarioName>();
  for (const scenario of payload.scenarios) {
    if (!REQUIRED_PHYSICAL_SCENARIOS.includes(scenario.scenario) || seen.has(scenario.scenario))
      throw new Error(`invalid or duplicate scenario: ${String(scenario.scenario)}`);
    seen.add(scenario.scenario);
    assertTimestamp(scenario.observed_at, `${scenario.scenario}.observed_at`);
    assertSha(scenario.raw_trace_sha256, `${scenario.scenario}.raw_trace_sha256`);
    if (scenario.status !== "passed" || scenario.assertions.length === 0 || scenario.raw_trace_events.length === 0)
      throw new Error(`${scenario.scenario} lacks a passing retained trace`);
  }
}

export function validateEvidenceBindings(
  payload: RawPhysicalDevicePayload,
  sourceSha: string,
  bindings: EvidenceBindings,
): void {
  const deployedSha =
    bindings.deployment.candidate_sha ?? bindings.deployment.git_commit_sha ?? bindings.deployment.source_sha;
  if (
    deployedSha !== sourceSha ||
    bindings.deployment.deployment_id !== payload.deployment_id ||
    bindings.deployment.build_id !== payload.build_id ||
    bindings.deployment.state !== "READY" ||
    bindings.deployment.url !== payload.trusted_https_origin
  )
    throw new Error("physical evidence deployment identity is not the exact READY candidate deployment");
  const manifest = bindings.approvedRouteManifest;
  if (
    manifest.artifact_kind !== "gate-c-c3-approved-route-manifest" ||
    manifest.source_sha !== sourceSha ||
    manifest.deployment_id !== payload.deployment_id ||
    manifest.build_id !== payload.build_id ||
    manifest.trusted_https_origin !== payload.trusted_https_origin ||
    bindings.routeManifestSha256 !== payload.route_manifest_sha256 ||
    !Array.isArray(manifest.routes) ||
    manifest.routes.length === 0 ||
    manifest.routes.some((route) => !route.startsWith("/"))
  )
    throw new Error("route manifest is not approved for the exact deployment/build/origin");
}

export async function loadEvidenceBindings(
  deploymentReceiptPath: string,
  routeManifestPath: string,
): Promise<EvidenceBindings> {
  const [deploymentBytes, routesBytes] = await Promise.all([
    readFile(deploymentReceiptPath),
    readFile(routeManifestPath),
  ]);
  return {
    deployment: JSON.parse(deploymentBytes.toString("utf8")) as DeploymentReceipt,
    approvedRouteManifest: JSON.parse(routesBytes.toString("utf8")) as ApprovedRouteManifest,
    routeManifestSha256: sha256(routesBytes),
  };
}

export async function importPhysicalReceipt(
  payload: RawPhysicalDevicePayload,
  sourceSha: string,
  bindings: EvidenceBindings,
): Promise<string> {
  validateRawPhysicalPayload(payload, sourceSha);
  validateEvidenceBindings(payload, sourceSha, bindings);
  const physicalDir = path.join(root, "artifacts", "qa", "gate-c-c3", sourceSha, "physical", payload.platform);
  await mkdir(path.join(physicalDir, "scenarios"), { recursive: true });
  await mkdir(path.join(physicalDir, "traces"), { recursive: true });
  const artifact_hashes: { path: string; size_bytes: number; sha256: Sha256 }[] = [];
  const scenarios: { scenario: PhysicalScenarioName; status: "passed"; receipt_sha256: Sha256 }[] = [];
  for (const scenario of payload.scenarios) {
    const trace = Buffer.from(`${JSON.stringify(scenario.raw_trace_events, null, 2)}\n`);
    const traceSha = sha256(trace);
    if (traceSha !== scenario.raw_trace_sha256)
      throw new Error(`${scenario.scenario} raw trace hash does not match captured bytes`);
    const traceRelative = `traces/${scenario.scenario}.trace.json`;
    await writeFile(path.join(physicalDir, traceRelative), trace, { flag: "wx" });
    artifact_hashes.push({ path: traceRelative, size_bytes: trace.byteLength, sha256: traceSha });
    const unsignedScenario = {
      artifact_kind: "gate-c-c3-scenario-receipt",
      source_sha: sourceSha,
      owner_kind: "physical_device",
      owner_name: payload.platform,
      scenario: scenario.scenario,
      status: "passed",
      observed_at: scenario.observed_at,
      assertions: [...scenario.assertions].sort(),
      observations: scenario.observations,
      raw_trace_sha256: traceSha,
    };
    const receipt_sha256 = sha256(canonicalJson(unsignedScenario));
    const document = { ...unsignedScenario, receipt_sha256 };
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
    const scenarioRelative = `scenarios/${scenario.scenario}.json`;
    await writeFile(path.join(physicalDir, scenarioRelative), bytes, { flag: "wx" });
    artifact_hashes.push({ path: scenarioRelative, size_bytes: bytes.byteLength, sha256: receipt_sha256 });
    scenarios.push({ scenario: scenario.scenario, status: "passed", receipt_sha256 });
  }
  const unsignedReceipt = {
    artifact_kind: "gate-c-c3-physical-device-receipt",
    schema_version: 2,
    source_sha: sourceSha,
    platform: payload.platform,
    device_model: payload.device_model,
    os_version: payload.os_version,
    browser_name: payload.browser_name,
    browser_version: payload.browser_version,
    capture_id_sha256: sha256(payload.capture_id),
    collector_sha256: sha256(payload.collector),
    collection_method: payload.collection_method,
    device_run_id_sha256: sha256(payload.device_run_id),
    captured_at: payload.captured_at,
    collected_at: payload.collected_at,
    trusted_https_origin_sha256: sha256(payload.trusted_https_origin),
    tester_attestation_sha256: sha256(payload.tester_attestation),
    profile_identifier_sha256: sha256(`${payload.platform}:${payload.device_model}:${payload.device_run_id}`),
    deployment: {
      deployment_id: payload.deployment_id,
      build_id: payload.build_id,
      route_manifest_sha256: payload.route_manifest_sha256,
    },
    status: "passed",
    failed_count: 0,
    skipped_count: 0,
    scenarios,
    artifact_hashes: artifact_hashes.sort((a, b) => a.path.localeCompare(b.path)),
  } as const;
  const finalReceipt = { ...unsignedReceipt, receipt_sha256: sha256(canonicalJson(unsignedReceipt)) };
  const output = path.join(physicalDir, "receipt.json");
  await writeFile(output, `${JSON.stringify(finalReceipt, null, 2)}\n`, { flag: "wx" });
  return output;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sha =
    args.find((arg) => arg.startsWith("--sha="))?.slice(6) ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const deployment = args.find((arg) => arg.startsWith("--deployment-receipt="))?.slice(21);
  const routes = args.find((arg) => arg.startsWith("--route-manifest="))?.slice(17);
  const files = args.filter((arg) => !arg.startsWith("--"));
  if (!deployment || !routes || files.length === 0)
    throw new Error(
      "Usage: --sha=<SHA> --deployment-receipt=<READY receipt> --route-manifest=<approved routes> <ios.json> <android.json>",
    );
  const bindings = await loadEvidenceBindings(
    path.resolve(process.cwd(), deployment),
    path.resolve(process.cwd(), routes),
  );
  for (const file of files) {
    const output = await importPhysicalReceipt(
      JSON.parse(await readFile(path.resolve(process.cwd(), file), "utf8")) as RawPhysicalDevicePayload,
      sha,
      bindings,
    );
    process.stdout.write(
      `Imported hash-bound physical-device receipt (${(await stat(output)).size} bytes): ${output}\n`,
    );
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void main().catch((error: unknown) => {
    process.stderr.write(`Import failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  });
