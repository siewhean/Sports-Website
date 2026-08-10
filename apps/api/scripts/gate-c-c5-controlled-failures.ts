import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  C5_CONTROLLED_FAILURES,
  C5_FAULT_INJECTORS,
  type C5ControlledFailure,
  type C5ControlledFailureHook,
  type C5ControlledFailureReceipt,
  type C5FaultInjector,
} from "@matchday/observability";
import { gateCC5RetainedArtifactRoot, type GateCC5RetainedArtifacts } from "./gate-c-c5-retained-artifacts.js";

const SOURCE_SHA = /^[a-f0-9]{40}$/u;
const SAFE_IDENTIFIER = /^[a-z][a-z0-9:_-]{7,199}$/u;
const SAFE_ORACLE = /^[a-z][a-z0-9_]{2,199}$/u;
const SAFE_COMMAND = /^(?:[A-Za-z0-9._+-]+|\/[A-Za-z0-9_./+-]+)$/u;
const SHELL_INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "csh",
  "tcsh",
  "powershell",
  "pwsh",
  "env",
]);
const EVAL_INTERPRETERS = new Set(["node", "bun", "deno", "python", "python3", "ruby", "perl", "php"]);
const EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c", "--command"]);
const SECRET_LIKE =
  /(?:\b(?:secret|token|password|cookie|authorization|bearer)\b|(?:postgres(?:ql)?|redis|rediss):\/\/|https?:\/\/[^\s"']+@)/iu;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const FAULT_INJECTORS: Readonly<Record<C5ControlledFailure, readonly C5FaultInjector[]>> = {
  postgres_interruption: ["command", "network_proxy"],
  redis_interruption: ["command", "network_proxy"],
  api_interruption: ["process_signal", "network_proxy", "command"],
  web_interruption: ["process_signal", "network_proxy", "command"],
  worker_interruption: ["process_signal", "network_proxy", "command"],
  latency: ["network_proxy", "bounded_delay"],
  connection_pressure: ["connection_limit"],
  outbox_delay: ["bounded_delay", "command"],
  disk_pressure: ["filesystem_limit"],
  pdf_failure: ["command"],
  backup_restore: ["command"],
  projection_regeneration: ["command"],
};

type FaultPhase = "injection" | "recovery" | "cleanup";

export type GateCC5ExternalCommand = Readonly<{
  command: string;
  args: readonly string[];
}>;

export type GateCC5ControlledFailureDefinition = Readonly<{
  injector: C5FaultInjector;
  recoveryOracle: string;
  injection: GateCC5ExternalCommand;
  recovery: GateCC5ExternalCommand;
  cleanup: GateCC5ExternalCommand;
}>;

export type GateCC5ControlledFailureConfiguration = Readonly<{
  sourceSha: string;
  target: Readonly<{
    environment: "dedicated_c5_drill";
    production: false;
    shared: false;
    postgresqlIdentifier: string;
    redisNamespace: string;
    apiOrigin: string;
    webOrigin: string;
    apiControlId: string;
    webControlId: string;
    workerControlId: string;
    schedulerControlId: string;
  }>;
  faults: Readonly<Record<C5ControlledFailure, GateCC5ControlledFailureDefinition>>;
}>;

export type GateCC5CommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type GateCC5CommandRunner = (
  command: GateCC5ExternalCommand,
  environment: Readonly<Record<string, string>>,
) => Promise<GateCC5CommandResult>;

type Value = Record<string, unknown>;

function record(value: unknown): Value | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Value) : null;
}

function exactKeys(value: Value, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function requiredString(value: Value, key: string, label: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !candidate) throw new Error(`Gate C C5 ${label} ${key} must be a string`);
  return candidate;
}

