import { SPORT_PACKS, validateSportPack, type SportId, type SportPack } from "@matchday/domain";

export type SportPackAdminState =
  "ready" | "loading" | "empty" | "error" | "offline" | "conflict" | "permission" | "expired" | "revoked";

export type SportPackAdminVersion = Readonly<{
  sportCode: SportId;
  version: string;
  schemaVersion: number;
  definition: SportPack;
  definitionHash: string;
  status: "draft" | "active" | "superseded";
  revision: number;
  createdBy: string | null;
  createdAt: string;
  activatedBy: string | null;
  activatedAt: string | null;
  supersededAt: string | null;
  supersededBy: string | null;
  supersededByVersion: string | null;
  readOnly: true;
}>;

export type SportDefaultsAdminDocument = Readonly<{
  state: SportPackAdminState;
  canManage: boolean;
  activeSportId: SportId;
  versions: readonly SportPackAdminVersion[];
}>;

export type SportPackDraftReceipt = Readonly<{
  sportCode: SportId;
  version: string;
  schemaVersion: number;
  definitionHash: string;
  status: "draft";
  revision: number;
  createdBy: string;
  createdAt: string;
  idempotentReplay: boolean;
}>;

export type SportPackActivationReceipt = Readonly<{
  sportCode: SportId;
  version: string;
  schemaVersion: number;
  definitionHash: string;
  status: "active";
  revision: number;
  activatedBy: string;
  activatedAt: string;
  previousActiveVersion: string | null;
  idempotentReplay: boolean;
}>;

