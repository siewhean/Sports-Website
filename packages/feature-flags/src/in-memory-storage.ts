import type { FeatureFlagScope, FeatureFlagStorage } from "./types.js";

export class InMemoryFeatureFlagStorage implements FeatureFlagStorage {
  private readonly overrides = new Map<string, unknown>();

  async getOverride(flagKey: string, scope: FeatureFlagScope): Promise<unknown | undefined> {
    return this.overrides.get(storageKey(flagKey, scope));
  }

  async setOverride(flagKey: string, scope: FeatureFlagScope, value: unknown): Promise<void> {
    this.overrides.set(storageKey(flagKey, scope), value);
  }

  async deleteOverride(flagKey: string, scope: FeatureFlagScope): Promise<void> {
    this.overrides.delete(storageKey(flagKey, scope));
  }
}

function storageKey(flagKey: string, scope: FeatureFlagScope): string {
  return scope.kind === "global" ? `${flagKey}:global` : `${flagKey}:${scope.kind}:${scope.id}`;
}
