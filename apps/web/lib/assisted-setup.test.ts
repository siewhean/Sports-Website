import { describe, expect, it } from "vitest";
import {
  ASSISTED_SETUP_DRAFT_KEY,
  ASSISTED_SETUP_DRAFT_MAX_AGE_MS,
  ASSISTED_SETUP_DRAFT_VERSION,
  estimateMatches,
  parseAssistedSetupDraft,
} from "./assisted-setup";

const now = Date.UTC(2026, 6, 17, 8);
const validDraft = {
  version: ASSISTED_SETUP_DRAFT_VERSION,
  savedAt: now - 1_000,
  activeStep: 5,
  competitionName: "Singapore Open 2026",
  startDate: "2026-08-14",
  endDate: "2026-08-16",
  venue: "National Stadium",
  teams: 8,
  divisions: 1,
  areas: 2,
  slotMinutes: 30,
  days: [{ label: "Saturday", opening: "08:00", closing: "18:00" }],
  areaAvailability: ["full", "limited"],
  unavailableMinutes: 60,
  settingsMode: "recommended",
  recommendation: "balanced",
  schedule: "balanced",
} as const;

describe("Assisted Setup match estimates", () => {
  it("uses the domain-backed canonical template metrics", () => {
    expect(estimateMatches(8, 1, "fast")).toBe(8);
    expect(estimateMatches(8, 1, "balanced")).toBe(16);
    expect(estimateMatches(8, 1, "depth")).toBe(18);
    expect(estimateMatches(24, 1, "depth")).toBe(58);
  });

  it("responds to format, team, and division inputs", () => {
    expect(estimateMatches(16, 1, "balanced")).toBe(32);
    expect(estimateMatches(16, 2, "balanced")).toBe(32);
    expect(estimateMatches(17, 2, "balanced")).toBe(30);
    expect(estimateMatches(8, 1, "depth")).not.toBe(estimateMatches(8, 1, "fast"));
  });

  it("does not invent an estimate for invalid entry inputs", () => {
    expect(estimateMatches(-8, 1, "balanced")).toBe(0);
    expect(estimateMatches(8, 0, "balanced")).toBe(0);
    expect(estimateMatches(2, 3, "balanced")).toBe(0);
    expect(estimateMatches(2, 2, "balanced")).toBe(0);
    expect(estimateMatches(513, 1, "balanced")).toBe(0);
  });
});

describe("Assisted Setup browser draft", () => {
  it("accepts a bounded, non-sensitive settings draft", () => {
    expect(ASSISTED_SETUP_DRAFT_KEY).toBe("matchday.assisted-setup.draft.v1");
    expect(parseAssistedSetupDraft(JSON.stringify(validDraft), now)).toEqual(validDraft);
  });

  it("rejects malformed, expired, and out-of-bounds drafts", () => {
    expect(parseAssistedSetupDraft("not-json", now)).toBeNull();
    expect(
      parseAssistedSetupDraft(
        JSON.stringify({ ...validDraft, savedAt: now - ASSISTED_SETUP_DRAFT_MAX_AGE_MS - 1 }),
        now,
      ),
    ).toBeNull();
    expect(parseAssistedSetupDraft(JSON.stringify({ ...validDraft, teams: 10_000 }), now)).toBeNull();
    expect(
      parseAssistedSetupDraft(JSON.stringify({ ...validDraft, participantNames: ["Private person"] }), now),
    ).toEqual(validDraft);
  });
});