export type SportPackAdminIndex = Readonly<{
  sportCode: SportId;
  activeVersion: string | null;
  versions: readonly Readonly<{
    version: string;
    schemaVersion: number;
    definitionHash: string;
    status: "draft" | "active" | "superseded";
    revision: number;
    createdAt: string;
    activatedAt: string | null;
    supersededAt: string | null;
  }>[];
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function sportId(value: unknown): value is SportId {
  return typeof value === "string" && value in SPORT_PACKS;
}

function iso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function parseSportPackAdminRead(value: unknown): SportPackAdminVersion | null {
  const item = record(value);
  if (
    !item ||
    !exactKeys(item, [
      "sport_code",
      "version",
      "schema_version",
      "definition",
      "definition_hash",
      "status",
      "revision",
      "created_by",
      "created_at",
      "activated_by",
      "activated_at",
      "superseded_at",
      "superseded_by",
      "superseded_by_version",
      "read_only",
    ])
  )
    return null;
  if (
    !sportId(item.sport_code) ||
    typeof item.version !== "string" ||
    !item.version ||
    !Number.isSafeInteger(item.schema_version) ||
    (item.schema_version as number) < 1 ||
    !hash(item.definition_hash) ||
    !["draft", "active", "superseded"].includes(String(item.status)) ||
    !Number.isSafeInteger(item.revision) ||
    (item.revision as number) < 1 ||
    (item.created_by !== null && !uuid(item.created_by)) ||
    !iso(item.created_at) ||
    (item.activated_by !== null && !uuid(item.activated_by)) ||
    (item.activated_at !== null && !iso(item.activated_at)) ||
    (item.superseded_at !== null && !iso(item.superseded_at)) ||
    (item.superseded_by !== null && !uuid(item.superseded_by)) ||
    (item.superseded_by_version !== null &&
      (typeof item.superseded_by_version !== "string" || !item.superseded_by_version)) ||
    item.read_only !== true ||
    validateSportPack(item.definition).length > 0
  )
    return null;
  const definition = item.definition as SportPack;
  if (
    definition.sportId !== item.sport_code ||
    definition.version !== item.version ||
    definition.schemaVersion !== item.schema_version
  )
    return null;
  if ((item.status !== "draft") !== (item.activated_at !== null && item.activated_by !== null)) return null;
  if (
    (item.status === "superseded") !==
    (item.superseded_at !== null && item.superseded_by !== null && item.superseded_by_version !== null)
  )
    return null;
  return {
    sportCode: item.sport_code,
    version: item.version,
    schemaVersion: item.schema_version as number,
    definition,
    definitionHash: item.definition_hash,
    status: item.status as "draft" | "active" | "superseded",
    revision: item.revision as number,
    createdBy: item.created_by as string | null,
    createdAt: item.created_at as string,
    activatedBy: item.activated_by as string | null,
    activatedAt: item.activated_at as string | null,
    supersededAt: item.superseded_at as string | null,
    supersededBy: item.superseded_by as string | null,
    supersededByVersion: item.superseded_by_version as string | null,
    readOnly: true,
  };
}

export function parseSportPackDraftReceipt(value: unknown): SportPackDraftReceipt | null {
  const item = record(value);
  if (
    !item ||
    !exactKeys(item, [
      "sport_code",
      "version",
      "schema_version",
      "definition_hash",
      "status",
      "revision",
      "created_by",
      "created_at",
      "idempotent_replay",
    ])
  )
    return null;
  if (
    !sportId(item.sport_code) ||
    typeof item.version !== "string" ||
    !item.version ||
    !Number.isSafeInteger(item.schema_version) ||
    !hash(item.definition_hash) ||
    item.status !== "draft" ||
    !Number.isSafeInteger(item.revision) ||
    (item.revision as number) < 1 ||
    !uuid(item.created_by) ||
    !iso(item.created_at) ||
    typeof item.idempotent_replay !== "boolean"
  )
    return null;
  return {
    sportCode: item.sport_code,
    version: item.version,
    schemaVersion: item.schema_version as number,
    definitionHash: item.definition_hash,
    status: "draft",
    revision: item.revision as number,
    createdBy: item.created_by,
    createdAt: item.created_at,
    idempotentReplay: item.idempotent_replay,
  };
}

export function parseSportPackActivationReceipt(value: unknown): SportPackActivationReceipt | null {
  const item = record(value);
  if (
    !item ||
    !exactKeys(item, [
      "sport_code",
      "version",
      "schema_version",
      "definition_hash",
      "status",
      "revision",
      "activated_by",
      "activated_at",
      "previous_active_version",
      "idempotent_replay",
    ])
  )
    return null;
  if (
    !sportId(item.sport_code) ||
    typeof item.version !== "string" ||
    !item.version ||
    !Number.isSafeInteger(item.schema_version) ||
    !hash(item.definition_hash) ||
    item.status !== "active" ||
    !Number.isSafeInteger(item.revision) ||
    (item.revision as number) < 2 ||
    !uuid(item.activated_by) ||
    !iso(item.activated_at) ||
    (item.previous_active_version !== null &&
      (typeof item.previous_active_version !== "string" || !item.previous_active_version)) ||
    typeof item.idempotent_replay !== "boolean"
  )
    return null;
  return {
    sportCode: item.sport_code,
    version: item.version,
    schemaVersion: item.schema_version as number,
    definitionHash: item.definition_hash,
    status: "active",
    revision: item.revision as number,
    activatedBy: item.activated_by,
    activatedAt: item.activated_at,
    previousActiveVersion: item.previous_active_version as string | null,
    idempotentReplay: item.idempotent_replay,
  };
}

export function parseSportPackAdminIndex(value: unknown): SportPackAdminIndex | null {
  const item = record(value);
  if (
    !item ||
    !exactKeys(item, ["sport_code", "active_version", "versions"]) ||
    !sportId(item.sport_code) ||
    (item.active_version !== null && (typeof item.active_version !== "string" || !item.active_version)) ||
    !Array.isArray(item.versions)
  )
    return null;
  const versions = item.versions.map((value) => {
    const version = record(value);
    if (
      !version ||
      !exactKeys(version, [
        "version",
        "schema_version",
        "definition_hash",
        "status",
        "revision",
        "created_at",
        "activated_at",
        "superseded_at",
      ]) ||
      typeof version.version !== "string" ||
      !version.version ||
      !Number.isSafeInteger(version.schema_version) ||
      !hash(version.definition_hash) ||
      !["draft", "active", "superseded"].includes(String(version.status)) ||
      !Number.isSafeInteger(version.revision) ||
      (version.revision as number) < 1 ||
      !iso(version.created_at) ||
      (version.activated_at !== null && !iso(version.activated_at)) ||
      (version.superseded_at !== null && !iso(version.superseded_at))
    )
      return null;
    return {
      version: version.version,
      schemaVersion: version.schema_version as number,
      definitionHash: version.definition_hash,
      status: version.status as "draft" | "active" | "superseded",
      revision: version.revision as number,
      createdAt: version.created_at,
      activatedAt: version.activated_at as string | null,
      supersededAt: version.superseded_at as string | null,
    };
  });
  if (
    versions.some((version) => !version) ||
    versions.filter((version) => version?.status === "active").length > 1 ||
    (item.active_version === null) !== versions.every((version) => version?.status !== "active") ||
    (item.active_version !== null &&
      !versions.some((version) => version?.status === "active" && version.version === item.active_version))
  )
    return null;
  return {
    sportCode: item.sport_code,
    activeVersion: item.active_version as string | null,
    versions: versions as SportPackAdminIndex["versions"],
  };
}

export function nextDraftDefinition(source: SportPack, version: string): SportPack | null {
  const definition = { ...source, version };
  return validateSportPack(definition).length === 0 ? definition : null;
}

export const phase3AdminMachine = {
  post: "POST" as const,
  applicationJson: "application/json" as const,
  definitionKeys: ["definition"] as const,
  revisionKeys: ["revision"] as const,
  activationKeys: ["revision", "expected_active_version"] as const,
  requestInvalid: "REQUEST_INVALID" as const,
  invalidDraft: "Invalid sport-pack draft command",
  invalidActivation: "Invalid sport-pack activation command",
  conflict: "conflict" as const,
  permission: "permission" as const,
  expired: "expired" as const,
  revoked: "revoked" as const,
  offline: "offline" as const,
  error: "error" as const,
  empty: "empty" as const,
  ready: "ready" as const,
  draft: "draft" as const,
  active: "active" as const,
  superseded: "superseded" as const,
  save: "save" as const,
  activate: "activate" as const,
  expiredCode: "EXPIRED" as const,
  revokedCode: "REVOKED" as const,
  inactiveCode: "INACTIVE" as const,
} as const;

export const phase3AdminCopy = {
  active: "Active baseline",
  draft: "Draft baseline",
  immutable: "Version content is immutable after creation.",
  newVersion: "New version",
  newVersionHelp: "Use semantic versioning. Saving creates a new immutable draft from this definition.",
  draftSaved: "Draft created. Review it before activation.",
  activated: "Baseline activated. Existing competitions keep their pinned version.",
  saving: "Saving…",
  activating: "Activating…",
  activationTitle: "Version activation",
  activationReady: "This draft can become the product baseline for new competitions.",
  activeTruth: "This version is active and immutable. Existing competitions remain pinned to their saved version.",
  commandFailed: "The administration command failed. No success was recorded.",
  commandInvalid: "The administration service returned an invalid response.",
  expiredTitle: "Administrator session expired",
  expiredBody: "Sign in again before changing sport-pack defaults.",
  revokedTitle: "Administrator access was revoked",
  revokedBody: "This session no longer has platform-administrator authority.",
  conflictTitle: "Sport-pack version changed",
  conflictBody: "Reload the current revision before activating it.",
  revision: "Revision",
  definitionHash: "Definition hash",
  versionPlaceholder: "1.1.0",
} as const;
