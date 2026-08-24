import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  C5_CONTROLLED_FAILURES,
  type C5ControlledFailure,
  type C5IntegratedWorkloadReceipt,
} from "@matchday/observability";
import {
  gateCC5RetainedArtifactRoot,
  verifyGateCC5RetainedArtifacts,
  type GateCC5RetainedArtifacts,
} from "../../scripts/gate-c-c5-retained-artifacts.js";

const sourceSha = "c".repeat(40);
const retainedRoot = gateCC5RetainedArtifactRoot(sourceSha);
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const lanePhases = {
  injection: ["PRECONDITION", "INJECT", "DEGRADATION"],
  recovery: ["RECOVER", "INVARIANT"],
  cleanup: ["CLEANUP"],
} as const;
function retainedArtifact(fault: C5ControlledFailure, lane: keyof typeof lanePhases): string {
  return JSON.stringify({
    artifact_kind: "gate-c-c5-sanitized-fault-attestations-v1",
    lane,
    phases: lanePhases[lane].map((phase) => ({
      protocol: "gate-c-c5-fault-attestation-v1",
      source_sha: sourceSha,
      run_id: "run-1",
      deployment_id: "dpl-1",
      build_id: "build-1",
      component: "test",
      fault,
      phase,
      nonce_sha256: hash(`${fault}:${phase}:nonce`),
      observation_sha256: hash(`${fault}:${phase}:observation`),
      attestation_sha256: hash(`${fault}:${phase}:attestation`),
    })),
  });
}

afterEach(async () => {
  await rm(path.dirname(retainedRoot), { recursive: true, force: true });
});

async function createFixture(): Promise<{
  receipt: Pick<C5IntegratedWorkloadReceipt, "source_sha" | "controlled_failures">;
  artifacts: GateCC5RetainedArtifacts;
}> {
  await mkdir(retainedRoot, { recursive: true });
  const artifacts = {} as Record<C5ControlledFailure, { injection: string; recovery: string; cleanup: string }>;
  const controlledFailures = [] as C5IntegratedWorkloadReceipt["controlled_failures"] extends readonly (infer Item)[]
    ? Item[]
    : never[];
  for (const fault of C5_CONTROLLED_FAILURES) {
    const injection = `${fault}/injection.log`;
    const recovery = `${fault}/recovery.log`;
    const cleanup = `${fault}/cleanup.log`;
    const contents = {
      injection: retainedArtifact(fault, "injection"),
      recovery: retainedArtifact(fault, "recovery"),
      cleanup: retainedArtifact(fault, "cleanup"),
    };
    await Promise.all(
      Object.entries({ injection, recovery, cleanup }).map(async ([kind, relativePath]) => {
        await mkdir(path.dirname(path.join(retainedRoot, relativePath)), { recursive: true });
        await writeFile(path.join(retainedRoot, relativePath), contents[kind as keyof typeof contents], "utf8");
      }),
    );
    artifacts[fault] = { injection, recovery, cleanup };
    controlledFailures.push({
      fault,
      injector: "command",
      injection_evidence_sha256: hash(contents.injection),
      recovery_evidence_sha256: hash(contents.recovery),
      cleanup_evidence_sha256: hash(contents.cleanup),
      recovery_observed: true,
      cleanup_observed: true,
      recovery_oracle: `recovered_${fault}`,
    });
  }
  return {
    receipt: { source_sha: sourceSha, controlled_failures: controlledFailures },
    artifacts,
  };
}

