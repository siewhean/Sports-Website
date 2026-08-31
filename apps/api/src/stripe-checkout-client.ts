import { ApiError, ErrorCode } from "./errors.js";

export interface StripeCheckoutSessionParams {
  organisationId: string;
  competitionId?: string | undefined;
  tier: "event_pass" | "organiser_pro";
  topUpUnits?: number | undefined;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string | undefined;
}

export interface StripeTopUpSessionParams {
  organisationId: string;
  topUpUnits: number;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string | undefined;
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

export class HttpStripeCheckoutClient implements StripeCheckoutClientPort {
  constructor(
    private readonly secretKey: string,
    private readonly priceConfig: {
      eventPassPriceId?: string;
      organiserProPriceId?: string;
      aiTopUpPriceId?: string;
    } = {},
  ) {}

  private async requestSession(body: URLSearchParams) {
    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new ApiError(502, ErrorCode.SERVICE_UNAVAILABLE, `Stripe API error: ${response.statusText} - ${errorText}`);
    }
    return (await response.json()) as {
      id: string;
      url: string;
      amount_total: number | null;
      currency: string | null;
      expires_at: number;
    };
  }

  private assertConfigured() {
    if (!this.secretKey || this.secretKey.trim() === "") {
      throw new ApiError(503, ErrorCode.SERVICE_UNAVAILABLE, "Stripe secret key is not configured");
    }
  }

  async createSession(params: StripeCheckoutSessionParams): Promise<StripeCheckoutSessionResult> {
    this.assertConfigured();
    if (params.tier === "event_pass" && !params.competitionId) {
      throw new ApiError(422, ErrorCode.VALIDATION_ERROR, "Event Pass checkout requires a competition");
    }
    const isSubscription = params.tier === "organiser_pro";
    const body = new URLSearchParams();
    body.set("mode", isSubscription ? "subscription" : "payment");
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

    const priceId =
      params.tier === "organiser_pro"
        ? (this.priceConfig.organiserProPriceId ?? process.env.STRIPE_PRICE_ID_ORGANISER_PRO)
        : (this.priceConfig.eventPassPriceId ?? process.env.STRIPE_PRICE_ID_EVENT_PASS);
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
      const topUpPriceId = this.priceConfig.aiTopUpPriceId ?? process.env.STRIPE_PRICE_ID_AI_TOPUP;
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

    const data = await this.requestSession(body);
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
    if (!Number.isSafeInteger(params.topUpUnits) || params.topUpUnits < 1) {
      throw new ApiError(422, ErrorCode.VALIDATION_ERROR, "AI top-up units must be a positive integer");
    }
    const body = new URLSearchParams();
    body.set("mode", "payment");
    body.set("success_url", params.successUrl);
    body.set("cancel_url", params.cancelUrl);
    body.set("client_reference_id", params.organisationId);
    body.set("metadata[organisation_id]", params.organisationId);
    body.set("metadata[purchase_type]", "ai_top_up");
    body.set("metadata[top_up_units]", params.topUpUnits.toString());
    const topUpPriceId = this.priceConfig.aiTopUpPriceId ?? process.env.STRIPE_PRICE_ID_AI_TOPUP;
    if (topUpPriceId) {
      body.set("line_items[0][price]", topUpPriceId);
      body.set("line_items[0][quantity]", params.topUpUnits.toString());
    } else {
      body.set("line_items[0][price_data][currency]", "usd");
      body.set("line_items[0][price_data][unit_amount]", "500");
      body.set("line_items[0][price_data][product_data][name]", "AI Assistant Action Pack");
      body.set("line_items[0][quantity]", params.topUpUnits.toString());
    }
    const data = await this.requestSession(body);
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
