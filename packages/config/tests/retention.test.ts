import { describe, expect, it } from "vitest";
import { defaultRetentionPolicy, parseRetentionPolicy } from "../src/retention.js";

describe("PDPA retention policy", () => {
  it("uses the documented defaults when nothing is configured", () => {
    expect(parseRetentionPolicy({})).toEqual(defaultRetentionPolicy);
    expect(defaultRetentionPolicy).toMatchObject({
      sessionDays: 30,
      scoringAttemptDays: 30,
      notificationDays: 180,
      billingReceiptDays: 400,
      providerEventDays: 90,
      anonymousCasualGameDays: 30,
    });
  });

  it("accepts overrides and the kill switch", () => {
    const policy = parseRetentionPolicy({
      PDPA_RETENTION_SESSION_DAYS: "14",
      PDPA_RETENTION_NOTIFICATION_DAYS: "365",
      PDPA_PURGE_ENABLED: "false",
    });
    expect(policy).toMatchObject({ sessionDays: 14, notificationDays: 365, enabled: false });
  });

  it.each([
    ["PDPA_RETENTION_SCORING_ATTEMPT_DAYS", "3"],
    ["PDPA_RETENTION_BILLING_RECEIPT_DAYS", "30"],
    ["PDPA_RETENTION_SESSION_DAYS", "1.5"],
    ["PDPA_PURGE_BATCH_SIZE", "abc"],
    ["PDPA_PURGE_ENABLED", "maybe"],
  ])("rejects unsafe %s=%s", (name, value) => {
    expect(() => parseRetentionPolicy({ [name]: value })).toThrow(name);
  });
});
