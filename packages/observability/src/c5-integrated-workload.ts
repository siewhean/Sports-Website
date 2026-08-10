import { createHash } from "node:crypto";
import {
  C5_WORKLOAD_OPERATIONS,
  assertC5OperationBudget,
  assertC5WorkloadProfile,
  type C5WorkloadOperation,
  type C5WorkloadProfile,
} from "./workload-profile.js";
import {
  executeC5Workload,
  type C5WorkloadExecutor,
  type C5WorkloadReceipt,
  type C5WorkloadSchedule,
  type C5WorkloadTiming,
} from "./workload-runner.js";

const sha256 = /^[a-f0-9]{64}$/u;
const sourceSha = /^[a-f0-9]{40}$/u;
const recoveryOracle = /^[a-z][a-z0-9_]{2,199}$/u;

/**
 * These are intentionally distinct from ordinary workload failures. A C5
 * certification run must prove that each fault was injected and that its
 * operation-specific oracle observed the expected safe outcome.
 */
export const C5_CONTROLLED_FAILURES = [
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
] as const;

export type C5ControlledFailure = (typeof C5_CONTROLLED_FAILURES)[number];

export const C5_FAULT_INJECTORS = [
  "process_signal",
  "network_proxy",
  "connection_limit",
  "bounded_delay",
  "filesystem_limit",
  "command",
] as const;

export type C5FaultInjector = (typeof C5_FAULT_INJECTORS)[number];

export type C5ControlledFailureReceipt = Readonly<{
  fault: C5ControlledFailure;
  injector: C5FaultInjector;
  /** Hashes bind retained raw drill logs without publishing topology or credentials. */
  injection_evidence_sha256: string;
  recovery_evidence_sha256: string;
  cleanup_evidence_sha256: string;
  recovery_observed: true;
  cleanup_observed: true;
  /** A stable non-secret code such as `retry_after_redis_recovery`. */
  recovery_oracle: string;
}>;

export type C5ControlledFailureHook = () => Promise<C5ControlledFailureReceipt>;

export type C5IntegratedWorkloadReceipt = Readonly<{
  artifact_kind: "gate-c-c5-integrated-workload-receipt";
  source_sha: string;
  profile_id: string;
  approval_reference_sha256: string;
  workload_plan_sha256: string;
  minimum_samples_per_operation: number;
  duration_ms: number;
  operations: Readonly<Record<C5WorkloadOperation, C5WorkloadReceipt>>;
  controlled_failures: readonly C5ControlledFailureReceipt[];
  postgresql_identifier_sha256: string;
  redis_namespace_sha256: string;
}>;

/**
 * The C5 ledger must retain this approved plan with the source evidence. It
 * prevents an operator from reducing an otherwise approved pilot profile to a
 * single smoke request after approval.
 */
export type C5ApprovedWorkloadPlan = Readonly<{
  profile: C5WorkloadProfile;
  minimumSamplesPerOperation: number;
  maximumSamplesPerOperation: Readonly<Record<C5WorkloadOperation, number>>;
  maximumSamplesPerWorkerPerSecond: number;
  convergencePolicy: Readonly<{
    waveCount: number;
    samplesPerWave: number;
  }>;
}>;

type C5IntegratedWorkloadExecutionBase = Readonly<{
  sourceSha: string;
  plan: C5ApprovedWorkloadPlan;
  operationTimeoutMs: number;
  controlledFailureHooks: Readonly<Record<C5ControlledFailure, C5ControlledFailureHook>>;
  postgresqlIdentifier: string;
  redisNamespace: string;
}>;

export type C5WorkloadResource = Readonly<{
  executor: C5WorkloadExecutor;
  close?(): Promise<void>;
}>;

export type C5IntegratedWorkloadExecution = C5IntegratedWorkloadExecutionBase &
  (
    | Readonly<{
        executors: Readonly<Record<C5WorkloadOperation, C5WorkloadExecutor>>;
        operationResources?: never;
      }>
    | Readonly<{
        executors?: never;
        operationResources: Readonly<Record<C5WorkloadOperation, () => Promise<C5WorkloadResource>>>;
      }>
  );

export const C5_MINIMUM_SAMPLES_PER_OPERATION = 150;
export const C5_MAXIMUM_SAMPLES_PER_WORKER_PER_SECOND = 1;
export const C5_MAXIMUM_SAMPLES_PER_OPERATION = Object.freeze({
  score_event_acknowledgement: 7_200,
  public_result_convergence: 300,
  public_current_conditional_read: 540_000,
  lease_takeover: 7_200,
  repair_publication: 18_000,
}) satisfies Readonly<Record<C5WorkloadOperation, number>>;
export const C5_CONVERGENCE_POLICY = Object.freeze({ waveCount: 2, samplesPerWave: 150 });