function parseCommand(value: unknown, label: string): GateCC5ExternalCommand {
  const candidate = record(value);
  if (!candidate || !exactKeys(candidate, ["command", "args"])) {
    throw new Error(`Gate C C5 ${label} command has unsupported fields`);
  }
  const command = requiredString(candidate, "command", label);
  if (!SAFE_COMMAND.test(command) || command.includes("..") || SECRET_LIKE.test(command)) {
    throw new Error(`Gate C C5 ${label} command is unsafe`);
  }
  if (!Array.isArray(candidate.args) || candidate.args.some((arg) => typeof arg !== "string")) {
    throw new Error(`Gate C C5 ${label} command args must be strings`);
  }
  const args = candidate.args as string[];
  if (args.length > 100 || args.some((arg) => arg.length > 2_000 || /[\0\r\n]/u.test(arg) || SECRET_LIKE.test(arg))) {
    throw new Error(`Gate C C5 ${label} command args are unsafe`);
  }
  const executable = path.posix.basename(command).toLowerCase();
  if (
    SHELL_INTERPRETERS.has(executable) ||
    (EVAL_INTERPRETERS.has(executable) && args.some((arg) => EVAL_FLAGS.has(arg)))
  ) {
    throw new Error(`Gate C C5 ${label} command may not use a shell or eval interpreter`);
  }
  return { command, args };
}

function parseDefinition(value: unknown, fault: C5ControlledFailure): GateCC5ControlledFailureDefinition {
  const candidate = record(value);
  if (!candidate || !exactKeys(candidate, ["injector", "recoveryOracle", "injection", "recovery", "cleanup"])) {
    throw new Error(`Gate C C5 ${fault} definition has unsupported fields`);
  }
  const injector = requiredString(candidate, "injector", fault) as C5FaultInjector;
  const recoveryOracle = requiredString(candidate, "recoveryOracle", fault);
  if (!C5_FAULT_INJECTORS.includes(injector) || !FAULT_INJECTORS[fault].includes(injector)) {
    throw new Error(`Gate C C5 ${fault} injector is unsupported for this fault`);
  }
  if (!SAFE_ORACLE.test(recoveryOracle)) throw new Error(`Gate C C5 ${fault} recovery oracle is unsafe`);
  return {
    injector,
    recoveryOracle,
    injection: parseCommand(candidate.injection, `${fault} injection`),
    recovery: parseCommand(candidate.recovery, `${fault} recovery`),
    cleanup: parseCommand(candidate.cleanup, `${fault} cleanup`),
  };
}

/** Parses a complete fail-closed external drill manifest; no fault has a built-in fake fallback. */
export function parseGateCC5ControlledFailureConfiguration(
  value: string | undefined,
  expectedSourceSha: string,
  activeTarget: GateCC5ControlledFailureConfiguration["target"],
): GateCC5ControlledFailureConfiguration {
  if (!SOURCE_SHA.test(expectedSourceSha)) throw new Error("Gate C C5 controlled failures require an exact source SHA");
  if (!value?.trim()) throw new Error("Gate C C5 controlled failures require GATE_C_C5_CONTROLLED_FAILURES_JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Gate C C5 controlled-failure configuration is not valid JSON");
  }
  const candidate = record(parsed);
  const target = record(candidate?.target);
  const faults = record(candidate?.faults);
  if (!candidate || !target || !faults || !exactKeys(candidate, ["sourceSha", "target", "faults"])) {
    throw new Error("Gate C C5 controlled-failure configuration has unsupported fields");
  }
  if (candidate.sourceSha !== expectedSourceSha) {
    throw new Error("Gate C C5 controlled-failure configuration is not bound to the exact source SHA");
  }
  if (
    !exactKeys(target, ["environment", "production", "shared"]) ||
    target.environment !== "dedicated_c5_drill" ||
    target.production !== false ||
    target.shared !== false
  ) {
    throw new Error("Gate C C5 controlled failures require a dedicated non-production non-shared target");
  }
  const postgresqlIdentifier = activeTarget.postgresqlIdentifier;
  const redisNamespace = activeTarget.redisNamespace;
  const runtimeControls = [
    activeTarget.apiOrigin,
    activeTarget.webOrigin,
    activeTarget.apiControlId,
    activeTarget.webControlId,
    activeTarget.workerControlId,
    activeTarget.schedulerControlId,
  ];
  if (runtimeControls.some((control) => typeof control !== "string" || control.trim().length < 3)) {
    throw new Error("Gate C C5 controlled failures require all active runtime control identities");
  }
  if (
    !SAFE_IDENTIFIER.test(postgresqlIdentifier) ||
    !SAFE_IDENTIFIER.test(redisNamespace) ||
    !/(?:c5|phase4).*(?:drill|e2e)/u.test(postgresqlIdentifier) ||
    !/(?:c5|phase4).*(?:drill|e2e)/u.test(redisNamespace) ||
    postgresqlIdentifier === redisNamespace
  ) {
    throw new Error("Gate C C5 controlled failures require distinct disposable PostgreSQL and Redis identities");
  }
  if (!exactKeys(faults, C5_CONTROLLED_FAILURES)) {
    throw new Error("Gate C C5 controlled-failure configuration must define all twelve faults exactly once");
  }
  const definitions = Object.fromEntries(
    C5_CONTROLLED_FAILURES.map((fault) => [fault, parseDefinition(faults[fault], fault)]),
  ) as Record<C5ControlledFailure, GateCC5ControlledFailureDefinition>;
  return {
    sourceSha: expectedSourceSha,
    target: {
      environment: "dedicated_c5_drill",
      production: false,
      shared: false,
      postgresqlIdentifier,
      redisNamespace,
      apiOrigin: activeTarget.apiOrigin,
      webOrigin: activeTarget.webOrigin,
      apiControlId: activeTarget.apiControlId,
      webControlId: activeTarget.webControlId,
      workerControlId: activeTarget.workerControlId,
      schedulerControlId: activeTarget.schedulerControlId,
    },
    faults: definitions,
  };
}

