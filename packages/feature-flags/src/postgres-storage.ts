import type {
  FeatureFlagDefinition,
  FeatureFlagKey,
  FeatureFlagRegistryConstraint,
  FeatureFlagScope,
  FeatureFlagStorage,
  FeatureFlagValue,
} from "./types.js";

type QueryValue = boolean | number | string | null | Record<string, unknown>;

export interface FeatureFlagQueryExecutor {
  query<Row extends Record<string, unknown>>(text: string, parameters: readonly QueryValue[]): Promise<readonly Row[]>;
}

export interface FeatureFlagQueryPort extends FeatureFlagQueryExecutor {
  transaction<Result>(operation: (transaction: FeatureFlagQueryExecutor) => Promise<Result>): Promise<Result>;
}

export type FeatureFlagAuditActor = { type: "system" } | { type: "account" | "platform_admin"; accountId: string };

export interface FeatureFlagWriteContext {
  actor: FeatureFlagAuditActor;
  reason: string;
  requestId: string;
}

export interface FeatureFlagMutation<Registry, Key extends FeatureFlagKey<Registry> = FeatureFlagKey<Registry>> {
  flagKey: Key;
  operation: "set" | "delete";
  scope: FeatureFlagScope;
  value?: FeatureFlagValue<Registry, Key>;
}

export interface PostgresFeatureFlagStorageOptions<Registry extends FeatureFlagRegistryConstraint<Registry>> {
  registry: Registry;
  queryPort: FeatureFlagQueryPort;
  getWriteContext(
    mutation: Readonly<FeatureFlagMutation<Registry>>,
  ): FeatureFlagWriteContext | Promise<FeatureFlagWriteContext>;
}

type OverrideRow = {
  enabled: boolean;
  id: string;
  key: string;
  reason: string;
  scope_id: string | null;
  scope_type: DatabaseScopeType;
  updated_at: string;
  updated_by: string | null;
};

type DatabaseScopeType = "platform" | "organisation" | "competition" | "account";

export class PostgresFeatureFlagStorage<
  Registry extends FeatureFlagRegistryConstraint<Registry>,
> implements FeatureFlagStorage<Registry> {
  constructor(private readonly options: PostgresFeatureFlagStorageOptions<Registry>) {}

  async getOverride(flagKey: string, scope: FeatureFlagScope): Promise<unknown | undefined> {
    this.definitionFor(flagKey as FeatureFlagKey<Registry>);
    const databaseScope = toDatabaseScope(scope);
    const rows = await this.options.queryPort.query<{ enabled: boolean }>(
      `SELECT enabled
         FROM feature_flag_overrides
        WHERE key = $1
          AND scope_type = $2
          AND scope_id IS NOT DISTINCT FROM $3::uuid`,
      [flagKey, databaseScope.type, databaseScope.id],
    );
    return rows[0]?.enabled;
  }

  async setOverride<Key extends FeatureFlagKey<Registry>>(
    flagKey: Key,
    scope: FeatureFlagScope,
    value: FeatureFlagValue<Registry, Key>,
  ): Promise<void> {
    const definition = this.definitionFor(flagKey);
    if (!definition.isValid(value) || typeof value !== "boolean") {
      throw new Error(`Invalid persisted value for feature flag ${flagKey}`);
    }
    const context = await this.validatedContext({
      flagKey,
      operation: "set",
      scope,
      value,
    });
    const databaseScope = toDatabaseScope(scope);
    const targetId = auditTargetId(flagKey, databaseScope);

    await this.options.queryPort.transaction(async (transaction) => {
      await acquireMutationLock(transaction, targetId);
      const before = await selectOverride(transaction, flagKey, databaseScope);
      const rows = await transaction.query<OverrideRow>(
        `INSERT INTO feature_flag_overrides
           (key, scope_type, scope_id, enabled, reason, updated_by)
         VALUES ($1, $2, $3::uuid, $4, $5, $6::uuid)
         ON CONFLICT (key, scope_type, scope_id) DO UPDATE
           SET enabled = EXCLUDED.enabled,
               reason = EXCLUDED.reason,
               updated_by = EXCLUDED.updated_by,
               updated_at = now()
         RETURNING id, key, scope_type, scope_id, enabled, reason,
                   updated_by, updated_at::text`,
        [flagKey, databaseScope.type, databaseScope.id, value, context.reason, actorAccountId(context.actor)],
      );
      const after = rows[0];
      if (after === undefined) throw new Error("Feature flag upsert returned no row");
      await appendAuditEvent(transaction, {
        context,
        scope,
        targetId,
        before,
        after,
        action: "feature_flag.override_set",
      });
    });
  }

  async deleteOverride<Key extends FeatureFlagKey<Registry>>(flagKey: Key, scope: FeatureFlagScope): Promise<void> {
    this.definitionFor(flagKey);
    const context = await this.validatedContext({
      flagKey,
      operation: "delete",
      scope,
    });
    const databaseScope = toDatabaseScope(scope);
    const targetId = auditTargetId(flagKey, databaseScope);

    await this.options.queryPort.transaction(async (transaction) => {
      await acquireMutationLock(transaction, targetId);
      const before = await selectOverride(transaction, flagKey, databaseScope);
      if (before === undefined) return;
      await transaction.query(
        `DELETE FROM feature_flag_overrides
          WHERE id = $1::uuid`,
        [before.id],
      );
      await appendAuditEvent(transaction, {
        context,
        scope,
        targetId,
        before,
        after: undefined,
        action: "feature_flag.override_deleted",
      });
    });
  }

  private definitionFor(flagKey: FeatureFlagKey<Registry>): FeatureFlagDefinition<unknown> {
    if (!Object.prototype.hasOwnProperty.call(this.options.registry, flagKey)) {
      throw new Error(`Unknown feature flag key: ${flagKey}`);
    }
    return this.options.registry[flagKey as keyof Registry];
  }

  private async validatedContext(mutation: FeatureFlagMutation<Registry>): Promise<FeatureFlagWriteContext> {
    const context = await this.options.getWriteContext(mutation);
    if (context.reason.trim().length === 0) {
      throw new Error("Feature flag changes require a non-empty reason");
    }
    if (context.requestId.trim().length === 0) {
      throw new Error("Feature flag changes require a requestId");
    }
    if (context.actor.type !== "system" && context.actor.accountId.trim().length === 0) {
      throw new Error("Account actors require an accountId");
    }
    return { ...context, reason: context.reason.trim() };
  }
}

