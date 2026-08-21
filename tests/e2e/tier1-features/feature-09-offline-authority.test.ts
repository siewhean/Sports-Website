import { describe, it, expect } from "vitest";
import {
  assertOfflineMatchAuthorization,
  offlineRecordingAvailability,
  canReplayOfflineCommand,
  assertOfflineCommand,
  type OfflineMatchAuthorization,
} from "@matchday/domain";
import { createValidOfflineAuthorization, createValidOfflineEventCommand } from "../helpers/fixtures";

describe("Tier 1 - Feature 09: Server-Authoritative Offline Scoring Authority", () => {
  it("F09-T01: assertOfflineMatchAuthorization validates valid server-issued authorization package", () => {
    const auth = createValidOfflineAuthorization();
    expect(() => assertOfflineMatchAuthorization(auth)).not.toThrow();
  });

  it("F09-T02: assertOfflineMatchAuthorization rejects recording windows exceeding 4 hours", () => {
    const base = Date.now();
    const invalidAuth = createValidOfflineAuthorization({
      authorized_at: new Date(base).toISOString(),
      recording_expires_at: new Date(base + 4.5 * 60 * 60 * 1_000).toISOString(), // 4.5h > 4h
    });
    expect(() => assertOfflineMatchAuthorization(invalidAuth)).toThrow(
      "Offline authorization recording and replay windows are invalid",
    );
  });

  it("F09-T03: assertOfflineMatchAuthorization rejects replay windows exceeding 15m grace period", () => {
    const base = Date.now();
    const invalidAuth = createValidOfflineAuthorization({
      authorized_at: new Date(base).toISOString(),
      recording_expires_at: new Date(base + 2 * 60 * 60 * 1_000).toISOString(),
      replay_expires_at: new Date(base + 2 * 60 * 60 * 1_000 + 20 * 60 * 1_000).toISOString(), // +20m > 15m
    });
    expect(() => assertOfflineMatchAuthorization(invalidAuth)).toThrow(
      "Offline authorization recording and replay windows are invalid",
    );
  });

  it("F09-T04: offlineRecordingAvailability reports available, warning (1800), and full (2000) based on queue size", () => {
    const auth = createValidOfflineAuthorization();
    const now = Date.now();

    expect(offlineRecordingAvailability(auth, 100, now)).toBe("available");
    expect(offlineRecordingAvailability(auth, 1_799, now)).toBe("available");
    expect(offlineRecordingAvailability(auth, 1_800, now)).toBe("queue_warning");
    expect(offlineRecordingAvailability(auth, 1_999, now)).toBe("queue_warning");
    expect(offlineRecordingAvailability(auth, 2_000, now)).toBe("queue_full");
    expect(offlineRecordingAvailability(auth, 2_500, now)).toBe("queue_full");
  });

  it("F09-T05: canReplayOfflineCommand allows replay only while pass and replay windows are active", () => {
    const auth = createValidOfflineAuthorization();
    const now = Date.now();
    expect(canReplayOfflineCommand(auth, now)).toBe(true);

    // After replay expiration
    const replayExpired = Date.parse(auth.replay_expires_at) + 1_000;
    expect(canReplayOfflineCommand(auth, replayExpired)).toBe(false);

    // After pass expiration
    const passExpired = Date.parse(auth.pass_expires_at) + 1_000;
    expect(canReplayOfflineCommand(auth, passExpired)).toBe(false);
  });
});
