import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  C5_CONTROLLED_FAILURES,
  type C5ControlledFailure,
  type C5ControlledFailureHook,
  type C5ControlledFailureReceipt,
} from "@matchday/observability";

const executeFile = promisify(execFile);
const commandPattern = /^[A-Za-z0-9_./:-]+(?:\s+[A-Za-z0-9_./:=,-]+)*$/u;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

type DrillPhase = "PRECONDITION" | "INJECT" | "DEGRADATION" | "RECOVER" | "INVARIANT" | "CLEANUP";

function commandEnvironmentKey(fault: C5ControlledFailure, phase: DrillPhase): string {
  return `GATE_C_C5_${fault.toUpperCase()}_${phase}_COMMAND`;
}

function unavailable(fault: C5ControlledFailure, phase: string): string {
  return `${fault}:${phase}:NOT_REACHED\n`;
}

function failed(fault: C5ControlledFailure, phase: string): string {
  // Do not retain a provider error message: those often include command-line
  // context or credentials. The command itself is the secure-system record.
  return `${fault}:${phase}:FAILED\n`;
}

async function invoke(command: string, fault: C5ControlledFailure, phase: string): Promise<string> {
  if (!commandPattern.test(command)) {
    throw new Error(`Gate C C5 ${fault} ${phase} command contains unsafe shell syntax`);
  }
  const [file, ...arguments_] = command.split(/\s+/u);
  const result = await executeFile(file!, arguments_, { encoding: "utf8", timeout: 60_000, windowsHide: true });
  // Commands must emit only a non-secret, bounded assertion line. This is
  // retained as operational proof; URLs, credentials and verbose process logs
  // belong in the provider's secure evidence store, not this repository.
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (
    !output ||
    output.length > 4_096 ||
    /(?:secret|token|password|authorization|postgres(?:ql)?:\/\/|redis(?:s)?:\/\/)/iu.test(output)
  ) {
    throw new Error(`Gate C C5 ${fault} ${phase} command did not emit a safe bounded assertion`);
  }
  return `${fault}:${phase}:${output.replaceAll(/\s+/gu, " ")}\n`;
}

/**
 * Builds the twelve genuine fault hooks used by the checked-in staging adapter.
 * Every phase is a controlled command, no hook fabricates observations, and a
 * missing command fails before a receipt can be returned.
 */
export function createGateCC5ControlledStagingFaultHooks(
  input: Readonly<{
    retainedRoot: string;
    environment?: NodeJS.ProcessEnv;
  }>,
): Readonly<Record<C5ControlledFailure, C5ControlledFailureHook>> {
  const environment = input.environment ?? process.env;
  return Object.fromEntries(
    C5_CONTROLLED_FAILURES.map((fault) => [
      fault,
      async (): Promise<C5ControlledFailureReceipt> => {
        const commands: Record<
          "precondition" | "injection" | "degradation" | "recovery" | "invariant" | "cleanup",
          string | undefined
        > = {
          precondition: environment[commandEnvironmentKey(fault, "PRECONDITION")],
          injection: environment[commandEnvironmentKey(fault, "INJECT")],
          degradation: environment[commandEnvironmentKey(fault, "DEGRADATION")],
          recovery: environment[commandEnvironmentKey(fault, "RECOVER")],
          invariant: environment[commandEnvironmentKey(fault, "INVARIANT")],
          cleanup: environment[commandEnvironmentKey(fault, "CLEANUP")],
        };
        if (Object.values(commands).some((command) => !command)) {
          throw new Error(
            `Gate C C5 ${fault} requires PRECONDITION, INJECT, DEGRADATION, RECOVER, INVARIANT and CLEANUP controlled-staging commands`,
          );
        }
        const directory = path.join(input.retainedRoot, fault);
        await mkdir(directory, { recursive: true });
        let injection = "";
        let recovery = "";
        let cleanup = "";
        let phaseFailure: unknown;
        try {
          injection += await invoke(commands.precondition!, fault, "precondition");
          injection += await invoke(commands.injection!, fault, "injection");
          injection += await invoke(commands.degradation!, fault, "degradation");
          recovery += await invoke(commands.recovery!, fault, "recovery");
          recovery += await invoke(commands.invariant!, fault, "invariant");
        } catch (error) {
          phaseFailure = error;
          injection ||= failed(fault, "fault_phase");
          recovery ||= unavailable(fault, "recovery");
        } finally {
          try {
            cleanup = await invoke(commands.cleanup!, fault, "cleanup");
          } catch {
            cleanup = failed(fault, "cleanup");
          }
          injection ||= unavailable(fault, "injection");
          recovery ||= unavailable(fault, "recovery");
          await Promise.all([
            writeFile(path.join(directory, "injection.log"), injection, { encoding: "utf8", flag: "wx", mode: 0o600 }),
            writeFile(path.join(directory, "recovery.log"), recovery, { encoding: "utf8", flag: "wx", mode: 0o600 }),
            writeFile(path.join(directory, "cleanup.log"), cleanup, { encoding: "utf8", flag: "wx", mode: 0o600 }),
          ]);
        }
        if (phaseFailure) throw phaseFailure;
        if (cleanup.includes(":FAILED\n")) {
          throw new Error(`Gate C C5 ${fault} cleanup command failed after the controlled drill`);
        }
        return {
          fault,
          injector: "command",
          injection_evidence_sha256: digest(injection),
          recovery_evidence_sha256: digest(recovery),
          cleanup_evidence_sha256: digest(cleanup),
          recovery_observed: true,
          cleanup_observed: true,
          recovery_oracle: "controlled_staging_recovered",
        };
      },
    ]),
  ) as Readonly<Record<C5ControlledFailure, C5ControlledFailureHook>>;
}
