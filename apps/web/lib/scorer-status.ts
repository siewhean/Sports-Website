import { interpolate, scorerMessages } from "@matchday/ui";

/**
 * The scorer's one status chip, in plain language. Derived from the access state, the offline queue and the
 * optimistic tap queue; order matters (someone else scoring outranks connectivity).
 */
export type ScorerStatusTone = "ok" | "busy" | "warn" | "blocked";

export type ScorerStatusInput = Readonly<{
  writerState: string;
  offlineState: string;
  online: boolean;
  /** Offline-stored commands plus optimistic taps not yet confirmed. */
  pendingCount: number;
  syncing: boolean;
}>;

export function scorerStatus(input: ScorerStatusInput): Readonly<{ tone: ScorerStatusTone; label: string }> {
  const status = scorerMessages.status;
  switch (input.writerState) {
    case "conflict":
    case "candidate":
    case "transferred":
      return { tone: "blocked", label: status.anotherPhone };
    case "read-only":
      return { tone: "blocked", label: status.readOnly };
    case "expired":
    case "revoked":
      return { tone: "blocked", label: status.ended };
    case "checking":
      return { tone: "busy", label: status.checking };
    case "rate-limited":
      return { tone: "warn", label: status.rateLimited };
    case "expiring":
      return { tone: "busy", label: status.reconnecting };
  }
  if (input.offlineState === "conflict" || input.offlineState === "read-only") {
    return { tone: "blocked", label: status.anotherPhone };
  }
  if (input.offlineState === "expired" || input.offlineState === "revoked")
    return { tone: "blocked", label: status.ended };
  if (input.offlineState === "storage-error") return { tone: "warn", label: status.storageProblem };
  if (input.offlineState === "reconnecting" || input.offlineState === "replaying") {
    return { tone: "busy", label: status.syncing };
  }
  // "pending-sync" while the browser is online means a replay is about to run, so that reads as syncing.
  const offline = !input.online || input.offlineState === "offline-recording";
  if (offline) {
    return input.pendingCount > 0
      ? { tone: "warn", label: interpolate(status.offlinePending, { count: input.pendingCount }) }
      : { tone: "warn", label: status.offline };
  }
  if (input.syncing || input.pendingCount > 0) return { tone: "busy", label: status.syncing };
  return { tone: "ok", label: status.online };
}

export type ScorerLinkTarget = Readonly<{ matchId: string | null; competitionId: string | null }>;

const linkIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

/**
 * The match or competition named by the scorer link (`/score?match=…` or `?competition=…`). A 12-digit code is
 * only accepted together with one of these, so without them the code box can never succeed.
 */
export function scorerLinkTarget(search: string): ScorerLinkTarget {
  const params = new URLSearchParams(search);
  const clean = (value: string | null) => {
    const trimmed = value?.trim() ?? "";
    return linkIdPattern.test(trimmed) ? trimmed : null;
  };
  return { matchId: clean(params.get("match")), competitionId: clean(params.get("competition")) };
}
