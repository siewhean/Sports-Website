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

  it("creates real Stripe checkout session via configured provider client", async () => {
    const mockSql = {
      unsafe: (async (query: string) => {
        if (query.includes("FROM organisation_memberships")) {
          return [{ "?column?": 1 }];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const mockStripeClient = {
      createSession: async (params: {
        organisationId: string;
        tier: "event_pass" | "organiser_pro";
        topUpUnits?: number;
        successUrl: string;
        cancelUrl: string;
      }) => {
        return {
          sessionId: "cs_live_real_stripe_session_12345678",
          checkoutUrl: `https://checkout.stripe.com/c/pay/cs_live_real_stripe_session_12345678`,
          organisationId: params.organisationId,
          tier: params.tier,
          topUpUnits: params.topUpUnits ?? 0,
          amountTotal: params.tier === "organiser_pro" ? 9900 : 4900,
          currency: "usd",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          successUrl: params.successUrl,
          cancelUrl: params.cancelUrl,
        };
      },
    };

    const runtime = new EntitlementRuntime(mockSql, mockStripeClient);
    const actor = { accountId: "acc-1" };

    const session = await runtime.createCheckoutSession(actor, "org-1", {
      tier: "organiser_pro",
      topUpUnits: 5,
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    expect(session.session_id).toBe("cs_live_real_stripe_session_12345678");
    expect(session.checkout_url).toBe("https://checkout.stripe.com/c/pay/cs_live_real_stripe_session_12345678");
    expect(session.organisation_id).toBe("org-1");
    expect(session.tier).toBe("organiser_pro");
    expect(session.top_up_units).toBe(5);
    expect(session.amount_total).toBe(9900);
    expect(session.currency).toBe("usd");
  });

  it("fails safely with 503 when Stripe payment configuration is missing", async () => {
    const mockSql = {
      unsafe: (async (query: string) => {
        if (query.includes("FROM organisation_memberships")) {
          return [{ "?column?": 1 }];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtimeWithoutStripe = new EntitlementRuntime(mockSql, undefined);
    const actor = { accountId: "acc-1" };

    const originalKey = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;

    try {
      await expect(
        runtimeWithoutStripe.createCheckoutSession(actor, "org-1", {
          tier: "event_pass",
          successUrl: "https://example.com/success",
          cancelUrl: "https://example.com/cancel",
        }),
      ).rejects.toThrow(/Stripe payment provider is not configured/);
    } finally {
      if (originalKey !== undefined) {
        process.env.STRIPE_SECRET_KEY = originalKey;
      }
    }
  });

  // --- Stripe webhook metadata reading tests (BIL-015 through BIL-019) ---

  it("BIL-015: reads organisation_id from metadata.organisation_id not data.object root", async () => {
    const secret = "whsec_test_bil015";
    const now = Math.floor(Date.now() / 1000);
    const calls: string[] = [];

    const mockSql = {
      unsafe: (async (query: string) => {
        calls.push(query.trim().split("\n")[0]!);
        if (query.includes("billing_webhook_receipts") && query.includes("SELECT")) return [];
        if (query.includes("INSERT INTO billing_webhook_receipts")) return [];
        if (query.includes("INSERT INTO organisation_subscriptions")) return [];
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new EntitlementRuntime(mockSql);

    const payload = {
      id: "evt_bil015",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_abc",
          customer: "cus_abc",
          subscription: null,
          metadata: {
            organisation_id: "org-from-metadata",
            tier: "event_pass",
            top_up_units: "0",
          },
        },
      },
    };

    const rawPayload = JSON.stringify(payload);
    const ts = now.toString();
    const sig = createHmac("sha256", secret).update(`${ts}.${rawPayload}`).digest("hex");
    const header = `t=${ts},v1=${sig}`;

    const result = await runtime.processBillingWebhook(header, rawPayload, payload, secret);
    expect(result.processed).toBe(true);
    expect(result.eventType).toBe("checkout.session.completed");
    // Should have issued an INSERT into organisation_subscriptions
    expect(calls.some((c) => c.includes("INSERT INTO organisation_subscriptions"))).toBe(true);
  });

  it("BIL-016: reads tier from metadata.tier and parses top_up_units from string", async () => {
    const secret = "whsec_test_bil016";
    const now = Math.floor(Date.now() / 1000);
    const insertedGrants: unknown[][] = [];

    const mockSql = {
      unsafe: (async (query: string, params?: unknown[]) => {
        if (query.includes("billing_webhook_receipts") && query.includes("SELECT")) return [];
        if (query.includes("SELECT tier FROM organisation_subscriptions")) return [{ tier: "organiser_pro" }];
        if (query.includes("INSERT INTO entitlement_grants")) {
          insertedGrants.push(params ?? []);
          return [];
        }
        if (query.includes("INSERT INTO organisation_subscriptions")) return [];
        if (query.includes("INSERT INTO billing_webhook_receipts")) return [];
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new EntitlementRuntime(mockSql);

    const payload = {
      id: "evt_bil016",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_def",
          customer: "cus_def",
          subscription: "sub_def",
          metadata: {
            organisation_id: "org-bil016",
            tier: "organiser_pro",
            top_up_units: "10", // string, as Stripe always sends
          },
        },
      },
    };

    const rawPayload = JSON.stringify(payload);
    const ts = now.toString();
    const sig = createHmac("sha256", secret).update(`${ts}.${rawPayload}`).digest("hex");
    const header = `t=${ts},v1=${sig}`;

    await runtime.processBillingWebhook(header, rawPayload, payload, secret);

    // top_up_units "10" should be parsed to integer 10
    expect(insertedGrants.length).toBe(1);
    const grantParams = insertedGrants[0] as unknown[];
    expect(grantParams[0]).toBe("org-bil016");
    expect(grantParams[1]).toBe("organiser_pro");
    expect(grantParams[2]).toBe(10);
  });

  it("BIL-017: top_up_units = '0' does not insert entitlement_grants row", async () => {
    const secret = "whsec_test_bil017";
    const now = Math.floor(Date.now() / 1000);
    const insertedGrants: unknown[][] = [];

    const mockSql = {
      unsafe: (async (query: string, params?: unknown[]) => {
        if (query.includes("billing_webhook_receipts") && query.includes("SELECT")) return [];
        if (query.includes("INSERT INTO entitlement_grants")) {
          insertedGrants.push(params ?? []);
          return [];
        }
        if (query.includes("INSERT INTO organisation_subscriptions")) return [];
        if (query.includes("INSERT INTO billing_webhook_receipts")) return [];
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new EntitlementRuntime(mockSql);

    const payload = {
      id: "evt_bil017",
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: {
            organisation_id: "org-bil017",
            tier: "event_pass",
            top_up_units: "0",
          },
        },
      },
    };

    const rawPayload = JSON.stringify(payload);
    const ts = now.toString();
    const sig = createHmac("sha256", secret).update(`${ts}.${rawPayload}`).digest("hex");
    const header = `t=${ts},v1=${sig}`;

    await runtime.processBillingWebhook(header, rawPayload, payload, secret);
    expect(insertedGrants.length).toBe(0);
  });

  it("BIL-018: customer.subscription.deleted resolves org via provider_subscription_id DB lookup", async () => {
    const secret = "whsec_test_bil018";
    const now = Math.floor(Date.now() / 1000);
    const updatedOrgs: string[] = [];

    const mockSql = {
      unsafe: (async (query: string, params?: unknown[]) => {
        if (query.includes("billing_webhook_receipts") && query.includes("SELECT")) return [];
        if (query.includes("SELECT organisation_id FROM organisation_subscriptions")) {
          // Resolve sub_del999 -> org-resolved-from-db
          return [{ organisation_id: "org-resolved-from-db" }];
        }
        if (query.includes("UPDATE organisation_subscriptions") && query.includes("canceled")) {
          updatedOrgs.push((params as string[])[0]!);
          return [];
        }
        if (query.includes("INSERT INTO billing_webhook_receipts")) return [];
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new EntitlementRuntime(mockSql);

    // For customer.subscription.deleted, data.object IS the Subscription — its root id is the sub ID
    const payload = {
      id: "evt_bil018",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_del999", // subscription ID at root, no organisation_id here
        },
      },
    };

    const rawPayload = JSON.stringify(payload);
    const ts = now.toString();
    const sig = createHmac("sha256", secret).update(`${ts}.${rawPayload}`).digest("hex");
    const header = `t=${ts},v1=${sig}`;

    const result = await runtime.processBillingWebhook(header, rawPayload, payload, secret);
    expect(result.processed).toBe(true);
    expect(updatedOrgs).toEqual(["org-resolved-from-db"]);
  });

  it("BIL-019: invalid Stripe webhook signature is rejected with 401", async () => {
    const secret = "whsec_test_bil019";
    const now = Math.floor(Date.now() / 1000);

    const mockSql = {
      unsafe: (async () => []) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new EntitlementRuntime(mockSql);

    const payload = {
      id: "evt_bil019",
      type: "checkout.session.completed",
      data: { object: { metadata: { organisation_id: "org-1" } } },
    };

    const rawPayload = JSON.stringify(payload);
    const ts = now.toString();
    const badHeader = `t=${ts},v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`;

    await expect(runtime.processBillingWebhook(badHeader, rawPayload, payload, secret)).rejects.toThrow(
      /Invalid Stripe webhook signature/,
    );
  });
});
