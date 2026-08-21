import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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

export type RequiredPhysicalScenario = (typeof REQUIRED_PHYSICAL_SCENARIOS)[number];

export interface RawScenarioExecution {
  scenario: RequiredPhysicalScenario;
  status: "passed" | "failed";
  observed_at: string;
  assertions: string[];
  observations: Record<string, unknown>;
  raw_trace_sha256: string;
}

export interface RawPhysicalDevicePayload {
  platform: "ios" | "android";
  device_model: string;
  os_version: string;
  browser_name: string;
  browser_version: string;
  collected_at: string;
  trusted_https_origin: string;
  tester_attestation: string;
  scenarios: RawScenarioExecution[];
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function canonicalEvidenceJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalEvidenceJson).join(",")}]`;
  if (value && typeof value === "object" && value !== null) {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalEvidenceJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function validateRawPhysicalPayload(payload: unknown): asserts payload is RawPhysicalDevicePayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("Physical evidence payload must be an object");
  }
  const p = payload as Partial<RawPhysicalDevicePayload>;
  if (p.platform !== "ios" && p.platform !== "android") {
    throw new Error(`Invalid platform: ${p.platform}`);
  }
  if (!p.device_model || typeof p.device_model !== "string") {
    throw new Error("device_model is required and must be a string");
  }
  if (!p.os_version || typeof p.os_version !== "string") {
    throw new Error("os_version is required");
  }
  if (!p.browser_name || typeof p.browser_name !== "string") {
    throw new Error("browser_name is required");
  }
  if (!p.browser_version || typeof p.browser_version !== "string") {
    throw new Error("browser_version is required");
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
    if (!s.raw_trace_sha256 || s.raw_trace_sha256.length !== 64) {
      throw new Error(`Scenario ${s.scenario} is missing valid 64-char raw_trace_sha256`);
    }
    if (!Array.isArray(s.assertions) || s.assertions.length === 0) {
      throw new Error(`Scenario ${s.scenario} must contain at least one assertion`);
    }
  }
}

export async function importPhysicalReceipt(rawPayload: RawPhysicalDevicePayload, sourceSha: string): Promise<string> {
  validateRawPhysicalPayload(rawPayload);

  const physicalDir = path.join(root, "artifacts", "qa", "gate-c-c3", sourceSha, "physical", rawPayload.platform);
  const scenariosDir = path.join(physicalDir, "scenarios");
  await mkdir(scenariosDir, { recursive: true });

  const scenarioEntries = [];
  const artifactHashes = [];

  for (const s of rawPayload.scenarios) {
    const doc = {
      artifact_kind: "gate-c-c3-scenario-receipt",
      source_sha: sourceSha,
      owner_kind: "physical_device",
      owner_name: rawPayload.platform,
      scenario: s.scenario,
      status: s.status,
      observed_at: s.observed_at,
      assertions: s.assertions,
      observations: s.observations,
      raw_trace_sha256: s.raw_trace_sha256,
    };

    const docContent = `${JSON.stringify(doc, null, 2)}\n`;
    const docSha = sha256(docContent);
    const scenarioRelPath = `scenarios/${s.scenario}.json`;
    const scenarioAbsPath = path.join(physicalDir, scenarioRelPath);
    await writeFile(scenarioAbsPath, docContent, "utf8");

    scenarioEntries.push({
      scenario: s.scenario,
      status: s.status,
      receipt_sha256: docSha,
    });

    artifactHashes.push({
      path: scenarioRelPath,
      sha256: docSha,
      size_bytes: Buffer.byteLength(docContent, "utf8"),
    });
  }

  const baseReceipt = {
    artifact_kind: "gate-c-c3-physical-device-receipt",
    source_sha: sourceSha,
    platform: rawPayload.platform,
    status: "passed" as const,
    failed_count: 0,
    skipped_count: 0,
    device_model: rawPayload.device_model,
    os_version: rawPayload.os_version,
    browser_name: rawPayload.browser_name,
    browser_version: rawPayload.browser_version,
    collected_at: rawPayload.collected_at,
    trusted_https_origin_sha256: sha256(rawPayload.trusted_https_origin),
    profile_identifier_sha256: sha256(`matchday-c3-physical-profile-${rawPayload.platform}`),
    tester_attestation_sha256: sha256(rawPayload.tester_attestation),
    scenarios: scenarioEntries,
    artifact_hashes: artifactHashes,
  };

  const receiptSha256 = sha256(canonicalEvidenceJson(baseReceipt));
  const finalReceipt = {
    ...baseReceipt,
    receipt_sha256: receiptSha256,
  };

  const receiptPath = path.join(physicalDir, "receipt.json");
  await writeFile(receiptPath, `${JSON.stringify(finalReceipt, null, 2)}\n`, "utf8");
  return receiptPath;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const rawPath = args[0];
  if (!rawPath) {
    process.stderr.write("Usage: tsx import-gate-c-c3-physical-evidence.ts <path-to-raw-payload.json>\n");
    process.exit(1);
  }

  const payloadPath = path.resolve(process.cwd(), rawPath);
  const content = await readFile(payloadPath, "utf8");
  const payload = JSON.parse(content);

  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const receiptPath = await importPhysicalReceipt(payload, sourceSha);
  process.stdout.write(`Successfully imported and validated physical receipt: ${receiptPath}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((err) => {
    process.stderr.write(`Import failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
