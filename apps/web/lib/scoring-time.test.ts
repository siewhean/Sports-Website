import { describe, expect, it } from "vitest";
import { formatRecordedTime, recordedElapsedSeconds } from "./scoring-time";

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
});
