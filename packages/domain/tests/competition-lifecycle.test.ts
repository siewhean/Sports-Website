import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPETITION_AUTO_COMPLETE_GRACE_MS,
  DEFAULT_LIVE_MATCH_STALE_AFTER_MS,
  HOUR_MS,
  competitionScheduleEndsAt,
  isCompetitionScheduleElapsed,
  isLiveMatchStale,
  liveMatchStaleCutoff,
} from "../src/index.js";

describe("competition schedule end", () => {
  it("ends at local midnight after the final day in the competition timezone", () => {
    // 21 Sep 2026 00:00 in Singapore (UTC+8) is 20 Sep 16:00 UTC.
    expect(competitionScheduleEndsAt("2026-09-20", "Asia/Singapore").toISOString()).toBe("2026-09-20T16:00:00.000Z");
    // 21 Sep 2026 00:00 in Los Angeles (PDT, UTC-7) is 07:00 UTC.
    expect(competitionScheduleEndsAt("2026-09-20", "America/Los_Angeles").toISOString()).toBe(
      "2026-09-21T07:00:00.000Z",
    );
    expect(competitionScheduleEndsAt("2026-12-31", "UTC").toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("handles a DST transition on the day after the final day", () => {
    // Europe/London leaves BST on 25 Oct 2026 at 02:00; midnight is still BST (UTC+1).
    expect(competitionScheduleEndsAt("2026-10-24", "Europe/London").toISOString()).toBe("2026-10-24T23:00:00.000Z");
    // The next midnight is GMT.
    expect(competitionScheduleEndsAt("2026-10-25", "Europe/London").toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });

  it("uses the first existing minute when local midnight is skipped", () => {
    // America/Santiago springs forward at 00:00 on 6 Sep 2026 (00:00 -> 01:00, UTC-4 -> UTC-3).
    expect(competitionScheduleEndsAt("2026-09-05", "America/Santiago").toISOString()).toBe("2026-09-06T04:00:00.000Z");
  });

  it("rejects malformed dates and unknown timezones", () => {
    expect(() => competitionScheduleEndsAt("2026-02-30", "UTC")).toThrow(/not a valid civil date/);
    expect(() => competitionScheduleEndsAt("20-09-2026", "UTC")).toThrow(/YYYY-MM-DD/);
    expect(() => competitionScheduleEndsAt("2026-09-20", "Mars/Olympus")).toThrow(/Invalid IANA time zone/);
  });
});

describe("competition auto-completion boundary", () => {
  const endsOn = "2026-09-20";
  const timeZone = "Asia/Singapore";
  const endsAt = Date.parse("2026-09-20T16:00:00.000Z");

  it("defaults to a 24 hour grace period", () => {
    expect(DEFAULT_COMPETITION_AUTO_COMPLETE_GRACE_MS).toBe(24 * HOUR_MS);
  });

  it("is not elapsed during the final day or within the grace period", () => {
    expect(isCompetitionScheduleElapsed({ endsOn, timeZone, now: Date.parse("2026-09-20T15:59:59.999Z") })).toBe(false);
    expect(isCompetitionScheduleElapsed({ endsOn, timeZone, now: endsAt + 24 * HOUR_MS - 1 })).toBe(false);
  });

  it("is elapsed exactly at the end of the grace period and afterwards", () => {
    expect(isCompetitionScheduleElapsed({ endsOn, timeZone, now: endsAt + 24 * HOUR_MS })).toBe(true);
    expect(isCompetitionScheduleElapsed({ endsOn, timeZone, now: new Date("2026-10-09T00:00:00Z") })).toBe(true);
  });

  it("evaluates the boundary in the competition timezone, not UTC", () => {
    const now = Date.parse("2026-09-21T10:00:00.000Z");
    // Singapore ended 18h earlier; Los Angeles ended 3h earlier.
    expect(isCompetitionScheduleElapsed({ endsOn, timeZone: "Asia/Singapore", now, graceMs: 12 * HOUR_MS })).toBe(true);
    expect(isCompetitionScheduleElapsed({ endsOn, timeZone: "America/Los_Angeles", now, graceMs: 12 * HOUR_MS })).toBe(
      false,
    );
  });

  it("supports a zero grace period and rejects invalid durations", () => {
    expect(isCompetitionScheduleElapsed({ endsOn, timeZone, now: endsAt, graceMs: 0 })).toBe(true);
    expect(() => isCompetitionScheduleElapsed({ endsOn, timeZone, now: endsAt, graceMs: -1 })).toThrow(/Grace/);
    expect(() => isCompetitionScheduleElapsed({ endsOn, timeZone, now: Number.NaN })).toThrow(/Current time/);
  });
});

describe("stale live match", () => {
  const now = Date.parse("2026-10-09T12:00:00.000Z");

  it("defaults to six hours without scoring activity", () => {
    expect(DEFAULT_LIVE_MATCH_STALE_AFTER_MS).toBe(6 * HOUR_MS);
    expect(liveMatchStaleCutoff(now).toISOString()).toBe("2026-10-09T06:00:00.000Z");
  });

  it("is stale at or beyond the window and live inside it", () => {
    expect(isLiveMatchStale({ lastActivityAt: now - 6 * HOUR_MS, now })).toBe(true);
    expect(isLiveMatchStale({ lastActivityAt: new Date("2026-09-20T08:00:00Z"), now })).toBe(true);
    expect(isLiveMatchStale({ lastActivityAt: now - 6 * HOUR_MS + 1, now })).toBe(false);
    expect(isLiveMatchStale({ lastActivityAt: now - HOUR_MS, now, staleAfterMs: 30 * 60_000 })).toBe(true);
  });
});
