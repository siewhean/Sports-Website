import { describe, expect, it } from "vitest";
import { civilMinuteAtEpoch, resolveCivilMinute, createFormatter, parseDate, parseTime } from "../src/civil-time.js";

describe("Civil-Time Domain Utility", () => {
  it("resolves Singapore normal time and supports exact round-trip", () => {
    const civil = { date: "2026-10-01", time: "09:00" };
    const epochMs = resolveCivilMinute(civil, "Asia/Singapore");

    // Asia/Singapore is UTC+8: 09:00 local is 01:00 UTC
    const expectedUtc = Date.UTC(2026, 9, 1, 1, 0, 0, 0);
    expect(epochMs).toBe(expectedUtc);

    // Round-trip back to civil minute in Asia/Singapore
    const roundTrip = civilMinuteAtEpoch(epochMs, "Asia/Singapore");
    expect(roundTrip).toEqual({
      date: "2026-10-01",
      time: "09:00",
    });
  });

  it("is independent of host timezone", () => {
    // Both Singapore and New York times resolve deterministically to known UTC instants
    const sgCivil = { date: "2026-06-15", time: "14:30" };
    const sgEpoch = resolveCivilMinute(sgCivil, "Asia/Singapore");
    expect(sgEpoch).toBe(Date.UTC(2026, 5, 15, 6, 30, 0, 0));

    const nyCivil = { date: "2026-06-15", time: "10:30" };
    const nyEpoch = resolveCivilMinute(nyCivil, "America/New_York");
    // In June, NY is EDT (UTC-4): 10:30 EDT is 14:30 UTC
    expect(nyEpoch).toBe(Date.UTC(2026, 5, 15, 14, 30, 0, 0));

    expect(civilMinuteAtEpoch(sgEpoch, "Asia/Singapore")).toEqual(sgCivil);
    expect(civilMinuteAtEpoch(nyEpoch, "America/New_York")).toEqual(nyCivil);
  });

  it("rejects nonexistent spring-forward DST gap minute", () => {
    // In America/New_York on 2026-03-08, 02:00 springs forward to 03:00. 02:30 does not exist.
    expect(() => resolveCivilMinute({ date: "2026-03-08", time: "02:30" }, "America/New_York")).toThrowError(
      /does not exist in America\/New_York/,
    );
  });

  it("selects earlier instant for autumn repeated-time fold", () => {
    // In America/New_York on 2026-11-01, 01:30 repeats (first EDT at 05:30 UTC, then EST at 06:30 UTC)
    const epochMs = resolveCivilMinute({ date: "2026-11-01", time: "01:30" }, "America/New_York");
    const earlierUtc = Date.UTC(2026, 10, 1, 5, 30, 0, 0); // 01:30 EDT
    const laterUtc = Date.UTC(2026, 10, 1, 6, 30, 0, 0); // 01:30 EST

    expect(epochMs).toBe(earlierUtc);
    expect(epochMs).toBeLessThan(laterUtc);

    const civil = civilMinuteAtEpoch(epochMs, "America/New_York");
    expect(civil).toEqual({ date: "2026-11-01", time: "01:30" });
  });

  it("handles cross-midnight civil time representations", () => {
    // Window from 23:30 on 1 Oct to 01:00 on 2 Oct
    const startEpoch = resolveCivilMinute({ date: "2026-10-01", time: "23:30" }, "Asia/Singapore");
    const endEpoch = resolveCivilMinute({ date: "2026-10-02", time: "01:00" }, "Asia/Singapore");

    expect(endEpoch).toBeGreaterThan(startEpoch);
    expect(endEpoch - startEpoch).toBe(90 * 60 * 1000); // 90 minutes

    expect(civilMinuteAtEpoch(startEpoch, "Asia/Singapore")).toEqual({
      date: "2026-10-01",
      time: "23:30",
    });
    expect(civilMinuteAtEpoch(endEpoch, "Asia/Singapore")).toEqual({
      date: "2026-10-02",
      time: "01:00",
    });
  });

  it("rejects invalid civil date", () => {
    expect(() => resolveCivilMinute({ date: "2026-02-30", time: "10:00" }, "Asia/Singapore")).toThrowError(
      /not a valid civil date/,
    );

    expect(() => parseDate("invalid-date")).toThrowError(/must use YYYY-MM-DD/);
  });

  it("rejects invalid local time", () => {
    expect(() => resolveCivilMinute({ date: "2026-10-01", time: "25:00" }, "Asia/Singapore")).toThrowError(
      /not a valid local time/,
    );

    expect(() => parseTime("invalid-time")).toThrowError(/must use HH:mm/);
    expect(() => parseTime("12:60")).toThrowError(/not a valid local time/);
  });

  it("rejects invalid IANA timezone identifiers", () => {
    expect(() => createFormatter("Not/A_Real_Timezone")).toThrowError(/Invalid IANA time zone/);

    expect(() => resolveCivilMinute({ date: "2026-10-01", time: "10:00" }, "Invalid/Zone")).toThrowError(
      /Invalid IANA time zone/,
    );
  });
});
