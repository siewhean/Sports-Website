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

function commandEnvironmentKey(fault: C5ControlledFailure, phase: "INJECT" | "RECOVER" | "CLEANUP"): string {
  return `GATE_C_C5_${fault.toUpperCase()}_${phase}_COMMAND`;
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
        const commands = {
          injection: environment[commandEnvironmentKey(fault, "INJECT")],
          recovery: environment[commandEnvironmentKey(fault, "RECOVER")],
          cleanup: environment[commandEnvironmentKey(fault, "CLEANUP")],
        };
        if (!commands.injection || !commands.recovery || !commands.cleanup) {
          throw new Error(`Gate C C5 ${fault} requires INJECT, RECOVER and CLEANUP controlled-staging commands`);
        }
        const directory = path.join(input.retainedRoot, fault);
        await mkdir(directory, { recursive: true });
        const injection = await invoke(commands.injection, fault, "injection");
        const recovery = await invoke(commands.recovery, fault, "recovery");
        const cleanup = await invoke(commands.cleanup, fault, "cleanup");
        await Promise.all([
          writeFile(path.join(directory, "injection.log"), injection, { encoding: "utf8", flag: "wx", mode: 0o600 }),
          writeFile(path.join(directory, "recovery.log"), recovery, { encoding: "utf8", flag: "wx", mode: 0o600 }),
          writeFile(path.join(directory, "cleanup.log"), cleanup, { encoding: "utf8", flag: "wx", mode: 0o600 }),
        ]);
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
