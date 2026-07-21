import { describe, expect, it } from "vitest";

import { createWorkerEdgeCachePurgePort } from "../../src/index.js";

describe("worker edge cache composition", () => {
  it("keeps the adapter optional for local development", () => {
    expect(createWorkerEdgeCachePurgePort({ environment: "local" })).toBeUndefined();
  });

  it("fails closed for staging and production workers", () => {
    expect(() => createWorkerEdgeCachePurgePort({ environment: "staging" })).toThrow("required");
    expect(() => createWorkerEdgeCachePurgePort({ environment: "production" })).toThrow("required");
  });

  it("constructs the validated adapter without exposing its secret", () => {
    const adapter = createWorkerEdgeCachePurgePort({
      environment: "production",
      edgeCache: {
        purgeEndpoint: "https://edge-bridge.example.test/purge",
        purgeBearerToken: "e".repeat(32),
      },
    });
    expect(adapter).toBeDefined();
    expect(JSON.stringify(adapter)).not.toContain("e".repeat(32));
  });
});