export const C5_APPROVED_PILOT_PROFILE = Object.freeze({
  profileId: "c5-pilot-2026-001",
  durationSeconds: 3_600,
  scorekeeperCount: 2,
  publicReaderCount: 150,
  organiserWorkerCount: 5,
  approval: Object.freeze({
    owner: "Siew Hean, Tournament Director",
    approvedAtUtc: "2026-07-04T08:30:00Z",
    reference: "C5-PILOT-APPROVAL-2026-001",
  }),
}) satisfies C5WorkloadProfile;

/** Returns the single hash-bindable workload plan approved for C5 closeout. */
export function createC5ApprovedPilotWorkloadPlan(
  profile: C5WorkloadProfile = C5_APPROVED_PILOT_PROFILE,
): C5ApprovedWorkloadPlan {
  assertC5WorkloadProfile(profile);
  const plan: C5ApprovedWorkloadPlan = {
    profile,
    minimumSamplesPerOperation: C5_MINIMUM_SAMPLES_PER_OPERATION,
    maximumSamplesPerOperation: C5_MAXIMUM_SAMPLES_PER_OPERATION,
    maximumSamplesPerWorkerPerSecond: C5_MAXIMUM_SAMPLES_PER_WORKER_PER_SECOND,
    convergencePolicy: C5_CONVERGENCE_POLICY,
  };
  validatePlan(plan);
  return plan;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("C5 integrated workload plan has an unsupported value");
  return encoded;
}

function validatePlan(plan: C5ApprovedWorkloadPlan): void {
  const candidate = record(plan);
  const profile = record(plan.profile);
  const approval = profile ? record(profile.approval) : null;
  if (
    !candidate ||
    !exactKeys(candidate, [
      "profile",
      "minimumSamplesPerOperation",
      "maximumSamplesPerOperation",
      "maximumSamplesPerWorkerPerSecond",
      "convergencePolicy",
    ])
  ) {
    throw new Error("C5 integrated workload plan has unsupported fields");
  }
  if (
    !profile ||
    !exactKeys(profile, [
      "profileId",
      "durationSeconds",
      "scorekeeperCount",
      "publicReaderCount",
      "organiserWorkerCount",
      "approval",
    ]) ||
    !approval ||
    !exactKeys(approval, ["owner", "approvedAtUtc", "reference"])
  ) {
    throw new Error("C5 integrated workload plan has unsupported profile fields");
  }
  assertC5WorkloadProfile(plan.profile);
  if (plan.minimumSamplesPerOperation !== C5_MINIMUM_SAMPLES_PER_OPERATION) {
    throw new Error("C5 integrated workload plan requires exactly 150 minimum samples per operation");
  }
  if (
    plan.profile.profileId !== C5_APPROVED_PILOT_PROFILE.profileId ||
    plan.profile.durationSeconds !== 3_600 ||
    plan.profile.scorekeeperCount !== 2 ||
    plan.profile.publicReaderCount !== 150 ||
    plan.profile.organiserWorkerCount !== 5 ||
    plan.profile.approval.owner !== C5_APPROVED_PILOT_PROFILE.approval.owner ||
    plan.profile.approval.approvedAtUtc !== C5_APPROVED_PILOT_PROFILE.approval.approvedAtUtc ||
    plan.profile.approval.reference !== C5_APPROVED_PILOT_PROFILE.approval.reference
  ) {
    throw new Error("C5 integrated workload plan does not match the approved pilot profile");
  }
  if (
    !exactKeys(record(plan.maximumSamplesPerOperation) ?? {}, C5_WORKLOAD_OPERATIONS) ||
    C5_WORKLOAD_OPERATIONS.some(
      (operation) => plan.maximumSamplesPerOperation[operation] !== C5_MAXIMUM_SAMPLES_PER_OPERATION[operation],
    )
  ) {
    throw new Error("C5 integrated workload plan has invalid per-operation sample ceilings");
  }
  if (plan.maximumSamplesPerWorkerPerSecond !== C5_MAXIMUM_SAMPLES_PER_WORKER_PER_SECOND) {
    throw new Error("C5 integrated workload plan requires at most one sample per worker per second");
  }
  if (
    !exactKeys(record(plan.convergencePolicy) ?? {}, ["waveCount", "samplesPerWave"]) ||
    plan.convergencePolicy.waveCount !== 2 ||
    plan.convergencePolicy.samplesPerWave !== 150
  ) {
    throw new Error("C5 integrated workload plan requires two convergence waves of 150 samples");
  }
}

