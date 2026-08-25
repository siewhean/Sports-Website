import { ApiError, ErrorCode } from "./errors.js";

export interface StripeCheckoutSessionParams {
  organisationId: string;
  tier: "event_pass" | "organiser_pro";
  topUpUnits?: number | undefined;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string | undefined;
}

export interface StripeCheckoutSessionResult {
  sessionId: string;
  checkoutUrl: string;
  organisationId: string;
  tier: "event_pass" | "organiser_pro";
  topUpUnits: number;
  amountTotal: number;
  currency: string;
  expiresAt: string;
  successUrl: string;
  cancelUrl: string;
}

export interface StripeCheckoutClientPort {
  createSession(params: StripeCheckoutSessionParams): Promise<StripeCheckoutSessionResult>;
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

  async createSession(params: StripeCheckoutSessionParams): Promise<StripeCheckoutSessionResult> {
    if (!this.secretKey || this.secretKey.trim() === "") {
      throw new ApiError(503, ErrorCode.SERVICE_UNAVAILABLE, "Stripe secret key is not configured");
    }

    const isSubscription = params.tier === "organiser_pro";
    const body = new URLSearchParams();
    body.set("mode", isSubscription ? "subscription" : "payment");
    body.set("success_url", params.successUrl);
    body.set("cancel_url", params.cancelUrl);
    body.set("client_reference_id", params.organisationId);
    body.set("metadata[organisation_id]", params.organisationId);
    body.set("metadata[tier]", params.tier);
    if (params.topUpUnits !== undefined && params.topUpUnits > 0) {
      body.set("metadata[top_up_units]", params.topUpUnits.toString());
    }

    // Line items
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
      if (isSubscription) {
        body.set("line_items[0][price_data][recurring][interval]", "month");
      }
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

    const data = (await response.json()) as {
      id: string;
      url: string;
      amount_total: number | null;
      currency: string | null;
      expires_at: number;
    };

    return {
      sessionId: data.id,
      checkoutUrl: data.url,
      organisationId: params.organisationId,
      tier: params.tier,
      topUpUnits: params.topUpUnits ?? 0,
      amountTotal: data.amount_total ?? (params.tier === "organiser_pro" ? 9900 : 4900),
      currency: data.currency ?? "usd",
      expiresAt: new Date(data.expires_at * 1000).toISOString(),
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
    };
  }
}
