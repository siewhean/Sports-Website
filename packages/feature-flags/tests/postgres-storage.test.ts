import { describe, expect, it, vi } from "vitest";

import { PostgresFeatureFlagStorage, featureFlags, type FeatureFlagQueryPort } from "../src/index.js";

describe("PostgresFeatureFlagStorage validation", () => {
  const queryPort: FeatureFlagQueryPort = {
    query: vi.fn().mockResolvedValue([]),
    transaction: vi.fn(async (operation) => operation(queryPort)),
  };

  it("rejects keys and values outside the typed registry", async () => {
    const storage = makeStorage(queryPort);
    const untypedBoundary = storage as unknown as {
      setOverride(key: string, scope: { kind: "global" }, value: unknown): Promise<void>;
    };
    await expect(untypedBoundary.setOverride("not.registered", { kind: "global" }, true)).rejects.toThrow(
      "Unknown feature flag key",
    );
    await expect(untypedBoundary.setOverride("maintenance.global", { kind: "global" }, "yes")).rejects.toThrow(
      "Invalid persisted value",
    );
  });

  it("requires actor attribution, request ID, and reason before querying", async () => {
    const storage = new PostgresFeatureFlagStorage({
      registry: featureFlags,
      queryPort,
      getWriteContext: () => ({
        actor: { type: "platform_admin", accountId: "" },
        requestId: "",
        reason: "",
      }),
    });
    await expect(storage.setOverride("maintenance.global", { kind: "global" }, true)).rejects.toThrow(
      "non-empty reason",
    );
    expect(queryPort.transaction).not.toHaveBeenCalled();
  });
});

function makeStorage(queryPort: FeatureFlagQueryPort) {
  return new PostgresFeatureFlagStorage({
    registry: featureFlags,
    queryPort,
    getWriteContext: () => ({
      actor: { type: "system" },
      requestId: "request-1",
      reason: "test",
    }),
  });
}

function assertTypedWriteContract(storage: PostgresFeatureFlagStorage<typeof featureFlags>): void {
  // @ts-expect-error unknown keys must fail at compile time as well as runtime
  void storage.setOverride("not.registered", { kind: "global" }, true);
  // @ts-expect-error the registry derives a boolean value for this key
  void storage.setOverride("maintenance.global", { kind: "global" }, "yes");
}

void assertTypedWriteContract;
