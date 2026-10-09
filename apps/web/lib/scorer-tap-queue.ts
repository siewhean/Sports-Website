import type { ScoringEventCommand } from "@/lib/phase2";
import type { ScoreControlAction } from "@/lib/five-sport-score-control-actions";

/**
 * Optimistic tap queue for the scorer screen.
 *
 * Taps are recorded locally straight away (the score moves on the next frame) and sent to the server one at a
 * time, in order. Each command's `expectedSequence` is the sequence of the previous acknowledged event, so a
 * concurrent writer surfaces as a sequence conflict instead of silently interleaving. A rejected tap is rolled
 * back together with every tap queued after it (their expected sequences were built on top of it).
 *
 * Pure and deterministic: PhoneScoring owns the network calls, this module owns the bookkeeping.
 */

export type TapCommand = Omit<ScoringEventCommand, "expectedSequence">;

export type QueuedTap = Readonly<{
  id: string;
  command: TapCommand;
  side: "home" | "away" | null;
  /** Signed effect on the side's score (a reversal carries the negated delta of its target). */
  scoreDelta: number;
  segmentNumber: number;
  label: string;
  status: "queued" | "sending" | "acknowledged";
  eventId?: string;
  sequence?: number;
  /** For an undo: the client event id of the tap being reversed. */
  undoOf?: string;
}>;

export type TapRollback = Readonly<{ count: number; reason: string }>;

export type TapQueueState = Readonly<{
  /** Latest sequence known to the server; the next command expects exactly this. */
  sequence: number;
  taps: readonly QueuedTap[];
  rolledBack: TapRollback | null;
}>;

export type TapQueueAction =
  | Readonly<{ type: "sync"; sequence: number }>
  | Readonly<{ type: "enqueue"; tap: Omit<QueuedTap, "status"> }>
  | Readonly<{ type: "cancel"; id: string }>
  | Readonly<{ type: "send"; id: string }>
  | Readonly<{ type: "acknowledged"; id: string; eventId: string; sequence: number }>
  | Readonly<{ type: "rejected"; reason: string }>
  | Readonly<{ type: "offloaded"; ids: readonly string[] }>
  | Readonly<{ type: "dismissRollback" }>;

export function emptyTapQueue(sequence = 0): TapQueueState {
  return { sequence, taps: [], rolledBack: null };
}

export function tapQueueReducer(state: TapQueueState, action: TapQueueAction): TapQueueState {
  switch (action.type) {
    case "sync": {
      // An authoritative session: acknowledged taps it already contains stop counting optimistically.
      const sending = state.taps.some((tap) => tap.status === "sending");
      return {
        ...state,
        sequence: sending ? Math.max(state.sequence, action.sequence) : action.sequence,
        taps: state.taps.filter(
          (tap) => tap.status !== "acknowledged" || (tap.sequence ?? Number.POSITIVE_INFINITY) > action.sequence,
        ),
      };
    }
    case "enqueue":
      if (state.taps.some((tap) => tap.id === action.tap.id)) return state;
      return { ...state, taps: [...state.taps, { ...action.tap, status: "queued" }] };
    case "cancel": {
      const target = state.taps.find((tap) => tap.id === action.id);
      if (!target || target.status !== "queued") return state;
      // Undoing a tap that never left the phone also drops an undo queued for it.
      return { ...state, taps: state.taps.filter((tap) => tap.id !== action.id && tap.undoOf !== action.id) };
    }
    case "send":
      return {
        ...state,
        taps: state.taps.map((tap) =>
          tap.id === action.id && tap.status === "queued" ? { ...tap, status: "sending" } : tap,
        ),
      };
    case "acknowledged":
      return {
        ...state,
        sequence: Math.max(state.sequence, action.sequence),
        taps: state.taps.map((tap) =>
          tap.id === action.id
            ? { ...tap, status: "acknowledged", eventId: action.eventId, sequence: action.sequence }
            : tap,
        ),
      };
    case "rejected": {
      const removed = state.taps.filter((tap) => tap.status !== "acknowledged");
      if (removed.length === 0) return state;
      return {
        ...state,
        taps: state.taps.filter((tap) => tap.status === "acknowledged"),
        rolledBack: { count: removed.length, reason: action.reason },
      };
    }
    case "offloaded": {
      const ids = new Set(action.ids);
      return { ...state, taps: state.taps.filter((tap) => !ids.has(tap.id)) };
    }
    case "dismissRollback":
      return state.rolledBack ? { ...state, rolledBack: null } : state;
  }
}

/** The next tap to send, or null while one is already in flight (one request at a time). */
export function nextTapToSend(state: TapQueueState): QueuedTap | null {
  if (state.taps.some((tap) => tap.status === "sending")) return null;
  return state.taps.find((tap) => tap.status === "queued") ?? null;
}

export function tapQueueIdle(state: TapQueueState): boolean {
  return !state.taps.some((tap) => tap.status === "queued" || tap.status === "sending");
}

export function unsentTapCount(state: TapQueueState): number {
  return state.taps.filter((tap) => tap.status !== "acknowledged").length;
}

/** Optimistic score delta for one side, optionally limited to a segment. */
export function optimisticDelta(state: TapQueueState, side: "home" | "away", segmentNumber?: number): number {
  return state.taps
    .filter((tap) => tap.side === side && (segmentNumber === undefined || tap.segmentNumber === segmentNumber))
    .reduce((total, tap) => total + tap.scoreDelta, 0);
}

export function withExpectedSequence(tap: QueuedTap, expectedSequence: number): ScoringEventCommand {
  return { ...tap.command, expectedSequence };
}

/**
 * One tap records the action straight away when nobody has to be named and the action is routine (points,
 * timeouts, team fouls). Anything that needs a player (goals, cards, player fouls) or ends a set/match keeps
 * the confirmation sheet.
 */
export function isOneTapAction(action: Pick<ScoreControlAction, "control" | "group">): boolean {
  if (action.control.participantAttribution === "required") return false;
  return action.group === "score" || action.group === "operational";
}
