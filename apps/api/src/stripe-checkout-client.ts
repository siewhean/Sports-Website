import { randomUUID } from "node:crypto";
import { ApiError, ErrorCode } from "./errors.js";

/** Upper bound for AI action packs in one checkout; anything larger needs a sales conversation. */
export const MAX_CHECKOUT_TOP_UP_UNITS = 100;

export interface StripeCheckoutSessionParams {
  organisationId: string;
  competitionId?: string | undefined;
  tier: "event_pass" | "organiser_pro";
  topUpUnits?: number | undefined;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string | undefined;
  /** Stable key so a retried/double-submitted request returns the same Stripe session. */
  idempotencyKey?: string | undefined;
}

export interface StripeTopUpSessionParams {
  organisationId: string;
  topUpUnits: number;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string | undefined;
  idempotencyKey?: string | undefined;
}

export interface StripeCheckoutSessionResult {
  sessionId: string;
  checkoutUrl: string;
  organisationId: string;
  competitionId?: string | undefined;
  tier: "event_pass" | "organiser_pro";
  topUpUnits: number;
  amountTotal: number;
  currency: string;
  expiresAt: string;
  successUrl: string;
  cancelUrl: string;
}

export interface StripeTopUpSessionResult {
  sessionId: string;
  checkoutUrl: string;
  organisationId: string;
  topUpUnits: number;
  amountTotal: number;
  currency: string;
  expiresAt: string;
  successUrl: string;
  cancelUrl: string;
}

export interface StripeCheckoutClientPort {
  createSession(params: StripeCheckoutSessionParams): Promise<StripeCheckoutSessionResult>;
  createTopUpSession?(params: StripeTopUpSessionParams): Promise<StripeTopUpSessionResult>;
}

type StripeClientLogger = { error: (payload: Record<string, unknown>, message: string) => void };

export type HttpStripeCheckoutClientOptions = {
  eventPassPriceId?: string | undefined;
  organiserProPriceId?: string | undefined;
  aiTopUpPriceId?: string | undefined;
  timeoutMs?: number | undefined;
  logger?: StripeClientLogger | undefined;
  fetch?: typeof fetch | undefined;
  apiBaseUrl?: string | undefined;
};

const genericProviderError = () =>
  new ApiError(502, ErrorCode.SERVICE_UNAVAILABLE, "Payment provider request failed. Please try again.");

function assertUnits(units: number | undefined, required: boolean): void {
  if (units === undefined && !required) return;
  if (!Number.isSafeInteger(units) || (units as number) < 1 || (units as number) > MAX_CHECKOUT_TOP_UP_UNITS) {
    throw new ApiError(
      422,
      ErrorCode.VALIDATION_ERROR,
      `AI top-up units must be an integer between 1 and ${MAX_CHECKOUT_TOP_UP_UNITS}`,
    );
  }
}

export class HttpStripeCheckoutClient implements StripeCheckoutClientPort {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;

  constructor(
    private readonly secretKey: string,
    private readonly options: HttpStripeCheckoutClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.stripe.com";
  }

