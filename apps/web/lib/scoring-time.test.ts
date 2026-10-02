import { describe, expect, it } from "vitest";
import { MAX_MANUAL_TIME_SECONDS, formatRecordedTime, parseRecordedTime, recordedElapsedSeconds } from "./scoring-time";

describe("recorded scoring time", () => {
  it("converts a countdown entry to canonical elapsed seconds", () => {
    expect(recordedElapsedSeconds("09:00", "remaining", 10)).toBe(60);
    expect(formatRecordedTime(60)).toBe("01:00");
  });

  it("rejects values outside the configured period", () => {
    expect(recordedElapsedSeconds("10:01", "remaining", 10)).toBeNull();
    expect(recordedElapsedSeconds("10:01", "elapsed", 10)).toBeNull();
    expect(recordedElapsedSeconds("09:00", "remaining", null)).toBeNull();
  });

  it("enforces canonical <= 3599 second boundary (59:59 accepted, 60:00 rejected)", () => {
    expect(MAX_MANUAL_TIME_SECONDS).toBe(3599);
    expect(parseRecordedTime("59:59")).toBe(3599);
    expect(parseRecordedTime("5959")).toBe(3599);
    expect(parseRecordedTime("60:00")).toBeNull();
    expect(parseRecordedTime("6000")).toBeNull();
    expect(parseRecordedTime("00:00")).toBe(0);

    // Elapsed mode at boundary
    expect(recordedElapsedSeconds("59:59", "elapsed", 60)).toBe(3599);
    expect(recordedElapsedSeconds("60:00", "elapsed", 60)).toBeNull();

    // Remaining mode exact period end
    // For standard period (e.g. 10m): 00:00 remaining is 600s elapsed (valid)
    expect(recordedElapsedSeconds("00:00", "remaining", 10)).toBe(600);

    // For 60m period: 00:00 remaining would be 3600s elapsed which exceeds 3599 limit,
    // so it is rejected to ensure no UI-valid value can predictably produce API 400
    expect(recordedElapsedSeconds("00:00", "remaining", 60)).toBeNull();
    expect(recordedElapsedSeconds("00:01", "remaining", 60)).toBe(3599);
  });
});
