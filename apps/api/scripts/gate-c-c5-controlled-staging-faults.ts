import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
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
const sourceShaPattern = /^[a-f0-9]{40}$/u;
const protocol = "gate-c-c5-fault-attestation-v1";

export const GATE_C_C5_FAULT_PHASES = [
  "PRECONDITION",
  "INJECT",
  "DEGRADATION",
  "RECOVER",
  "INVARIANT",
  "CLEANUP",
] as const;
type DrillPhase = (typeof GATE_C_C5_FAULT_PHASES)[number];
type ArtifactLane = "injection" | "recovery" | "cleanup";
const lanePhases: Readonly<Record<ArtifactLane, readonly DrillPhase[]>> = {
  injection: ["PRECONDITION", "INJECT", "DEGRADATION"],
  recovery: ["RECOVER", "INVARIANT"],
  cleanup: ["CLEANUP"],
};
const faultComponents: Readonly<Record<C5ControlledFailure, string>> = {
  postgres_interruption: "postgresql",
  redis_interruption: "redis",
  api_interruption: "api",
  web_interruption: "web",
  worker_interruption: "worker",
  latency: "control_plane",
  connection_pressure: "postgresql",
  outbox_delay: "worker",
  disk_pressure: "postgresql",
  pdf_failure: "worker",
  backup_restore: "postgresql",
  projection_regeneration: "worker",
};
type AttestedPhase = Readonly<{
  protocol: typeof protocol;
  source_sha: string;
  run_id: string;
  deployment_id: string;
  build_id: string;
  component: string;
  fault: C5ControlledFailure;
  phase: DrillPhase;
  nonce: string;
  observation: string;
  attestation: string;
}>;
type SanitizedPhase = Readonly<{
  protocol: typeof protocol;
  source_sha: string;
  run_id: string;
  deployment_id: string;
  build_id: string;
  component: string;
  fault: C5ControlledFailure;
  phase: DrillPhase;
  nonce_sha256: string;
  observation_sha256: string;
  attestation_sha256: string;
}>;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function commandEnvironmentKey(fault: C5ControlledFailure, phase: DrillPhase): string {
  return `GATE_C_C5_${fault.toUpperCase()}_${phase}_COMMAND`;
}
function sign(secret: string, value: Omit<AttestedPhase, "attestation">): string {
  return createHmac("sha256", secret)
    .update(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
      "utf8",
    )
    .digest("hex");
}
function safeEqualHex(left: string, right: string): boolean {
  return (
    /^[a-f0-9]{64}$/u.test(left) &&
    /^[a-f0-9]{64}$/u.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

function parseAttestation(
  value: string,
  expected: Omit<AttestedPhase, "observation" | "attestation">,
  secret: string,
): SanitizedPhase {
  let candidate: unknown;
  try {
    candidate = JSON.parse(value);
  } catch {
    throw new Error(
      `Gate C C5 ${expected.fault} ${expected.phase} command must return one signed control-plane JSON attestation`,
    );
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    throw new Error(`Gate C C5 ${expected.fault} ${expected.phase} command did not return an attestation object`);
  const record = candidate as Record<string, unknown>;
  const keys = [
    "protocol",
    "source_sha",
    "run_id",
    "deployment_id",
    "build_id",
    "component",
    "fault",
    "phase",
    "nonce",
    "observation",
    "attestation",
  ];
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !(key in record)) ||
    Object.entries(expected).some(([key, expectedValue]) => record[key] !== expectedValue) ||
    typeof record.nonce !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(record.nonce) ||
    typeof record.observation !== "string" ||
    !/^[a-z][a-z0-9_.:-]{2,255}$/u.test(record.observation) ||
    typeof record.attestation !== "string"
  )
    throw new Error(
      `Gate C C5 ${expected.fault} ${expected.phase} control-plane attestation is malformed or mismatched`,
    );
  const unsigned = { ...expected, observation: record.observation } as Omit<AttestedPhase, "attestation">;
  if (!safeEqualHex(record.attestation, sign(secret, unsigned)))
    throw new Error(`Gate C C5 ${expected.fault} ${expected.phase} control-plane attestation signature is invalid`);
  return {
    protocol: expected.protocol,
    source_sha: expected.source_sha,
    run_id: expected.run_id,
    deployment_id: expected.deployment_id,
    build_id: expected.build_id,
    component: expected.component,
    fault: expected.fault,
    phase: expected.phase,
    nonce_sha256: digest(record.nonce),
    observation_sha256: digest(record.observation),
    attestation_sha256: digest(record.attestation),
  };
}

async function invoke(
  command: string,
  expected: Omit<AttestedPhase, "observation" | "attestation">,
  secret: string,
): Promise<SanitizedPhase> {
  if (!commandPattern.test(command))
    throw new Error(`Gate C C5 ${expected.fault} ${expected.phase} command contains unsafe shell syntax`);
  const [file, ...arguments_] = command.split(/\s+/u);
  const { stdout, stderr } = await executeFile(file!, arguments_, {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    env: {
      PATH: process.env.PATH ?? "",
      GATE_C_C5_FAULT_PROTOCOL: protocol,
      GATE_C_C5_FAULT_SOURCE_SHA: expected.source_sha,
      GATE_C_C5_FAULT_RUN_ID: expected.run_id,
      GATE_C_C5_FAULT_DEPLOYMENT_ID: expected.deployment_id,
      GATE_C_C5_FAULT_BUILD_ID: expected.build_id,
      GATE_C_C5_FAULT_COMPONENT: expected.component,
      GATE_C_C5_FAULT: expected.fault,
      GATE_C_C5_FAULT_PHASE: expected.phase,
      GATE_C_C5_FAULT_NONCE: expected.nonce,
    },
  });
  if (stderr || stdout.length > 8192)
    throw new Error(`Gate C C5 ${expected.fault} ${expected.phase} command emitted unexpected output`);
  return parseAttestation(stdout.trim(), expected, secret);
}
function artifact(lane: ArtifactLane, phases: readonly SanitizedPhase[]): string {
  return `${JSON.stringify({ artifact_kind: "gate-c-c5-sanitized-fault-attestations-v1", lane, phases })}\n`;
}

/** stdout is never evidence: each phase must return a signed response to a
 * fresh nonce from the separately deployed controlled-staging control plane. */
export function createGateCC5ControlledStagingFaultHooks(
  input: Readonly<{
    retainedRoot: string;
    sourceSha: string;
    runId: string;
    deploymentId: string;
    buildId: string;
    faultAttestationSecret: string;
    environment?: NodeJS.ProcessEnv;
  }>,
): Readonly<Record<C5ControlledFailure, C5ControlledFailureHook>> {
  if (!sourceShaPattern.test(input.sourceSha) || Buffer.byteLength(input.faultAttestationSecret, "utf8") < 32)
    throw new Error("Gate C C5 fault hooks require exact source SHA and a 32-byte fault attestation secret");
  const environment = input.environment ?? process.env;
  return Object.fromEntries(
    C5_CONTROLLED_FAILURES.map((fault) => [
      fault,
      async (): Promise<C5ControlledFailureReceipt> => {
        const commands = Object.fromEntries(
          GATE_C_C5_FAULT_PHASES.map((phase) => [
            phase,
            environment[commandEnvironmentKey(fault, phase)] as string | undefined,
          ]),
        ) as Record<DrillPhase, string | undefined>;
        if (Object.values(commands).some((command) => !command))
          throw new Error(
            `Gate C C5 ${fault} requires PRECONDITION, INJECT, DEGRADATION, RECOVER, INVARIANT and CLEANUP controlled-staging commands`,
          );
        const directory = path.join(input.retainedRoot, fault);
        await mkdir(directory, { recursive: true });
        const observed: Partial<Record<DrillPhase, SanitizedPhase>> = {};
        let failure: unknown;
        try {
          for (const phase of GATE_C_C5_FAULT_PHASES.slice(0, -1)) {
            const expected: Omit<AttestedPhase, "observation" | "attestation"> = {
              protocol,
              source_sha: input.sourceSha,
              run_id: input.runId,
              deployment_id: input.deploymentId,
              build_id: input.buildId,
              component: faultComponents[fault],
              fault,
              phase,
              nonce: randomUUID(),
            };
            observed[phase] = await invoke(commands[phase]!, expected, input.faultAttestationSecret);
          }
        } catch (error) {
          failure = error;
        }
        try {
          const phase: DrillPhase = "CLEANUP";
          const expected: Omit<AttestedPhase, "observation" | "attestation"> = {
            protocol,
            source_sha: input.sourceSha,
            run_id: input.runId,
            deployment_id: input.deploymentId,
            build_id: input.buildId,
            component: faultComponents[fault],
            fault,
            phase,
            nonce: randomUUID(),
          };
          observed[phase] = await invoke(commands[phase]!, expected, input.faultAttestationSecret);
        } catch (error) {
          failure ??= error;
        }
        const lanes: Record<ArtifactLane, string> = {
          injection: artifact(
            "injection",
            lanePhases.injection
              .map((phase) => observed[phase])
              .filter((value): value is SanitizedPhase => Boolean(value)),
          ),
          recovery: artifact(
            "recovery",
            lanePhases.recovery
              .map((phase) => observed[phase])
              .filter((value): value is SanitizedPhase => Boolean(value)),
          ),
          cleanup: artifact(
            "cleanup",
            lanePhases.cleanup
              .map((phase) => observed[phase])
              .filter((value): value is SanitizedPhase => Boolean(value)),
          ),
        };
        await Promise.all(
          Object.entries(lanes).map(([lane, content]) =>
            writeFile(path.join(directory, `${lane}.log`), content, { encoding: "utf8", flag: "wx", mode: 0o600 }),
          ),
        );
        if (failure || GATE_C_C5_FAULT_PHASES.some((phase) => !observed[phase]))
          throw failure ?? new Error(`Gate C C5 ${fault} has incomplete signed phase evidence`);
        return {
          fault,
          injector: "command",
          injection_evidence_sha256: digest(lanes.injection),
          recovery_evidence_sha256: digest(lanes.recovery),
          cleanup_evidence_sha256: digest(lanes.cleanup),
          recovery_observed: true,
          cleanup_observed: true,
          recovery_oracle: "controlled_staging_recovered",
        };
      },
    ]),
  ) as Readonly<Record<C5ControlledFailure, C5ControlledFailureHook>>;
}
