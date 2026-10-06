import type { Meter } from "@opentelemetry/api";

export type ScoringAccessHmacMetricRecorder = {
  rateLimit(input: {
    primaryVersion: string;
    acceptedVersionCount: number;
    operation: "assert" | "invalid" | "success";
  }): void;
  lifecycle(input: { keyVersion: string; action: "activated" | "verification_only" | "retired" }): void;
};

export const noopScoringAccessHmacMetrics: ScoringAccessHmacMetricRecorder = {
  rateLimit() {},
  lifecycle() {},
};

/** Bind only to this API runtime; recording must never alter scoring decisions. */
export function createScoringAccessHmacMetrics(meter: Meter): ScoringAccessHmacMetricRecorder {
  try {
    const rateLimitCounter = meter.createCounter("scoring_access_hmac_rate_limit_operations_total", {
      description: "Scoring access rate-limit operations by public HMAC key version and accepted-key count",
    });
    const lifecycleCounter = meter.createCounter("scoring_access_hmac_key_lifecycle_total", {
      description: "Scoring access HMAC key lifecycle transitions by public version",
    });
    return {
      rateLimit(input) {
        try {
          rateLimitCounter.add(1, {
            "scoring_access.hmac.primary_version": input.primaryVersion,
            "scoring_access.hmac.accepted_version_count": input.acceptedVersionCount,
            "scoring_access.hmac.operation": input.operation,
          });
        } catch {
          // Telemetry failure must not change rate-limit decisions.
        }
      },
      lifecycle(input) {
        try {
          lifecycleCounter.add(1, {
            "scoring_access.hmac.key_version": input.keyVersion,
            "scoring_access.hmac.lifecycle_action": input.action,
          });
        } catch {
          // Durable key state and audit records remain authoritative.
        }
      },
    };
  } catch {
    return noopScoringAccessHmacMetrics;
  }
}
