export type FeatureFlagAdminState =
  "ready" | "loading" | "empty" | "error" | "offline" | "conflict" | "permission" | "expired" | "revoked";

export type ScopeKind = "global" | "organization" | "competition" | "account";

export type FeatureFlagScopeDto =
  | { kind: "global" }
  | { kind: "organization"; id: string }
  | { kind: "competition"; id: string }
  | { kind: "account"; id: string };

export type FeatureFlagOverrideItem = Readonly<{
  id: string;
  key: string;
  scope: FeatureFlagScopeDto;
  value: unknown;
  reason: string;
  updatedBy: string | null;
  updatedAt: string;
}>;

export type FeatureFlagSummary = Readonly<{
  key: string;
  description: string;
  defaultValue: unknown;
  valueType: string;
  overridesCount: number;
  overrides: readonly FeatureFlagOverrideItem[];
}>;

export type FeatureFlagAuditEvent = Readonly<{
  id: string;
  request_id: string;
  actor_account_id: string | null;
  actor_type: string;
  organisation_id: string | null;
  action: string;
  target_type: string;
  target_id: string;
  reason: string | null;
  before_state: unknown;
  after_state: unknown;
  metadata: unknown;
  created_at: string;
}>;

export type FeatureFlagAdminDocument = Readonly<{
  state: FeatureFlagAdminState;
  canManage: boolean;
  flags: readonly FeatureFlagSummary[];
  activeFlagKey: string | null;
  activeFlagDetail?: FeatureFlagSummary | null;
  auditEvents?: readonly FeatureFlagAuditEvent[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function parseFeatureFlagOverride(value: unknown): FeatureFlagOverrideItem | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.key !== "string" ||
    !isRecord(value.scope) ||
    typeof value.scope.kind !== "string" ||
    typeof value.reason !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  const kind = value.scope.kind as ScopeKind;
  let scopeDto: FeatureFlagScopeDto;
  if (kind === "global") {
    scopeDto = { kind: "global" };
  } else if (kind === "organization" || kind === "competition" || kind === "account") {
    if (typeof value.scope.id !== "string") return null;
    scopeDto = { kind, id: value.scope.id };
  } else {
    return null;
  }

  return {
    id: value.id,
    key: value.key,
    scope: scopeDto,
    value: value.value,
    reason: value.reason,
    updatedBy: typeof value.updatedBy === "string" ? value.updatedBy : null,
    updatedAt: value.updatedAt,
  };
}

export function parseFeatureFlagSummary(value: unknown): FeatureFlagSummary | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.key !== "string" ||
    typeof value.description !== "string" ||
    typeof value.valueType !== "string" ||
    typeof value.overridesCount !== "number" ||
    !Array.isArray(value.overrides)
  ) {
    return null;
  }
  const overrides: FeatureFlagOverrideItem[] = [];
  for (const item of value.overrides) {
    const parsed = parseFeatureFlagOverride(item);
    if (!parsed) return null;
    overrides.push(parsed);
  }

  return {
    key: value.key,
    description: value.description,
    defaultValue: value.defaultValue,
    valueType: value.valueType,
    overridesCount: value.overridesCount,
    overrides,
  };
}

export function parseFeatureFlagList(value: unknown): readonly FeatureFlagSummary[] | null {
  if (!isRecord(value) || !Array.isArray(value.flags)) return null;
  const flags: FeatureFlagSummary[] = [];
  for (const item of value.flags) {
    const parsed = parseFeatureFlagSummary(item);
    if (!parsed) return null;
    flags.push(parsed);
  }
  return flags;
}

export function parseFeatureFlagAudit(value: unknown): readonly FeatureFlagAuditEvent[] | null {
  if (!isRecord(value) || !Array.isArray(value.events)) return null;
  const events: FeatureFlagAuditEvent[] = [];
  for (const item of value.events) {
    if (!isRecord(item)) return null;
    if (typeof item.id !== "string" || typeof item.action !== "string" || typeof item.created_at !== "string") {
      return null;
    }
    events.push({
      id: item.id,
      request_id: typeof item.request_id === "string" ? item.request_id : "",
      actor_account_id: typeof item.actor_account_id === "string" ? item.actor_account_id : null,
      actor_type: typeof item.actor_type === "string" ? item.actor_type : "system",
      organisation_id: typeof item.organisation_id === "string" ? item.organisation_id : null,
      action: item.action,
      target_type: typeof item.target_type === "string" ? item.target_type : "feature_flag",
      target_id: typeof item.target_id === "string" ? item.target_id : "",
      reason: typeof item.reason === "string" ? item.reason : null,
      before_state: item.before_state,
      after_state: item.after_state,
      metadata: item.metadata,
      created_at: item.created_at,
    });
  }
  return events;
}

