import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScoringCommandPort } from "@/lib/phase2-scoring";
import {
  emptyTapQueue,
  isOneTapAction,
  nextTapToSend,
  optimisticDelta,
  tapQueueIdle,
  tapQueueReducer,
  unsentTapCount,
  withExpectedSequence,
  type QueuedTap,
  type TapQueueAction,
  type TapQueueState,
} from "@/lib/scorer-tap-queue";
import { scorerLinkTarget, scorerStatus } from "@/lib/scorer-status";
import type { ScorecardControl } from "@/lib/five-sport-scorecard";

function tap(id: string, side: "home" | "away" = "home", scoreDelta = 1, segmentNumber = 1): Omit<QueuedTap, "status"> {
  return {
    id,
    command: {
      clientEventId: id,
      matchId: "m1",
      eventType: "point",
      canonical: true,
      team: side,
      scorer: "",
      period: segmentNumber,
      segmentNumber,
      manualTime: "00:00",
    },
    side,
    scoreDelta,
    segmentNumber,
    label: "Point",
  };
}

function run(actions: TapQueueAction[], start: TapQueueState = emptyTapQueue(10)): TapQueueState {
  return actions.reduce(tapQueueReducer, start);
}

describe("optimistic tap queue", () => {
  it("moves the score immediately and sends one tap at a time with chained expected sequences", () => {
    let state = run([
      { type: "enqueue", tap: tap("a") },
      { type: "enqueue", tap: tap("b", "away") },
      { type: "enqueue", tap: tap("c") },
    ]);
    expect(optimisticDelta(state, "home")).toBe(2);
    expect(optimisticDelta(state, "away")).toBe(1);
    expect(unsentTapCount(state)).toBe(3);

    const first = nextTapToSend(state)!;
    expect(withExpectedSequence(first, state.sequence).expectedSequence).toBe(10);
    state = tapQueueReducer(state, { type: "send", id: first.id });
    // In-flight guard: nothing else is sent until the first answers.
    expect(nextTapToSend(state)).toBeNull();

    state = tapQueueReducer(state, { type: "acknowledged", id: "a", eventId: "e-a", sequence: 11 });
    const second = nextTapToSend(state)!;
    expect(second.id).toBe("b");
    expect(withExpectedSequence(second, state.sequence).expectedSequence).toBe(11);
    // Acknowledged but not yet reconciled taps still count, so the score never flickers back.
    expect(optimisticDelta(state, "home")).toBe(2);
  });

  it("drops acknowledged taps once the authoritative session includes them", () => {
    let state = run([
      { type: "enqueue", tap: tap("a") },
      { type: "send", id: "a" },
      { type: "acknowledged", id: "a", eventId: "e-a", sequence: 11 },
      { type: "enqueue", tap: tap("b") },
    ]);
    state = tapQueueReducer(state, { type: "sync", sequence: 11 });
    expect(state.taps.map((item) => item.id)).toEqual(["b"]);
    expect(state.sequence).toBe(11);
    expect(optimisticDelta(state, "home")).toBe(1);
  });

  it("rolls back the rejected tap and everything queued after it, with a clear reason", () => {
    const state = run([
      { type: "enqueue", tap: tap("a") },
      { type: "send", id: "a" },
      { type: "acknowledged", id: "a", eventId: "e-a", sequence: 11 },
      { type: "enqueue", tap: tap("b") },
      { type: "enqueue", tap: tap("c", "away") },
      { type: "send", id: "b" },
      { type: "rejected", reason: "the score changed on the server." },
    ]);
    expect(state.taps.map((item) => item.id)).toEqual(["a"]);
    expect(state.rolledBack).toEqual({ count: 2, reason: "the score changed on the server." });
    expect(optimisticDelta(state, "away")).toBe(0);
    expect(tapQueueIdle(state)).toBe(true);
    expect(tapQueueReducer(state, { type: "dismissRollback" }).rolledBack).toBeNull();
  });

  it("cancels an unsent tap (and its queued undo) without touching the server", () => {
    const state = run([
      { type: "enqueue", tap: tap("a") },
      { type: "enqueue", tap: { ...tap("u", "home", -1), undoOf: "a" } },
      { type: "cancel", id: "a" },
    ]);
    expect(state.taps).toEqual([]);
    const sending = run([
      { type: "enqueue", tap: tap("a") },
      { type: "send", id: "a" },
      { type: "cancel", id: "a" },
    ]);
    expect(sending.taps).toHaveLength(1);
  });

  it("keeps a sync from rewinding the sequence while a tap is in flight", () => {
    const state = run([
      { type: "enqueue", tap: tap("a") },
      { type: "send", id: "a" },
      { type: "sync", sequence: 9 },
    ]);
    expect(state.sequence).toBe(10);
  });

  it("hands taps to the offline queue and ignores duplicates", () => {
    const state = run([
      { type: "enqueue", tap: tap("a") },
      { type: "enqueue", tap: tap("a") },
      { type: "enqueue", tap: tap("b") },
      { type: "offloaded", ids: ["a"] },
    ]);
    expect(state.taps.map((item) => item.id)).toEqual(["b"]);
  });

  it("limits the optimistic delta to a segment for set-based sports", () => {
    const state = run([
      { type: "enqueue", tap: tap("a", "home", 1, 1) },
      { type: "enqueue", tap: tap("b", "home", 1, 2) },
    ]);
    expect(optimisticDelta(state, "home", 2)).toBe(1);
  });
});

