export type Phase3SportCode = "canoe_polo" | "badminton" | "table_tennis" | "volleyball" | "basketball";
export type Phase3CompetitionStatus = "draft" | "ready" | "published" | "live" | "completed" | "archived";

export type Phase3CompetitionView = {
  id: string;
  organisation_id: string;
  name: string;
  slug: string;
  sport_code: Phase3SportCode;
  status: Phase3CompetitionStatus;
  location: { venue: string; address: string; locality: string | null; country_code: string };
  starts_on: string;
  ends_on: string;
  timezone: string;
  locale: string;
  plan_tier: "free" | "organiser_pro" | "event_pass";
  revision: number;
};

export type Phase3EntryView = {
  id: string;
  division_id: string;
  name: string;
  entry_type: "team" | "individual" | "placeholder";
  status: "confirmed" | "active" | "withdrawn" | "replaced";
  seed: number | null;
  metadata: Record<string, unknown>;
  availability: Array<{ start: string; end: string }>;
  replacement_entry_id: string | null;
  replaces_entry_id: string | null;
  revision: number;
};

export type Phase3SettingsView = {
  competition_id: string;
  division_id: string | null;
  sport_code: Phase3SportCode;
  pack_schema_version: number;
  pack_version: string;
  recommended_snapshot: Record<string, unknown>;
  override: Record<string, unknown>;
  effective: Record<string, unknown>;
  mode: "recommended" | "customised";
  revision: number;
  definition_hash: string;
};

export type Phase3CapacityView = {
  competition_id: string;
  timeZone: string;
  slotMinutes: number;
  rawTotalSlots: number;
  fixedReserveSlots: number;
  availableMatchSlots: number;
  requiredMatchSlots: number;
  remainingMatchSlots: number;
  status: "comfortable" | "tight" | "does_not_fit";
  intervals: ReadonlyArray<Record<string, unknown>>;
  areas: ReadonlyArray<Record<string, unknown>>;
};

export type Phase3DivisionView = {
  id: string;
  competition_id: string;
  name: string;
  code: string | null;
  team_limit: 8 | 12 | 16 | 24 | 48;
  settings_override: Record<string, unknown>;
  revision: number;
};

export type Phase3CapacityMutation = {
  areas: Array<{
    name: string;
    sort_order?: number;
    slot_minutes: number;
    fixed_reserve_slots?: number;
    availability: Phase3CapacityWindow[];
    unavailable?: Phase3CapacityWindow[];
  }>;
};

export type Phase3CapacityWindow = {
  date: string;
  start_time: string;
  end_time: string;
  cross_midnight?: boolean;
};

export type Phase3SportDefaultView = {
  account_id: string;
  sport_code: Phase3SportCode;
  source_pack_version?: string;
  settings: Record<string, unknown> | null;
  updated_at?: string;
};

export type Phase3FormatRevisionView = {
  id: string;
  competition_id: string;
  division_id: string;
  revision: number;
  definition_hash: string;
  status: "draft" | "published" | "superseded";
  valid: boolean;
  issues: Array<{ code: string; path: string; message: string }>;
  deterministic_match_count: number;
};

export type Phase3StandingsSnapshotView = {
  id: string;
  competition_id: string;
  division_id: string;
  result_version: number;
  calculation_input_hash: string;
  standings: Record<string, unknown>;
  explanation: Record<string, unknown>;
};

export type Phase3ImportResult =
  | { ok: true; import_id: string; inserted: number; entries: Phase3EntryView[] }
  | {
      ok: false;
      errors: Array<{ row: number; path: string; code: string; message: string }>;
    };