export const featureFlagAdminMachine = {
  put: "PUT" as const,
  delete: "DELETE" as const,
  applicationJson: "application/json" as const,
  conflict: "conflict" as const,
  permission: "permission" as const,
  expired: "expired" as const,
  revoked: "revoked" as const,
  offline: "offline" as const,
  error: "error" as const,
  empty: "empty" as const,
  ready: "ready" as const,
  expiredCode: "EXPIRED" as const,
  revokedCode: "REVOKED" as const,
  inactiveCode: "INACTIVE" as const,
  globalKind: "global" as const,
  orgKind: "organization" as const,
  compKind: "competition" as const,
  accountKind: "account" as const,
  trueValue: "true" as const,
  falseValue: "false" as const,
  actionPut: "put" as const,
  actionDelete: "delete" as const,
  notFoundCode: "FEATURE_FLAG_NOT_FOUND" as const,
  requestInvalid: "REQUEST_INVALID" as const,
  validationError: "VALIDATION_ERROR" as const,
  requestBodyRequired: "Request body required" as const,
  validationMessage: "scope, value, and reason (>=3 chars) are required" as const,
  validationDeleteMessage: "scope and reason (>=3 chars) are required" as const,
} as const;

export const featureFlagAdminCopy = {
  brandMark: "M",
  brandTitle: "MATCHDAY ADMIN",
  brandSubtitle: "PLATFORM CONTROL PLANE",
  pageTitle: "Feature flag administration",
  pageIntro: "Manage scoped runtime overrides, inspect effective values, and review audit history without deployment.",
  searchPlaceholder: "Search flags…",
  defaultPrefix: "Default: ",
  overrideSuffixSingular: " override",
  overrideSuffixPlural: " overrides",
  scopeLabel: "Target scope",
  scopeIdLabel: "Target scope ID (UUID)",
  scopeIdPlaceholder: "00000000-0000-0000-0000-000000000000",
  effectiveStateLabel: "Effective state:",
  setOverrideValueLabel: "Set override value",
  activeOverridesTitle: "Active overrides",
  noActiveOverrides: "No active overrides stored for this flag.",
  scopeColumn: "Scope",
  valueColumn: "Value",
  reasonColumn: "Reason",
  updatedAtColumn: "Updated At",
  actionColumn: "Action",
  targetColumn: "Target",
  actorColumn: "Actor",
  timestampColumn: "Timestamp",
  saveSuccess: "Feature flag override saved successfully",
  deleteSuccess: "Feature flag override removed successfully",
  saveFailed: "Failed to save feature flag override",
  deleteFailed: "Failed to remove feature flag override",
  scopeGlobal: "Global (Platform)",
  scopeOrg: "Organisation",
  scopeComp: "Competition",
  scopeAccount: "Account",
  statusRegistryDefault: "REGISTRY DEFAULT",
  statusInherited: "INHERITED VALUE",
  statusExplicitOverride: "EXPLICIT OVERRIDE",
  valueTrue: "Enabled (true)",
  valueFalse: "Disabled (false)",
  saveOverride: "Save override",
  removeOverride: "Remove override",
  reasonLabel: "Reason for change (mandatory, minimum 3 characters)",
  reasonPlaceholder: "Explain why this flag override is being changed or removed…",
  dangerousConfirmTitle: "Confirm high-impact flag mutation",
  dangerousConfirmWarning:
    "This mutation affects platform-global behavior. Review the changes below before confirming.",
  flagLabel: "Flag key",
  oldValueLabel: "Previous value",
  newValueLabel: "New value",
  confirmButton: "Confirm mutation",
  cancelButton: "Cancel",
  auditHistoryTitle: "Audit history",
  noAuditEvents: "No audit events recorded for this flag.",
  conflictTitle: "Concurrent modification detected",
  conflictBody: "The override was updated by another administrator.authoritative state has been reloaded.",
  conflictAction: "Review updated state and re-submit",
  permissionTitle: "Platform administrator authority required",
  permissionBody: "Only authenticated users with the platform_admin role can inspect and mutate feature flags.",
  errorTitle: "Unable to load feature flags",
  errorBody: "An unexpected error occurred while communicating with the administration API.",
  offlineTitle: "Administration service offline",
  offlineBody: "Could not connect to the API server. Check your network connection.",
  emptyTitle: "No feature flags found",
  emptyBody: "No feature flags are registered in the current system registry.",
} as const;
