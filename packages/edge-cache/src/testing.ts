import {
  assertEdgePurgeRequest,
  type EdgeCachePurgePort,
  type EdgePurgeRequest,
  type EdgePurgeResult,
} from "./types.js";

export class InMemoryEdgeCachePurgeAdapter implements EdgeCachePurgePort {
  readonly requests: EdgePurgeRequest[] = [];

  constructor(private readonly now: () => Date = () => new Date("2026-07-17T00:00:00.000Z")) {}

  async purge(request: EdgePurgeRequest): Promise<EdgePurgeResult> {
    assertEdgePurgeRequest(request);
    this.requests.push(structuredClone(request));
    return { purgedAt: this.now().toISOString(), providerRequestId: `memory-${this.requests.length}` };
  }
}
