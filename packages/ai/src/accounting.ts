import type { Phase4AiAccountingDecision } from "@matchday/contracts";

export function decideAiActionAccounting(input: {
  outcome: "success" | "failure" | "manual_fallback";
  cacheStatus: "hit" | "miss" | "not_checked";
  valid: boolean;
}): Phase4AiAccountingDecision {
  if (input.outcome === "manual_fallback") return { charge: false, reason: "manual_fallback", units: 0 };
  if (input.outcome === "failure") return { charge: false, reason: "failed", units: 0 };
  if (!input.valid) return { charge: false, reason: "invalid", units: 0 };
  if (input.cacheStatus === "hit") return { charge: false, reason: "cached", units: 0 };
  if (input.cacheStatus !== "miss") return { charge: false, reason: "cache_unavailable", units: 0 };
  return { charge: true, reason: "successful_uncached_action", units: 1 };
}
