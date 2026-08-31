import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PostgresJsSql } from "@matchday/identity";
import { EntitlementRuntime } from "../../src/entitlement-runtime.js";

describe("Event Pass competition scope", () => {
  it("binds Event Pass checkout to an owned competition", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const sql = {
      unsafe: (async (query: string) => {
        if (query.includes("role IN ('owner','organiser')")) return [{ ok: 1 }];
        if (query.includes("SELECT organisation_id FROM competitions")) return [{ organisation_id: "org-1" }];
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;
    const stripe = {
      createSession: async (params: Record<string, unknown>) => {
        captured.push(params);
        return {
          sessionId: "cs_test_event_pass",
          checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_event_pass",
          organisationId: "org-1",
          competitionId: "comp-1",
          tier: "event_pass" as const,
          topUpUnits: 0,
          amountTotal: 4900,
          currency: "usd",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          successUrl: "https://matchday.test/success",
          cancelUrl: "https://matchday.test/cancel",
        };
      },
    };
    const runtime = new EntitlementRuntime(sql, stripe);

    const result = await runtime.createCheckoutSession({ accountId: "acc-1" }, "org-1", {
      tier: "event_pass",
      competitionId: "comp-1",
      successUrl: "https://matchday.test/success",
      cancelUrl: "https://matchday.test/cancel",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ organisationId: "org-1", competitionId: "comp-1", tier: "event_pass" });
    expect(result.competition_id).toBe("comp-1");
  });

  it("rejects Event Pass checkout for a competition outside the organisation", async () => {
    let stripeCalls = 0;
    const sql = {
      unsafe: (async (query: string) => {
        if (query.includes("role IN ('owner','organiser')")) return [{ ok: 1 }];
        if (query.includes("SELECT organisation_id FROM competitions")) return [{ organisation_id: "org-2" }];
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;
    const stripe = {
      createSession: async () => {
        stripeCalls += 1;
        throw new Error("must not reach Stripe");
      },
    };
    const runtime = new EntitlementRuntime(sql, stripe);

    await expect(
      runtime.createCheckoutSession({ accountId: "acc-1" }, "org-1", {
        tier: "event_pass",
        competitionId: "comp-2",
        successUrl: "https://matchday.test/success",
        cancelUrl: "https://matchday.test/cancel",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(stripeCalls).toBe(0);
  });

  it("persists the competition-scoped purchase grant from Stripe metadata", async () => {
    const secret = "whsec_event_pass_scope";
    const now = Math.floor(Date.now() / 1000);
    const grantParams: unknown[][] = [];
    const sql = {
      unsafe: (async (query: string, params?: unknown[]) => {
        if (query.includes("INSERT INTO billing_webhook_receipts")) return [{ id: "receipt-1" }];
        if (query.includes("SELECT organisation_id FROM competitions")) return [{ organisation_id: "org-1" }];
        if (query.includes("INSERT INTO entitlement_grants") && query.includes("unlimited_entries")) {
          grantParams.push(params ?? []);
          return [];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;
    const runtime = new EntitlementRuntime(sql);
    const payload = {
      id: "evt_event_pass_scope",
      type: "checkout.session.completed",
      data: {
        object: {
          customer: "cus_1",
          metadata: {
            organisation_id: "org-1",
            competition_id: "comp-1",
            purchase_type: "plan",
            tier: "event_pass",
          },
        },
      },
    };
    const raw = JSON.stringify(payload);
    const signature = createHmac("sha256", secret).update(`${now}.${raw}`).digest("hex");

    const result = await runtime.processBillingWebhook(`t=${now},v1=${signature}`, raw, payload, secret);

    expect(result.processed).toBe(true);
    expect(grantParams).toEqual([["comp-1", "org-1", "stripe:event-pass:evt_event_pass_scope:comp-1"]]);
  });

  it("checks competition effective tier for branding instead of the organisation subscription", async () => {
    const sql = {
      unsafe: (async (query: string, params?: unknown[]) => {
        if (query.includes("SELECT organisation_id FROM competitions")) return [{ organisation_id: "org-1" }];
        if (query.includes("role IN ('owner','organiser')")) return [{ ok: 1 }];
        if (query.includes("matchday_effective_plan_tier")) {
          return [{ tier: params?.[0] === "comp-pass" ? "event_pass" : "free" }];
        }
        if (query.includes("INSERT INTO competition_branding")) {
          return [
            {
              competition_id: params?.[0],
              primary_color: "#112233",
              secondary_color: null,
              logo_url: null,
              banner_url: null,
              hide_platform_badge: false,
            },
          ];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;
    const runtime = new EntitlementRuntime(sql);
    const actor = { accountId: "acc-1" };

    await expect(runtime.setBranding(actor, "org-1", "comp-pass", { primary_color: "#112233" })).resolves.toMatchObject({
      competition_id: "comp-pass",
    });
    await expect(runtime.setBranding(actor, "org-1", "comp-free", { primary_color: "#112233" })).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});