function safeOutput(value: string, label: string, target: GateCC5ControlledFailureConfiguration["target"]): void {
  if (
    Buffer.byteLength(value, "utf8") > MAX_LOG_BYTES ||
    SECRET_LIKE.test(value) ||
    value.includes(target.postgresqlIdentifier) ||
    [
      target.redisNamespace,
      target.apiOrigin,
      target.webOrigin,
      target.apiControlId,
      target.webControlId,
      target.workerControlId,
      target.schedulerControlId,
    ].some((raw) => value.includes(raw))
  ) {
    throw new Error(`Gate C C5 ${label} output cannot be retained safely`);
  }
}

export const runGateCC5ExternalCommand: GateCC5CommandRunner = async (definition, environment) =>
  await new Promise<GateCC5CommandResult>((resolve, reject) => {
    const child = spawn(definition.command, [...definition.args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...environment },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let spawnError: Error | null = null;
    let timedOut = false;
    let escalation: NodeJS.Timeout | null = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 2_000);
      escalation.unref?.();
    }, COMMAND_TIMEOUT_MS);
    timeout.unref?.();
    const collect = (destination: Buffer[], chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_LOG_BYTES) child.kill("SIGKILL");
      else destination.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      if (bytes > MAX_LOG_BYTES) return reject(new Error("Gate C C5 controlled-failure command output exceeded 5 MiB"));
      if (timedOut) return reject(new Error("Gate C C5 controlled-failure command timed out and was terminated"));
      if (spawnError) return reject(spawnError);
      if (signal) return reject(new Error(`Gate C C5 controlled-failure command exited by ${signal}`));
      resolve({
        exitCode: exitCode ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseObservation(
  stdout: string,
  input: Readonly<{
    sourceSha: string;
    fault: C5ControlledFailure;
    phase: FaultPhase;
    recoveryOracle: string;
    postgresqlIdentifier: string;
    redisNamespace: string;
    apiOrigin: string;
    webOrigin: string;
    apiControlId: string;
    webControlId: string;
    workerControlId: string;
    schedulerControlId: string;
  }>,
): Value {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Gate C C5 ${input.fault} ${input.phase} did not emit a JSON observation`);
  }
  const observation = record(parsed);
  if (
    !observation ||
    !exactKeys(observation, [
      "artifact_kind",
      "source_sha",
      "fault",
      "phase",
      "observed",
      "recovery_oracle",
      "postgresql_identifier_sha256",
      "redis_namespace_sha256",
      "api_origin_sha256",
      "web_origin_sha256",
      "api_control_sha256",
      "web_control_sha256",
      "worker_control_sha256",
      "scheduler_control_sha256",
    ]) ||
    observation.artifact_kind !== "gate-c-c5-fault-observation" ||
    observation.source_sha !== input.sourceSha ||
    observation.fault !== input.fault ||
    observation.phase !== input.phase ||
    observation.observed !== true ||
    observation.recovery_oracle !== input.recoveryOracle ||
    observation.postgresql_identifier_sha256 !== hash(Buffer.from(input.postgresqlIdentifier, "utf8")) ||
    observation.redis_namespace_sha256 !== hash(Buffer.from(input.redisNamespace, "utf8")) ||
    observation.api_origin_sha256 !== hash(Buffer.from(input.apiOrigin, "utf8")) ||
    observation.web_origin_sha256 !== hash(Buffer.from(input.webOrigin, "utf8")) ||
    observation.api_control_sha256 !== hash(Buffer.from(input.apiControlId, "utf8")) ||
    observation.web_control_sha256 !== hash(Buffer.from(input.webControlId, "utf8")) ||
    observation.worker_control_sha256 !== hash(Buffer.from(input.workerControlId, "utf8")) ||
    observation.scheduler_control_sha256 !== hash(Buffer.from(input.schedulerControlId, "utf8"))
  ) {
    throw new Error(`Gate C C5 ${input.fault} ${input.phase} observation is not bound to the active isolation`);
  }
  return observation;
}

async function retainPhaseLog(
  retainedRoot: string,
  evidencePrefix: string,
  sourceSha: string,
  fault: C5ControlledFailure,
  phase: FaultPhase,
  definition: GateCC5ControlledFailureDefinition,
  target: GateCC5ControlledFailureConfiguration["target"],
  result: GateCC5CommandResult,
): Promise<Readonly<{ path: string; sha256: string }>> {
  safeOutput(result.stdout, `${fault} ${phase} stdout`, target);
  safeOutput(result.stderr, `${fault} ${phase} stderr`, target);
  const observation = parseObservation(result.stdout, {
    sourceSha,
    fault,
    phase,
    recoveryOracle: definition.recoveryOracle,
    postgresqlIdentifier: target.postgresqlIdentifier,
    redisNamespace: target.redisNamespace,
    apiOrigin: target.apiOrigin,
    webOrigin: target.webOrigin,
    apiControlId: target.apiControlId,
    webControlId: target.webControlId,
    workerControlId: target.workerControlId,
    schedulerControlId: target.schedulerControlId,
  });
  const relativePath = `${evidencePrefix}${fault}/${phase}.json`;
  const bytes = Buffer.from(
    `${JSON.stringify({
      artifact_kind: "gate-c-c5-controlled-failure-log",
      source_sha: sourceSha,
      fault,
      phase,
      injector: definition.injector,
      recovery_oracle: definition.recoveryOracle,
      command_definition_sha256: hash(
        Buffer.from(
          JSON.stringify({
            command: definition[phase].command,
            args: definition[phase].args,
          }),
          "utf8",
        ),
      ),
      exit_code: result.exitCode,
      observation,
      stderr: result.stderr,
    })}\n`,
    "utf8",
  );
  if (bytes.byteLength > MAX_LOG_BYTES) throw new Error(`Gate C C5 ${fault} ${phase} retained log exceeds 5 MiB`);
  const absolutePath = path.join(retainedRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
  await writeFile(absolutePath, bytes, { mode: 0o600, flag: "wx" });
  return { path: relativePath, sha256: hash(bytes) };
}

/**
 * Builds serial real-drill hooks. Every phase is an operator-supplied command;
 * recovery and cleanup exit zero are the explicit external oracles. Cleanup is
 * attempted even when injection or recovery fails, and no synthetic receipt is emitted.
 */
export function createGateCC5ControlledFailureHooks(
  configuration: GateCC5ControlledFailureConfiguration,
  commandRunner: GateCC5CommandRunner = runGateCC5ExternalCommand,
  evidencePrefix = "",
): Readonly<{
  hooks: Readonly<Record<C5ControlledFailure, C5ControlledFailureHook>>;
  artifacts: GateCC5RetainedArtifacts;
}> {
  if (evidencePrefix && !/^run-[12]\/$/u.test(evidencePrefix)) {
    throw new Error("Gate C C5 controlled-failure evidence prefix must identify run 1 or run 2");
  }
  const retainedRoot = gateCC5RetainedArtifactRoot(configuration.sourceSha);
  const artifacts = Object.fromEntries(
    C5_CONTROLLED_FAILURES.map((fault) => [
      fault,
      {
        injection: `${evidencePrefix}${fault}/injection.json`,
        recovery: `${evidencePrefix}${fault}/recovery.json`,
        cleanup: `${evidencePrefix}${fault}/cleanup.json`,
      },
    ]),
  ) as Record<C5ControlledFailure, { injection: string; recovery: string; cleanup: string }>;
  let activeFault: C5ControlledFailure | null = null;
  const completed = new Set<C5ControlledFailure>();
  const hooks = Object.fromEntries(
    C5_CONTROLLED_FAILURES.map((fault, index) => [
      fault,
      async (): Promise<C5ControlledFailureReceipt> => {
        if (activeFault) throw new Error(`Gate C C5 controlled failures may not overlap: ${activeFault}`);
        if (completed.has(fault)) throw new Error(`Gate C C5 controlled failure ${fault} may run only once`);
        const previous = C5_CONTROLLED_FAILURES[index - 1];
        if (previous && !completed.has(previous)) {
          throw new Error(`Gate C C5 controlled failures must run serially in canonical order before ${fault}`);
        }
        activeFault = fault;
        const definition = configuration.faults[fault];
        const environment = {
          GATE_C_C5_SOURCE_SHA: configuration.sourceSha,
          GATE_C_C5_FAULT: fault,
          GATE_C_C5_POSTGRESQL_IDENTIFIER: configuration.target.postgresqlIdentifier,
          GATE_C_C5_REDIS_NAMESPACE: configuration.target.redisNamespace,
          GATE_C_C5_API_ORIGIN: configuration.target.apiOrigin,
          GATE_C_C5_WEB_ORIGIN: configuration.target.webOrigin,
          GATE_C_C5_API_CONTROL_ID: configuration.target.apiControlId,
          GATE_C_C5_WEB_CONTROL_ID: configuration.target.webControlId,
          GATE_C_C5_WORKER_CONTROL_ID: configuration.target.workerControlId,
          GATE_C_C5_SCHEDULER_CONTROL_ID: configuration.target.schedulerControlId,
        };
        let injection: Readonly<{ path: string; sha256: string }> | null = null;
        let recovery: Readonly<{ path: string; sha256: string }> | null = null;
        let cleanup: Readonly<{ path: string; sha256: string }> | null = null;
        let primaryError: unknown = null;
        try {
          const result = await commandRunner(definition.injection, environment);
          injection = await retainPhaseLog(
            retainedRoot,
            evidencePrefix,
            configuration.sourceSha,
            fault,
            "injection",
            definition,
            configuration.target,
            result,
          );
          if (result.exitCode !== 0)
            throw new Error(`Gate C C5 ${fault} injection command failed with ${String(result.exitCode)}`);
          const recovered = await commandRunner(definition.recovery, environment);
          recovery = await retainPhaseLog(
            retainedRoot,
            evidencePrefix,
            configuration.sourceSha,
            fault,
            "recovery",
            definition,
            configuration.target,
            recovered,
          );
          if (recovered.exitCode !== 0)
            throw new Error(`Gate C C5 ${fault} recovery oracle failed with ${String(recovered.exitCode)}`);
        } catch (error) {
          primaryError = error;
        } finally {
          try {
            const cleaned = await commandRunner(definition.cleanup, environment);
            cleanup = await retainPhaseLog(
              retainedRoot,
              evidencePrefix,
              configuration.sourceSha,
              fault,
              "cleanup",
              definition,
              configuration.target,
              cleaned,
            );
            if (cleaned.exitCode !== 0)
              throw new Error(`Gate C C5 ${fault} cleanup oracle failed with ${String(cleaned.exitCode)}`);
          } catch (error) {
            primaryError = primaryError
              ? new AggregateError([primaryError, error], `${fault} drill and cleanup failed`)
              : error;
          }
          activeFault = null;
        }
        if (primaryError) throw primaryError;
        if (!injection || !recovery || !cleanup)
          throw new Error(`Gate C C5 ${fault} did not retain all three phase logs`);
        completed.add(fault);
        return {
          fault,
          injector: definition.injector,
          injection_evidence_sha256: injection.sha256,
          recovery_evidence_sha256: recovery.sha256,
          cleanup_evidence_sha256: cleanup.sha256,
          recovery_observed: true,
          cleanup_observed: true,
          recovery_oracle: definition.recoveryOracle,
        };
      },
    ]),
  ) as Record<C5ControlledFailure, C5ControlledFailureHook>;
  return { hooks, artifacts };
}
