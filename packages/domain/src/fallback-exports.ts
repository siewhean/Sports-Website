import { assertPublicProjectionPrivacy } from "./public-truth.js";

export type FallbackSport = "canoe_polo" | "badminton" | "table_tennis" | "volleyball" | "basketball";

export type FallbackParticipant = Readonly<{
  entryId: string | null;
  displayName: string;
}>;

export type FallbackMatch = Readonly<{
  matchId: string;
  divisionId: string;
  divisionName: string;
  matchCode: string;
  stage: string;
  home: FallbackParticipant;
  away: FallbackParticipant;
  startsAt: string;
  endsAt: string;
  playingArea: string;
}>;

export type ScheduleFallbackInput = Readonly<{
  competitionId: string;
  competitionName: string;
  sport: FallbackSport;
  timezone: string;
  scheduleVersion: number;
  resultVersion: number;
  generatedAt: string;
  publicVerificationUrl: string;
  sourceFingerprint: string;
  matches: readonly FallbackMatch[];
}>;

export type ScheduleFallbackDocument = Readonly<{
  schemaVersion: 1;
  documentType: "schedule_pdf";
  competitionId: string;
  competitionName: string;
  sport: FallbackSport;
  timezone: string;
  scheduleVersion: number;
  resultVersion: number;
  generatedAt: string;
  publicVerificationUrl: string;
  sourceFingerprint: string;
  filename: string;
  divisions: readonly Readonly<{
    divisionId: string;
    divisionName: string;
    matches: readonly FallbackMatch[];
  }>[];
}>;

export type ScoreSheetSection = Readonly<{
  kind: "periods" | "segments" | "quarters" | "discipline" | "timeouts" | "incidents" | "officials" | "signatures";
  label: string;
  columns: readonly string[];
  repeatable: boolean;
}>;

export type EmergencyScoreSheetInput = Readonly<{
  competitionId: string;
  competitionName: string;
  sport: FallbackSport;
  timezone: string;
  scheduleVersion: number;
  resultVersion: number;
  generatedAt: string;
  sourceFingerprint: string;
  sheetIdentifier: string;
  match: FallbackMatch;
}>;

export type EmergencyScoreSheet = Readonly<{
  schemaVersion: 1;
  documentType: "emergency_score_sheet";
  competitionId: string;
  competitionName: string;
  sport: FallbackSport;
  timezone: string;
  scheduleVersion: number;
  resultVersion: number;
  generatedAt: string;
  sourceFingerprint: string;
  sheetIdentifier: string;
  filename: string;
  match: FallbackMatch;
  sections: readonly ScoreSheetSection[];
}>;

export type FallbackManifestEntry = Readonly<{
  documentType: "schedule_pdf" | "emergency_score_sheet";
  path: string;
  sha256: string;
  sizeBytes: number;
}>;

export type FallbackExportManifestInput = Readonly<{
  competitionId: string;
  scheduleVersion: number;
  resultVersion: number;
  generatedAt: string;
  generatorVersion: string;
  sourceFingerprint: string;
  files: readonly FallbackManifestEntry[];
}>;

export type FallbackExportManifest = Readonly<{
  schemaVersion: 1;
  artifactKind: "gate-c-c4-fallback-export-manifest";
  competitionId: string;
  scheduleVersion: number;
  resultVersion: number;
  generatedAt: string;
  generatorVersion: string;
  sourceFingerprint: string;
  files: readonly FallbackManifestEntry[];
  manifestFingerprintInput: string;
}>;

const sha256Pattern = /^[a-f0-9]{64}$/u;

