import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { C5_CONTROLLED_FAILURES } from "@matchday/observability";

import {
  createGateCC5ControlledStagingFaultHooks,
  GATE_C_C5_FAULT_PHASES,
} from "../../scripts/gate-c-c5-controlled-staging-faults.js";

const secret = "a".repeat(32);
const sourceSha = "a".repeat(40);
const common = {
  sourceSha,
  runId: "test-run",
  deploymentId: "dpl_test",
  buildId: "build_test",
  faultAttestationSecret: secret,
};

async function attestorCommand(directory: string): Promise<string> {
  const script = path.join(directory, "attestor.mjs");
  const node = path.join(directory, "node");
  await symlink(process.execPath, node);
  await writeFile(
    script,
    `import { createHmac } from 'node:crypto';
const keys=['protocol','source_sha','run_id','deployment_id','build_id','component','fault','phase','nonce'];
const env=process.env; const value={protocol:env.GATE_C_C5_FAULT_PROTOCOL,source_sha:env.GATE_C_C5_FAULT_SOURCE_SHA,run_id:env.GATE_C_C5_FAULT_RUN_ID,deployment_id:env.GATE_C_C5_FAULT_DEPLOYMENT_ID,build_id:env.GATE_C_C5_FAULT_BUILD_ID,component:env.GATE_C_C5_FAULT_COMPONENT,fault:env.GATE_C_C5_FAULT,phase:env.GATE_C_C5_FAULT_PHASE,nonce:env.GATE_C_C5_FAULT_NONCE,observation:'control_plane_observed'};
value.attestation=createHmac('sha256','${secret}').update(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\\n'),'utf8').digest('hex'); console.log(JSON.stringify(value));\n`,
    "utf8",
  );
  return `${node} ${script}`;
}

function environmentFor(command: string): NodeJS.ProcessEnv {
  return Object.fromEntries(
    C5_CONTROLLED_FAILURES.flatMap((fault) =>
      GATE_C_C5_FAULT_PHASES.map((phase) => [`GATE_C_C5_${fault.toUpperCase()}_${phase}_COMMAND`, command]),
    ),
  );
}

describe("Gate C C5 controlled staging fault hooks", () => {
  it("fails closed when any real fault command is absent", async () => {
    const hooks = createGateCC5ControlledStagingFaultHooks({
      retainedRoot: "/tmp/gate-c-c5-retained",
      ...common,
      environment: {},
    });
    await expect(hooks.redis_interruption()).rejects.toThrow(
      "requires PRECONDITION, INJECT, DEGRADATION, RECOVER, INVARIANT and CLEANUP",
    );
  });

  it("rejects arbitrary stdout, including /usr/bin/printf, and retains no forged receipt", async () => {
    const retainedRoot = await mkdtemp(path.join(os.tmpdir(), "gate-c-c5-fault-"));
    try {
      const env = environmentFor("/usr/bin/printf observation");
      const hooks = createGateCC5ControlledStagingFaultHooks({ retainedRoot, ...common, environment: env });
      await expect(hooks.redis_interruption()).rejects.toThrow("signed control-plane JSON attestation");
      const cleanup = await readFile(path.join(retainedRoot, "redis_interruption", "cleanup.log"), "utf8");
      expect(cleanup).toContain('"phases":[]');
      expect(cleanup).not.toContain("observation");
    } finally {
      await rm(retainedRoot, { recursive: true, force: true });
    }
  });

  it("requires a distinct signed nonce-bound control-plane attestation for every phase of every fault and retains hashes only", async () => {
    const retainedRoot = await mkdtemp(path.join(os.tmpdir(), "gate-c-c5-fault-"));
    try {
      const command = await attestorCommand(retainedRoot);
      const hooks = createGateCC5ControlledStagingFaultHooks({
        retainedRoot,
        ...common,
        environment: environmentFor(command),
      });
      for (const fault of C5_CONTROLLED_FAILURES)
        await expect(hooks[fault]()).resolves.toMatchObject({ fault, recovery_observed: true, cleanup_observed: true });
      const injection = JSON.parse(
        await readFile(path.join(retainedRoot, "postgres_interruption", "injection.log"), "utf8"),
      );
      expect(injection.phases.map((phase: { phase: string }) => phase.phase)).toEqual([
        "PRECONDITION",
        "INJECT",
        "DEGRADATION",
      ]);
      for (const lane of ["injection", "recovery", "cleanup"] as const) {
        const retained = await readFile(path.join(retainedRoot, "postgres_interruption", `${lane}.log`), "utf8");
        expect(retained).not.toContain("control_plane_observed");
        expect(retained).not.toContain('"nonce"');
        expect(retained).toContain("observation_sha256");
        expect(retained).toContain("attestation_sha256");
      }
    } finally {
      await rm(retainedRoot, { recursive: true, force: true });
    }
  });
});
