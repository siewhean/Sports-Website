import { describe, expect, it } from "vitest";
import {
  buildEmergencyScoreSheet,
  buildFallbackExportManifest,
  buildScheduleFallbackDocument,
  safeFallbackFilename,
  type EmergencyScoreSheetInput,
  type FallbackMatch,
  type FallbackSport,
  type ScheduleFallbackInput,
} from "../src/index.js";

const fingerprint = "a".repeat(64);

function match(matchId: string, overrides: Partial<FallbackMatch> = {}): FallbackMatch {
  return {
    matchId,
    divisionId: "division-open",
    divisionName: "Open",
    matchCode: matchId.toUpperCase(),
    stage: "Group stage",
    home: { entryId: "entry-home", displayName: "Home Team" },
    away: { entryId: "entry-away", displayName: "Away Team" },
    startsAt: "2026-08-01T01:00:00.000Z",
    endsAt: "2026-08-01T01:30:00.000Z",
    playingArea: "Court 1",
    ...overrides,
  };
}

function scheduleInput(overrides: Partial<ScheduleFallbackInput> = {}): ScheduleFallbackInput {
  return {
    competitionId: "competition-1",
    competitionName: "National Championship",
    sport: "canoe_polo",
    timezone: "Asia/Singapore",
    scheduleVersion: 4,
    resultVersion: 7,
    generatedAt: "2026-08-01T00:00:00.000Z",
    publicVerificationUrl: "https://example.test/competitions/national-championship",
    sourceFingerprint: fingerprint,
    matches: [match("match-1")],
    ...overrides,
  };
}

function scoreSheetInput(sport: FallbackSport): EmergencyScoreSheetInput {
  return {
    competitionId: "competition-1",
    competitionName: "National Championship",
    sport,
    timezone: "Asia/Singapore",
    scheduleVersion: 4,
    resultVersion: 7,
    generatedAt: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: fingerprint,
    sheetIdentifier: `sheet-${sport}`,
    match: match("match-1"),
  };
}

describe("Gate C C4 deterministic fallback exports", () => {
  it("groups and orders multi-division schedules deterministically", () => {
    const matches = [
      match("match-3", {
        divisionId: "division-women",
        divisionName: "Women",
        startsAt: "2026-08-01T02:00:00.000Z",
        endsAt: "2026-08-01T02:30:00.000Z",
      }),
      match("match-2", {
        startsAt: "2026-08-01T03:00:00.000Z",
        endsAt: "2026-08-01T03:30:00.000Z",
        playingArea: "Court 2",
      }),
      match("match-1"),
    ];
    const forward = buildScheduleFallbackDocument(scheduleInput({ matches }));
    const reversed = buildScheduleFallbackDocument(scheduleInput({ matches: [...matches].reverse() }));

    expect(reversed).toEqual(forward);
    expect(forward.divisions.map(({ divisionId }) => divisionId)).toEqual(["division-open", "division-women"]);
    expect(forward.divisions[0]?.matches.map(({ matchId }) => matchId)).toEqual(["match-1", "match-2"]);
    expect(forward.filename).toBe("national-championship-schedule-v4.pdf");
  });

  it("rejects duplicate matches malformed times and unsafe verification URLs", () => {
    expect(() =>
      buildScheduleFallbackDocument(scheduleInput({ matches: [match("match-1"), match("match-1")] })),
    ).toThrow(/Duplicate fallback match/);
    expect(() =>
      buildScheduleFallbackDocument(
        scheduleInput({ matches: [match("match-1", { endsAt: "2026-08-01T00:30:00.000Z" })] }),
      ),
    ).toThrow(/must end after/);
    expect(() =>
      buildScheduleFallbackDocument(scheduleInput({ publicVerificationUrl: "http://example.test/competition" })),
    ).toThrow(/credential-free HTTPS/);
    expect(() =>
      buildScheduleFallbackDocument(
        scheduleInput({ publicVerificationUrl: "https://user:password@example.test/competition" }),
      ),
    ).toThrow(/credential-free HTTPS/);
    expect(() =>
      buildScheduleFallbackDocument(
        scheduleInput({ publicVerificationUrl: "https://example.test/competition#access=x" }),
      ),
    ).toThrow(/credential-free HTTPS/);
  });

  it("defines sport-specific paper scoring structures for all five sports", () => {
    const expectations: Readonly<Record<FallbackSport, readonly string[]>> = {
      canoe_polo: ["periods", "discipline", "timeouts", "incidents", "officials", "signatures"],
      badminton: ["segments", "incidents", "officials", "signatures"],
      table_tennis: ["segments", "incidents", "officials", "signatures"],
      volleyball: ["segments", "timeouts", "incidents", "officials", "signatures"],
      basketball: ["quarters", "timeouts", "discipline", "incidents", "officials", "signatures"],
    };

    for (const sport of Object.keys(expectations) as FallbackSport[]) {
      const sheet = buildEmergencyScoreSheet(scoreSheetInput(sport));
      expect(sheet.sections.map(({ kind }) => kind)).toEqual(expectations[sport]);
      expect(sheet.filename).toContain("national-championship-match-1-sheet-");
      expect(sheet.match.home.displayName).toBe("Home Team");
    }
  });

  it("rejects unsafe sheet identifiers and secret-like public text", () => {
    expect(() => buildEmergencyScoreSheet({ ...scoreSheetInput("basketball"), sheetIdentifier: "../private" })).toThrow(
      /unsafe characters/,
    );
    expect(() =>
      buildEmergencyScoreSheet({
        ...scoreSheetInput("canoe_polo"),
        match: match("match-1", { home: { entryId: "entry-home", displayName: "Bearer abc.def.ghi" } }),
      }),
    ).toThrow(/forbidden data/);
  });

  it("builds order-independent manifests and rejects unsafe or duplicate paths", () => {
    const files = [
      {
        documentType: "emergency_score_sheet" as const,
        path: "score-sheets/match-1.pdf",
        sha256: "b".repeat(64),
        sizeBytes: 2500,
      },
      { documentType: "schedule_pdf" as const, path: "schedule.pdf", sha256: "c".repeat(64), sizeBytes: 5000 },
    ];
    const base = {
      competitionId: "competition-1",
      scheduleVersion: 4,
      resultVersion: 7,
      generatedAt: "2026-08-01T00:00:00.000Z",
      generatorVersion: "gate-c-c4-pdf-v1",
      sourceFingerprint: fingerprint,
    };
    const forward = buildFallbackExportManifest({ ...base, files });
    const reversed = buildFallbackExportManifest({ ...base, files: [...files].reverse() });

    expect(reversed).toEqual(forward);
    expect(forward.files.map(({ path }) => path)).toEqual(["schedule.pdf", "score-sheets/match-1.pdf"]);
    expect(forward.manifestFingerprintInput).toContain("gate-c-c4-fallback-export-manifest");

    expect(() => buildFallbackExportManifest({ ...base, files: [{ ...files[0]!, path: "../escape.pdf" }] })).toThrow(
      /unsafe/,
    );
    expect(() => buildFallbackExportManifest({ ...base, files: [files[0]!, files[0]!] })).toThrow(/Duplicate/);
    expect(() => buildFallbackExportManifest({ ...base, files: [{ ...files[0]!, sizeBytes: 0 }] })).toThrow(/size/);
  });

  it("normalises safe export filenames without directory components", () => {
    expect(safeFallbackFilename("  Hall 4 / Finals: Open  ")).toBe("hall-4-finals-open.pdf");
    expect(safeFallbackFilename("../../", "json")).toBe("matchday-export.json");
  });
});