const scoreSheetSections = Object.freeze({
  canoe_polo: Object.freeze([
    { kind: "periods", label: "Period score", columns: ["period", "home_goals", "away_goals"], repeatable: true },
    {
      kind: "discipline",
      label: "Cards and discipline",
      columns: ["time", "side", "person", "card", "reason"],
      repeatable: true,
    },
    { kind: "timeouts", label: "Timeouts", columns: ["time", "side", "period"], repeatable: true },
    { kind: "incidents", label: "Incidents and corrections", columns: ["time", "note"], repeatable: true },
    { kind: "officials", label: "Officials", columns: ["role", "name"], repeatable: true },
    { kind: "signatures", label: "Confirmation", columns: ["role", "name", "signature"], repeatable: false },
  ]),
  badminton: Object.freeze([
    { kind: "segments", label: "Games", columns: ["game", "home_points", "away_points", "winner"], repeatable: true },
    { kind: "incidents", label: "Incidents and corrections", columns: ["game", "note"], repeatable: true },
    { kind: "officials", label: "Officials", columns: ["role", "name"], repeatable: true },
    { kind: "signatures", label: "Confirmation", columns: ["role", "name", "signature"], repeatable: false },
  ]),
  table_tennis: Object.freeze([
    { kind: "segments", label: "Games", columns: ["game", "home_points", "away_points", "winner"], repeatable: true },
    { kind: "incidents", label: "Incidents and corrections", columns: ["game", "note"], repeatable: true },
    { kind: "officials", label: "Officials", columns: ["role", "name"], repeatable: true },
    { kind: "signatures", label: "Confirmation", columns: ["role", "name", "signature"], repeatable: false },
  ]),
  volleyball: Object.freeze([
    { kind: "segments", label: "Sets", columns: ["set", "home_points", "away_points", "winner"], repeatable: true },
    { kind: "timeouts", label: "Timeouts", columns: ["set", "side", "score"], repeatable: true },
    { kind: "incidents", label: "Incidents and corrections", columns: ["set", "note"], repeatable: true },
    { kind: "officials", label: "Officials", columns: ["role", "name"], repeatable: true },
    { kind: "signatures", label: "Confirmation", columns: ["role", "name", "signature"], repeatable: false },
  ]),
  basketball: Object.freeze([
    { kind: "quarters", label: "Quarter score", columns: ["quarter", "home_points", "away_points"], repeatable: true },
    { kind: "timeouts", label: "Timeouts", columns: ["quarter", "side", "game_clock"], repeatable: true },
    {
      kind: "discipline",
      label: "Fouls",
      columns: ["quarter", "side", "person", "foul", "game_clock"],
      repeatable: true,
    },
    { kind: "incidents", label: "Incidents and corrections", columns: ["quarter", "note"], repeatable: true },
    { kind: "officials", label: "Officials", columns: ["role", "name"], repeatable: true },
    { kind: "signatures", label: "Confirmation", columns: ["role", "name", "signature"], repeatable: false },
  ]),
} satisfies Readonly<Record<FallbackSport, readonly ScoreSheetSection[]>>);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Fallback export input contains an unsupported value");
  return serialized;
}

function nonBlank(value: string, label: string, maximum = 200): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > maximum) throw new Error(`${label} must contain 1-${maximum} characters`);
  return trimmed;
}

