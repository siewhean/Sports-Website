/**
 * PDPA data-retention policy. Every period is configurable through the environment; the defaults
 * below are the schedule published in the privacy policy (packages/ui/src/legal.ts) and must be
 * changed together with it.
 */
export type RetentionPolicy = {
  enabled: boolean;
  /** Expired or revoked sign-in sessions, expired recovery requests. */
  sessionDays: number;
  /** Scoring-access attempt / rate-limit evidence. */
  scoringAttemptDays: number;
  /** In-app notifications and the queued/delivered email copies that hang off them. */
  notificationDays: number;
  /** Stripe webhook receipts (idempotency + raw payload). */
  billingReceiptDays: number;
  /** Identity-provider back-channel event de-duplication records. */
  providerEventDays: number;
  /** Casual games that were never claimed by an account. */
  anonymousCasualGameDays: number;
  intervalMinutes: number;
  batchSize: number;
};

type NumericKey = Exclude<keyof RetentionPolicy, "enabled">;
type Spec = { env: string; key: NumericKey; min: number; max: number };

const specs: readonly Spec[] = [
  { env: "PDPA_RETENTION_SESSION_DAYS", key: "sessionDays", min: 1, max: 3650 },
  { env: "PDPA_RETENTION_SCORING_ATTEMPT_DAYS", key: "scoringAttemptDays", min: 7, max: 3650 },
  { env: "PDPA_RETENTION_NOTIFICATION_DAYS", key: "notificationDays", min: 7, max: 3650 },
  { env: "PDPA_RETENTION_BILLING_RECEIPT_DAYS", key: "billingReceiptDays", min: 90, max: 3650 },
  { env: "PDPA_RETENTION_PROVIDER_EVENT_DAYS", key: "providerEventDays", min: 7, max: 3650 },
  { env: "PDPA_RETENTION_CASUAL_ANON_DAYS", key: "anonymousCasualGameDays", min: 1, max: 3650 },
  { env: "PDPA_PURGE_INTERVAL_MINUTES", key: "intervalMinutes", min: 5, max: 10_080 },
  { env: "PDPA_PURGE_BATCH_SIZE", key: "batchSize", min: 10, max: 5_000 },
];

export const defaultRetentionPolicy: Readonly<RetentionPolicy> = Object.freeze({
  enabled: true,
  sessionDays: 30,
  scoringAttemptDays: 30,
  notificationDays: 180,
  billingReceiptDays: 400,
  providerEventDays: 90,
  anonymousCasualGameDays: 30,
  intervalMinutes: 360,
  batchSize: 500,
});

export function parseRetentionPolicy(source: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  const policy: RetentionPolicy = { ...defaultRetentionPolicy };
  const enabled = source.PDPA_PURGE_ENABLED?.trim().toLowerCase();
  if (enabled) {
    if (enabled !== "true" && enabled !== "false") throw new Error("PDPA_PURGE_ENABLED must be true or false");
    policy.enabled = enabled === "true";
  }
  for (const spec of specs) {
    const raw = source[spec.env]?.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
      throw new Error(`${spec.env} must be an integer between ${spec.min} and ${spec.max}`);
    }
    policy[spec.key] = value;
  }
  return policy;
}