export function assertC5ApprovedWorkloadPlan(plan: C5ApprovedWorkloadPlan): void {
  validatePlan(plan);
}

function operationWorkerCount(profile: C5WorkloadProfile, operation: C5WorkloadOperation): number {
  switch (operation) {
    case "score_event_acknowledgement":
    case "lease_takeover":
      return profile.scorekeeperCount;
    case "public_result_convergence":
    case "public_current_conditional_read":
      return profile.publicReaderCount;
    case "repair_publication":
      return profile.organiserWorkerCount;
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`C5 integrated ${label} must not be empty`);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
  return observed.length === expected.length && observed.every((key, index) => key === expected[index]);
}

function assertFaultReceipt(value: C5ControlledFailureReceipt, expected: C5ControlledFailure): void {
  const candidate = record(value);
  if (
    !candidate ||
    !exactKeys(candidate, [
      "fault",
      "injector",
      "injection_evidence_sha256",
      "recovery_evidence_sha256",
      "cleanup_evidence_sha256",
      "recovery_observed",
      "cleanup_observed",
      "recovery_oracle",
    ]) ||
    value.fault !== expected ||
    !C5_FAULT_INJECTORS.includes(value.injector) ||
    !sha256.test(value.injection_evidence_sha256) ||
    !sha256.test(value.recovery_evidence_sha256) ||
    !sha256.test(value.cleanup_evidence_sha256) ||
    value.recovery_observed !== true ||
    value.cleanup_observed !== true
  ) {
    throw new Error(`C5 controlled failure ${expected} did not produce a valid receipt`);
  }
  if (typeof value.recovery_oracle !== "string" || !recoveryOracle.test(value.recovery_oracle)) {
    throw new Error(`C5 controlled failure ${expected} has an unsafe recovery oracle`);
  }
}

function assertWorkloadReceipt(
  value: unknown,
  operation: C5WorkloadOperation,
  plan: C5ApprovedWorkloadPlan,
  expectedSourceSha: string,
): asserts value is C5WorkloadReceipt {
  const receipt = record(value);
  const summary = receipt ? record(receipt.summary) : null;
  const correctness = receipt ? record(receipt.correctness) : null;
  if (
    !receipt ||
    !summary ||
    !correctness ||
    !exactKeys(receipt, [
      "operation",
      "sourceSha",
      "workerCount",
      "timeoutCount",
      "elapsedMs",
      "scheduledCadenceMs",
      "convergenceWaveCount",
      "convergenceSamplesPerWave",
      "summary",
      "correctness",
    ]) ||
    !exactKeys(summary, [
      "sampleCount",
      "successfulCount",
      "expectedFailureCount",
      "unexpectedFailureCount",
      "errorRate",
      "p50Ms",
      "p95Ms",
      "p99Ms",
      "maxMs",
    ]) ||
    !exactKeys(correctness, ["passed"]) ||
    receipt.operation !== operation ||
    receipt.sourceSha !== expectedSourceSha ||
    receipt.workerCount !== operationWorkerCount(plan.profile, operation) ||
    receipt.timeoutCount !== 0 ||
    typeof receipt.elapsedMs !== "number" ||
    !Number.isFinite(receipt.elapsedMs) ||
    receipt.elapsedMs < plan.profile.durationSeconds * 1_000 ||
    typeof summary.sampleCount !== "number" ||
    !Number.isInteger(summary.sampleCount) ||
    summary.sampleCount < plan.minimumSamplesPerOperation ||
    typeof summary.successfulCount !== "number" ||
    !Number.isInteger(summary.successfulCount) ||
    summary.successfulCount < plan.minimumSamplesPerOperation ||
    typeof summary.expectedFailureCount !== "number" ||
    !Number.isInteger(summary.expectedFailureCount) ||
    summary.expectedFailureCount !== 0 ||
    typeof summary.unexpectedFailureCount !== "number" ||
    !Number.isInteger(summary.unexpectedFailureCount) ||
    summary.unexpectedFailureCount !== 0 ||
    summary.errorRate !== 0 ||
    typeof summary.p50Ms !== "number" ||
    !Number.isFinite(summary.p50Ms) ||
    summary.p50Ms < 0 ||
    typeof summary.p95Ms !== "number" ||
    !Number.isFinite(summary.p95Ms) ||
    summary.p95Ms < 0 ||
    typeof summary.p99Ms !== "number" ||
    !Number.isFinite(summary.p99Ms) ||
    summary.p99Ms < 0 ||
    typeof summary.maxMs !== "number" ||
    !Number.isFinite(summary.maxMs) ||
    summary.maxMs < 0 ||
    summary.sampleCount !== summary.successfulCount + summary.expectedFailureCount + summary.unexpectedFailureCount ||
    summary.p50Ms > summary.p95Ms ||
    summary.p95Ms > summary.p99Ms ||
    summary.p99Ms > summary.maxMs ||
    correctness.passed !== true
  ) {
    throw new Error(`C5 integrated workload receipt failed ${operation}`);
  }
  if (operation === "public_result_convergence") {
    if (
      receipt.scheduledCadenceMs !== null ||
      receipt.convergenceWaveCount !== plan.convergencePolicy.waveCount ||
      receipt.convergenceSamplesPerWave !== plan.convergencePolicy.samplesPerWave ||
      summary.sampleCount !== plan.convergencePolicy.waveCount * plan.convergencePolicy.samplesPerWave
    ) {
      throw new Error(`C5 integrated workload receipt failed ${operation}`);
    }
  } else if (
    receipt.scheduledCadenceMs !== 1_000 ||
    receipt.convergenceWaveCount !== 0 ||
    receipt.convergenceSamplesPerWave !== 0 ||
    summary.sampleCount > plan.maximumSamplesPerOperation[operation]
  ) {
    throw new Error(`C5 integrated workload receipt failed ${operation}`);
  }
  const validated = value as C5WorkloadReceipt;
  assertC5OperationBudget(operation, validated.summary, { passed: true });
}

