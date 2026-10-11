import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import type { PostgresJsSql } from "@matchday/identity";
import {
  EmailTemplateRegistry,
  InMemoryEmailOutboxStore,
  InMemoryNotificationRateLimiter,
  InMemoryNotificationStore,
  InMemoryNotificationUnitOfWork,
  NotificationService,
} from "@matchday/notifications";
import { buildApp } from "../../src/app.js";
import { escapeCsvCell } from "../../src/csv-escape.js";
import {
  EntitlementRuntime,
  assertCheckoutRedirectUrl,
  minimiseStripeEventForStorage,
  type StripeWebhookEvent,
} from "../../src/entitlement-runtime.js";
import { ExportRuntime } from "../../src/export-runtime.js";
import type { IdentityApiRuntime } from "../../src/identity-runtime.js";
import { constantTimeEquals, requireMutationSession } from "../../src/mutation-guard.js";
import { HttpStripeCheckoutClient, MAX_CHECKOUT_TOP_UP_UNITS } from "../../src/stripe-checkout-client.js";
import { healthyProbes, testConfig } from "../helpers.js";

const ORIGIN = "https://app.matchday.example";

function sign(raw: string, secret: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}`;
}

function recordingSql(responder: (query: string, params: unknown[]) => unknown[] = () => []) {
  const calls: { query: string; params: unknown[] }[] = [];
  const sql = {
    unsafe: (async (query: string, params: unknown[] = []) => {
      calls.push({ query, params });
      return responder(query, params);
    }) as PostgresJsSql["unsafe"],
    begin: async <T>(callback: (tx: PostgresJsSql) => Promise<T>) => callback(sql as unknown as PostgresJsSql),
  } as unknown as PostgresJsSql;
  return { sql, calls };
}

function identityRuntime(accountId = "00000000-0000-4000-8000-000000000001") {
  return {
    authenticate: vi.fn(async (sessionToken: string) => ({
      account: { id: accountId, primaryEmail: "o@example.test", displayName: "O", status: "active" },
      sessionId: "s",
      sessionToken,
      csrfToken: "csrf-token-value",
      idleExpiresAt: new Date(Date.now() + 60_000),
      absoluteExpiresAt: new Date(Date.now() + 60_000),
    })),
    verifyCsrfToken: vi.fn(() => true),
    rateLimitAccountId: vi.fn().mockResolvedValue(null),
  } as unknown as IdentityApiRuntime;
}

const sessionHeaders = { cookie: "matchday_session=token", "x-csrf-token": "csrf-token-value", origin: ORIGIN };

describe("CSV formula injection (CWE-1236)", () => {
  it.each([
    ['=HYPERLINK("http://evil")', '"\'=HYPERLINK(""http://evil"")"'],
    ["+1+1", "'+1+1"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\tcmd", "'\tcmd"],
    ["\rcmd", '"\'\rcmd"'],
    ["Spikers, FC", '"Spikers, FC"'],
    ["Plain", "Plain"],
  ])("neutralises %j", (input, expected) => {
    expect(escapeCsvCell(input)).toBe(expected);
  });

  it("keeps real numbers numeric", () => {
    expect(escapeCsvCell(-3)).toBe("-3");
    expect(escapeCsvCell(null)).toBe("");
  });
});

describe("Stripe webhook payment state and minimisation", () => {
  const secret = "whsec_w2";
  const session = (type: string, paymentStatus: string, extra: Record<string, unknown> = {}): StripeWebhookEvent =>
    ({
      id: `evt_${type}_${paymentStatus}`,
      type,
      created: 1_700_000_000,
      data: {
        object: {
          id: "cs_w2_1",
          mode: "payment",
          payment_status: paymentStatus,
          amount_total: 2500,
          currency: "usd",
          customer: "cus_1",
          customer_details: { email: "buyer@example.test", name: "Buyer", address: { line1: "1 Road" } },
          metadata: { organisation_id: "org-1", purchase_type: "ai_top_up", top_up_units: "5" },
          ...extra,
        },
      },
    }) as unknown as StripeWebhookEvent;

  it("stores only the allow-listed projection", () => {
    const stored = minimiseStripeEventForStorage(session("checkout.session.completed", "paid"));
    expect(JSON.stringify(stored)).not.toContain("buyer@example.test");
    expect(JSON.stringify(stored)).not.toContain("customer_details");
    expect(stored.data.object).toMatchObject({ id: "cs_w2_1", amount_total: 2500, payment_status: "paid" });
  });

  it("does not grant on an unpaid completion, grants once on async success", async () => {
    const { sql, calls } = recordingSql((query) =>
      query.includes("INSERT INTO billing_webhook_receipts") ? [{ id: "r" }] : [],
    );
    const runtime = new EntitlementRuntime(sql, undefined, { webhookSecret: secret });
    const unpaid = session("checkout.session.completed", "unpaid");
    await runtime.processBillingWebhook(sign(JSON.stringify(unpaid), secret), JSON.stringify(unpaid), unpaid);
    expect(calls.some((call) => call.query.includes("INSERT INTO entitlement_grants"))).toBe(false);
    const stored = calls.find((call) => call.query.includes("INSERT INTO billing_webhook_receipts"))!;
    expect(String(stored.params[3])).not.toContain("buyer@example.test");

    const succeeded = session("checkout.session.async_payment_succeeded", "paid");
    await runtime.processBillingWebhook(sign(JSON.stringify(succeeded), secret), JSON.stringify(succeeded), succeeded);
    const grants = calls.filter((call) => call.query.includes("INSERT INTO entitlement_grants"));
    expect(grants).toHaveLength(1);
    // Keyed on the Checkout Session, so a paid completion for the same session cannot double-grant.
    expect(grants[0]!.params[3]).toBe("stripe:top-up:session:cs_w2_1");
  });

  it("revokes session grants on async payment failure", async () => {
    const { sql, calls } = recordingSql((query) =>
      query.includes("INSERT INTO billing_webhook_receipts") ? [{ id: "r" }] : [],
    );
    const failed = session("checkout.session.async_payment_failed", "unpaid");
    await new EntitlementRuntime(sql, undefined, { webhookSecret: secret }).processBillingWebhook(
      sign(JSON.stringify(failed), secret),
      JSON.stringify(failed),
      failed,
    );
    const revoke = calls.find((call) => call.query.includes("UPDATE entitlement_grants SET expires_at=now()"));
    expect(revoke?.params[1]).toContain("stripe:top-up:session:cs_w2_1");
  });

  it("rejects webhooks when no secret is configured", async () => {
    const { sql } = recordingSql();
    const event = session("checkout.session.completed", "paid");
    await expect(
      new EntitlementRuntime(sql).processBillingWebhook(
        sign(JSON.stringify(event), secret),
        JSON.stringify(event),
        event,
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe("Checkout redirect and unit validation", () => {
  const allowed = [ORIGIN, "http://localhost:3000"];
  it.each([
    "https://evil.example/success",
    "javascript:alert(1)",
    "http://app.matchday.example/success",
    "https://user:pass@app.matchday.example/x",
    "//evil.example",
    "not a url",
  ])("rejects %s", (url) => {
    expect(() => assertCheckoutRedirectUrl(url, allowed)).toThrow(/not allowed/);
  });

  it("accepts configured origins and fails closed with none configured", () => {
    expect(assertCheckoutRedirectUrl(`${ORIGIN}/organiser?billing=ok`, allowed)).toBe(`${ORIGIN}/organiser?billing=ok`);
    expect(assertCheckoutRedirectUrl("http://localhost:3000/ok", allowed)).toBe("http://localhost:3000/ok");
    expect(() => assertCheckoutRedirectUrl(`${ORIGIN}/ok`, [])).toThrow(/not allowed/);
  });

  it("caps top-up units and passes an idempotency key to Stripe", async () => {
    const { sql } = recordingSql((query) => (query.includes("organisation_memberships") ? [{ ok: 1 }] : []));
    const createTopUpSession = vi.fn(async (params: { topUpUnits: number; idempotencyKey?: string | undefined }) => ({
      sessionId: "cs",
      checkoutUrl: "https://checkout.stripe.com/c/pay/cs",
      organisationId: "org-1",
      topUpUnits: params.topUpUnits,
      amountTotal: 500,
      currency: "usd",
      expiresAt: new Date().toISOString(),
      successUrl: `${ORIGIN}/s`,
      cancelUrl: `${ORIGIN}/c`,
    }));
    const runtime = new EntitlementRuntime(
      sql,
      { createSession: vi.fn(), createTopUpSession },
      { checkoutRedirectOrigins: [ORIGIN] },
    );
    const input = { purchaseType: "ai_top_up" as const, successUrl: `${ORIGIN}/s`, cancelUrl: `${ORIGIN}/c` };
    await expect(
      runtime.createCheckoutSession({ accountId: "a" }, "org-1", {
        ...input,
        topUpUnits: MAX_CHECKOUT_TOP_UP_UNITS + 1,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      runtime.createCheckoutSession({ accountId: "a" }, "org-1", {
        ...input,
        topUpUnits: 2,
        successUrl: "https://evil.example/s",
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "REDIRECT_URI_REJECTED" });
    await runtime.createCheckoutSession({ accountId: "a" }, "org-1", { ...input, topUpUnits: 2 });
    expect(createTopUpSession.mock.calls[0]![0].idempotencyKey).toMatch(/^matchday-checkout-[0-9a-f]{64}$/);
  });
});

describe("HttpStripeCheckoutClient", () => {
  it("sends Idempotency-Key, pins card payments and uses a timeout", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "cs_1",
            url: "https://checkout.stripe.com/c/1",
            amount_total: 500,
            currency: "usd",
            expires_at: 1,
          }),
          { status: 200 },
        ),
    );
    const client = new HttpStripeCheckoutClient("sk_test_x", {
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 1234,
    });
    await client.createTopUpSession({
      organisationId: "org-1",
      topUpUnits: 1,
      successUrl: `${ORIGIN}/s`,
      cancelUrl: `${ORIGIN}/c`,
      idempotencyKey: "idem-1",
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("idem-1");
    expect(String(init.body)).toContain("payment_method_types%5B0%5D=card");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns a generic error and logs sanitised Stripe detail", async () => {
    const logger = { error: vi.fn() };
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              code: "parameter_invalid",
              param: "line_items",
              message: "acct_123 secret detail",
            },
          }),
          { status: 400, headers: { "request-id": "req_1" } },
        ),
    );
    const client = new HttpStripeCheckoutClient("sk_test_x", { fetch: fetchMock as unknown as typeof fetch, logger });
    const failure = await client
      .createTopUpSession({ organisationId: "o", topUpUnits: 1, successUrl: `${ORIGIN}/s`, cancelUrl: `${ORIGIN}/c` })
      .then(
        () => ({ statusCode: 0, message: "unexpected success" }),
        (error: unknown) => error as Error & { statusCode: number },
      );
    expect(failure.statusCode).toBe(502);
    expect(failure.message).not.toContain("acct_123");
    expect(JSON.stringify(logger.error.mock.calls)).toContain("parameter_invalid");
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("acct_123");
  });
});

describe("requireMutationSession", () => {
  const identity = { authenticate: vi.fn(async () => ({ account: { id: "a" }, csrfToken: "csrf-token-value" })) };
  const request = (headers: Record<string, string>) => ({ headers }) as unknown as FastifyRequest;
  it("requires an allowed Origin before authenticating", async () => {
    await expect(requireMutationSession(request({}), identity, [ORIGIN])).rejects.toMatchObject({
      code: "ORIGIN_REJECTED",
    });
    await expect(
      requireMutationSession(request({ origin: "https://evil.example" }), identity, [ORIGIN]),
    ).rejects.toMatchObject({ code: "ORIGIN_REJECTED" });
    expect(identity.authenticate).not.toHaveBeenCalled();
  });
  it("verifies the CSRF token in constant time", async () => {
    await expect(
      requireMutationSession(request({ origin: ORIGIN, "x-csrf-token": "csrf-token-valuX" }), identity, [ORIGIN]),
    ).rejects.toMatchObject({ code: "CSRF_INVALID" });
    await expect(
      requireMutationSession(request({ origin: ORIGIN, "x-csrf-token": "csrf-token-value" }), identity, [ORIGIN]),
    ).resolves.toMatchObject({ account: { id: "a" } });
    expect(constantTimeEquals("abc", "abc")).toBe(true);
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
    expect(constantTimeEquals(undefined, "abc")).toBe(false);
    expect(constantTimeEquals("", "")).toBe(false);
  });
});

describe("Competition archive import hardening", () => {
  const archive = {
    schema_version: "1.0",
    competition: { id: "c-old", name: "Imported", sport_code: "volleyball", status: "completed" },
    branding: { primary_color: "#112233", logo_url: "javascript:alert(1)", hide_platform_badge: true },
    sponsors: [{ name: "Bar", tier: "headline", website_url: "javascript:alert(1)", sort_order: 1 }],
    divisions: [
      {
        id: "d",
        name: "A",
        entries: [
          { id: "e1", name: "One" },
          { id: "e2", name: "Two" },
        ],
        matches: [{ id: "m", code: "M1", stage: "group", home_entry_id: "e1", away_entry_id: "e2", state: "final" }],
      },
    ],
  };
  const owner = (tier: string) =>
    recordingSql((query) => {
      if (query.includes("FROM organisation_memberships")) return [{ role: "owner" }];
      if (query.includes("matchday_effective_plan_tier")) return [{ tier }];
      return [];
    });

  it("drops branding and sponsors on a plan without them and forces pending matches", async () => {
    const { sql, calls } = owner("free");
    const result = await new ExportRuntime(sql).importCompetitionArchive({ accountId: "a" }, "org", archive);
    expect(result.warnings.join(" ")).toMatch(/branding was not imported/i);
    expect(result.warnings.join(" ")).toMatch(/sponsors were not imported/i);
    expect(calls.some((call) => call.query.includes("INSERT INTO competition_branding"))).toBe(false);
    expect(calls.some((call) => call.query.includes("INSERT INTO competition_sponsors"))).toBe(false);
    const match = calls.find((call) => call.query.includes("INSERT INTO matches"))!;
    expect(match.params[5]).toBe("pending");
  });

  it("strips non-https links even when entitled", async () => {
    const { sql, calls } = owner("organiser_pro");
    const result = await new ExportRuntime(sql).importCompetitionArchive({ accountId: "a" }, "org", archive);
    const branding = calls.find((call) => call.query.includes("INSERT INTO competition_branding"))!;
    expect(branding.params[3]).toBeNull();
    const sponsor = calls.find((call) => call.query.includes("INSERT INTO competition_sponsors"))!;
    expect(sponsor.params[4]).toBeNull();
    expect(result.warnings.join(" ")).toMatch(/https/);
  });

  it("rejects archives over the size caps", () => {
    const runtime = new ExportRuntime(recordingSql().sql);
    const tooMany = { ...archive, divisions: Array.from({ length: 33 }, (_, index) => ({ name: `D${index}` })) };
    expect(runtime.validateCompetitionArchive(tooMany)).toMatchObject({ valid: false });
  });

  it("requires Origin + CSRF on the import route and validates the archive schema", async () => {
    const importCompetitionArchive = vi.fn(async () => ({ competition_id: "x" }));
    const safeArchive = {
      ...archive,
      branding: { primary_color: "#112233", logo_url: "https://cdn.example/logo.png" },
      sponsors: [{ name: "Bar", tier: "headline", website_url: "https://bar.example", sort_order: 1 }],
    };
    const app = await buildApp({
      config: testConfig({ API_ALLOWED_ORIGINS: ORIGIN }),
      probes: healthyProbes,
      identityRuntime: identityRuntime(),
      exportRuntime: { importCompetitionArchive } as unknown as ExportRuntime,
    });
    const url = "/api/v1/organisations/00000000-0000-4000-8000-000000000002/competitions/import-archive";
    const noOrigin = await app.inject({
      method: "POST",
      url,
      headers: { cookie: "matchday_session=token", "x-csrf-token": "csrf-token-value" },
      payload: { archive: safeArchive },
    });
    expect(noOrigin.statusCode).toBe(403);
    const badCsrf = await app.inject({
      method: "POST",
      url,
      headers: { ...sessionHeaders, "x-csrf-token": "wrong" },
      payload: { archive: safeArchive },
    });
    expect(badCsrf.statusCode).toBe(403);
    const badTier = await app.inject({
      method: "POST",
      url,
      headers: sessionHeaders,
      payload: { archive: { ...safeArchive, sponsors: [{ name: "x", tier: "platinum", sort_order: 1 }] } },
    });
    expect(badTier.statusCode).toBe(400);
    const scriptUrl = await app.inject({ method: "POST", url, headers: sessionHeaders, payload: { archive } });
    expect(scriptUrl.statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url, headers: sessionHeaders, payload: { archive: safeArchive } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(importCompetitionArchive).toHaveBeenCalledOnce();
    await app.close();
  });
});

describe("Notification routes", () => {
  async function notificationApp() {
    const emailOutbox = new InMemoryEmailOutboxStore();
    const notifications = new InMemoryNotificationStore(emailOutbox);
    const notificationService = new NotificationService(
      notifications,
      new InMemoryNotificationUnitOfWork(notifications, emailOutbox),
      new EmailTemplateRegistry(),
      {
        createId: () => "notif-1",
        now: () => new Date(),
        rateLimiter: new InMemoryNotificationRateLimiter({ maximum: 100, windowMs: 60_000 }),
      },
    );
    return buildApp({
      config: testConfig({
        API_ALLOWED_ORIGINS: ORIGIN,
        EMAIL_PROVIDER_WEBHOOK_SECRET: "whsec_dGVzdC1zZWNyZXQtMzItYnl0ZXMtc3ZpeC1rZXk=",
      }),
      probes: healthyProbes,
      identityRuntime: identityRuntime(),
      notificationService,
    });
  }

  it("only accepts known preference types", async () => {
    const app = await notificationApp();
    const junk = await app.inject({
      method: "PUT",
      url: "/api/v1/notifications/preferences/arbitrary-junk-type",
      headers: sessionHeaders,
      payload: { in_app_enabled: true, email_enabled: true },
    });
    expect(junk.statusCode).toBe(400);
    const known = await app.inject({
      method: "PUT",
      url: "/api/v1/notifications/preferences/match_reminder",
      headers: sessionHeaders,
      payload: { in_app_enabled: true, email_enabled: false },
    });
    expect(known.statusCode, known.body).toBe(200);
    await app.close();
  });

  it("does not echo parser or signature detail from the provider webhook", async () => {
    const app = await notificationApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/webhooks/resend",
      headers: {
        "svix-id": "msg_1",
        "svix-timestamp": "1",
        "svix-signature": "v1,bad",
        "content-type": "application/json",
      },
      payload: { type: "email.bounced" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toBe("Invalid webhook signature or payload");
    await app.close();
  });
});

describe("Operational token comparisons", () => {
  it("hides deep health unless the exact token is presented", async () => {
    const token = "d".repeat(40);
    const app = await buildApp({ config: { ...testConfig(), deepHealthToken: token }, probes: healthyProbes });
    expect(
      (await app.inject({ url: "/health/deep", headers: { "x-deep-health-token": `${token}x` } })).statusCode,
    ).toBe(404);
    expect((await app.inject({ url: "/health/deep", headers: { "x-deep-health-token": token } })).statusCode).toBe(200);
    await app.close();
  });
});
