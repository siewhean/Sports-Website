import type { AppConfig } from "@matchday/config";
import { HttpEdgeCachePurgeAdapter, type EdgeCachePurgePort } from "@matchday/edge-cache";

type WorkerEdgeCacheConfig = Pick<AppConfig, "edgeCache" | "environment">;

export function createWorkerEdgeCachePurgePort(config: WorkerEdgeCacheConfig): EdgeCachePurgePort | undefined {
  if (config.edgeCache === undefined) {
    if (config.environment === "staging" || config.environment === "production") {
      throw new Error("Edge cache purge configuration is required for staging and production workers");
    }
    return undefined;
  }
  return new HttpEdgeCachePurgeAdapter({
    endpoint: config.edgeCache.purgeEndpoint,
    bearerToken: config.edgeCache.purgeBearerToken,
  });
}