/**
 * Validates a sanitised exact-SHA receipt. It deliberately accepts only hashes
 * for infrastructure identities and approval references: callers must retain
 * raw operational logs outside Git under the corresponding exact-SHA path.
 */
export function validateC5IntegratedWorkloadReceipt(
  value: unknown,
  expected: Readonly<{ sourceSha: string; plan: C5ApprovedWorkloadPlan }>,
): C5IntegratedWorkloadReceipt {
  validatePlan(expected.plan);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("C5 integrated workload receipt must be an object");
  }
  const rawReceipt = record(value)!;
  if (
    !exactKeys(rawReceipt, [
      "artifact_kind",
      "source_sha",
      "profile_id",
      "approval_reference_sha256",
      "workload_plan_sha256",
      "minimum_samples_per_operation",
      "duration_ms",
      "operations",
      "controlled_failures",
      "postgresql_identifier_sha256",
      "redis_namespace_sha256",
    ])
  ) {
    throw new Error("C5 integrated workload receipt has unsupported fields");
  }
  const receipt = rawReceipt as Partial<C5IntegratedWorkloadReceipt>;
  if (
    receipt.artifact_kind !== "gate-c-c5-integrated-workload-receipt" ||
    receipt.source_sha !== expected.sourceSha ||
    !sourceSha.test(expected.sourceSha)
  ) {
    throw new Error("C5 integrated workload receipt is not bound to the exact source SHA");
  }
  if (
    receipt.profile_id !== expected.plan.profile.profileId ||
    !sha256.test(receipt.approval_reference_sha256 ?? "") ||
    receipt.approval_reference_sha256 !== hash(expected.plan.profile.approval.reference) ||
    receipt.workload_plan_sha256 !== hash(stableJson(expected.plan)) ||
    receipt.minimum_samples_per_operation !== expected.plan.minimumSamplesPerOperation
  ) {
    throw new Error("C5 integrated workload receipt has no approved profile");
  }
  if (typeof receipt.duration_ms !== "number" || !Number.isFinite(receipt.duration_ms) || receipt.duration_ms < 0) {
    throw new Error("C5 integrated workload receipt has an invalid duration");
  }
  if (receipt.duration_ms < expected.plan.profile.durationSeconds * 1_000 * C5_WORKLOAD_OPERATIONS.length) {
    throw new Error("C5 integrated workload receipt did not cover the approved duration");
  }
  if (!sha256.test(receipt.postgresql_identifier_sha256 ?? "") || !sha256.test(receipt.redis_namespace_sha256 ?? "")) {
    throw new Error("C5 integrated workload receipt has malformed isolation hashes");
  }
  const operations = record(receipt.operations);
  if (!operations || !exactKeys(operations, C5_WORKLOAD_OPERATIONS)) {
    throw new Error("C5 integrated workload receipt is missing operations");
  }
  for (const operation of C5_WORKLOAD_OPERATIONS) {
    assertWorkloadReceipt(operations[operation], operation, expected.plan, expected.sourceSha);
  }
  if (
    !Array.isArray(receipt.controlled_failures) ||
    receipt.controlled_failures.length !== C5_CONTROLLED_FAILURES.length
  ) {
    throw new Error("C5 integrated workload receipt is missing controlled-failure evidence");
  }
  for (const fault of C5_CONTROLLED_FAILURES) {
    const matches = receipt.controlled_failures.filter((candidate) => candidate.fault === fault);
    if (matches.length !== 1) throw new Error(`C5 integrated workload receipt has invalid ${fault} evidence`);
    assertFaultReceipt(matches[0]!, fault);
  }
  return receipt as C5IntegratedWorkloadReceipt;
}

