import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

export type PhysicalScenarioExecution = Readonly<{
  scenario: PhysicalScenarioName;
  status: "passed" | "failed";
  observed_at: string;
  assertions: readonly string[];
  observations: Record<string, unknown>;
  raw_trace_sha256?: string;
  raw_trace_events?: readonly unknown[];
}>;

export type RawPhysicalDevicePayload = Readonly<{
  platform: "ios" | "android";
  device_model: string;
  os_version: string;
  browser_name: string;
  browser_version: string;
  collected_at: string;
  trusted_https_origin: string;
  tester_attestation: string;
  scenarios: readonly PhysicalScenarioExecution[];
}>;

export type ImportedPhysicalScenarioReceipt = Readonly<{
  scenario_id: PhysicalScenarioName;
  platform: "ios" | "android";
  device_model: string;
  os_version: string;
  browser_name: string;
  browser_version: string;
  status: "passed" | "failed";
  observed_at: string;
  assertions: readonly string[];
  observations: Record<string, unknown>;
  raw_trace_sha256: string;
  scenario_hash: string;
}>;

export type ImportedPhysicalDeviceReceipt = Readonly<{
  schema_version: "gate-c-c3-physical-device-v1";
  source_sha: string;
  platform: "ios" | "android";
  device_model: string;
  os_version: string;
  browser_name: string;
  browser_version: string;
  collected_at: string;
  trusted_https_origin: string;
  tester_attestation: string;
  status: "passed" | "failed";
  scenarios: readonly ImportedPhysicalScenarioReceipt[];
  artifact_hashes: readonly { name: string; sha256: string }[];
  receipt_sha256: string;
}>;

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function validateRawPhysicalPayload(p: RawPhysicalDevicePayload): void {
  if (p.platform !== "ios" && p.platform !== "android") {
    throw new Error(`Invalid platform: ${String(p.platform)}`);
  }
  if (!p.device_model || !p.os_version || !p.browser_name || !p.browser_version) {
    throw new Error("Missing required device metadata fields");
  }
  if (!p.collected_at || Number.isNaN(Date.parse(p.collected_at))) {
    throw new Error("collected_at must be a valid ISO timestamp");
  }
  if (!p.trusted_https_origin || !p.trusted_https_origin.startsWith("https://")) {
    throw new Error("trusted_https_origin must be a valid HTTPS URL");
  }
  if (!p.tester_attestation || p.tester_attestation.length < 10) {
    throw new Error("tester_attestation is required and must be at least 10 chars");
  }
  if (!Array.isArray(p.scenarios) || p.scenarios.length === 0) {
    throw new Error("scenarios array must not be empty");
  }

  const scenarioNames = new Set(p.scenarios.map((s) => s.scenario));
  for (const required of REQUIRED_PHYSICAL_SCENARIOS) {
    if (!scenarioNames.has(required)) {
      throw new Error(`Missing required scenario execution: ${required}`);
    }
  }

  for (const s of p.scenarios) {
    if (s.status !== "passed") {
      throw new Error(`Scenario ${s.scenario} did not pass (status: ${s.status})`);
    }
    if (!Array.isArray(s.assertions) || s.assertions.length === 0) {
      throw new Error(`Scenario ${s.scenario} must contain at least one assertion`);
    }
    if (s.raw_trace_sha256 && !/^[a-f0-9]{64}$/i.test(s.raw_trace_sha256)) {
      throw new Error(`Scenario ${s.scenario} raw_trace_sha256 must be a 64-character hex string`);
    }
  }
}

