import { execFileSync } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type C5ApprovedWorkloadPlan, type C5IntegratedWorkloadReceipt } from "@matchday/observability";

import { gateCC5RetainedArtifactRoot, verifyGateCC5RetainedArtifacts } from "./gate-c-c5-retained-artifacts.js";
import { parseGateCC5WorkloadProfile } from "./gate-c-c5-workload-profile.js";
import { runC5BenchmarkAndEvidence } from "./run-gate-c-c5-benchmark.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sourceShaPattern = /^[a-f0-9]{40}$/u;
const minimumCertificationSamples = 500;

function exactSourceSha(): string {
  const value = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (!sourceShaPattern.test(value)) throw new Error("Gate C C5 certification requires a full source SHA");
  return value;
}

function requireCleanSourceTree(): void {
  const dirty = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (dirty) throw new Error(`Refusing Gate C C5 certification on a dirty source tree:\n${dirty}`);
}

function requiredPositiveInteger(value: string | undefined, label: string, minimum: number, maximum: number): number {
  if (!value || !/^\d+$/u.test(value)) throw new Error(`Gate C C5 certification requires ${label}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Gate C C5 ${label} must be an integer from ${String(minimum)} to ${String(maximum)}`);
  }
  return parsed;
}

async function writeCertification(output: string, receipt: unknown, artifacts: unknown): Promise<void> {
  await writeFile(output, `${JSON.stringify({ receipt, retained_artifacts: artifacts }, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

/**
 * Authoritative C5 entry point. It deliberately has no local/default runtime:
 * certification is valid only when a controlled-staging adapter supplies real
 * Postgres, Redis, API/web/worker paths, and actual fault injection hooks.
 */
export async function runGateCC5Certification(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (environment.GATE_C_C5_STAGING_OPT_IN !== "1") {
    throw new Error("Refusing C5 certification without GATE_C_C5_STAGING_OPT_IN=1");
  }
  requireCleanSourceTree();
  const sourceSha = exactSourceSha();
  const profileJson = environment.GATE_C_C5_WORKLOAD_PROFILE_JSON;
  const profile = parseGateCC5WorkloadProfile(profileJson);
  const minimumSamplesPerOperation = requiredPositiveInteger(
    environment.GATE_C_C5_MINIMUM_SAMPLES,
    "GATE_C_C5_MINIMUM_SAMPLES",
    minimumCertificationSamples,
    1_000_000,
  );
  const operationTimeoutMs = requiredPositiveInteger(
    environment.GATE_C_C5_OPERATION_TIMEOUT_MS,
    "GATE_C_C5_OPERATION_TIMEOUT_MS",
    1,
    60_000,
  );
  const maximumSamples = requiredPositiveInteger(
    environment.GATE_C_C5_MAXIMUM_SAMPLES,
    "GATE_C_C5_MAXIMUM_SAMPLES",
    minimumSamplesPerOperation,
    1_000_000,
  );
  const retainedRoot = gateCC5RetainedArtifactRoot(sourceSha);
  await mkdir(retainedRoot, { recursive: true });
  if ((await realpath(retainedRoot)) !== retainedRoot) {
    throw new Error("Gate C C5 retained root must not traverse symlinks");
  }
  const output = path.join(path.dirname(retainedRoot), "certification.json");
  const plan: C5ApprovedWorkloadPlan = { profile, minimumSamplesPerOperation };
  {
    const receipt = (await runC5BenchmarkAndEvidence({
      plan,
      maximumSamples,
      operationTimeoutMs,
      retainedRoot,
    })) as C5IntegratedWorkloadReceipt;
    const retainedArtifacts = Object.fromEntries(
      receipt.controlled_failures.map((failure) => [
        failure.fault,
        {
          injection: `${failure.fault}/injection.log`,
          recovery: `${failure.fault}/recovery.log`,
          cleanup: `${failure.fault}/cleanup.log`,
        },
      ]),
    );
    await verifyGateCC5RetainedArtifacts({
      retainedRoot,
      sourceSha,
      receipt,
      artifacts: retainedArtifacts,
    });
    requireCleanSourceTree();
    if (exactSourceSha() !== sourceSha) throw new Error("Gate C C5 source changed during certification");
    await writeCertification(output, receipt, retainedArtifacts);
    return output;
  }
}

async function main(): Promise<void> {
  const output = await runGateCC5Certification();
  process.stdout.write(`Gate C C5 certification receipt retained at ${output}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `Gate C C5 certification FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
