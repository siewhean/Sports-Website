import { afterEach, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { C5_CONTROLLED_FAILURES, type C5ControlledFailure } from "@matchday/observability";
import {
  createGateCC5ControlledFailureHooks,
  parseGateCC5ControlledFailureConfiguration,
  type GateCC5CommandRunner,
} from "../../scripts/gate-c-c5-controlled-failures.js";
import {
  gateCC5RetainedArtifactRoot,
  verifyGateCC5RetainedArtifacts,
} from "../../scripts/gate-c-c5-retained-artifacts.js";

const sourceSha = "d".repeat(40);
const retainedRoot = gateCC5RetainedArtifactRoot(sourceSha);
const activeTarget = {
  environment: "dedicated_c5_drill" as const,
  production: false as const,
  shared: false as const,
  postgresqlIdentifier: "matchday_c5_drill_database_001",
  redisNamespace: "matchday:c5:drill:e2e:001",
  apiOrigin: "http://127.0.0.1:4101",
  webOrigin: "http://127.0.0.1:3103",
  apiControlId: "fastify:100:4101",
  webControlId: "process:101:3103",
  workerControlId: "phase4-real-e2e-worker-001",
  schedulerControlId: "matchday-phase4-real-e2e-scheduler-001",
};
const injectors: Record<C5ControlledFailure, string> = {
  postgres_interruption: "command",
  redis_interruption: "command",
  api_interruption: "process_signal",
  web_interruption: "process_signal",
  worker_interruption: "process_signal",
  latency: "network_proxy",
  connection_pressure: "connection_limit",
  outbox_delay: "bounded_delay",
  disk_pressure: "filesystem_limit",
  pdf_failure: "command",
  backup_restore: "command",
  projection_regeneration: "command",
};
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function observation(environment: Readonly<Record<string, string>>, phase: string): string {
  const canonicalPhase = phase === "inject" ? "injection" : phase === "recover" ? "recovery" : phase;
  return JSON.stringify({
    artifact_kind: "gate-c-c5-fault-observation",
    source_sha: environment.GATE_C_C5_SOURCE_SHA,
    fault: environment.GATE_C_C5_FAULT,
    phase: canonicalPhase,
    observed: true,
    recovery_oracle: `recovered_${environment.GATE_C_C5_FAULT}`,
    postgresql_identifier_sha256: sha256(environment.GATE_C_C5_POSTGRESQL_IDENTIFIER!),
    redis_namespace_sha256: sha256(environment.GATE_C_C5_REDIS_NAMESPACE!),
    api_origin_sha256: sha256(environment.GATE_C_C5_API_ORIGIN!),
    web_origin_sha256: sha256(environment.GATE_C_C5_WEB_ORIGIN!),
    api_control_sha256: sha256(environment.GATE_C_C5_API_CONTROL_ID!),
    web_control_sha256: sha256(environment.GATE_C_C5_WEB_CONTROL_ID!),
    worker_control_sha256: sha256(environment.GATE_C_C5_WORKER_CONTROL_ID!),
    scheduler_control_sha256: sha256(environment.GATE_C_C5_SCHEDULER_CONTROL_ID!),
  });
}

function configuration(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sourceSha,
    target: {
      environment: "dedicated_c5_drill",
      production: false,
      shared: false,
    },
    faults: Object.fromEntries(
      C5_CONTROLLED_FAILURES.map((fault) => [
        fault,
        {
          injector: injectors[fault],
          recoveryOracle: `recovered_${fault}`,
          injection: { command: "drill-command", args: [fault, "inject"] },
          recovery: { command: "drill-command", args: [fault, "recover"] },
          cleanup: { command: "drill-command", args: [fault, "cleanup"] },
        },
      ]),
    ),
    ...overrides,
  });
}

afterEach(async () => {
  await rm(retainedRoot, { recursive: true, force: true });
});

