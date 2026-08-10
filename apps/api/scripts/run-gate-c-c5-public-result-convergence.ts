import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeC5Workload } from "@matchday/observability";
import { parseGateCC5MaximumSamples, parseGateCC5WorkloadProfile } from "./gate-c-c5-workload-profile.js";
import { runOnce } from "./run-phase-4-real-e2e.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const project = "phase-4-real-desktop-chromium";
const operationTimeoutMs = 10_000;

function requireCleanSourceTree(): void {
  const dirty = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (dirty) throw new Error(`C5 public-result convergence refuses a dirty source tree:\n${dirty}`);
}

async function main(): Promise<void> {
  if (!/^[a-f0-9]{40}$/u.test(sourceSha)) throw new Error("C5 public-result convergence requires an exact source SHA");
  requireCleanSourceTree();
  const profile = parseGateCC5WorkloadProfile(process.env.GATE_C_C5_WORKLOAD_PROFILE_JSON);
  const maximumSamples = parseGateCC5MaximumSamples(process.env.GATE_C_C5_MAXIMUM_SAMPLES);
  if (maximumSamples < profile.publicReaderCount) {
    throw new Error("C5 public-result convergence needs at least one maximum sample per public reader");
  }
  const artifacts = path.join(root, "artifacts", "qa", "gate-c-c5", sourceSha, "public-result-convergence");
  const receiptPath = path.join(artifacts, "receipt.json");
  const isolationRecord = path.join(artifacts, "phase4-isolation.ndjson");
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  await runOnce(1, {
    sourceSha,
    recordFile: isolationRecord,
    redisDatabase: 14,
    infrastructureMode: (process.env.PHASE4_E2E_INFRA_MODE ?? "local") as "docker" | "local",
    afterGateCC4Complete: async (context) => {
      const executor = await context.createPublicResultConvergenceExecutor({ project, sampleCount: maximumSamples });
      const receipt = await executeC5Workload(
        {
          operation: "public_result_convergence",
          profile,
          sourceSha,
          maximumSamples,
          operationTimeoutMs,
          schedule: { kind: "convergence_waves", waveCount: 2, samplesPerWave: 150 },
        },
        executor,
      );
      if (
        receipt.correctness.passed !== true ||
        receipt.summary.unexpectedFailureCount !== 0 ||
        receipt.timeoutCount !== 0
      ) {
        throw new Error("C5 public-result convergence workload failed its correctness oracle");
      }
      requireCleanSourceTree();
      await writeFile(
        receiptPath,
        `${JSON.stringify({ artifact_kind: "gate-c-c5-public-result-convergence", source_sha: sourceSha, receipt }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      process.stdout.write(`C5 public-result convergence receipt: ${receiptPath}\n`);
    },
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
