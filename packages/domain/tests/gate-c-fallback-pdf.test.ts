import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildEmergencyScoreSheet,
  buildScheduleFallbackDocument,
  renderEmergencyScoreSheetPdf,
  renderScheduleFallbackPdf,
  type FallbackMatch,
} from "../src/index.js";

const fingerprint = "a".repeat(64);

function match(index: number): FallbackMatch {
  return {
    matchId: `match-${index}`,
    divisionId: index % 2 === 0 ? "division-women" : "division-open",
    divisionName: index % 2 === 0 ? "Women" : "Open",
    matchCode: `M${index}`,
    stage: index > 24 ? "Knockout stage" : "Group stage",
    home: { entryId: `entry-${index}-home`, displayName: `Home Team ${index}` },
    away: { entryId: `entry-${index}-away`, displayName: `Away Team ${index}` },
    startsAt: `2026-08-${String(Math.floor((index - 1) / 12) + 1).padStart(2, "0")}T01:00:00.000Z`,
    endsAt: `2026-08-${String(Math.floor((index - 1) / 12) + 1).padStart(2, "0")}T01:30:00.000Z`,
    playingArea: `Court ${(index % 4) + 1}`,
  };
}

function pdfText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe("Gate C C4 deterministic fallback PDF rendering", () => {
  it("renders an A4 schedule deterministically and paginates long events", () => {
    const document = buildScheduleFallbackDocument({
      competitionId: "competition-1",
      competitionName: "National Championship",
      sport: "canoe_polo",
      timezone: "Asia/Singapore",
      scheduleVersion: 4,
      resultVersion: 7,
      generatedAt: "2026-08-01T00:00:00.000Z",
      publicVerificationUrl: "https://example.test/competitions/national-championship",
      sourceFingerprint: fingerprint,
      matches: Array.from({ length: 36 }, (_, index) => match(index + 1)),
    });

    const first = renderScheduleFallbackPdf(document);
    const second = renderScheduleFallbackPdf(document);
    const text = pdfText(first);

    expect(second).toEqual(first);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/MediaBox [0 0 595 842]");
    expect(text).toContain("Published competition schedule");
    expect(text).toContain("Schedule v4 | Results v7");
    expect(text).toContain("%%EOF");
    expect([...text.matchAll(/\/Type \/Page\b/gu)]).toHaveLength(2);
    expect(createHash("sha256").update(first).digest("hex")).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("renders sport-specific emergency score sheets without private data", () => {
    for (const sport of ["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"] as const) {
      const sheet = buildEmergencyScoreSheet({
        competitionId: "competition-1",
        competitionName: "National Championship",
        sport,
        timezone: "Asia/Singapore",
        scheduleVersion: 4,
        resultVersion: 7,
        generatedAt: "2026-08-01T00:00:00.000Z",
        sourceFingerprint: fingerprint,
        sheetIdentifier: `sheet-${sport}`,
        match: match(1),
      });
      const bytes = renderEmergencyScoreSheetPdf(sheet);
      const text = pdfText(bytes);

      expect(text.startsWith("%PDF-1.4")).toBe(true);
      expect(text).toContain("Emergency match score sheet");
      expect(text).toContain(`Sheet ID: sheet-${sport}`);
      expect(text).not.toMatch(/bearer|cookie|password|secret|#access=/iu);
    }
  });

  it("normalises unsupported glyphs instead of emitting invalid font data", () => {
    const document = buildScheduleFallbackDocument({
      competitionId: "competition-1",
      competitionName: "Café 国际 Cup",
      sport: "badminton",
      timezone: "Asia/Singapore",
      scheduleVersion: 1,
      resultVersion: 1,
      generatedAt: "2026-08-01T00:00:00.000Z",
      publicVerificationUrl: "https://example.test/competition",
      sourceFingerprint: fingerprint,
      matches: [match(1)],
    });

    const text = pdfText(renderScheduleFallbackPdf(document));
    expect(text).toContain("Cafe ?? Cup");
  });
});
