import { describe, it, expect } from "vitest";
import {
  assertOfflineMatchAuthorization,
  offlineRecordingAvailability,
  canReplayOfflineCommand,
} from "@matchday/domain";
import { createValidOfflineAuthorization } from "../helpers/fixtures";

describe("Tier 2 - Boundary 09: Offline Scoring Expiration & Queue Boundaries", () => {
  it("B09-T01: exactly 4.0 hours recording duration is valid; 4.0 hours + 1ms is rejected", () => {
    const base = Date.now();
    const exact4h = createValidOfflineAuthorization({
      authorized_at: new Date(base).toISOString(),
      recording_expires_at: new Date(base + 4 * 60 * 60 * 1_000).toISOString(),
      replay_expires_at: new Date(base + 4 * 60 * 60 * 1_000 + 5 * 60 * 1_000).toISOString(),
    });
    expect(() => assertOfflineMatchAuthorization(exact4h)).not.toThrow();

    const over4h = createValidOfflineAuthorization({
      authorized_at: new Date(base).toISOString(),
      recording_expires_at: new Date(base + 4 * 60 * 60 * 1_000 + 1).toISOString(), // 4h + 1ms!
    });
    expect(() => assertOfflineMatchAuthorization(over4h)).toThrow(
      "Offline authorization recording and replay windows are invalid",
    );
  });

  it("B09-T02: exactly 15.0 minutes replay grace is valid; 15.0 minutes + 1ms is rejected", () => {
    const base = Date.now();
    const exact15mGrace = createValidOfflineAuthorization({
      authorized_at: new Date(base).toISOString(),
      recording_expires_at: new Date(base + 2 * 60 * 60 * 1_000).toISOString(),
      replay_expires_at: new Date(base + 2 * 60 * 60 * 1_000 + 15 * 60 * 1_000).toISOString(),
    });
    expect(() => assertOfflineMatchAuthorization(exact15mGrace)).not.toThrow();

    const over15mGrace = createValidOfflineAuthorization({
      authorized_at: new Date(base).toISOString(),
      recording_expires_at: new Date(base + 2 * 60 * 60 * 1_000).toISOString(),
      replay_expires_at: new Date(base + 2 * 60 * 60 * 1_000 + 15 * 60 * 1_000 + 1).toISOString(),
    });
    expect(() => assertOfflineMatchAuthorization(over15mGrace)).toThrow(
      "Offline authorization recording and replay windows are invalid",
    );
  });

  it("B09-T03: queue threshold boundaries at 1799 (available), 1800 (warning), 1999 (warning), 2000 (full)", () => {
    const auth = createValidOfflineAuthorization();
    const now = Date.now();

    expect(offlineRecordingAvailability(auth, 0, now)).toBe("available");
    expect(offlineRecordingAvailability(auth, 1_799, now)).toBe("available");
    expect(offlineRecordingAvailability(auth, 1_800, now)).toBe("queue_warning");
    expect(offlineRecordingAvailability(auth, 1_999, now)).toBe("queue_warning");
    expect(offlineRecordingAvailability(auth, 2_000, now)).toBe("queue_full");
  });

  it("B09-T04: replay deadline boundary: canReplayOfflineCommand returns true at expiry - 1ms, false at expiry", () => {
    const auth = createValidOfflineAuthorization();
    const replayExpiryMs = Date.parse(auth.replay_expires_at);

    expect(canReplayOfflineCommand(auth, replayExpiryMs - 1)).toBe(true);
    expect(canReplayOfflineCommand(auth, replayExpiryMs)).toBe(false);
    expect(canReplayOfflineCommand(auth, replayExpiryMs + 1)).toBe(false);
  });

  it("B09-T05: pass deadline boundary: canReplayOfflineCommand returns true at pass_expiry - 1ms, false at pass_expiry", () => {
    const base = Date.now();
    const expiryTime = base + 2 * 60 * 60 * 1_000;
    const auth = createValidOfflineAuthorization({
      authorized_at: new Date(base).toISOString(),
      recording_expires_at: new Date(expiryTime).toISOString(),
      replay_expires_at: new Date(expiryTime + 10 * 60 * 1_000).toISOString(),
      pass_expires_at: new Date(expiryTime + 10 * 60 * 1_000).toISOString(), // Coincides with replay expiry
    });
    const passExpiryMs = Date.parse(auth.pass_expires_at);

    expect(canReplayOfflineCommand(auth, passExpiryMs - 1)).toBe(true);
    expect(canReplayOfflineCommand(auth, passExpiryMs)).toBe(false);
  });
});