/**
 * Executes all five C1-C4 workload classes against caller-provided real
 * adapters. This package never creates fake infrastructure or credentials;
 * the API harness must supply its isolated PostgreSQL/Redis-backed adapters.
 */
export async function executeC5IntegratedWorkload(
  input: C5IntegratedWorkloadExecution,
  timing?: C5WorkloadTiming,
): Promise<C5IntegratedWorkloadReceipt> {
  if (!sourceSha.test(input.sourceSha)) throw new Error("C5 integrated workload requires a full source SHA");
  validatePlan(input.plan);
  assertNonEmpty(input.postgresqlIdentifier, "PostgreSQL identifier");
  assertNonEmpty(input.redisNamespace, "Redis namespace");
  const now = timing?.now ?? (() => performance.now());
  const startedAt = now();
  // Operations share the same disposable aggregate. Keep their C1-C4 state
  // transitions ordered; each operation retains its own approved worker
  // concurrency through `executeC5Workload`.
  const operationEntries: [C5WorkloadOperation, C5WorkloadReceipt][] = [];
  for (const operation of C5_WORKLOAD_OPERATIONS) {
    const schedule: C5WorkloadSchedule =
      operation === "public_result_convergence"
        ? {
            kind: "convergence_waves",
            waveCount: input.plan.convergencePolicy.waveCount as 2,
            samplesPerWave: input.plan.convergencePolicy.samplesPerWave as 150,
          }
        : { kind: "cadenced", minimumIntervalMs: 1_000 };
    const resource = input.operationResources
      ? await input.operationResources[operation]()
      : { executor: input.executors[operation] };
    try {
      const receipt = await executeC5Workload(
        {
          operation,
          profile: input.plan.profile,
          sourceSha: input.sourceSha,
          maximumSamples: input.plan.maximumSamplesPerOperation[operation],
          operationTimeoutMs: input.operationTimeoutMs,
          schedule,
        },
        resource.executor,
        timing,
      );
      // Stop before starting the next one-hour operation if the current class did
      // not produce its full exact-SHA certification evidence.
      assertWorkloadReceipt(receipt, operation, input.plan, input.sourceSha);
      operationEntries.push([operation, receipt]);
    } finally {
      await resource.close?.();
    }
  }
  const controlledFailures: C5ControlledFailureReceipt[] = [];
  // Fault drills intentionally do not overlap. An interrupted Redis/API/worker
  // drill must have completed recovery and cleanup before the next drill starts.
  for (const fault of C5_CONTROLLED_FAILURES) {
    const receipt = await input.controlledFailureHooks[fault]();
    assertFaultReceipt(receipt, fault);
    controlledFailures.push(receipt);
  }
  const operations = Object.fromEntries(operationEntries) as Record<C5WorkloadOperation, C5WorkloadReceipt>;
  return validateC5IntegratedWorkloadReceipt(
    {
      artifact_kind: "gate-c-c5-integrated-workload-receipt",
      source_sha: input.sourceSha,
      profile_id: input.plan.profile.profileId,
      approval_reference_sha256: hash(input.plan.profile.approval.reference),
      workload_plan_sha256: hash(stableJson(input.plan)),
      minimum_samples_per_operation: input.plan.minimumSamplesPerOperation,
      duration_ms: now() - startedAt,
      operations,
      controlled_failures: controlledFailures,
      postgresql_identifier_sha256: hash(input.postgresqlIdentifier),
      redis_namespace_sha256: hash(input.redisNamespace),
    },
    { sourceSha: input.sourceSha, plan: input.plan },
  );
}
