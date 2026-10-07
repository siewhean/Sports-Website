export interface FeatureFlagDefinition<Value> {
  defaultValue: Value;
  description: string;
  isValid(value: unknown): value is Value;
}

export type FeatureFlagRegistryConstraint<Registry> = {
  [Key in keyof Registry]: FeatureFlagDefinition<unknown>;
};

export type FeatureFlagKey<Registry> = Extract<keyof Registry, string>;

export type FeatureFlagValue<Registry, Key extends FeatureFlagKey<Registry>> =
  Registry[Key] extends FeatureFlagDefinition<infer Value> ? Value : never;

export type FeatureFlagScope =
  | { kind: "global" }
  | { kind: "organization"; id: string }
  | { kind: "competition"; id: string }
  | { kind: "account"; id: string };

export interface FeatureFlagContext {
  organizationId?: string;
  competitionId?: string;
  accountId?: string;
}

export interface FeatureFlagOverrideRecord {
  id: string;
  key: string;
  scope: FeatureFlagScope;
  value: unknown;
  reason: string;
  updatedBy: string | null;
  updatedAt: string;
}

export interface FeatureFlagMutationOptions {
  expectedUpdatedAt?: string;
}

export interface FeatureFlagReader {
  getOverride(flagKey: string, scope: FeatureFlagScope): Promise<unknown | undefined>;
}

export interface FeatureFlagStorage<
  Registry = Record<string, FeatureFlagDefinition<unknown>>,
> extends FeatureFlagReader {
  getOverrideRecord?(flagKey: string, scope: FeatureFlagScope): Promise<FeatureFlagOverrideRecord | null>;
  listOverrides?(flagKey?: string): Promise<FeatureFlagOverrideRecord[]>;
  setOverride<Key extends FeatureFlagKey<Registry>>(
    flagKey: Key,
    scope: FeatureFlagScope,
    value: FeatureFlagValue<Registry, Key>,
    options?: FeatureFlagMutationOptions,
  ): Promise<void>;
  deleteOverride<Key extends FeatureFlagKey<Registry>>(
    flagKey: Key,
    scope: FeatureFlagScope,
    options?: FeatureFlagMutationOptions,
  ): Promise<void>;
}

export type FeatureFlagEvaluationSource = FeatureFlagScope["kind"] | "default";

export interface FeatureFlagEvaluation<Value> {
  key: string;
  value: Value;
  source: FeatureFlagEvaluationSource;
  scope?: FeatureFlagScope;
  ignoredInvalidOverrides: FeatureFlagScope[];
  fallbackReason?: "storage-error";
}

export interface FeatureFlagStorageError {
  flagKey: string;
  error: Error;
}
