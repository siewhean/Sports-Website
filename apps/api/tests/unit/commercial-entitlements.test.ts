import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PostgresJsSql } from "@matchday/identity";
import { getTierDefinition, isFeatureAllowed, assertEntryLimit, resolveBillingSummary } from "@matchday/domain";
import { EntitlementRuntime, verifyStripeWebhookSignature } from "../../src/entitlement-runtime.js";

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

  it("verifies webhook signatures with timing-safe HMAC-SHA256 and strict tolerance", () => {
    const secret = "whsec_production_secret_test_1234567890";
    const payload = JSON.stringify({ id: "evt_123", type: "checkout.session.completed" });
    const now = Math.floor(Date.now() / 1000);
    const timestamp = now.toString();
    const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
    const validHeader = `t=${timestamp},v1=${signature}`;

    // 1. Valid signature
    expect(verifyStripeWebhookSignature(validHeader, payload, secret, 300, now)).toBe(true);

    // 2. Invalid signature value
    expect(
      verifyStripeWebhookSignature(`t=${timestamp},v1=bad_hex_signature_deadbeef`, payload, secret, 300, now),
    ).toBe(false);

    // 3. Missing signature
    expect(verifyStripeWebhookSignature(undefined, payload, secret)).toBe(false);
    expect(verifyStripeWebhookSignature("", payload, secret)).toBe(false);
    expect(verifyStripeWebhookSignature("malformed-header-without-v1", payload, secret)).toBe(false);

    // 4. Missing secret (fails closed)
    expect(verifyStripeWebhookSignature(validHeader, payload, undefined)).toBe(false);
    expect(verifyStripeWebhookSignature(validHeader, payload, "")).toBe(false);

    // 5. Expired timestamp (> 300 seconds old)
    const expiredTimestamp = (now - 305).toString();
    const expiredSig = createHmac("sha256", secret).update(`${expiredTimestamp}.${payload}`).digest("hex");
    const expiredHeader = `t=${expiredTimestamp},v1=${expiredSig}`;
    expect(verifyStripeWebhookSignature(expiredHeader, payload, secret, 300, now)).toBe(false);

    // 6. Future timestamp beyond tolerance
    const futureTimestamp = (now + 305).toString();
    const futureSig = createHmac("sha256", secret).update(`${futureTimestamp}.${payload}`).digest("hex");
    const futureHeader = `t=${futureTimestamp},v1=${futureSig}`;
    expect(verifyStripeWebhookSignature(futureHeader, payload, secret, 300, now)).toBe(false);

    // 7. Body tampering
    const tamperedPayload = JSON.stringify({ id: "evt_123", type: "checkout.session.completed", extra: "injected" });
    expect(verifyStripeWebhookSignature(validHeader, tamperedPayload, secret, 300, now)).toBe(false);

    // 8. Rejection of legacy hardcoded signatures
    expect(verifyStripeWebhookSignature("development-signature", payload, secret)).toBe(false);
    expect(verifyStripeWebhookSignature("test-valid-signature", payload, secret)).toBe(false);
  });

  it("prevents IDOR: rejects branding mutation if competition does not belong to organisation", async () => {
    const mockSql = {
      unsafe: (async (query: string) => {
        if (query.includes("FROM competitions")) {
          // competition belongs to org-2, not org-1
          return [{ organisation_id: "org-2" }];
        }
        if (query.includes("FROM organisation_memberships")) {
          return [{ "?column?": 1 }];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new EntitlementRuntime(mockSql);
    const actor = { accountId: "acc-1" };

    await expect(runtime.setBranding(actor, "org-1", "comp-1", { primary_color: "#112233" })).rejects.toThrow(
      /Competition not found/,
    );
  });

  it("enforces custom_branding entitlement when custom colors are set", async () => {
    const mockSql = {
      unsafe: (async (query: string) => {
        if (query.includes("FROM competitions")) {
          return [{ organisation_id: "org-1" }];
        }
        if (query.includes("FROM organisation_memberships")) {
          return [{ "?column?": 1 }];
        }
        if (query.includes("FROM organisation_subscriptions")) {
          // free tier
          return [{ tier: "free", status: "active" }];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new EntitlementRuntime(mockSql);
    const actor = { accountId: "acc-1" };

    await expect(runtime.setBranding(actor, "org-1", "comp-1", { primary_color: "#112233" })).rejects.toThrow(
      /Feature 'custom_branding' is not included/,
    );
  });

  it("creates structured checkout sessions with valid URLs and pricing", async () => {
    const mockSql = {
      unsafe: (async (query: string) => {
        if (query.includes("FROM organisation_memberships")) {
          return [{ "?column?": 1 }];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new EntitlementRuntime(mockSql);
    const actor = { accountId: "acc-1" };

    const session = await runtime.createCheckoutSession(actor, "org-1", {
      tier: "organiser_pro",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    expect(session.session_id).toMatch(/^cs_/);
    expect(session.checkout_url).toContain("https://checkout.stripe.com/c/pay/");
    expect(session.amount_total).toBe(9900);
    expect(session.currency).toBe("usd");
  });
});