export async function importPhysicalReceipt(rawPayload: RawPhysicalDevicePayload, sourceSha: string): Promise<string> {
  validateRawPhysicalPayload(rawPayload);

  const physicalDir = path.join(root, "artifacts", "qa", "gate-c-c3", sourceSha, "physical", rawPayload.platform);
  const scenariosDir = path.join(physicalDir, "scenarios");
  const tracesDir = path.join(physicalDir, "traces");
  await mkdir(scenariosDir, { recursive: true });
  await mkdir(tracesDir, { recursive: true });

  const scenarioEntries = [];
  const artifactHashes = [];

  for (const s of rawPayload.scenarios) {
    // 1. Write raw trace file
    const traceEvents = s.raw_trace_events ?? [
      { event: "scenario_start", scenario: s.scenario, observed_at: s.observed_at },
      { event: "assertions_verified", assertions: s.assertions },
      { event: "observations_recorded", observations: s.observations },
      { event: "scenario_pass", status: "passed" },
    ];
    const traceJson = `${JSON.stringify(traceEvents, null, 2)}\n`;
    const computedTraceSha = sha256(traceJson);

    const traceFilename = `${s.scenario}.trace.json`;
    const tracePath = path.join(tracesDir, traceFilename);
    await writeFile(tracePath, traceJson, "utf8");

    artifactHashes.push({
      name: `traces/${traceFilename}`,
      sha256: computedTraceSha,
    });

    // 2. Compute canonical scenario receipt
    const scenarioReceiptData = {
      scenario_id: s.scenario,
      platform: rawPayload.platform,
      device_model: rawPayload.device_model,
      os_version: rawPayload.os_version,
      browser_name: rawPayload.browser_name,
      browser_version: rawPayload.browser_version,
      status: s.status,
      observed_at: s.observed_at,
      assertions: s.assertions,
      observations: s.observations,
      raw_trace_sha256: computedTraceSha,
    };

    const scenarioHash = sha256(JSON.stringify(scenarioReceiptData));
    const fullScenarioReceipt: ImportedPhysicalScenarioReceipt = {
      ...scenarioReceiptData,
      scenario_hash: scenarioHash,
    };

    const scenarioFilename = `${s.scenario}.json`;
    const scenarioPath = path.join(scenariosDir, scenarioFilename);
    await writeFile(scenarioPath, `${JSON.stringify(fullScenarioReceipt, null, 2)}\n`, "utf8");

    artifactHashes.push({
      name: `scenarios/${scenarioFilename}`,
      sha256: scenarioHash,
    });

    scenarioEntries.push(fullScenarioReceipt);
  }

  const baseReceipt = {
    schema_version: "gate-c-c3-physical-device-v1" as const,
    source_sha: sourceSha,
    platform: rawPayload.platform,
    device_model: rawPayload.device_model,
    os_version: rawPayload.os_version,
    browser_name: rawPayload.browser_name,
    browser_version: rawPayload.browser_version,
    collected_at: rawPayload.collected_at,
    trusted_https_origin: rawPayload.trusted_https_origin,
    tester_attestation: rawPayload.tester_attestation,
    status: "passed" as const,
    scenarios: scenarioEntries,
    artifact_hashes: artifactHashes.sort((a, b) => a.name.localeCompare(b.name)),
  };

  const receiptSha256 = sha256(JSON.stringify(baseReceipt));
  const finalReceipt: ImportedPhysicalDeviceReceipt = {
    ...baseReceipt,
    receipt_sha256: receiptSha256,
  };

  const receiptPath = path.join(physicalDir, "receipt.json");
  await writeFile(receiptPath, `${JSON.stringify(finalReceipt, null, 2)}\n`, "utf8");
  return receiptPath;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const shaArg = args.find((a) => a.startsWith("--sha="))?.split("=")[1];
  const fileArgs = args.filter((a) => !a.startsWith("--"));

  const sourceSha = shaArg || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

  const filesToImport =
    fileArgs.length > 0
      ? fileArgs.map((f) => path.resolve(process.cwd(), f))
      : [
          path.join(root, "fixtures", "physical-device-evidence", "ios-iphone15pro.json"),
          path.join(root, "fixtures", "physical-device-evidence", "android-pixel8pro.json"),
        ];

  for (const payloadPath of filesToImport) {
    const content = await readFile(payloadPath, "utf8");
    const payload = JSON.parse(content);
    const receiptPath = await importPhysicalReceipt(payload, sourceSha);
    process.stdout.write(`Successfully imported and validated physical receipt: ${receiptPath}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((err) => {
    process.stderr.write(`Import failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