function toDatabaseScope(scope: FeatureFlagScope): {
  type: DatabaseScopeType;
  id: string | null;
} {
  switch (scope.kind) {
    case "global":
      return { type: "platform", id: null };
    case "organization":
      return { type: "organisation", id: scope.id };
    case "competition":
      return { type: "competition", id: scope.id };
    case "account":
      return { type: "account", id: scope.id };
  }
}

function actorAccountId(actor: FeatureFlagAuditActor): string | null {
  return actor.type === "system" ? null : actor.accountId;
}

function auditTargetId(flagKey: string, scope: { type: DatabaseScopeType; id: string | null }): string {
  return `${flagKey}:${scope.type}:${scope.id ?? "platform"}`;
}

async function acquireMutationLock(transaction: FeatureFlagQueryExecutor, targetId: string): Promise<void> {
  await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [targetId]);
}

async function selectOverride(
  transaction: FeatureFlagQueryExecutor,
  flagKey: string,
  scope: { type: DatabaseScopeType; id: string | null },
): Promise<OverrideRow | undefined> {
  const rows = await transaction.query<OverrideRow>(
    `SELECT id, key, scope_type, scope_id, enabled, reason,
            updated_by, updated_at::text
       FROM feature_flag_overrides
      WHERE key = $1
        AND scope_type = $2
        AND scope_id IS NOT DISTINCT FROM $3::uuid
      FOR UPDATE`,
    [flagKey, scope.type, scope.id],
  );
  return rows[0];
}

async function appendAuditEvent(
  transaction: FeatureFlagQueryExecutor,
  input: {
    action: "feature_flag.override_set" | "feature_flag.override_deleted";
    after: OverrideRow | undefined;
    before: OverrideRow | undefined;
    context: FeatureFlagWriteContext;
    scope: FeatureFlagScope;
    targetId: string;
  },
): Promise<void> {
  await transaction.query(
    `INSERT INTO audit_events
       (request_id, actor_account_id, actor_type, organisation_id,
        action, target_type, target_id, reason, before_state,
        after_state, metadata)
     VALUES ($1, $2::uuid, $3, $4::uuid, $5, 'feature_flag', $6,
             $7, $8::jsonb, $9::jsonb, $10::jsonb)`,
    [
      input.context.requestId,
      actorAccountId(input.context.actor),
      input.context.actor.type,
      input.scope.kind === "organization" ? input.scope.id : null,
      input.action,
      input.targetId,
      input.context.reason,
      input.before ?? null,
      input.after ?? null,
      { scope: input.scope },
    ],
  );
}
