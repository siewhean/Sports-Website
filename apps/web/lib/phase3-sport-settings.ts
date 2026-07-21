import {
  SPORT_PACKS,
  validateSportPack,
  validateSportSettings,
  type SettingDefinition,
  type SettingValue,
  type SettingsMode,
  type SportId,
  type SportPackOverride,
  type SportPack,
  type SportPackSettings,
} from "@matchday/domain";

export type SportSettingsSurfaceState =
  "ready" | "loading" | "empty" | "error" | "offline" | "conflict" | "read-only" | "permission" | "unavailable";

export type SportSettingsContext = Readonly<{
  scope: "competition" | "division";
  competitionId: string;
  competitionName: string;
  divisionId?: string;
  divisionName?: string;
}>;

export type SportSettingsCapabilities = Readonly<{
  save: boolean;
  saveDefault: boolean;
  copyPrevious: boolean;
}>;

export type SportSettingsDocument = Readonly<{
  state: SportSettingsSurfaceState;
  context: SportSettingsContext;
  sportId: SportId;
  sportName: string;
  packSchemaVersion: number;
  packVersion: string;
  packStatus: "provisional_product_baseline";
  authority: "product_recommendation_not_federation_profile";
  definitions: Readonly<Record<string, SettingDefinition>>;
  recommended: SportPackSettings;
  effective: SportPackSettings;
  override: SportPackOverride;
  mode: SettingsMode;
  revision: number;
  definitionHash: string;
  packDefinition: SportPack;
  canEdit: boolean;
  capabilities: SportSettingsCapabilities;
}>;

export type SettingsSyncPresentation = Readonly<{
  label: string;
  state: "saved" | "local" | "unavailable" | "offline" | "conflict" | "read-only";
}>;

export type SaveSportSettingsInput = Readonly<{
  competitionId: string;
  divisionId?: string;
  packVersion: string;
  revision: number;
  override: SportPackOverride;
}>;

export type SportSettingsPort = Readonly<{
  readCompetition(competitionId: string): Promise<SportSettingsDocument>;
  readDivision(competitionId: string, divisionId: string): Promise<SportSettingsDocument>;
  save(input: SaveSportSettingsInput): Promise<SportSettingsDocument>;
  saveAsMyDefault(document: SportSettingsDocument): Promise<void>;
  copyPrevious(document: SportSettingsDocument, sourceCompetitionId: string): Promise<SportSettingsDocument>;
}>;

const responseKeys = new Set([
  "competition_id",
  "division_id",
  "sport_code",
  "pack_schema_version",
  "pack_version",
  "recommended_snapshot",
  "override",
  "effective",
  "mode",
  "revision",
  "pack_definition_hash",
  "pack_definition",
  "permission",
  "read_only",
  "organisation_id",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sameSettings(left: SportPackSettings, right: SportPackSettings): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]))
  );
}

export function parseSportSettingsResponse(
  payload: unknown,
  context: SportSettingsContext,
): SportSettingsDocument | null {
  if (
    !isRecord(payload) ||
    Object.keys(payload).length !== responseKeys.size ||
    Object.keys(payload).some((key) => !responseKeys.has(key))
  )
    return null;
  const sportId = payload.sport_code;
  if (typeof sportId !== "string" || !(sportId in SPORT_PACKS)) return null;
  if (!isRecord(payload.pack_definition) || validateSportPack(payload.pack_definition).length > 0) return null;
  const pack = payload.pack_definition as SportPack;
  if (
    payload.competition_id !== context.competitionId ||
    payload.division_id !== (context.divisionId ?? null) ||
    typeof payload.organisation_id !== "string" ||
    payload.organisation_id.length === 0 ||
    pack.sportId !== sportId ||
    payload.pack_schema_version !== pack.schemaVersion ||
    payload.pack_version !== pack.version ||
    typeof payload.pack_definition_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.pack_definition_hash) ||
    !Number.isInteger(payload.revision) ||
    (payload.revision as number) < 1 ||
    (payload.mode !== "recommended" && payload.mode !== "customised") ||
    (payload.permission !== "read" && payload.permission !== "write") ||
    typeof payload.read_only !== "boolean" ||
    !isRecord(payload.recommended_snapshot) ||
    !isRecord(payload.override) ||
    !isRecord(payload.effective)
  )
    return null;
  if ((payload.permission === "read") !== payload.read_only) return null;
  const recommended = payload.recommended_snapshot as SportPackSettings;
  const override = payload.override as SportPackOverride;
  const effective = payload.effective as SportPackSettings;
  if (
    validateSportSettings(pack, recommended).length > 0 ||
    validateSportSettings(pack, override, { partial: true }).length > 0 ||
    validateSportSettings(pack, effective).length > 0 ||
    !sameSettings({ ...recommended, ...override }, effective) ||
    settingsMode(effective, recommended) !== payload.mode
  )
    return null;
  const readOnly = payload.read_only;
  return {
    state: readOnly ? "read-only" : "ready",
    context,
    sportId: pack.sportId,
    sportName: pack.displayName,
    packSchemaVersion: pack.schemaVersion,
    packVersion: pack.version,
    packStatus: pack.status,
    authority: pack.authority,
    definitions: pack.settingsSchema,
    recommended,
    effective,
    override,
    mode: payload.mode,
    revision: payload.revision as number,
    definitionHash: payload.pack_definition_hash,
    packDefinition: pack,
    canEdit: !readOnly,
    capabilities: {
      save: !readOnly,
      saveDefault: !readOnly,
      copyPrevious: !readOnly && context.scope === "competition",
    },
  };
}

