import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
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

describe("Gate C C4 deterministic fallback PDF rendering", () => {
  it("renders an A4 schedule deterministically and paginates long events", async () => {
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

    const first = await renderScheduleFallbackPdf(document);
    const second = await renderScheduleFallbackPdf(document);
    const parsed = await PDFDocument.load(first);
    const [firstPage] = parsed.getPages();

    expect(second).toEqual(first);
    expect(parsed.getPageCount()).toBe(2);
    expect(firstPage?.getWidth()).toBeCloseTo(595.28, 2);
    expect(firstPage?.getHeight()).toBeCloseTo(841.89, 2);
    expect(parsed.getTitle()).toBe("National Championship");
    expect(parsed.getCreationDate()?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(createHash("sha256").update(first).digest("hex")).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("renders sport-specific emergency score sheets without private data", async () => {
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
      const bytes = await renderEmergencyScoreSheetPdf(sheet);
      const parsed = await PDFDocument.load(bytes);
      const [firstPage] = parsed.getPages();

      expect(parsed.getPageCount()).toBeGreaterThan(0);
      expect(firstPage?.getWidth()).toBeCloseTo(595.28, 2);
      expect(firstPage?.getHeight()).toBeCloseTo(841.89, 2);
      expect(parsed.getTitle()).toBe("National Championship score sheet");
      expect(createHash("sha256").update(bytes).digest("hex")).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("normalises unsupported glyphs into a structurally valid PDF", async () => {
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

    const parsed = await PDFDocument.load(await renderScheduleFallbackPdf(document));
    expect(parsed.getTitle()).toBe("Cafe ?? Cup");
  });
});
