import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  C5_FAULT_INJECTORS,
  C5_CONTROLLED_FAILURES,
  type C5ControlledFailure,
  type C5ControlledFailureReceipt,
  type C5IntegratedWorkloadReceipt,
} from "@matchday/observability";

const sourceShaPattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const secretLikeContent =
  /(?:\b(?:secret|token|password|cookie|authorization|bearer)\b|(?:postgres(?:ql)?|redis|rediss):\/\/|https?:\/\/[^\s"']+@)/iu;
const maximumArtifactBytes = 5 * 1024 * 1024;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const recoveryOraclePattern = /^[a-z][a-z0-9_]{2,199}$/u;
const faultPhaseLanes = {
  injection: ["PRECONDITION", "INJECT", "DEGRADATION"],
  recovery: ["RECOVER", "INVARIANT"],
  cleanup: ["CLEANUP"],
} as const;

export type GateCC5FaultArtifactPaths = Readonly<{
  injection: string;
  recovery: string;
  cleanup: string;
}>;

export type GateCC5RetainedArtifacts = Readonly<Record<C5ControlledFailure, GateCC5FaultArtifactPaths>>;

export type GateCC5ArtifactVerification = Readonly<{
  fault: C5ControlledFailure;
  injection_sha256: string;
  recovery_sha256: string;
  cleanup_sha256: string;
}>;

type GateCC5FaultEvidenceReceipt = Readonly<Pick<C5IntegratedWorkloadReceipt, "source_sha" | "controlled_failures">>;

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertSafeRelativePath(value: string, label: string): void {
  if (!value || path.isAbsolute(value) || value.includes("\\")) {
    throw new Error(`Gate C C5 ${label} path must be a non-empty relative POSIX path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== value) {
    throw new Error(`Gate C C5 ${label} path escapes the retained artifact root`);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? (value as Record<string, unknown>) : null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
  return observed.length === expected.length && observed.every((key, index) => key === expected[index]);
}

function parseArtifactPaths(value: unknown, fault: C5ControlledFailure): GateCC5FaultArtifactPaths {
  const paths = record(value);
  if (!paths || !hasExactKeys(paths, ["injection", "recovery", "cleanup"])) {
    throw new Error(`Gate C C5 retained artifacts have an invalid ${fault} record`);
  }
  const injection = paths.injection;
  const recovery = paths.recovery;
  const cleanup = paths.cleanup;
  if (typeof injection !== "string" || typeof recovery !== "string" || typeof cleanup !== "string") {
    throw new Error(`Gate C C5 retained artifacts have non-string ${fault} paths`);
  }
  const parsed: GateCC5FaultArtifactPaths = { injection, recovery, cleanup };
  for (const [label, relativePath] of Object.entries(parsed)) assertSafeRelativePath(relativePath, `${fault} ${label}`);
  return parsed;
}

function parseArtifacts(value: unknown): GateCC5RetainedArtifacts {
  const artifacts = record(value);
  if (!artifacts || !hasExactKeys(artifacts, C5_CONTROLLED_FAILURES)) {
    throw new Error("Gate C C5 retained artifacts have unsupported fault records");
  }
  return Object.fromEntries(
    C5_CONTROLLED_FAILURES.map((fault) => [fault, parseArtifactPaths(artifacts[fault], fault)]),
  ) as GateCC5RetainedArtifacts;
}

async function readRetainedArtifact(root: string, relativePath: string): Promise<Buffer> {
  const candidate = path.resolve(root, relativePath);
  if (!candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("Gate C C5 artifact path escaped the retained artifact root");
  }
  const metadata = await lstat(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Gate C C5 retained artifact must be a regular non-symlink file");
  }
  const canonical = await realpath(candidate);
  if (!canonical.startsWith(`${root}${path.sep}`)) {
    throw new Error("Gate C C5 retained artifact real path escaped the retained artifact root");
  }
  if (metadata.size > maximumArtifactBytes) {
    throw new Error(`Gate C C5 retained artifact exceeds ${String(maximumArtifactBytes)} bytes`);
  }
  const content = await readFile(canonical);
  if (secretLikeContent.test(content.toString("utf8"))) {
    throw new Error("Gate C C5 retained artifact contains secret-like content");
  }
  return content;
}

function validateSanitizedFaultArtifact(
  content: Buffer,
  sourceSha: string,
  fault: C5ControlledFailure,
  lane: keyof typeof faultPhaseLanes,
): void {
  let value: unknown;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error(`Gate C C5 retained ${fault}/${lane} artifact is not signed-attestation JSON`);
  }
  const artifact = record(value);
  const phases = artifact?.phases;
  if (
    !artifact ||
    artifact.artifact_kind !== "gate-c-c5-sanitized-fault-attestations-v1" ||
    artifact.lane !== lane ||
    !Array.isArray(phases) ||
    phases.length !== faultPhaseLanes[lane].length
  ) {
    throw new Error(`Gate C C5 retained ${fault}/${lane} artifact has incomplete phase evidence`);
  }
  for (const [index, expectedPhase] of faultPhaseLanes[lane].entries()) {
    const phase = record(phases[index]);
    if (
      !phase ||
      !hasExactKeys(phase, [
        "protocol",
        "source_sha",
        "run_id",
        "deployment_id",
        "build_id",
        "component",
        "fault",
        "phase",
        "nonce_sha256",
        "observation_sha256",
        "attestation_sha256",
      ]) ||
      phase.protocol !== "gate-c-c5-fault-attestation-v1" ||
      phase.source_sha !== sourceSha ||
      phase.fault !== fault ||
      phase.phase !== expectedPhase ||
      typeof phase.run_id !== "string" ||
      !phase.run_id ||
      typeof phase.deployment_id !== "string" ||
      !phase.deployment_id ||
      typeof phase.build_id !== "string" ||
      !phase.build_id ||
      typeof phase.component !== "string" ||
      !phase.component ||
      ![phase.nonce_sha256, phase.observation_sha256, phase.attestation_sha256].every(
        (hash) => typeof hash === "string" && sha256Pattern.test(hash),
      )
    ) {
      throw new Error(`Gate C C5 retained ${fault}/${lane} artifact has invalid signed phase evidence`);
    }
  }
}

function parseFaultEvidenceReceipt(value: unknown, sourceSha: string): GateCC5FaultEvidenceReceipt {
  const receipt = record(value);
  if (!receipt || receipt.source_sha !== sourceSha || !Array.isArray(receipt.controlled_failures)) {
    throw new Error("Gate C C5 retained artifact receipt has an invalid source or controlled failures");
  }
  if (receipt.controlled_failures.length !== C5_CONTROLLED_FAILURES.length) {
    throw new Error("Gate C C5 retained artifact receipt has incomplete controlled failures");
  }
  const parsed: C5ControlledFailureReceipt[] = [];
  for (const fault of C5_CONTROLLED_FAILURES) {
    const matches = receipt.controlled_failures.filter((candidate) => record(candidate)?.fault === fault);
    if (matches.length !== 1 || !matches[0]) throw new Error(`Gate C C5 receipt omits ${fault} evidence`);
    const candidate = record(matches[0]);
    if (
      !candidate ||
      !hasExactKeys(candidate, [
        "fault",
        "injector",
        "injection_evidence_sha256",
        "recovery_evidence_sha256",
        "cleanup_evidence_sha256",
        "recovery_observed",
        "cleanup_observed",
        "recovery_oracle",
      ]) ||
      candidate.fault !== fault ||
      typeof candidate.injector !== "string" ||
      !C5_FAULT_INJECTORS.includes(candidate.injector as (typeof C5_FAULT_INJECTORS)[number]) ||
      typeof candidate.injection_evidence_sha256 !== "string" ||
      typeof candidate.recovery_evidence_sha256 !== "string" ||
      typeof candidate.cleanup_evidence_sha256 !== "string" ||
      !sha256Pattern.test(candidate.injection_evidence_sha256) ||
      !sha256Pattern.test(candidate.recovery_evidence_sha256) ||
      !sha256Pattern.test(candidate.cleanup_evidence_sha256) ||
      candidate.recovery_observed !== true ||
      candidate.cleanup_observed !== true ||
      typeof candidate.recovery_oracle !== "string" ||
      !recoveryOraclePattern.test(candidate.recovery_oracle)
    ) {
      throw new Error(`Gate C C5 receipt has invalid ${fault} evidence`);
    }
    parsed.push(candidate as C5ControlledFailureReceipt);
  }
  return { source_sha: sourceSha, controlled_failures: parsed };
}

export function gateCC5RetainedArtifactRoot(sourceSha: string): string {
  if (!sourceShaPattern.test(sourceSha))
    throw new Error("Gate C C5 retained artifact root requires an exact source SHA");
  return path.join(repositoryRoot, "artifacts", "qa", "gate-c-c5", sourceSha, "retained");
}

/**
 * Rehashes retained C5 drill logs. The caller passes only paths below the
 * exact-SHA retained tree; this function never trusts caller-supplied hashes.
 */
export async function verifyGateCC5RetainedArtifacts(
  input: Readonly<{
    retainedRoot: string;
    sourceSha: string;
    receipt: unknown;
    artifacts: unknown;
  }>,
): Promise<readonly GateCC5ArtifactVerification[]> {
  if (!sourceShaPattern.test(input.sourceSha)) {
    throw new Error("Gate C C5 retained artifact verification requires the receipt exact source SHA");
  }
  const receipt = parseFaultEvidenceReceipt(input.receipt, input.sourceSha);
  const artifacts = parseArtifacts(input.artifacts);
  const expectedRoot = gateCC5RetainedArtifactRoot(input.sourceSha);
  if (path.resolve(input.retainedRoot) !== expectedRoot) {
    throw new Error("Gate C C5 retained artifact root is not the exact-SHA retained directory");
  }
  const rootMetadata = await lstat(expectedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Gate C C5 retained artifact root must be a real directory");
  }
  const canonicalRoot = await realpath(expectedRoot);
  if (canonicalRoot !== expectedRoot) {
    throw new Error("Gate C C5 retained artifact root must not traverse symlinks");
  }
  const verified: GateCC5ArtifactVerification[] = [];
  for (const fault of C5_CONTROLLED_FAILURES) {
    const paths = artifacts[fault];
    const receiptEvidence = receipt.controlled_failures.find((candidate) => candidate.fault === fault);
    if (!paths || !receiptEvidence) throw new Error(`Gate C C5 retained artifact verifier lost ${fault} evidence`);
    const [injection, recovery, cleanup] = await Promise.all([
      readRetainedArtifact(canonicalRoot, paths.injection),
      readRetainedArtifact(canonicalRoot, paths.recovery),
      readRetainedArtifact(canonicalRoot, paths.cleanup),
    ]);
    const hashes = {
      injection_sha256: sha256(injection),
      recovery_sha256: sha256(recovery),
      cleanup_sha256: sha256(cleanup),
    };
    if (
      !sha256Pattern.test(receiptEvidence.injection_evidence_sha256) ||
      receiptEvidence.injection_evidence_sha256 !== hashes.injection_sha256 ||
      receiptEvidence.recovery_evidence_sha256 !== hashes.recovery_sha256 ||
      receiptEvidence.cleanup_evidence_sha256 !== hashes.cleanup_sha256
    ) {
      throw new Error(`Gate C C5 retained artifact hash does not match ${fault} receipt evidence`);
    }
    validateSanitizedFaultArtifact(injection, input.sourceSha, fault, "injection");
    validateSanitizedFaultArtifact(recovery, input.sourceSha, fault, "recovery");
    validateSanitizedFaultArtifact(cleanup, input.sourceSha, fault, "cleanup");
    verified.push({ fault, ...hashes });
  }
  return verified;
}