describe("Gate C C5 controlled failures", () => {
  it("runs all twelve external drills serially and retains rehashable injection, recovery and cleanup logs", async () => {
    const parsed = parseGateCC5ControlledFailureConfiguration(configuration(), sourceSha, activeTarget);
    const calls: string[] = [];
    let concurrent = 0;
    let maximumConcurrent = 0;
    const runner: GateCC5CommandRunner = async (command, environment) => {
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      calls.push(`${environment.GATE_C_C5_FAULT}:${command.args[1]}`);
      await Promise.resolve();
      concurrent -= 1;
      return { exitCode: 0, stdout: observation(environment, command.args[1]!), stderr: "" };
    };
    const controlled = createGateCC5ControlledFailureHooks(parsed, runner, "run-1/");
    const receipts = [];
    for (const fault of C5_CONTROLLED_FAILURES) receipts.push(await controlled.hooks[fault]());
    expect(maximumConcurrent).toBe(1);
    expect(calls).toHaveLength(36);
    expect(calls.slice(0, 3)).toEqual([
      "postgres_interruption:inject",
      "postgres_interruption:recover",
      "postgres_interruption:cleanup",
    ]);
    const retainedInjection = await readFile(`${retainedRoot}/run-1/postgres_interruption/injection.json`, "utf8");
    expect(retainedInjection).not.toContain("drill-command");
    expect(retainedInjection).not.toContain("matchday_c5_drill_database_001");
    expect(retainedInjection).not.toContain("matchday:c5:drill:e2e:001");
    expect(retainedInjection).not.toContain(activeTarget.apiOrigin);
    expect(retainedInjection).not.toContain(activeTarget.workerControlId);
    await expect(
      verifyGateCC5RetainedArtifacts({
        retainedRoot,
        sourceSha,
        receipt: { source_sha: sourceSha, controlled_failures: receipts },
        artifacts: controlled.artifacts,
      }),
    ).resolves.toHaveLength(12);
  });

  it("always attempts cleanup and emits no passing receipt after a failed recovery oracle", async () => {
    const parsed = parseGateCC5ControlledFailureConfiguration(configuration(), sourceSha, activeTarget);
    const calls: string[] = [];
    const runner: GateCC5CommandRunner = async (command, environment) => {
      calls.push(command.args[1]!);
      return {
        exitCode: command.args[1] === "recover" ? 7 : 0,
        stdout: observation(environment, command.args[1]!),
        stderr: "",
      };
    };
    const controlled = createGateCC5ControlledFailureHooks(parsed, runner);
    await expect(controlled.hooks.postgres_interruption()).rejects.toThrow("recovery oracle failed with 7");
    expect(calls).toEqual(["inject", "recover", "cleanup"]);
    await expect(controlled.hooks.redis_interruption()).rejects.toThrow("before redis_interruption");
  });

  it("rejects production, partial and unbound manifests rather than inventing fault evidence", () => {
    const production = JSON.parse(configuration()) as Record<string, unknown>;
    production.target = { ...(production.target as object), production: true };
    expect(() =>
      parseGateCC5ControlledFailureConfiguration(JSON.stringify(production), sourceSha, activeTarget),
    ).toThrow("dedicated non-production non-shared");

    const partial = JSON.parse(configuration()) as { faults: Record<C5ControlledFailure, unknown> };
    delete partial.faults.projection_regeneration;
    expect(() => parseGateCC5ControlledFailureConfiguration(JSON.stringify(partial), sourceSha, activeTarget)).toThrow(
      "all twelve faults",
    );
    expect(() => parseGateCC5ControlledFailureConfiguration(configuration(), "e".repeat(40), activeTarget)).toThrow(
      "not bound to the exact source SHA",
    );
  });

  it("rejects secret-like command arguments before invoking a provider-specific drill", () => {
    const unsafe = JSON.parse(configuration()) as { faults: Record<string, { injection: { args: string[] } }> };
    unsafe.faults.postgres_interruption!.injection.args = ["--password", "unsafe"];
    expect(() => parseGateCC5ControlledFailureConfiguration(JSON.stringify(unsafe), sourceSha, activeTarget)).toThrow(
      "command args are unsafe",
    );
  });

  it("rejects secret-like command output before retaining it and still runs cleanup", async () => {
    const parsed = parseGateCC5ControlledFailureConfiguration(configuration(), sourceSha, activeTarget);
    const calls: string[] = [];
    const runner: GateCC5CommandRunner = async (command, environment) => {
      calls.push(command.args[1]!);
      return {
        exitCode: 0,
        stdout:
          command.args[1] === "inject" ? "token=must-not-be-retained" : observation(environment, command.args[1]!),
        stderr: "",
      };
    };
    const controlled = createGateCC5ControlledFailureHooks(parsed, runner);
    await expect(controlled.hooks.postgres_interruption()).rejects.toThrow("cannot be retained safely");
    expect(calls).toEqual(["inject", "cleanup"]);
  });

  it("rejects a raw callback-scoped infrastructure identity in provider stderr", async () => {
    const parsed = parseGateCC5ControlledFailureConfiguration(configuration(), sourceSha, activeTarget);
    const runner: GateCC5CommandRunner = async (command, environment) => ({
      exitCode: 0,
      stdout: observation(environment, command.args[1]!),
      stderr: command.args[1] === "inject" ? activeTarget.redisNamespace : "",
    });
    const controlled = createGateCC5ControlledFailureHooks(parsed, runner);
    await expect(controlled.hooks.postgres_interruption()).rejects.toThrow("cannot be retained safely");
  });

  it.each([
    ["bash", ["drill.sh"]],
    ["/bin/zsh", ["drill.sh"]],
    ["node", ["--eval", "process.exit(0)"]],
    ["python3", ["-c", "print(1)"]],
  ])("rejects shell and eval interpreter command %s", (command, args) => {
    const unsafe = JSON.parse(configuration()) as {
      faults: Record<string, { injection: { command: string; args: string[] } }>;
    };
    unsafe.faults.postgres_interruption!.injection = { command, args };
    expect(() => parseGateCC5ControlledFailureConfiguration(JSON.stringify(unsafe), sourceSha, activeTarget)).toThrow(
      "shell or eval interpreter",
    );
  });

  it("rejects a no-op or wrong injector instead of certifying exit zero as an observed fault", async () => {
    const wrongInjector = JSON.parse(configuration()) as { faults: Record<string, { injector: string }> };
    wrongInjector.faults.connection_pressure!.injector = "command";
    expect(() =>
      parseGateCC5ControlledFailureConfiguration(JSON.stringify(wrongInjector), sourceSha, activeTarget),
    ).toThrow("unsupported for this fault");

    const parsed = parseGateCC5ControlledFailureConfiguration(configuration(), sourceSha, activeTarget);
    const controlled = createGateCC5ControlledFailureHooks(parsed, async (command, environment) => ({
      exitCode: 0,
      stdout: command.args[1] === "cleanup" ? observation(environment, "cleanup") : "",
      stderr: "",
    }));
    await expect(controlled.hooks.postgres_interruption()).rejects.toThrow("did not emit a JSON observation");
  });

  it("derives disposable identities only from the active Phase 4 callback context", () => {
    const parsed = parseGateCC5ControlledFailureConfiguration(configuration(), sourceSha, activeTarget);
    expect(parsed.target).toMatchObject(activeTarget);
    const operatorIdentity = JSON.parse(configuration()) as { target: Record<string, unknown> };
    operatorIdentity.target.postgresqlIdentifier = "matchday_c5_drill_spoofed";
    expect(() =>
      parseGateCC5ControlledFailureConfiguration(JSON.stringify(operatorIdentity), sourceSha, activeTarget),
    ).toThrow("dedicated non-production non-shared");
  });
});
