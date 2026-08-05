import { describe, expect, it } from "vitest";
import { GateCC3LostResponseFence } from "../../scripts/gate-c-c3-lost-response-fence.js";

const eventA = "00000000-0000-4000-8000-000000000001";
const eventB = "00000000-0000-4000-8000-000000000002";

describe("Gate C3 lost-response transport fence", () => {
  it("drops one response, blocks recovery and accepts only the exact retry in the armed browser scope", () => {
    const fence = new GateCC3LostResponseFence();
    expect(fence.arm("device-a", eventA, 0)).toBe(true);
    expect(fence.handle({ scope: "device-b", path: "/api/scoring/session", now: 1 })).toBe("allow");
    expect(fence.handle({ scope: "device-a", path: "/api/scoring/events", clientEventId: eventA, now: 1 })).toBe(
      "drop_response",
    );
    expect(fence.handle({ scope: "device-a", path: "/api/scoring/session", now: 2 })).toBe("destroy");
    expect(fence.handle({ scope: "device-a", path: "/api/scoring/events", clientEventId: eventB, now: 2 })).toBe(
      "destroy",
    );
    expect(fence.handle({ scope: "device-a", path: "/api/scoring/events", clientEventId: eventA, now: 3 })).toBe(
      "allow",
    );
    expect(fence.handle({ scope: "device-a", path: "/api/scoring/session", now: 4 })).toBe("allow");
  });

  it("rejects malformed, duplicate and expired arming without affecting another scope", () => {
    const fence = new GateCC3LostResponseFence(10);
    expect(fence.arm("", eventA, 0)).toBe(false);
    expect(fence.arm("device-a", "not-a-uuid", 0)).toBe(false);
    expect(fence.arm("device-a", eventA, 0)).toBe(true);
    expect(fence.arm("device-a", eventB, 1)).toBe(false);
    expect(fence.hasActive("device-a", 9)).toBe(true);
    expect(fence.hasActive("device-a", 10)).toBe(false);
    expect(fence.handle({ scope: "device-a", path: "/api/scoring/events", clientEventId: eventA, now: 10 })).toBe(
      "allow",
    );
  });
});