describe("C5 retained drill artifacts", () => {
  it("rehashes every exact-SHA fault artifact rather than trusting receipt hash strings", async () => {
    const { receipt, artifacts } = await createFixture();
    const verified = await verifyGateCC5RetainedArtifacts({ retainedRoot, sourceSha, receipt, artifacts });
    expect(verified).toHaveLength(C5_CONTROLLED_FAILURES.length);
    expect(verified[0]).toMatchObject({ fault: "postgres_interruption" });
  });

  it("rejects symlinks, changed content, and secret-like drill logs", async () => {
    const { receipt, artifacts } = await createFixture();
    await writeFile(path.join(retainedRoot, artifacts.redis_interruption.recovery), "changed", "utf8");
    await expect(verifyGateCC5RetainedArtifacts({ retainedRoot, sourceSha, receipt, artifacts })).rejects.toThrow(
      "hash does not match redis_interruption",
    );

    await writeFile(
      path.join(retainedRoot, artifacts.redis_interruption.recovery),
      retainedArtifact("redis_interruption", "recovery"),
      "utf8",
    );
    await rm(path.join(retainedRoot, artifacts.api_interruption.injection));
    await symlink(
      path.join(retainedRoot, artifacts.api_interruption.recovery),
      path.join(retainedRoot, artifacts.api_interruption.injection),
    );
    await expect(verifyGateCC5RetainedArtifacts({ retainedRoot, sourceSha, receipt, artifacts })).rejects.toThrow(
      "non-symlink",
    );

    await rm(path.join(retainedRoot, artifacts.api_interruption.injection));
    await writeFile(path.join(retainedRoot, artifacts.api_interruption.injection), "token=not-safe", "utf8");
    await expect(verifyGateCC5RetainedArtifacts({ retainedRoot, sourceSha, receipt, artifacts })).rejects.toThrow(
      "secret-like",
    );
  });

  it("rejects extra artifact fields and malformed controlled-failure records before opening files", async () => {
    const { receipt, artifacts } = await createFixture();
    await expect(
      verifyGateCC5RetainedArtifacts({
        retainedRoot,
        sourceSha,
        receipt,
        artifacts: { ...artifacts, unexpected_fault: artifacts.api_interruption },
      }),
    ).rejects.toThrow("unsupported fault records");
    await expect(
      verifyGateCC5RetainedArtifacts({
        retainedRoot,
        sourceSha,
        receipt: {
          ...receipt,
          controlled_failures: receipt.controlled_failures.map((fault) =>
            fault.fault === "api_interruption" ? { ...fault, unexpected_field: true } : fault,
          ),
        },
        artifacts,
      }),
    ).rejects.toThrow("invalid api_interruption evidence");
  });

  it("rejects missing, reordered, and unsigned per-phase fault attestations", async () => {
    const { receipt, artifacts } = await createFixture();
    const file = path.join(retainedRoot, artifacts.web_interruption.injection);
    const artifact = JSON.parse(await readFile(file, "utf8"));
    artifact.phases.pop();
    await writeFile(file, JSON.stringify(artifact), "utf8");
    const missingPhaseReceipt = {
      ...receipt,
      controlled_failures: receipt.controlled_failures.map((failure) =>
        failure.fault === "web_interruption"
          ? { ...failure, injection_evidence_sha256: hash(JSON.stringify(artifact)) }
          : failure,
      ),
    };
    await expect(
      verifyGateCC5RetainedArtifacts({ retainedRoot, sourceSha, receipt: missingPhaseReceipt, artifacts }),
    ).rejects.toThrow("incomplete phase evidence");
    await writeFile(file, retainedArtifact("web_interruption", "injection"), "utf8");
    const reordered = JSON.parse(await readFile(file, "utf8"));
    [reordered.phases[0], reordered.phases[1]] = [reordered.phases[1], reordered.phases[0]];
    await writeFile(file, JSON.stringify(reordered), "utf8");
    const reorderedReceipt = {
      ...receipt,
      controlled_failures: receipt.controlled_failures.map((failure) =>
        failure.fault === "web_interruption"
          ? { ...failure, injection_evidence_sha256: hash(JSON.stringify(reordered)) }
          : failure,
      ),
    };
    await expect(
      verifyGateCC5RetainedArtifacts({ retainedRoot, sourceSha, receipt: reorderedReceipt, artifacts }),
    ).rejects.toThrow("invalid signed phase evidence");
  });
});