  private async requestSession(body: URLSearchParams, idempotencyKey: string | undefined) {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}/v1/checkout/sessions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": idempotencyKey ?? randomUUID(),
        },
        body: body.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (err: unknown) {
      this.options.logger?.error(
        { event: "stripe_checkout_request_failed", reason: (err as Error)?.name ?? "unknown" },
        "Stripe checkout request failed before a response",
      );
      throw genericProviderError();
    }
    if (!response.ok) {
      // Stripe error bodies can include request ids, parameter names and account detail; keep them in
      // server logs only. Truncate so a hostile/huge body cannot flood the log pipeline.
      const errorText = (await response.text().catch(() => "")).slice(0, 2_000);
      let stripeError: { type?: unknown; code?: unknown; param?: unknown; message?: unknown } = {};
      try {
        stripeError = (JSON.parse(errorText) as { error?: typeof stripeError }).error ?? {};
      } catch {
        stripeError = {};
      }
      this.options.logger?.error(
        {
          event: "stripe_checkout_request_rejected",
          status: response.status,
          stripe_error_type: typeof stripeError.type === "string" ? stripeError.type : undefined,
          stripe_error_code: typeof stripeError.code === "string" ? stripeError.code : undefined,
          stripe_error_param: typeof stripeError.param === "string" ? stripeError.param : undefined,
          stripe_request_id: response.headers.get("request-id") ?? undefined,
        },
        "Stripe rejected checkout session creation",
      );
      throw genericProviderError();
    }
    const data = (await response.json().catch(() => null)) as {
      id?: unknown;
      url?: unknown;
      amount_total?: number | null;
      currency?: string | null;
      expires_at?: unknown;
    } | null;
    if (
      !data ||
      typeof data.id !== "string" ||
      typeof data.url !== "string" ||
      !data.url.startsWith("https://") ||
      typeof data.expires_at !== "number"
    ) {
      this.options.logger?.error({ event: "stripe_checkout_response_invalid" }, "Stripe returned an invalid session");
      throw genericProviderError();
    }
    return {
      id: data.id,
      url: data.url,
      amount_total: data.amount_total ?? null,
      currency: data.currency ?? null,
      expires_at: data.expires_at,
    };
  }

  private assertConfigured() {
    if (!this.secretKey || this.secretKey.trim() === "") {
      throw new ApiError(503, ErrorCode.SERVICE_UNAVAILABLE, "Stripe payment provider is not configured");
    }
  }

  async createSession(params: StripeCheckoutSessionParams): Promise<StripeCheckoutSessionResult> {
    this.assertConfigured();
    if (params.tier === "event_pass" && !params.competitionId) {
      throw new ApiError(422, ErrorCode.VALIDATION_ERROR, "Event Pass checkout requires a competition");
    }
    assertUnits(params.topUpUnits, false);
    const isSubscription = params.tier === "organiser_pro";
    const body = new URLSearchParams();
    body.set("mode", isSubscription ? "subscription" : "payment");
    // Card-only keeps fulfilment synchronous (payment_status=paid on completion); delayed methods
    // would still be handled through checkout.session.async_payment_* webhooks.
    body.set("payment_method_types[0]", "card");
    body.set("success_url", params.successUrl);
    body.set("cancel_url", params.cancelUrl);
    body.set("client_reference_id", params.organisationId);
    body.set("metadata[organisation_id]", params.organisationId);
    body.set("metadata[purchase_type]", "plan");
    body.set("metadata[tier]", params.tier);
    if (params.tier === "event_pass" && params.competitionId) {
      body.set("metadata[competition_id]", params.competitionId);
    }
    if (params.topUpUnits !== undefined && params.topUpUnits > 0) {
      body.set("metadata[top_up_units]", params.topUpUnits.toString());
    }

    const priceId = params.tier === "organiser_pro" ? this.options.organiserProPriceId : this.options.eventPassPriceId;
    if (priceId) {
      body.set("line_items[0][price]", priceId);
      body.set("line_items[0][quantity]", "1");
    } else {
      const unitAmount = params.tier === "organiser_pro" ? 9900 : 4900;
      body.set("line_items[0][price_data][currency]", "usd");
      body.set("line_items[0][price_data][unit_amount]", unitAmount.toString());
      body.set(
        "line_items[0][price_data][product_data][name]",
        params.tier === "organiser_pro" ? "MATCHDAY Pro Subscription" : "MATCHDAY Event Pass",
      );
      if (isSubscription) body.set("line_items[0][price_data][recurring][interval]", "month");
      body.set("line_items[0][quantity]", "1");
    }

    if (params.topUpUnits && params.topUpUnits > 0) {
      const topUpPriceId = this.options.aiTopUpPriceId;
      if (topUpPriceId) {
        body.set("line_items[1][price]", topUpPriceId);
        body.set("line_items[1][quantity]", params.topUpUnits.toString());
      } else {
        body.set("line_items[1][price_data][currency]", "usd");
        body.set("line_items[1][price_data][unit_amount]", "500");
        body.set("line_items[1][price_data][product_data][name]", "AI Assistant Action Pack");
        body.set("line_items[1][quantity]", params.topUpUnits.toString());
      }
    }

    const data = await this.requestSession(body, params.idempotencyKey);
    return {
      sessionId: data.id,
      checkoutUrl: data.url,
      organisationId: params.organisationId,
      ...(params.competitionId ? { competitionId: params.competitionId } : {}),
      tier: params.tier,
      topUpUnits: params.topUpUnits ?? 0,
      amountTotal: data.amount_total ?? (params.tier === "organiser_pro" ? 9900 : 4900),
      currency: data.currency ?? "usd",
      expiresAt: new Date(data.expires_at * 1000).toISOString(),
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
    };
  }

  async createTopUpSession(params: StripeTopUpSessionParams): Promise<StripeTopUpSessionResult> {
    this.assertConfigured();
    assertUnits(params.topUpUnits, true);
    const body = new URLSearchParams();
    body.set("mode", "payment");
    body.set("payment_method_types[0]", "card");
    body.set("success_url", params.successUrl);
    body.set("cancel_url", params.cancelUrl);
    body.set("client_reference_id", params.organisationId);
    body.set("metadata[organisation_id]", params.organisationId);
    body.set("metadata[purchase_type]", "ai_top_up");
    body.set("metadata[top_up_units]", params.topUpUnits.toString());
    const topUpPriceId = this.options.aiTopUpPriceId;
    if (topUpPriceId) {
      body.set("line_items[0][price]", topUpPriceId);
      body.set("line_items[0][quantity]", params.topUpUnits.toString());
    } else {
      body.set("line_items[0][price_data][currency]", "usd");
      body.set("line_items[0][price_data][unit_amount]", "500");
      body.set("line_items[0][price_data][product_data][name]", "AI Assistant Action Pack");
      body.set("line_items[0][quantity]", params.topUpUnits.toString());
    }
    const data = await this.requestSession(body, params.idempotencyKey);
    return {
      sessionId: data.id,
      checkoutUrl: data.url,
      organisationId: params.organisationId,
      topUpUnits: params.topUpUnits,
      amountTotal: data.amount_total ?? params.topUpUnits * 500,
      currency: data.currency ?? "usd",
      expiresAt: new Date(data.expires_at * 1000).toISOString(),
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
    };
  }
}
