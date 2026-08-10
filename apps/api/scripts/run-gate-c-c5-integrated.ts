import { execFileSync } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  C5_APPROVED_PILOT_PROFILE,
  createC5ApprovedPilotWorkloadPlan,
  executeC5IntegratedWorkload,
  type C5IntegratedWorkloadReceipt,
} from "@matchday/observability";
import {
  createGateCC5ControlledFailureHooks,
  parseGateCC5ControlledFailureConfiguration,
} from "./gate-c-c5-controlled-failures.js";
import { c5ReceiptHash } from "./gate-c-c5-evidence.js";
import { gateCC5RetainedArtifactRoot, verifyGateCC5RetainedArtifacts } from "./gate-c-c5-retained-artifacts.js";
import { parseGateCC5WorkloadProfile } from "./gate-c-c5-workload-profile.js";
import {
  resolveInfrastructureMode,
  runOnce,
  sourceShaAtHead,
  type GateCC4CompletedRunContext,
} from "./run-phase-4-real-e2e.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const EXACT_SHA = /^[a-f0-9]{40}$/u;

export type GateCC5IntegratedRunEnvironment = Readonly<{
  sourceSha: string;
  runNumber: 1 | 2;
  redisDatabase: number;
  operationTimeoutMs: number;
  receiptPath: string;
}>;

function exactApprovedProfile(profile: ReturnType<typeof parseGateCC5WorkloadProfile>): void {
  if (JSON.stringify(profile) !== JSON.stringify(C5_APPROVED_PILOT_PROFILE)) {
    throw new Error("Gate C C5 integrated run profile does not exactly match c5-pilot-2026-001 approval");
  }
}

function requiredInteger(value: string | undefined, label: string, minimum: number, maximum: number): number {
  if (!value || !/^\d+$/u.test(value)) throw new Error(`Gate C C5 ${label} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Gate C C5 ${label} must be from ${String(minimum)} to ${String(maximum)}`);
  }
  return parsed;
}

export function parseGateCC5IntegratedRunEnvironment(environment: NodeJS.ProcessEnv): GateCC5IntegratedRunEnvironment {
  const sourceSha = environment.GATE_C_C5_SOURCE_SHA ?? "";
  if (!EXACT_SHA.test(sourceSha)) throw new Error("Gate C C5 integrated run requires GATE_C_C5_SOURCE_SHA");
  const runNumber = requiredInteger(environment.GATE_C_C5_RUN_NUMBER, "run number", 1, 2) as 1 | 2;
  const redisDatabase = requiredInteger(environment.GATE_C_C5_REDIS_DATABASE, "Redis database", 0, 15);
  const operationTimeoutMs = requiredInteger(
    environment.GATE_C_C5_OPERATION_TIMEOUT_MS ?? "60000",
    "operation timeout milliseconds",
    1,
    60_000,
  );
  const retainedRoot = gateCC5RetainedArtifactRoot(sourceSha);
  const receiptPath = path.resolve(environment.GATE_C_C5_INTEGRATED_RECEIPT ?? "");
  const requiredParent = path.join(retainedRoot, `run-${String(runNumber)}`);
  if (
    !environment.GATE_C_C5_INTEGRATED_RECEIPT ||
    path.dirname(receiptPath) !== requiredParent ||
    path.basename(receiptPath) !== "integrated-workload-receipt.json"
  ) {
    throw new Error(
      `Gate C C5 GATE_C_C5_INTEGRATED_RECEIPT must be ${path.join(requiredParent, "integrated-workload-receipt.json")}`,
    );
  }
  return { sourceSha, runNumber, redisDatabase, operationTimeoutMs, receiptPath };
}

