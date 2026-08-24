#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const commandPattern = /^[A-Za-z0-9_./:-]+(?:\s+[A-Za-z0-9_./:=,-]+)*$/u;

export const GATE_C_C5_STAGING_FAULTS = [
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
];

export const GATE_C_C5_STAGING_PHASES = [
  "PRECONDITION",
  "INJECT",
  "DEGRADATION",
  "RECOVER",
  "INVARIANT",
  "CLEANUP",
];

function exactObject(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actualKeys.length !== expected.length || actualKeys.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  }
  return value;
}

export function parseGateCC5FaultCommandManifest(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("Gate C C5 staging requires GATE_C_C5_FAULT_COMMANDS_JSON");
  }
  if (Buffer.byteLength(raw, "utf8") > 48 * 1024) {
    throw new Error("Gate C C5 fault command manifest exceeds the protected-variable size limit");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Gate C C5 fault command manifest must be valid JSON");
  }
  const manifest = exactObject(parsed, GATE_C_C5_STAGING_FAULTS, "Gate C C5 fault command manifest");
  const normalized = {};
  for (const fault of GATE_C_C5_STAGING_FAULTS) {
    const phases = exactObject(manifest[fault], GATE_C_C5_STAGING_PHASES, `Gate C C5 ${fault} commands`);
    normalized[fault] = {};
    for (const phase of GATE_C_C5_STAGING_PHASES) {
      const command = phases[phase];
      if (
        typeof command !== "string" ||
        command !== command.trim() ||
        command.length < 2 ||
        command.length > 2048 ||
        !commandPattern.test(command)
      ) {
        throw new Error(`Gate C C5 ${fault} ${phase} command is missing or unsafe`);
      }
      const executable = command.split(/\s+/u)[0];
      if (!path.isAbsolute(executable)) {
        throw new Error(`Gate C C5 ${fault} ${phase} command must use an absolute operator executable`);
      }
      normalized[fault][phase] = command;
    }
  }
  return normalized;
}

export function expandGateCC5FaultCommandEnvironment(manifest) {
  const environment = {};
  for (const fault of GATE_C_C5_STAGING_FAULTS) {
    for (const phase of GATE_C_C5_STAGING_PHASES) {
      environment[`GATE_C_C5_${fault.toUpperCase()}_${phase}_COMMAND`] = manifest[fault][phase];
    }
  }
  return environment;
}

function validateOperatorExecutables(manifest) {
  const checked = new Set();
  for (const fault of GATE_C_C5_STAGING_FAULTS) {
    for (const phase of GATE_C_C5_STAGING_PHASES) {
      const executable = manifest[fault][phase].split(/\s+/u)[0];
      if (checked.has(executable)) continue;
      checked.add(executable);
      let real;
      try {
        real = realpathSync(executable);
      } catch {
        throw new Error(`Gate C C5 operator executable does not exist: ${executable}`);
      }
      if (real === root || real.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Gate C C5 operator executable must be outside this repository: ${executable}`);
      }
      if (!statSync(real).isFile()) {
        throw new Error(`Gate C C5 operator executable must be a regular file: ${executable}`);
      }
    }
  }
}

export function runGateCC5FromManifest(environment = process.env) {
  const manifest = parseGateCC5FaultCommandManifest(environment.GATE_C_C5_FAULT_COMMANDS_JSON);
  validateOperatorExecutables(manifest);
  const childEnvironment = {
    ...environment,
    ...expandGateCC5FaultCommandEnvironment(manifest),
  };
  delete childEnvironment.GATE_C_C5_FAULT_COMMANDS_JSON;

  const result = spawnSync("pnpm", ["evidence:gate-c-c5:run"], {
    cwd: root,
    env: childEnvironment,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Gate C C5 staging runner terminated by signal ${result.signal}`);
  return result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runGateCC5FromManifest();
  } catch (error) {
    process.stderr.write(`Gate C C5 staging orchestration FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