function positiveVersion(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function timestamp(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid timestamp`);
  return new Date(parsed).toISOString();
}

function sourceFingerprint(value: string): string {
  if (!sha256Pattern.test(value)) throw new Error("Fallback source fingerprint must be a lowercase SHA-256");
  return value;
}

export function safeFallbackFilename(value: string, extension: "pdf" | "json" = "pdf"): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
  return `${normalized || "matchday-export"}.${extension}`;
}

function verificationUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error("Public verification URL must be credential-free HTTPS without a fragment");
  }
  return parsed.toString();
}

function normalizeParticipant(participant: FallbackParticipant, label: string): FallbackParticipant {
  return {
    entryId: participant.entryId === null ? null : nonBlank(participant.entryId, `${label} entry ID`, 100),
    displayName: nonBlank(participant.displayName, `${label} display name`, 160),
  };
}

function normalizeMatch(match: FallbackMatch): FallbackMatch {
  const startsAt = timestamp(match.startsAt, `Match ${match.matchId} start`);
  const endsAt = timestamp(match.endsAt, `Match ${match.matchId} end`);
  if (Date.parse(endsAt) <= Date.parse(startsAt)) throw new Error(`Match ${match.matchId} must end after it starts`);
  const normalized: FallbackMatch = {
    matchId: nonBlank(match.matchId, "Match ID", 100),
    divisionId: nonBlank(match.divisionId, "Division ID", 100),
    divisionName: nonBlank(match.divisionName, "Division name", 160),
    matchCode: nonBlank(match.matchCode, "Match code", 60),
    stage: nonBlank(match.stage, "Match stage", 100),
    home: normalizeParticipant(match.home, "Home participant"),
    away: normalizeParticipant(match.away, "Away participant"),
    startsAt,
    endsAt,
    playingArea: nonBlank(match.playingArea, "Playing area", 160),
  };
  assertPublicProjectionPrivacy(normalized);
  return normalized;
}

function matchOrder(left: FallbackMatch, right: FallbackMatch): number {
  return (
    left.divisionName.localeCompare(right.divisionName) ||
    left.startsAt.localeCompare(right.startsAt) ||
    left.playingArea.localeCompare(right.playingArea) ||
    left.matchCode.localeCompare(right.matchCode) ||
    left.matchId.localeCompare(right.matchId)
  );
}

export function buildScheduleFallbackDocument(input: ScheduleFallbackInput): ScheduleFallbackDocument {
  const competitionId = nonBlank(input.competitionId, "Competition ID", 100);
  const competitionName = nonBlank(input.competitionName, "Competition name", 200);
  const generatedAt = timestamp(input.generatedAt, "Schedule generation time");
  const matches = input.matches.map(normalizeMatch).sort(matchOrder);
  const seen = new Set<string>();
  for (const match of matches) {
    if (seen.has(match.matchId)) throw new Error(`Duplicate fallback match ${match.matchId}`);
    seen.add(match.matchId);
  }
  const divisions = [...new Map(matches.map((match) => [match.divisionId, match.divisionName])).entries()]
    .map(([divisionId, divisionName]) => ({
      divisionId,
      divisionName,
      matches: matches.filter((match) => match.divisionId === divisionId),
    }))
    .sort(
      (left, right) =>
        left.divisionName.localeCompare(right.divisionName) || left.divisionId.localeCompare(right.divisionId),
    );
  const document: ScheduleFallbackDocument = {
    schemaVersion: 1,
    documentType: "schedule_pdf",
    competitionId,
    competitionName,
    sport: input.sport,
    timezone: nonBlank(input.timezone, "Timezone", 100),
    scheduleVersion: positiveVersion(input.scheduleVersion, "Schedule version"),
    resultVersion: positiveVersion(input.resultVersion, "Result version"),
    generatedAt,
    publicVerificationUrl: verificationUrl(input.publicVerificationUrl),
    sourceFingerprint: sourceFingerprint(input.sourceFingerprint),
    filename: safeFallbackFilename(`${competitionName}-schedule-v${input.scheduleVersion}`),
    divisions,
  };
  assertPublicProjectionPrivacy(document);
  return document;
}

export function buildEmergencyScoreSheet(input: EmergencyScoreSheetInput): EmergencyScoreSheet {
  const match = normalizeMatch(input.match);
  const sheetIdentifier = nonBlank(input.sheetIdentifier, "Score-sheet identifier", 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(sheetIdentifier)) {
    throw new Error("Score-sheet identifier contains unsafe characters");
  }
  const sheet: EmergencyScoreSheet = {
    schemaVersion: 1,
    documentType: "emergency_score_sheet",
    competitionId: nonBlank(input.competitionId, "Competition ID", 100),
    competitionName: nonBlank(input.competitionName, "Competition name", 200),
    sport: input.sport,
    timezone: nonBlank(input.timezone, "Timezone", 100),
    scheduleVersion: positiveVersion(input.scheduleVersion, "Schedule version"),
    resultVersion: positiveVersion(input.resultVersion, "Result version"),
    generatedAt: timestamp(input.generatedAt, "Score-sheet generation time"),
    sourceFingerprint: sourceFingerprint(input.sourceFingerprint),
    sheetIdentifier,
    filename: safeFallbackFilename(`${input.competitionName}-${match.matchCode}-${sheetIdentifier}`),
    match,
    sections: scoreSheetSections[input.sport].map((section) => ({ ...section, columns: [...section.columns] })),
  };
  assertPublicProjectionPrivacy(sheet);
  return sheet;
}

function manifestPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Fallback manifest path is unsafe: ${value}`);
  }
  return normalized;
}

export function buildFallbackExportManifest(input: FallbackExportManifestInput): FallbackExportManifest {
  const files = input.files
    .map((file) => ({
      documentType: file.documentType,
      path: manifestPath(file.path),
      sha256: sourceFingerprint(file.sha256),
      sizeBytes: file.sizeBytes,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) throw new Error(`Duplicate fallback manifest path ${file.path}`);
    seen.add(file.path);
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1) {
      throw new Error(`Fallback manifest size is invalid for ${file.path}`);
    }
  }
  const manifestBase = {
    schema_version: 1,
    artifact_kind: "gate-c-c4-fallback-export-manifest",
    competition_id: nonBlank(input.competitionId, "Competition ID", 100),
    schedule_version: positiveVersion(input.scheduleVersion, "Schedule version"),
    result_version: positiveVersion(input.resultVersion, "Result version"),
    generated_at: timestamp(input.generatedAt, "Manifest generation time"),
    generator_version: nonBlank(input.generatorVersion, "Generator version", 100),
    source_fingerprint: sourceFingerprint(input.sourceFingerprint),
    files: files.map((file) => ({
      document_type: file.documentType,
      path: file.path,
      sha256: file.sha256,
      size_bytes: file.sizeBytes,
    })),
  };
  const manifest: FallbackExportManifest = {
    schemaVersion: 1,
    artifactKind: "gate-c-c4-fallback-export-manifest",
    competitionId: manifestBase.competition_id,
    scheduleVersion: manifestBase.schedule_version,
    resultVersion: manifestBase.result_version,
    generatedAt: manifestBase.generated_at,
    generatorVersion: manifestBase.generator_version,
    sourceFingerprint: manifestBase.source_fingerprint,
    files,
    manifestFingerprintInput: stableJson(manifestBase),
  };
  assertPublicProjectionPrivacy(manifest);
  return manifest;
}