describe("one-tap eligibility", () => {
  const control = (overrides: Partial<ScorecardControl>): ScorecardControl => ({
    id: "point",
    label: "Point",
    kind: "score",
    scoreDelta: 1,
    requiresSide: true,
    participantAttribution: "optional",
    reversible: true,
    ...overrides,
  });

  it("taps points and timeouts straight in, but keeps the sheet for goals, cards and match-ending actions", () => {
    expect(isOneTapAction({ control: control({}), group: "score" })).toBe(true);
    expect(
      isOneTapAction({
        control: control({ id: "timeout", kind: "operational", participantAttribution: "none" }),
        group: "operational",
      }),
    ).toBe(true);
    expect(
      isOneTapAction({ control: control({ id: "goal", participantAttribution: "required" }), group: "score" }),
    ).toBe(false);
    expect(
      isOneTapAction({
        control: control({ id: "red_card", participantAttribution: "required" }),
        group: "operational",
      }),
    ).toBe(false);
    expect(
      isOneTapAction({
        control: control({ id: "walkover", participantAttribution: "none" }),
        group: "exceptional_outcome",
      }),
    ).toBe(false);
    expect(
      isOneTapAction({
        control: control({ id: "set_completion", participantAttribution: "none" }),
        group: "segment_completion",
      }),
    ).toBe(false);
  });
});

describe("scorer status chip", () => {
  const base = { writerState: "active", offlineState: "online", online: true, pendingCount: 0, syncing: false };

  it("uses plain language for every state", () => {
    expect(scorerStatus(base).label).toBe("Online");
    expect(scorerStatus({ ...base, syncing: true }).label).toBe("Syncing…");
    expect(scorerStatus({ ...base, online: false, pendingCount: 3 }).label).toBe("Offline · 3 pending");
    expect(scorerStatus({ ...base, online: false }).label).toBe("Offline");
    expect(scorerStatus({ ...base, offlineState: "replaying" }).label).toBe("Syncing…");
    expect(scorerStatus({ ...base, writerState: "conflict" }).label).toBe("Another phone is scoring");
    expect(scorerStatus({ ...base, writerState: "transferred" }).label).toBe("Another phone is scoring");
    expect(scorerStatus({ ...base, writerState: "read-only" }).label).toBe("View only");
    for (const writerState of ["active", "conflict", "candidate", "read-only", "expired", "expiring", "checking"]) {
      expect(scorerStatus({ ...base, writerState }).label).not.toMatch(/canonical|writer|fenc|takeover|lease/iu);
    }
  });
});

describe("scorer screen source guards", () => {
  it("keeps the in-flight guard, never disables every control for a tap, and sends a default undo reason", async () => {
    const source = await readFile(new URL("../../components/phase2/PhoneScoring.tsx", import.meta.url), "utf8");
    expect(source).toContain("if (drainingRef.current) return;");
    expect(source).toContain(
      'commitTap({ type: "acknowledged", id: tap.id, eventId: receipt.eventId, sequence: receipt.sequence })',
    );
    expect(source).toContain('commitTap({ type: "rejected", reason })');
    // A tap never sets the global pending flag, so the other buttons stay live.
    const drain = source.slice(source.indexOf("const drainTapQueue = async"), source.indexOf("const tapAction = ("));
    expect(drain).not.toContain("setActionPending(true)");
    expect(source).toContain("reason: scorerMessages.undoReasonDefault");
    expect(source).toContain("typedReason || reversalPreset || scorerMessages.undoReasonDefault");
    expect(source).not.toMatch(/canonical events|Writer lease/iu);
  });
});

describe("fallback code is bound to the scorer link", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads match / competition from the link and rejects junk", () => {
    expect(scorerLinkTarget("?match=m-12")).toEqual({ matchId: "m-12", competitionId: null });
    expect(scorerLinkTarget("?competition=c1&match=")).toEqual({ matchId: null, competitionId: "c1" });
    expect(scorerLinkTarget("?match=%3Cscript%3E")).toEqual({ matchId: null, competitionId: null });
  });

  it("sends expected_match_id / expected_competition_id with a code exchange", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createScoringCommandPort("api").exchangeAccess({
        shortCode: "123456789012",
        device: { id: "d1", label: "Phone" },
        expectedMatchId: "m-12",
        expectedCompetitionId: "c1",
      }),
    ).rejects.toBeTruthy();
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).toMatchObject({ shortCode: "123456789012", expected_match_id: "m-12", expected_competition_id: "c1" });
  });

  it("shows plain guidance instead of a code box that cannot succeed", async () => {
    const source = await readFile(new URL("../../components/phase2/PhoneScoring.tsx", import.meta.url), "utf8");
    expect(source).toContain("{scorerMessages.codeNeedsLink}");
    expect(source).toContain("expectedMatchId: linkTarget.matchId");
  });
});
