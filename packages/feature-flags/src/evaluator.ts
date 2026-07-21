import type {
  FeatureFlagContext,
  FeatureFlagEvaluation,
  FeatureFlagKey,
  FeatureFlagReader,
  FeatureFlagRegistryConstraint,
  FeatureFlagScope,
  FeatureFlagStorageError,
  FeatureFlagValue,
} from "./types.js";

export interface FeatureFlagEvaluatorOptions<Registry extends FeatureFlagRegistryConstraint<Registry>> {
  registry: Registry;
  storage: FeatureFlagReader;
  onStorageError?: (failure: FeatureFlagStorageError) => void;
}

export class FeatureFlagEvaluator<Registry extends FeatureFlagRegistryConstraint<Registry>> {
  constructor(private readonly options: FeatureFlagEvaluatorOptions<Registry>) {}

  async evaluate<Key extends FeatureFlagKey<Registry>>(
    key: Key,
    context: FeatureFlagContext = {},
  ): Promise<FeatureFlagEvaluation<FeatureFlagValue<Registry, Key>>> {
    const definition = this.options.registry[key];
    const ignoredInvalidOverrides: FeatureFlagScope[] = [];

    try {
      for (const scope of scopesFor(context)) {
        const override = await this.options.storage.getOverride(key, scope);
        if (override === undefined) continue;

        if (definition.isValid(override)) {
          return {
            key,
            value: override as FeatureFlagValue<Registry, Key>,
            source: scope.kind,
            scope,
            ignoredInvalidOverrides,
          };
        }

        ignoredInvalidOverrides.push(scope);
      }
    } catch (error: unknown) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.reportStorageError(key, normalizedError);
      return {
        key,
        value: definition.defaultValue as FeatureFlagValue<Registry, Key>,
        source: "default",
        ignoredInvalidOverrides,
        fallbackReason: "storage-error",
      };
    }

    return {
      key,
      value: definition.defaultValue as FeatureFlagValue<Registry, Key>,
      source: "default",
      ignoredInvalidOverrides,
    };
  }

  private reportStorageError(flagKey: string, error: Error): void {
    try {
      this.options.onStorageError?.({ flagKey, error });
    } catch {
      // Observability hooks must never change a flag's fail-safe behaviour.
    }
  }
}

export function scopesFor(context: FeatureFlagContext): FeatureFlagScope[] {
  return [
    ...(context.accountId === undefined ? [] : [{ kind: "account", id: context.accountId } as const]),
    ...(context.competitionId === undefined ? [] : [{ kind: "competition", id: context.competitionId } as const]),
    ...(context.organizationId === undefined ? [] : [{ kind: "organization", id: context.organizationId } as const]),
    { kind: "global" },
  ];
}
