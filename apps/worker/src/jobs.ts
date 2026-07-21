import type { EdgePurgeRequest, EdgePurgeResult } from "@matchday/edge-cache";
import type { JobDefinition } from "@matchday/jobs";

export interface FoundationProbePayload {
  correlationId: string;
  requestedAt: string;
}

export interface FoundationProbeResult {
  correlationId: string;
  handledAt: string;
}

export type WorkerJobRegistry = {
  "edge.public-projection.purge": JobDefinition<EdgePurgeRequest, EdgePurgeResult>;
  "foundation.probe": JobDefinition<FoundationProbePayload, FoundationProbeResult>;
};
