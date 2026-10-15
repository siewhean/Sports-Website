import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PostgresJsSql } from "@matchday/identity";
import { EntitlementRuntime, type StripeWebhookEvent } from "../../src/entitlement-runtime.js";

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
    const payload: StripeWebhookEvent = {
      id: "evt_atomic",
      type: "checkout.session.completed",
      data: {
        object: {
          payment_status: "paid",
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

  it("rejects standalone AI top-up checkout with 409 AI_TOP_UP_UNAVAILABLE (ADR 0010)", async () => {
    const sql = {
      unsafe: (async (query: string) =>
        query.includes("organisation_memberships") ? [{ ok: 1 }] : []) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;
    let stripeCalls = 0;
    const stripe = {
      createSession: async () => {
        stripeCalls += 1;
        throw new Error("plan checkout must not be used");
      },
      createTopUpSession: async () => {
        stripeCalls += 1;
        throw new Error("top-up checkout must not be used");
      },
    };
    await expect(
      new EntitlementRuntime(sql, stripe, {
        checkoutRedirectOrigins: ["https://example.test"],
      }).createCheckoutSession({ accountId: "actor-1" }, "org-1", {
        purchaseType: "ai_top_up",
        topUpUnits: 5,
        successUrl: "https://example.test/success",
        cancelUrl: "https://example.test/cancel",
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "AI_TOP_UP_UNAVAILABLE" });
    expect(stripeCalls).toBe(0);
  });

  it("historical ai_top_up webhook still grants once and a replay of the same event is a no-op", async () => {
    // Grants are keyed by idempotency_key with ON CONFLICT DO NOTHING; model that as a map.
    const grants = new Map<string, unknown[]>();
    const sql = {
      unsafe: (async (query: string, params?: unknown[]) => {
        if (query.includes("INSERT INTO billing_webhook_receipts")) return [{ id: "receipt-replay" }];
        if (query.includes("INSERT INTO entitlement_grants") && params) {
          const key = String(params[params.length - 1]);
          if (!grants.has(key)) grants.set(key, params);
        }
        return [];
      }) as PostgresJsSql["unsafe"],
      begin: async <T>(callback: (tx: PostgresJsSql) => Promise<T>) => callback(sql as unknown as PostgresJsSql),
    } as unknown as PostgresJsSql;
    const payload: StripeWebhookEvent = {
      id: "evt_historical_topup",
      type: "checkout.session.completed",
      data: {
        object: {
          payment_status: "paid",
          id: "cs_historical_topup",
          metadata: { organisation_id: "org-1", purchase_type: "ai_top_up", top_up_units: "5" },
        },
      },
    };
    const secret = "whsec_replay";
    const raw = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
    const runtime = new EntitlementRuntime(sql);
    await runtime.processBillingWebhook(`t=${timestamp},v1=${signature}`, raw, payload, secret);
    await runtime.processBillingWebhook(`t=${timestamp},v1=${signature}`, raw, payload, secret);
    expect([...grants.keys()]).toEqual(["stripe:top-up:session:cs_historical_topup"]);
    expect(grants.get("stripe:top-up:session:cs_historical_topup")).toEqual([
      "org-1",
      "free",
      5,
      "stripe:top-up:session:cs_historical_topup",
    ]);
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
    const payload: StripeWebhookEvent = {
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