export function assertGateCC5IntegratedPreflight(sourceSha: string): void {
  if (process.version !== "v24.18.0") {
    throw new Error(`Gate C C5 integrated run requires Node v24.18.0; received ${process.version}`);
  }
  const pnpmVersion = execFileSync("pnpm", ["--version"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  if (pnpmVersion !== "10.33.0") {
    throw new Error(`Gate C C5 integrated run requires pnpm 10.33.0; received ${pnpmVersion}`);
  }
  const head = sourceShaAtHead();
  if (head !== sourceSha) throw new Error("Gate C C5 integrated run source SHA does not match HEAD");
  execFileSync("git", ["cat-file", "-e", `${sourceSha}^{commit}`], { cwd: repositoryRoot, stdio: "ignore" });
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (status.trim()) throw new Error("Gate C C5 integrated run refuses a dirty working tree");
}

/** Refuses stale deterministic run evidence before Phase 4 provisioning or any fault command. */
export async function assertGateCC5IntegratedEvidencePathsAvailable(
  configuration: GateCC5IntegratedRunEnvironment,
): Promise<void> {
  const runRoot = path.dirname(configuration.receiptPath);
  try {
    await lstat(runRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Gate C C5 integrated run refuses pre-existing evidence path: ${runRoot}`);
}

function projectNames(context: GateCC4CompletedRunContext): string[] {
  const projects = Object.keys(context.repairs).sort();
  if (projects.length < 6) throw new Error("Gate C C5 integrated run requires all six real Phase 4 projects");
  return projects;
}

async function executeAgainstRealPhase4Context(
  context: GateCC4CompletedRunContext,
  input: Readonly<{
    profile: ReturnType<typeof parseGateCC5WorkloadProfile>;
    operationTimeoutMs: number;
    controlledFailureJson: string | undefined;
  }>,
): Promise<Readonly<{ receipt: C5IntegratedWorkloadReceipt; artifacts: unknown }>> {
  const projects = projectNames(context);
  const plan = createC5ApprovedPilotWorkloadPlan(input.profile);
  const target = {
    environment: "dedicated_c5_drill" as const,
    production: false as const,
    shared: false as const,
    postgresqlIdentifier: context.postgresqlIdentifier,
    redisNamespace: context.redisNamespace,
    apiOrigin: context.apiOrigin,
    webOrigin: context.webOrigin,
    ...context.runtimeControls,
  };
  const controlledConfiguration = parseGateCC5ControlledFailureConfiguration(
    input.controlledFailureJson,
    context.sourceSha,
    target,
  );
  const controlled = createGateCC5ControlledFailureHooks(
    controlledConfiguration,
    undefined,
    `run-${String(context.runNumber)}/`,
  );
  // Acquire session-backed resources only immediately before their serial operation.
  // Provisioning is outside measured latency and cannot consume an earlier operation's lease lifetime.
  const operationResources = {
    score_event_acknowledgement: async () =>
      await context.createScoreEventExecutor({
        project: projects[0]!,
        workerCount: input.profile.scorekeeperCount,
        durationSeconds: input.profile.durationSeconds,
      }),
    public_result_convergence: async () => ({
      executor: await context.createPublicResultConvergenceExecutor({
        project: projects[1]!,
        sampleCount: plan.convergencePolicy.waveCount * plan.convergencePolicy.samplesPerWave,
      }),
    }),
    public_current_conditional_read: async () => ({
      executor: context.createPublicCurrentExecutor({ project: projects[2]! }),
    }),
    lease_takeover: async () => ({
      executor: await context.createLeaseTakeoverExecutor({
        project: projects[3]!,
        workerCount: input.profile.scorekeeperCount,
      }),
    }),
    repair_publication: async () => ({
      executor: await context.createRepairPublicationExecutor({
        workerCount: input.profile.organiserWorkerCount,
      }),
    }),
  } as const;
  const receipt = await executeC5IntegratedWorkload({
    sourceSha: context.sourceSha,
    plan,
    operationTimeoutMs: input.operationTimeoutMs,
    operationResources,
    controlledFailureHooks: controlled.hooks,
    postgresqlIdentifier: context.postgresqlIdentifier,
    redisNamespace: context.redisNamespace,
  });
  await verifyGateCC5RetainedArtifacts({
    retainedRoot: gateCC5RetainedArtifactRoot(context.sourceSha),
    sourceSha: context.sourceSha,
    receipt,
    artifacts: controlled.artifacts,
  });
  return { receipt, artifacts: controlled.artifacts };
}

/** Runs one top-level exact-SHA C5 integrated workload; the ledger invokes it once per isolated run. */
export async function runGateCC5Integrated(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const configuration = parseGateCC5IntegratedRunEnvironment(environment);
  assertGateCC5IntegratedPreflight(configuration.sourceSha);
  await assertGateCC5IntegratedEvidencePathsAvailable(configuration);
  const profile = parseGateCC5WorkloadProfile(environment.GATE_C_C5_WORKLOAD_PROFILE_JSON);
  exactApprovedProfile(profile);
  const runRoot = path.dirname(configuration.receiptPath);
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  const isolationRecord = path.join(runRoot, "phase4-isolation.ndjson");
  let result: Awaited<ReturnType<typeof executeAgainstRealPhase4Context>> | null = null;
  await runOnce(configuration.runNumber, {
    recordFile: isolationRecord,
    redisDatabase: configuration.redisDatabase,
    infrastructureMode: resolveInfrastructureMode(environment.PHASE4_E2E_INFRA_MODE),
    sourceSha: configuration.sourceSha,
    afterGateCC4Complete: async (context) => {
      result = await executeAgainstRealPhase4Context(context, {
        profile,
        operationTimeoutMs: configuration.operationTimeoutMs,
        controlledFailureJson: environment.GATE_C_C5_CONTROLLED_FAILURES_JSON,
      });
    },
  });
  if (!result) throw new Error("Gate C C5 integrated run completed without an integrated receipt");
  const receipt = (result as Awaited<ReturnType<typeof executeAgainstRealPhase4Context>>).receipt;
  const artifacts = (result as Awaited<ReturnType<typeof executeAgainstRealPhase4Context>>).artifacts;
  // Keep retained bytes identical to the workload authority's canonical hash input.
  const receiptBytes = JSON.stringify(receipt);
  await writeFile(configuration.receiptPath, receiptBytes, { mode: 0o600, flag: "wx" });
  await writeFile(
    path.join(runRoot, "controlled-failure-artifacts.json"),
    `${JSON.stringify(
      {
        artifact_kind: "gate-c-c5-controlled-failure-artifact-index",
        source_sha: configuration.sourceSha,
        run: configuration.runNumber,
        receipt_sha256: c5ReceiptHash(receipt),
        artifacts,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600, flag: "wx" },
  );
  process.stdout.write(`Gate C C5 integrated run ${String(configuration.runNumber)}: PASS\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runGateCC5Integrated().catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
