import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BillingWebhookPayload } from "@matchday/contracts";
import type { PostgresJsSql } from "@matchday/identity";
import { EntitlementRuntime } from "../../src/entitlement-runtime.js";

describe("Phase 6 billing source remediation", () => {
  it("claims a Stripe event before applying checkout effects", async () => {
    const calls: string[] = [];
    const sql = {
      unsafe: (async (query: string) => {
        calls.push(query);
        if (query.includes("INSERT INTO billing_webhook_receipts")) return [{ id: "receipt-1" }];
        if (query.includes("SELECT tier FROM organisation_subscriptions")) return [{ tier: "free" }];
        return [];
      }) as PostgresJsSql["unsafe"],
      begin: async <T>(callback: (tx: PostgresJsSql) => Promise<T>) => callback(sql as unknown as PostgresJsSql),
    } as unknown as PostgresJsSql;
    const payload: BillingWebhookPayload = {
      id: "evt_atomic",
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: { organisation_id: "org-1", purchase_type: "ai_top_up", top_up_units: "5" },
        },
      },
    };
    const secret = "whsec_atomic";
    const raw = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
    await new EntitlementRuntime(sql).processBillingWebhook(`t=${timestamp},v1=${signature}`, raw, payload, secret);

    const receiptIndex = calls.findIndex((query) => query.includes("INSERT INTO billing_webhook_receipts"));
    const grantIndex = calls.findIndex((query) => query.includes("INSERT INTO entitlement_grants"));
    expect(receiptIndex).toBeGreaterThanOrEqual(0);
    expect(grantIndex).toBeGreaterThan(receiptIndex);
    expect(calls.some((query) => query.includes("INSERT INTO organisation_subscriptions"))).toBe(false);
  });

  it("creates standalone AI top-up checkout without a plan purchase", async () => {
    const sql = {
      unsafe: (async (query: string) => (query.includes("organisation_memberships") ? [{ ok: 1 }] : [])) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;
    const stripe = {
      createSession: async () => {
        throw new Error("plan checkout must not be used");
      },
      createTopUpSession: async (params: {
        organisationId: string;
        topUpUnits: number;
        successUrl: string;
        cancelUrl: string;
      }) => ({
        sessionId: "cs_topup",
        checkoutUrl: "https://checkout.stripe.test/cs_topup",
        organisationId: params.organisationId,
        topUpUnits: params.topUpUnits,
        amountTotal: 2500,
        currency: "usd",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        successUrl: params.successUrl,
        cancelUrl: params.cancelUrl,
      }),
    };
    const result = await new EntitlementRuntime(sql, stripe).createCheckoutSession({ accountId: "actor-1" }, "org-1", {
      purchaseType: "ai_top_up",
      topUpUnits: 5,
      successUrl: "https://example.test/success",
      cancelUrl: "https://example.test/cancel",
    });
    expect(result.purchase_type).toBe("ai_top_up");
    expect(result.tier).toBeNull();
    expect(result.top_up_units).toBe(5);
  });

  it("preserves provider subscription status and period fields in the source handler", async () => {
    const updates: unknown[][] = [];
    const sql = {
      unsafe: (async (query: string, params?: unknown[]) => {
        if (query.includes("provider_subscription_id")) return [{ organisation_id: "org-1" }];
        if (query.includes("INSERT INTO billing_webhook_receipts")) return [{ id: "receipt-2" }];
        if (query.includes("UPDATE organisation_subscriptions SET status=$2")) updates.push(params ?? []);
        return [];
      }) as PostgresJsSql["unsafe"],
      begin: async <T>(callback: (tx: PostgresJsSql) => Promise<T>) => callback(sql as unknown as PostgresJsSql),
    } as unknown as PostgresJsSql;
    const payload: BillingWebhookPayload = {
      id: "evt_lifecycle",
      type: "customer.subscription.updated",
      data: { object: { id: "sub-1", status: "past_due", current_period_start: 10, current_period_end: 20 } },
    };
    const secret = "whsec_lifecycle";
    const raw = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
    await new EntitlementRuntime(sql).processBillingWebhook(`t=${timestamp},v1=${signature}`, raw, payload, secret);
    expect(updates).toEqual([["org-1", "past_due", 10, 20]]);
  });
});
