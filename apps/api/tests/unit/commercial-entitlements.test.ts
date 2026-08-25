import { describe, expect, it } from "vitest";
import { getTierDefinition, isFeatureAllowed, assertEntryLimit, resolveBillingSummary } from "@matchday/domain";

describe("Commercial Entitlements & Billing Domain (BIL-001 through BIL-014)", () => {
  it("resolves free tier limits correctly (16 entries, no custom branding, 5 AI units)", () => {
    const def = getTierDefinition("free");
    expect(def.maxEntriesPerDivision).toBe(16);
    expect(def.customBrandingAllowed).toBe(false);
    expect(def.monthlyAiQuota).toBe(5);
    expect(isFeatureAllowed("free", "custom_branding")).toBe(false);
    expect(isFeatureAllowed("free", "ai_actions")).toBe(true);

    const limitCheck16 = assertEntryLimit("free", 16);
    expect(limitCheck16.allowed).toBe(true);

    expect(() => assertEntryLimit("free", 17)).toThrow();
  });

  it("resolves event_pass tier limits (unlimited entries, custom branding, 25 AI units)", () => {
    const def = getTierDefinition("event_pass");
    expect(def.maxEntriesPerDivision).toBe(Number.POSITIVE_INFINITY);
    expect(def.customBrandingAllowed).toBe(true);
    expect(def.monthlyAiQuota).toBe(25);
    expect(isFeatureAllowed("event_pass", "custom_branding")).toBe(true);
    expect(isFeatureAllowed("event_pass", "sponsor_placements")).toBe(true);

    const limitCheck100 = assertEntryLimit("event_pass", 100);
    expect(limitCheck100.allowed).toBe(true);
  });

  it("resolves organiser_pro tier limits (unlimited entries, 100 AI units)", () => {
    const def = getTierDefinition("organiser_pro");
    expect(def.monthlyAiQuota).toBe(100);
    expect(def.customBrandingAllowed).toBe(true);
    expect(isFeatureAllowed("organiser_pro", "export_advanced")).toBe(true);
  });

  it("calculates billing summary including top-ups and remaining quota", () => {
    const summary = resolveBillingSummary({
      organisationId: "11111111-1111-4111-8111-111111111111",
      tier: "event_pass",
      status: "active",
      usedAiUnits: 10,
      topUpAiUnits: 15,
    });

    expect(summary.tier).toBe("event_pass");
    expect(summary.ai_quota.limit).toBe(40); // 25 base + 15 top up
    expect(summary.ai_quota.used).toBe(10);
    expect(summary.ai_quota.remaining).toBe(30);
    expect(summary.custom_branding_allowed).toBe(true);
    expect(summary.unlimited_entries_allowed).toBe(true);
  });
});
