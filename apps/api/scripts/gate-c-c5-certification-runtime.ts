import type { C5ControlledFailure, C5IntegratedWorkloadExecution } from "@matchday/observability";

import type { GateCC5RetainedArtifacts } from "./gate-c-c5-retained-artifacts.js";

/**
 * Contract implemented by the controlled-staging adapter.  The certification
 * runner owns receipt creation and verification; an adapter may only provide
 * real isolated infrastructure and the five production-path executors.
 */
export type GateCC5CertificationRuntime = Readonly<{
  execution: C5IntegratedWorkloadExecution;
  retainedArtifacts: GateCC5RetainedArtifacts;
  /** The adapter must leave every resource disposable after this succeeds. */
  close: () => Promise<void>;
}>;

export type GateCC5CertificationRuntimeFactory = (
  input: Readonly<{
    sourceSha: string;
    profileJson: string;
    minimumSamplesPerOperation: number;
    maximumSamples: number;
    operationTimeoutMs: number;
    retainedRoot: string;
    requiredFaults: readonly C5ControlledFailure[];
  }>,
) => Promise<GateCC5CertificationRuntime>;

export type GateCC5CertificationRuntimeModule = Readonly<{
  createGateCC5CertificationRuntime: GateCC5CertificationRuntimeFactory;
}>;