function sameValue(left: SettingValue | undefined, right: SettingValue | undefined): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

export function deriveSportSettingsOverride(
  values: SportPackSettings,
  recommended: SportPackSettings,
): SportPackOverride {
  const override: Record<string, SettingValue> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!sameValue(value, recommended[key])) override[key] = value;
  }
  return override;
}

export function validateSettingsDraft(pack: SportPack, values: SportPackSettings): Readonly<Record<string, string>> {
  const issues = validateSportSettings(pack, values);
  return Object.fromEntries(issues.map((issue) => [issue.path.replace(/^settings\./, ""), issue.message]));
}

export function settingsMode(values: SportPackSettings, recommended: SportPackSettings): SettingsMode {
  return Object.keys(deriveSportSettingsOverride(values, recommended)).length === 0 ? "recommended" : "customised";
}

export function displaySettingValue(value: SettingValue): string {
  if (Array.isArray(value)) return value.map(humaniseSettingOption).join(" → ");
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (value === null) return "Not set";
  return typeof value === "string" ? humaniseSettingOption(value) : String(value);
}

export function humaniseSettingOption(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export const phase3SettingsCopy = {
  brandMark: "M",
  brand: "MATCHDAY",
  eyebrow: "Sport settings",
  pageTitle: "Competition settings",
  pageIntro: "Set the versioned competition baseline, then review any division-specific overrides.",
  recommended: "Recommended",
  customised: "Customised",
  reset: "Reset to recommended",
  save: "Save settings",
  saveDefault: "Save as my default",
  copyPrevious: "Copy previous",
  competition: "Competition",
  division: "Division",
  provisional: "Provisional product baseline",
  noAuthority: "Product recommendation — not a federation profile",
  loadingSettings: "Loading settings",
  loadingSettingsBody: "Reading the saved version and recommendation.",
  emptyTitle: "No settings yet",
  emptyBody: "Choose a sport pack before configuring this competition.",
  errorTitle: "Settings could not be loaded",
  errorBody: "Try again. Your last saved version is unchanged.",
  offlineTitle: "You are offline",
  offlineBody: "Reconnect before changing versioned competition settings.",
  conflictTitle: "A newer version was saved",
  conflictBody: "Reload the current revision, then review your changes before saving again.",
  readOnlyTitle: "Settings are read-only",
  readOnlyBody: "This published revision is locked for editing.",
  permissionTitle: "You cannot edit these settings",
  permissionBody: "Ask an owner or organiser for access.",
  unavailableTitle: "This settings action is not available yet",
  unavailableBody: "The authenticated command has not been connected. No changes were saved.",
  settingsLevel: "Settings level",
  packVersion: "Pack version",
  savedRevision: "Saved revision",
  competitionSettings: "Competition baseline",
  divisionSettings: "settings",
  divisionScopeBody: "Changes apply only to this division.",
  competitionScopeBody: "These values become the baseline for every division.",
  saving: "Saving…",
  copying: "Copying…",
  unsaved: "Unsaved changes",
  saved: "All changes saved",
  localDraft: "Local draft — not saved",
  saveUnavailable: "Saving unavailable",
  commandsUnavailable: "Authenticated command unavailable",
  settingsTools: "Settings tools",
  recommendation: "Recommendation",
  recommendationTitle: "Start from the sport pack",
  recommendationBody:
    "Recommended values are editable product starting points. They do not claim federation compliance.",
  reuse: "Reuse",
  reuseTitle: "Carry settings forward",
  previousCompetition: "Previous competition",
  previousUnavailable: "Previous competition copying is not available",
  personal: "Personal starting point",
  personalTitle: "Use this setup next time",
  personalBody: "This saves a personal default. It does not change another competition or the product baseline.",
  booleanHelp: "Turn this setting on or off.",
  orderedHelp: "Order from first tie-break to last.",
  enumHelp: "Choose the value used for this settings level.",
  reload: "Reload current revision",
  loadingAria: "Loading sport settings",
  restoredAnnouncement: "Recommended settings restored. Save to apply them.",
  savedAnnouncement: "Settings saved as a new revision.",
  defaultAnnouncement: "These settings are now your personal default for this sport.",
  copiedAnnouncement: "Previous competition settings copied. Review before saving.",
  commandFailed: "The authenticated settings command failed. No success was recorded.",
  commandInvalid: "The settings service returned an invalid command response.",
  mostRecentCompatible: "Most recent compatible competition",
  internalDefaults: "Internal defaults",
  internalAdministration: "Internal administration",
  adminTitle: "Sport-pack defaults",
  adminIntro: "Review versioned product starting points before they are used by new competitions.",
  sportPacks: "Sport packs",
  draftBaseline: "Draft baseline",
  schema: "Schema",
  pack: "pack",
  saveDraft: "Save draft",
  edit: "Edit",
  activation: "Activation",
  activationUnavailable: "Runtime activation unavailable",
  activationBody:
    "This surface prepares a provisional draft. Activation will be enabled only after the audited admin command is available.",
  activate: "Activate baseline",
  authorityNote: "No federation or governing-body authority is implied.",
  adminPermissionTitle: "Defaults administration is restricted",
  adminPermissionBody: "Platform administrator permission is required.",
  adminReadOnlyTitle: "Defaults are read-only",
  adminReadOnlyBody: "No authenticated platform-admin command is available in this release.",
  adminErrorTitle: "Defaults could not be loaded",
  adminErrorBody: "The administration service did not return a valid response.",
  adminOfflineTitle: "Administration is offline",
  adminOfflineBody: "Reconnect before reviewing provisional defaults.",
  adminEmptyTitle: "No provisional packs found",
  adminEmptyBody: "There are no product baselines available to review.",
  unavailable: "Unavailable",
  loadingAdmin: "Loading sport-pack defaults",
  loadingCompetition: "Loading competition settings",
  savedRevisionLabel: "Saved revision",
  revisionLoaded: "Revision loaded",
  savingUnavailableStatus: "saving unavailable",
  readOnlyStatus: "read-only",
  conflictStatus: "Revision conflict",
  offlineStatus: "Offline — no changes saved",
  unavailableStatus: "Saving unavailable",
  loadingStatus: "Loading saved revision",
  accessUnavailableStatus: "Settings access unavailable",
  revisionUnavailableStatus: "Saved revision unavailable",
  emptyStatus: "No saved settings",
} as const;

export const phase3SettingsMachine = {
  section: "settings" as const,
  conflict: "conflict" as const,
  readOnly: "read-only" as const,
  save: "save" as const,
  copy: "copy" as const,
  default: "default" as const,
  up: "up" as const,
  down: "down" as const,
  unavailable: "unavailable" as const,
  empty: "empty" as const,
  permission: "permission" as const,
  offline: "offline" as const,
} as const;

export const phase3VisualMachine = {
  settings: "settings" as const,
  admin: "admin" as const,
} as const;

export const phase3CommandMachine = {
  put: "PUT" as const,
  post: "POST" as const,
  applicationJson: "application/json" as const,
  settingsKeys: ["pack_version", "revision", "override"] as const,
  defaultKeys: ["pack_version", "settings"] as const,
  requestInvalid: "REQUEST_INVALID" as const,
  invalidSettings: "Invalid settings command",
  invalidDefault: "Invalid default settings command",
} as const;

export function changedAnnouncement(label: string): string {
  return `${label} changed.`;
}

export function divisionSettingsTitle(name: string | undefined): string {
  return `${name ?? phase3SettingsCopy.division} ${phase3SettingsCopy.divisionSettings}`;
}

export function moveSettingLabel(option: string, direction: "up" | "down"): string {
  return `Move ${humaniseSettingOption(option)} ${direction}`;
}

export function integerRangeHelp(minimum: number, maximum: number): string {
  return `Allowed range: ${minimum}–${maximum}.`;
}

export function settingsSyncPresentation(document: SportSettingsDocument): SettingsSyncPresentation {
  switch (document.state) {
    case "ready":
      return document.capabilities.save
        ? { label: `${phase3SettingsCopy.savedRevisionLabel} ${document.revision}`, state: "saved" }
        : {
            label: `${phase3SettingsCopy.revisionLoaded} ${document.revision} · ${phase3SettingsCopy.savingUnavailableStatus}`,
            state: "unavailable",
          };
    case "read-only":
      return {
        label: `${phase3SettingsCopy.savedRevisionLabel} ${document.revision} · ${phase3SettingsCopy.readOnlyStatus}`,
        state: "read-only",
      };
    case "conflict":
      return { label: phase3SettingsCopy.conflictStatus, state: "conflict" };
    case "offline":
      return { label: phase3SettingsCopy.offlineStatus, state: "offline" };
    case "unavailable":
      return { label: phase3SettingsCopy.unavailableStatus, state: "unavailable" };
    case "loading":
      return { label: phase3SettingsCopy.loadingStatus, state: "local" };
    case "permission":
      return { label: phase3SettingsCopy.accessUnavailableStatus, state: "unavailable" };
    case "error":
      return { label: phase3SettingsCopy.revisionUnavailableStatus, state: "unavailable" };
    case "empty":
      return { label: phase3SettingsCopy.emptyStatus, state: "unavailable" };
  }
}

export function unavailableSettingLabel(label: string): string {
  return `${phase3SettingsCopy.edit} ${label} — ${phase3SettingsCopy.unavailable}`;
}
