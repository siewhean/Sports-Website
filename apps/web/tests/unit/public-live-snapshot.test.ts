import { describe, expect, it } from "vitest";
import { liveConnection, liveContactTimeoutMs } from "@/lib/public-live-snapshot";
import { liveStatusText } from "@/components/phase2/PublicLiveStatus";

describe("connection status", () => {
  const base = { enabled: true, online: true, lastContactAt: 1_000, lastSyncedAt: 1_000, now: 2_000 };

  it("is live only with recent contact", () => {
    expect(liveConnection(base)).toBe("live");
    expect(liveConnection({ ...base, now: 1_000 + liveContactTimeoutMs + 1 })).toBe("reconnecting");
    expect(liveConnection({ ...base, lastSyncedAt: null })).toBe("connecting");
    expect(liveConnection({ ...base, online: false })).toBe("offline");
    expect(liveConnection({ ...base, enabled: false })).toBe("paused");
  });

  it("shows one honest label and never 'reconnecting' for a finished competition", () => {
    expect(liveStatusText("live", "live", "10:05")).toEqual({ tone: "live", text: "Live · updated 10:05" });
    expect(liveStatusText("reconnecting", "live", "10:05").text).toBe("Reconnecting… showing results from 10:05");
    expect(liveStatusText("reconnecting", "completed", "10:05")).toEqual({ tone: "idle", text: "Updated 10:05" });
    expect(liveStatusText("offline", "upcoming", "10:05").tone).toBe("warn");
  });
});
