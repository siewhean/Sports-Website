import { describe, expect, it, vi } from "vitest";

import {
  FeatureFlagEvaluator,
  InMemoryFeatureFlagStorage,
  featureFlags,
  scopesFor,
  type FeatureFlagStorage,
} from "../src/index.js";

describe("FeatureFlagEvaluator", () => {
  it("returns the typed default when no override exists", async () => {
    const evaluator = new FeatureFlagEvaluator({
      registry: featureFlags,
      storage: new InMemoryFeatureFlagStorage(),
    });

    await expect(evaluator.evaluate("public.results")).resolves.toMatchObject({
      value: true,
      source: "default",
    });
  });

  it("evaluates account, competition, organization, then global scope", async () => {
    const storage = new InMemoryFeatureFlagStorage();
    const key = "registration.self-service";
    await storage.setOverride(key, { kind: "global" }, true);
    await storage.setOverride(key, { kind: "organization", id: "org-1" }, false);
    await storage.setOverride(key, { kind: "competition", id: "competition-1" }, true);
    await storage.setOverride(key, { kind: "account", id: "account-1" }, false);
    const evaluator = new FeatureFlagEvaluator({
      registry: featureFlags,
      storage,
    });

    await expect(
      evaluator.evaluate(key, {
        organizationId: "org-1",
        competitionId: "competition-1",
        accountId: "account-1",
      }),
    ).resolves.toMatchObject({ value: false, source: "account" });

    await storage.deleteOverride(key, { kind: "account", id: "account-1" });
    await expect(
      evaluator.evaluate(key, {
        organizationId: "org-1",
        competitionId: "competition-1",
        accountId: "account-1",
      }),
    ).resolves.toMatchObject({ value: true, source: "competition" });
  });

  it("ignores invalid stored values and continues to a valid lower scope", async () => {
    const storage = new InMemoryFeatureFlagStorage();
    await storage.setOverride("maintenance.global", { kind: "account", id: "account-1" }, "yes");
    await storage.setOverride("maintenance.global", { kind: "global" }, true);
    const evaluator = new FeatureFlagEvaluator({
      registry: featureFlags,
      storage,
    });

    const evaluation = await evaluator.evaluate("maintenance.global", {
      accountId: "account-1",
    });
    expect(evaluation).toMatchObject({ value: true, source: "global" });
    expect(evaluation.ignoredInvalidOverrides).toEqual([{ kind: "account", id: "account-1" }]);
  });

  it("fails safely to the registry default when storage is unavailable", async () => {
    const error = new Error("database unavailable");
    const onStorageError = vi.fn();
    const storage: FeatureFlagStorage = {
      getOverride: vi.fn().mockRejectedValue(error),
      setOverride: vi.fn(),
      deleteOverride: vi.fn(),
    };
    const evaluator = new FeatureFlagEvaluator({
      registry: featureFlags,
      storage,
      onStorageError,
    });

    await expect(evaluator.evaluate("maintenance.global")).resolves.toMatchObject({
      value: false,
      source: "default",
      fallbackReason: "storage-error",
    });
    expect(onStorageError).toHaveBeenCalledWith({
      flagKey: "maintenance.global",
      error,
    });
  });

  it("remains fail-safe when the observability hook also fails", async () => {
    const storage: FeatureFlagStorage = {
      getOverride: vi.fn().mockRejectedValue(new Error("storage failed")),
      setOverride: vi.fn(),
      deleteOverride: vi.fn(),
    };
    const evaluator = new FeatureFlagEvaluator({
      registry: featureFlags,
      storage,
      onStorageError: () => {
        throw new Error("telemetry failed");
      },
    });

    await expect(evaluator.evaluate("maintenance.global")).resolves.toMatchObject({
      value: false,
      fallbackReason: "storage-error",
    });
  });
});

describe("scopesFor", () => {
  it("returns deterministic most-specific-first precedence", () => {
    expect(
      scopesFor({
        accountId: "account-1",
        competitionId: "competition-1",
        organizationId: "org-1",
      }),
    ).toEqual([
      { kind: "account", id: "account-1" },
      { kind: "competition", id: "competition-1" },
      { kind: "organization", id: "org-1" },
      { kind: "global" },
    ]);
  });
});
