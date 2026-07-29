import type { Phase3SportCode } from "./phase-3.js";

export type GateCFallbackParticipant = Readonly<{
  entry_id: string | null;
  display_name: string;
}>;

export type GateCScheduleExportMatch = Readonly<{
  match_id: string;
  division_id: string;
  division_name: string;
  match_code: string;
  stage: string;
  home: GateCFallbackParticipant;
  away: GateCFallbackParticipant;
  starts_at: string;
  ends_at: string;
  playing_area: string;
}>;

export type GateCScheduleFallbackRequest = Readonly<{
  competition_id: string;
  competition_name: string;
  sport_code: Phase3SportCode;
  timezone: string;
  schedule_version: number;
  result_version: number;
  generated_at: string;
  public_verification_url: string;
  source_fingerprint: string;
  matches: readonly GateCScheduleExportMatch[];
}>;

export type GateCScheduleFallbackDocument = Readonly<{
  schema_version: 1;
  document_type: "schedule_pdf";
  competition_id: string;
  competition_name: string;
  sport_code: Phase3SportCode;
  timezone: string;
  schedule_version: number;
  result_version: number;
  generated_at: string;
  public_verification_url: string;
  source_fingerprint: string;
  filename: string;
  divisions: readonly Readonly<{
    division_id: string;
    division_name: string;
    matches: readonly GateCScheduleExportMatch[];
  }>[];
}>;

export type GateCScoreSheetSectionKind =
  | "periods"
  | "segments"
  | "quarters"
  | "discipline"
  | "timeouts"
  | "incidents"
  | "officials"
  | "signatures";

export type GateCScoreSheetSection = Readonly<{
  kind: GateCScoreSheetSectionKind;
  label: string;
  columns: readonly string[];
  repeatable: boolean;
}>;

export type GateCEmergencyScoreSheetRequest = Readonly<{
  competition_id: string;
  competition_name: string;
  sport_code: Phase3SportCode;
  timezone: string;
  schedule_version: number;
  result_version: number;
  generated_at: string;
  source_fingerprint: string;
  sheet_identifier: string;
  match: GateCScheduleExportMatch;
}>;

export type GateCEmergencyScoreSheet = Readonly<{
  schema_version: 1;
  document_type: "emergency_score_sheet";
  competition_id: string;
  competition_name: string;
  sport_code: Phase3SportCode;
  timezone: string;
  schedule_version: number;
  result_version: number;
  generated_at: string;
  source_fingerprint: string;
  sheet_identifier: string;
  filename: string;
  match: GateCScheduleExportMatch;
  sections: readonly GateCScoreSheetSection[];
}>;

export type GateCFallbackManifestEntry = Readonly<{
  document_type: "schedule_pdf" | "emergency_score_sheet";
  path: string;
  sha256: string;
  size_bytes: number;
}>;

export type GateCFallbackExportManifest = Readonly<{
  schema_version: 1;
  artifact_kind: "gate-c-c4-fallback-export-manifest";
  competition_id: string;
  schedule_version: number;
  result_version: number;
  generated_at: string;
  generator_version: string;
  source_fingerprint: string;
  files: readonly GateCFallbackManifestEntry[];
  manifest_fingerprint_input: string;
}>;
