import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PostgresJsSql } from "@matchday/identity";
import {
  type BillingSummary,
  type BillingWebhookPayload,
  type CompetitionBranding,
  type CompetitionSponsor,
  type SubscriptionTier,
  ErrorCode,
} from "@matchday/contracts";
import {
  TIER_FEATURE_LIMITS,
  assertEntryLimit as assertDomainEntryLimit,
  assertFeatureEntitled,
} from "@matchday/domain";
import { ApiError } from "./errors.js";
import type { Phase3Actor } from "./phase-3-runtime.js";
import { MAX_CHECKOUT_TOP_UP_UNITS, type StripeCheckoutClientPort } from "./stripe-checkout-client.js";

export function verifyStripeWebhookSignature(
  signatureHeader: string | undefined,
  rawPayload: string,
  secret: string | undefined,
  toleranceSeconds: number = 300,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!signatureHeader || typeof signatureHeader !== "string" || !secret || secret.trim() === "") return false;
  const elements = signatureHeader.split(",");
  let timestamp = 0;
  const signatures: string[] = [];
  for (const el of elements) {
    const parts = el.split("=");
    const key = parts[0]?.trim();
    const value = parts.slice(1).join("=").trim();
    if (key === "t" && value) {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isNaN(parsed) && Number.isSafeInteger(parsed) && parsed > 0) timestamp = parsed;
    }
    if (key === "v1" && value) signatures.push(value);
  }
  if (timestamp === 0 || signatures.length === 0 || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const hmac = createHmac("sha256", secret).update(`${timestamp}.${rawPayload}`).digest("hex");
  return signatures.some((sig) => {
    try {
      const sigBuf = Buffer.from(sig, "hex");
      const hmacBuf = Buffer.from(hmac, "hex");
      return sigBuf.length === hmacBuf.length && timingSafeEqual(sigBuf, hmacBuf);
    } catch {
      return false;
    }
  });
}

function providerSubscriptionStatus(value: string | null | undefined): "active" | "trialing" | "past_due" | "canceled" {
  switch (value) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "canceled":
    case "cancelled":
    case "incomplete_expired":
      return "canceled";
    case "past_due":
    case "unpaid":
    case "paused":
    case "incomplete":
    default:
      return "past_due";
  }
}

/** Stripe event as received; only the fields MATCHDAY acts on are typed (and retained). */
export type StripeWebhookEvent = BillingWebhookPayload & {
  created?: number | null;
  data: {
    object: BillingWebhookPayload["data"]["object"] & {
      payment_status?: string | null;
      mode?: string | null;
    };
  };
};

type StoredStripeObject = {
  id: string | null;
  mode: string | null;
  payment_status: string | null;
  status: string | null;
  amount_total: number | null;
  currency: string | null;
  customer: string | null;
  subscription: string | null;
  client_reference_id: string | null;
  current_period_start: number | null;
  current_period_end: number | null;
  metadata: {
    organisation_id: string | null;
    competition_id: string | null;
    tier: string | null;
    purchase_type: string | null;
    top_up_units: string | null;
  };
};

const str = (value: unknown, max = 255): string | null =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
const int = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;

/**
 * Allow-listed projection of a Stripe event for durable storage. Stripe sessions carry customer PII
 * (customer_details: name, email, address, phone) and payment detail that MATCHDAY never needs; only
 * identifiers, amounts and the fields the receipt trigger (migration 0058) reads are retained. The
 * raw body is still what the signature is verified over; this runs strictly after verification.
 */
export function minimiseStripeEventForStorage(event: StripeWebhookEvent): {
  id: string;
  type: string;
  created: number | null;
  data: { object: StoredStripeObject };
} {
  const object = (event.data?.object ?? {}) as StripeWebhookEvent["data"]["object"];
  const metadata = (object.metadata ?? {}) as Record<string, unknown>;
  return {
    id: event.id,
    type: event.type,
    created: int(event.created),
    data: {
      object: {
        id: str(object.id),
        mode: str(object.mode, 32),
        payment_status: str(object.payment_status, 32),
        status: str(object.status, 32),
        amount_total: int(object.amount_total),
        currency: str(object.currency, 8),
        customer: str(object.customer),
        subscription: str(object.subscription),
        client_reference_id: str(object.client_reference_id),
        current_period_start: int(object.current_period_start),
        current_period_end: int(object.current_period_end),
        metadata: {
          organisation_id: str(metadata.organisation_id, 64),
          competition_id: str(metadata.competition_id, 64),
          tier: str(metadata.tier, 32),
          purchase_type: str(metadata.purchase_type, 32),
          top_up_units: str(metadata.top_up_units, 16),
        },
      },
    },
  };
}

/** Checkout states in which Stripe has actually collected (or does not require) the money. */
const PAID_CHECKOUT_STATES = new Set(["paid", "no_payment_required"]);

export type EntitlementRuntimeOptions = {
  /** STRIPE_WEBHOOK_SECRET from @matchday/config. */
  webhookSecret?: string | undefined;
  /**
   * Origins Stripe may send the paying browser back to (MATCHDAY_PUBLIC_ORIGIN + API_ALLOWED_ORIGINS).
   * Empty means every checkout redirect is rejected (fail closed).
   */
  checkoutRedirectOrigins?: readonly string[] | undefined;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Stripe redirects the paying browser to successUrl/cancelUrl, so an attacker-chosen URL would turn
 * our checkout into an open redirect from a trusted payment page. Only https (or loopback http for
 * local development) URLs on a configured MATCHDAY origin are accepted.
 */
export function assertCheckoutRedirectUrl(value: string, allowedOrigins: readonly string[]): string {
  const reject = () => new ApiError(400, ErrorCode.REDIRECT_URI_REJECTED, "Checkout redirect URL is not allowed");
  if (typeof value !== "string" || value.length > 2_048) throw reject();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw reject();
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure || url.username || url.password || !allowedOrigins.includes(url.origin)) throw reject();
  return url.href;
}

export class EntitlementRuntime {
  constructor(
    private readonly sql: PostgresJsSql,
    private readonly stripeClient?: StripeCheckoutClientPort,
    private readonly options: EntitlementRuntimeOptions = {},
  ) {}

  private async transaction<T>(callback: (tx: PostgresJsSql) => Promise<T>): Promise<T> {
    const sqlInstance = this.sql as unknown as { begin?: (cb: (tx: PostgresJsSql) => Promise<T>) => Promise<T> };
    return typeof sqlInstance.begin === "function" ? sqlInstance.begin(callback) : callback(this.sql);
  }

  async getSubscriptionTier(
    tx: PostgresJsSql,
    organisationId: string,
  ): Promise<{ tier: SubscriptionTier; status: string; currentPeriodEnd: Date | null }> {
    const record = (
      await tx.unsafe<{ tier: string; status: string; current_period_end: Date | null }>(
        `SELECT tier, status, current_period_end FROM organisation_subscriptions WHERE organisation_id=$1`,
        [organisationId],
      )
    )[0];
    const paidState = Boolean(
      record?.tier === "organiser_pro" &&
      ["active", "trialing"].includes(record.status) &&
      (!record.current_period_end || record.current_period_end.getTime() > Date.now()),
    );
    if (!record || !paidState) {
      return { tier: "free", status: record?.status ?? "active", currentPeriodEnd: record?.current_period_end ?? null };
    }
    return {
      tier: "organiser_pro",
      status: record.status,
      currentPeriodEnd: record.current_period_end,
    };
  }

  async getBillingSummary(organisationId: string): Promise<BillingSummary> {
    const sub = await this.getSubscriptionTier(this.sql, organisationId);
    const tierLimits = TIER_FEATURE_LIMITS[sub.tier];
    const credits = (
      await this.sql.unsafe<{ granted: number; consumed: number }>(
        `SELECT
             COALESCE(sum(g.quantity),0)::integer granted,
             COALESCE(sum((
               SELECT COALESCE(sum(c.quantity),0)
               FROM ai_credit_consumptions c
               WHERE c.grant_id=g.id
             )),0)::integer consumed
           FROM entitlement_grants g
           WHERE g.organisation_id=$1 AND g.feature='ai_actions'
             AND g.source IN ('top_up','admin_grant')
             AND (g.expires_at IS NULL OR g.expires_at>now())`,
        [organisationId],
      )
    )[0] ?? { granted: 0, consumed: 0 };
    const baseUsed =
      (
        await this.sql.unsafe<{ used: number }>(
          `SELECT count(*)::integer used
           FROM ai_action_ledger l
           WHERE l.organisation_id=$1 AND l.outcome='success' AND l.charged_units>0
             AND l.created_at>=date_trunc('month',now())
             AND NOT EXISTS (SELECT 1 FROM ai_credit_consumptions c WHERE c.ledger_id=l.id)`,
          [organisationId],
        )
      )[0]?.used ?? 0;
    const baseLimit = tierLimits.monthly_ai_actions;
    const topUpRemaining = Math.max(0, credits.granted - credits.consumed);
    const baseRemaining = Math.max(0, baseLimit - baseUsed);
    return {
      organisation_id: organisationId,
      tier: sub.tier,
      status:
        sub.status === "cancelled" || sub.status === "canceled"
          ? "cancelled"
          : (sub.status as "active" | "past_due" | "trialing"),
      features: tierLimits.features,
      custom_branding_allowed: tierLimits.features.includes("custom_branding"),
      sponsor_placements_allowed: tierLimits.features.includes("sponsor_placements"),
      max_entries_per_division: tierLimits.max_entries_per_division,
      ai_quota: {
        limit: baseLimit + credits.granted,
        used: Math.min(baseLimit, baseUsed) + credits.consumed,
        remaining: baseRemaining + topUpRemaining,
        period_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
        period_end: sub.currentPeriodEnd ? sub.currentPeriodEnd.toISOString() : null,
      },
    };
  }

  async getBillingSummaryForActor(actor: Phase3Actor, organisationId: string): Promise<BillingSummary> {
    await this.assertOrganisationMember(this.sql, organisationId, actor);
    return this.getBillingSummary(organisationId);
  }

  async getBillingHistory(actor: Phase3Actor, organisationId: string) {
    await this.assertOrganisationMember(this.sql, organisationId, actor);
    const receipts = await this.sql.unsafe<{
      id: string;
      event_type: string;
      created_at: Date;
      payload: { data?: { object?: { amount_total?: number; currency?: string } } };
    }>(
      `SELECT id, event_type, created_at, payload FROM billing_webhook_receipts WHERE organisation_id=$1 ORDER BY created_at DESC`,
      [organisationId],
    );
    return receipts.map((r) => ({
      id: r.id,
      event_type: r.event_type,
      created_at: r.created_at.toISOString(),
      amount_cents: r.payload?.data?.object?.amount_total ?? null,
      currency: r.payload?.data?.object?.currency ?? null,
    }));
  }

  async assertFeatureAllowed(
    tx: PostgresJsSql,
    organisationId: string,
    feature: Parameters<typeof assertFeatureEntitled>[1],
  ): Promise<void> {
    const sub = await this.getSubscriptionTier(tx, organisationId);
    try {
      assertFeatureEntitled(sub.tier, feature);
    } catch (err: unknown) {
      throw new ApiError(403, ErrorCode.ENTITLEMENT_REQUIRED, (err as Error).message);
    }
  }

  private async assertCompetitionFeatureAllowed(
    tx: PostgresJsSql,
    competitionId: string,
    feature: Parameters<typeof assertFeatureEntitled>[1],
  ): Promise<void> {
    const tier =
      (await tx.unsafe<{ tier: SubscriptionTier }>(`SELECT matchday_effective_plan_tier($1) tier`, [competitionId]))[0]
        ?.tier ?? "free";
    try {
      assertFeatureEntitled(tier, feature);
    } catch (err: unknown) {
      throw new ApiError(403, ErrorCode.ENTITLEMENT_REQUIRED, (err as Error).message);
    }
  }

  async assertEntryLimit(tx: PostgresJsSql, organisationId: string, requestedEntries: number): Promise<void> {
    const sub = await this.getSubscriptionTier(tx, organisationId);
    try {
      assertDomainEntryLimit(sub.tier, requestedEntries);
    } catch (err: unknown) {
      throw new ApiError(403, ErrorCode.ENTITLEMENT_LIMIT_EXCEEDED, (err as Error).message);
    }
  }

  async processBillingWebhook(
    signature: string | undefined,
    rawPayload: string,
    payload: StripeWebhookEvent,
    secret: string | undefined = this.options.webhookSecret,
  ): Promise<{ processed: boolean; eventType: string }> {
    if (!verifyStripeWebhookSignature(signature, rawPayload, secret)) {
      throw new ApiError(401, ErrorCode.AUTHENTICATION_REQUIRED, "Invalid Stripe webhook signature");
    }
    const stored = minimiseStripeEventForStorage(payload);
    const eventId = stored.id;
    const eventType = stored.type;
    const processed = await this.transaction(async (tx) => {
      const object = stored.data.object;
      let orgId = object.metadata.organisation_id ?? object.client_reference_id ?? null;
      if (!orgId && ["customer.subscription.updated", "customer.subscription.deleted"].includes(eventType)) {
        const subId = object.subscription ?? object.id;
        if (subId) {
          orgId =
            (
              await tx.unsafe<{ organisation_id: string }>(
                `SELECT organisation_id FROM organisation_subscriptions WHERE provider_subscription_id=$1`,
                [subId],
              )
            )[0]?.organisation_id ?? null;
        }
      }

      const claim = await tx.unsafe<{ id: string }>(
        `INSERT INTO billing_webhook_receipts
           (organisation_id, provider_event_id, event_type, status, payload, created_at, processed_at)
         VALUES ($1,$2,$3,'processed',($4::text)::jsonb,now(),now())
         ON CONFLICT (provider_event_id) DO NOTHING RETURNING id`,
        // Bind as text then cast: a parameter typed jsonb would be JSON-encoded a second time by the
        // driver and stored as a JSON *string*, invisible to the 0058 trigger and billing history.
        [orgId, eventId, eventType, JSON.stringify(stored)],
      );
      if (!claim[0]) {
        const existing = (
          await tx.unsafe<{ id: string }>(`SELECT id FROM billing_webhook_receipts WHERE provider_event_id=$1`, [
            eventId,
          ])
        )[0];
        if (existing) return false;
      }

      const isCompletion = eventType === "checkout.session.completed";
      const isAsyncSuccess = eventType === "checkout.session.async_payment_succeeded";
      if ((isCompletion || isAsyncSuccess) && orgId) {
        // A completed session with payment_status "unpaid" is a delayed payment method that is still
        // settling: fulfil only once Stripe reports the money as collected (here, or later via
        // checkout.session.async_payment_succeeded). A missing status fails closed.
        if (!object.payment_status || !PAID_CHECKOUT_STATES.has(object.payment_status)) return true;
        await this.fulfilCheckout(tx, orgId, eventId, object);
      } else if (eventType === "checkout.session.async_payment_failed" && orgId) {
        await this.revokeCheckout(tx, orgId, object);
      } else if (eventType === "customer.subscription.updated" && orgId) {
        const status = providerSubscriptionStatus(object.status);
        await tx.unsafe(
          `UPDATE organisation_subscriptions SET status=$2,
             current_period_start=COALESCE(to_timestamp($3::double precision),current_period_start),
             current_period_end=COALESCE(to_timestamp($4::double precision),current_period_end),updated_at=now()
           WHERE organisation_id=$1`,
          [orgId, status, object.current_period_start ?? null, object.current_period_end ?? null],
        );
        if (["active", "trialing"].includes(status)) {
          const subRecord = (
            await tx.unsafe<{ tier: SubscriptionTier }>(
              `SELECT tier FROM organisation_subscriptions WHERE organisation_id=$1`,
              [orgId],
            )
          )[0];
          if (subRecord) {
            const includedUnits = TIER_FEATURE_LIMITS[subRecord.tier]?.monthly_ai_actions ?? 0;
            if (includedUnits > 0) await this.seedIncludedAiAllowances(tx, orgId, includedUnits);
          }
        }
      } else if (eventType === "customer.subscription.deleted" && orgId) {
        await tx.unsafe(
          `UPDATE organisation_subscriptions SET tier='free',status='canceled',updated_at=now() WHERE organisation_id=$1`,
          [orgId],
        );
      }
      return true;
    });
    return { processed, eventType };
  }

  /** Grant keys hang off the Checkout Session so completed + async_succeeded can never double-grant. */
  private checkoutGrantKeys(eventId: string, object: StoredStripeObject, competitionId: string | null) {
    const anchor = object.id ? `session:${object.id}` : `event:${eventId}`;
    return {
      eventPass: `stripe:event-pass:${anchor}:${competitionId ?? "none"}`,
      topUp: `stripe:top-up:${anchor}`,
    };
  }

  private async fulfilCheckout(tx: PostgresJsSql, orgId: string, eventId: string, object: StoredStripeObject) {
    const purchaseType = object.metadata.purchase_type ?? (object.metadata.tier ? "plan" : "ai_top_up");
    const topUpUnits = Number.parseInt(object.metadata.top_up_units ?? "0", 10);
    let competitionId: string | null = null;
    if (purchaseType !== "ai_top_up") {
      const tierRaw = object.metadata.tier ?? "event_pass";
      const tier: SubscriptionTier = ["event_pass", "organiser_pro"].includes(tierRaw)
        ? (tierRaw as SubscriptionTier)
        : "event_pass";
      competitionId = tier === "event_pass" ? object.metadata.competition_id : null;
      if (tier === "event_pass" && !competitionId) {
        throw new ApiError(422, ErrorCode.VALIDATION_ERROR, "Event Pass webhook requires a competition");
      }
      if (competitionId) {
        await this.assertCompetitionBelongsToOrganisation(tx, competitionId, orgId);
      }
      if (tier === "event_pass" && competitionId) {
        await tx.unsafe(
          `INSERT INTO entitlement_grants
             (organisation_id,competition_id,tier,feature,source,quantity,idempotency_key,expires_at)
           SELECT c.organisation_id,c.id,'event_pass','unlimited_entries','purchase',1,$3,
                  ((c.ends_on + 1)::timestamp AT TIME ZONE c.timezone)
           FROM competitions c
           WHERE c.id=$1 AND c.organisation_id=$2
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [competitionId, orgId, this.checkoutGrantKeys(eventId, object, competitionId).eventPass],
        );
      } else if (tier === "organiser_pro") {
        await tx.unsafe(
          `INSERT INTO organisation_subscriptions
             (organisation_id,tier,status,provider_customer_id,provider_subscription_id,current_period_start,current_period_end,updated_at)
           VALUES ($1,'organiser_pro','active',$2,$3,
             COALESCE(to_timestamp($4::double precision),now()),
             COALESCE(to_timestamp($5::double precision),now()+interval '30 days'),now())
           ON CONFLICT (organisation_id) DO UPDATE SET
             tier='organiser_pro',status='active',
             provider_customer_id=COALESCE(EXCLUDED.provider_customer_id,organisation_subscriptions.provider_customer_id),
             provider_subscription_id=COALESCE(EXCLUDED.provider_subscription_id,organisation_subscriptions.provider_subscription_id),
             current_period_start=EXCLUDED.current_period_start,current_period_end=EXCLUDED.current_period_end,updated_at=now()`,
          [
            orgId,
            object.customer ?? null,
            object.subscription ?? null,
            object.current_period_start ?? null,
            object.current_period_end ?? null,
          ],
        );
        await this.seedIncludedAiAllowances(tx, orgId, TIER_FEATURE_LIMITS.organiser_pro.monthly_ai_actions);
      }
    }
    if (Number.isSafeInteger(topUpUnits) && topUpUnits > 0 && topUpUnits <= MAX_CHECKOUT_TOP_UP_UNITS) {
      const tier =
        (
          await tx.unsafe<{ tier: SubscriptionTier }>(
            `SELECT tier FROM organisation_subscriptions
             WHERE organisation_id=$1 AND status IN ('active','trialing')
               AND (current_period_end IS NULL OR current_period_end>now())`,
            [orgId],
          )
        )[0]?.tier ?? "free";
      await tx.unsafe(
        `INSERT INTO entitlement_grants (organisation_id,tier,feature,source,quantity,idempotency_key)
         VALUES ($1,$2,'ai_actions','top_up',$3,$4) ON CONFLICT (idempotency_key) DO NOTHING`,
        [orgId, tier, topUpUnits, this.checkoutGrantKeys(eventId, object, competitionId).topUp],
      );
    }
  }

  /**
   * checkout.session.async_payment_failed: the delayed payment never settled. Completion with
   * payment_status=unpaid does not fulfil, so normally nothing exists to undo; still expire anything
   * keyed to this session and demote a Pro subscription this session activated (defence in depth).
   */
  private async revokeCheckout(tx: PostgresJsSql, orgId: string, object: StoredStripeObject) {
    if (!object.id) return;
    await tx.unsafe(
      `UPDATE entitlement_grants SET expires_at=now()
       WHERE organisation_id=$1 AND idempotency_key = ANY($2::text[])
         AND (expires_at IS NULL OR expires_at>now())`,
      [
        orgId,
        [
          `stripe:top-up:session:${object.id}`,
          `stripe:event-pass:session:${object.id}:${object.metadata.competition_id ?? "none"}`,
        ],
      ],
    );
    if (object.metadata.tier === "organiser_pro" && object.subscription) {
      await tx.unsafe(
        `UPDATE organisation_subscriptions SET status='past_due',updated_at=now()
         WHERE organisation_id=$1 AND provider_subscription_id=$2`,
        [orgId, object.subscription],
      );
    }
  }

  private async seedIncludedAiAllowances(tx: PostgresJsSql, orgId: string, includedUnits: number) {
    await tx.unsafe(
      `INSERT INTO ai_usage_allowances (organisation_id, actor_account_id, action, period_start, action_limit)
       SELECT $1, m.account_id, action_value, date_trunc('month', now())::date, $2
       FROM organisation_memberships m
       CROSS JOIN unnest(ARRAY['text_to_brief','format_recommendations','format_modification','schedule_preferences','repair_recommendations']) action_value
       WHERE m.organisation_id=$1 AND m.status='active'
       ON CONFLICT (organisation_id, actor_account_id, action, period_start) DO UPDATE SET
         action_limit=GREATEST(ai_usage_allowances.action_limit, EXCLUDED.action_limit),
         updated_at=now()`,
      [orgId, includedUnits],
    );
    await tx.unsafe(
      `INSERT INTO ai_allowance_base_limits (organisation_id, actor_account_id, action, period_start, base_limit)
       SELECT $1, m.account_id, action_value, date_trunc('month', now())::date, $2
       FROM organisation_memberships m
       CROSS JOIN unnest(ARRAY['text_to_brief','format_recommendations','format_modification','schedule_preferences','repair_recommendations']) action_value
       WHERE m.organisation_id=$1 AND m.status='active'
       ON CONFLICT (organisation_id, actor_account_id, action, period_start) DO UPDATE SET
         base_limit=GREATEST(ai_allowance_base_limits.base_limit, EXCLUDED.base_limit)`,
      [orgId, includedUnits],
    );
    await tx.unsafe(`SELECT phase6_refresh_ai_allowance_headroom($1)`, [orgId]);
  }

  async createCheckoutSession(
    actor: Phase3Actor,
    organisationId: string,
    input:
      | { tier: "event_pass"; competitionId: string; topUpUnits?: number; successUrl: string; cancelUrl: string }
      | { tier: "organiser_pro"; topUpUnits?: number; successUrl: string; cancelUrl: string }
      | { purchaseType: "ai_top_up"; topUpUnits: number; successUrl: string; cancelUrl: string },
  ) {
    await this.assertOrganisationEditor(this.sql, organisationId, actor);
    const client = this.stripeClient ?? null;
    if (!client) throw new ApiError(503, ErrorCode.SERVICE_UNAVAILABLE, "Stripe payment provider is not configured");
    const allowedOrigins = this.options.checkoutRedirectOrigins ?? [];
    const successUrl = assertCheckoutRedirectUrl(input.successUrl, allowedOrigins);
    const cancelUrl = assertCheckoutRedirectUrl(input.cancelUrl, allowedOrigins);
    const units = input.topUpUnits;
    if (units !== undefined && (!Number.isSafeInteger(units) || units < 1 || units > MAX_CHECKOUT_TOP_UP_UNITS)) {
      throw new ApiError(
        422,
        ErrorCode.VALIDATION_ERROR,
        `AI top-up units must be an integer between 1 and ${MAX_CHECKOUT_TOP_UP_UNITS}`,
      );
    }
    // Same actor + same purchase within one minute maps to one Stripe session (double-submit safe).
    const idempotencyKey = `matchday-checkout-${createHash("sha256")
      .update(
        JSON.stringify([
          actor.accountId,
          organisationId,
          "purchaseType" in input ? "ai_top_up" : input.tier,
          "competitionId" in input ? input.competitionId : null,
          units ?? 0,
          successUrl,
          cancelUrl,
          Math.floor(Date.now() / 60_000),
        ]),
      )
      .digest("hex")}`;

    if ("purchaseType" in input) {
      if (!client.createTopUpSession) {
        throw new ApiError(503, ErrorCode.SERVICE_UNAVAILABLE, "Stripe AI top-up checkout is not configured");
      }
      const session = await client.createTopUpSession({
        organisationId,
        topUpUnits: input.topUpUnits,
        successUrl,
        cancelUrl,
        idempotencyKey,
      });
      return {
        session_id: session.sessionId,
        checkout_url: session.checkoutUrl,
        organisation_id: session.organisationId,
        competition_id: null,
        purchase_type: "ai_top_up" as const,
        tier: null,
        top_up_units: session.topUpUnits,
        amount_total: session.amountTotal,
        currency: session.currency,
        expires_at: session.expiresAt,
        success_url: session.successUrl,
        cancel_url: session.cancelUrl,
      };
    }

    if (input.tier === "event_pass") {
      await this.assertCompetitionBelongsToOrganisation(this.sql, input.competitionId, organisationId);
    }
    const competitionId = input.tier === "event_pass" ? input.competitionId : undefined;
    const session = await client.createSession({
      organisationId,
      ...(competitionId ? { competitionId } : {}),
      tier: input.tier,
      topUpUnits: input.topUpUnits,
      successUrl,
      cancelUrl,
      idempotencyKey,
    });
    return {
      session_id: session.sessionId,
      checkout_url: session.checkoutUrl,
      organisation_id: session.organisationId,
      competition_id: session.competitionId ?? null,
      purchase_type: "plan" as const,
      tier: session.tier,
      top_up_units: session.topUpUnits,
      amount_total: session.amountTotal,
      currency: session.currency,
      expires_at: session.expiresAt,
      success_url: session.successUrl,
      cancel_url: session.cancelUrl,
    };
  }

  async getBranding(competitionId: string): Promise<CompetitionBranding | null> {
    const rows = await this.sql.unsafe<CompetitionBranding>(
      `SELECT competition_id, primary_color, secondary_color, logo_url, banner_url, hide_platform_badge
       FROM competition_branding WHERE competition_id=$1`,
      [competitionId],
    );
    return rows[0] ?? null;
  }

  async setBranding(
    actor: Phase3Actor,
    organisationId: string,
    competitionId: string,
    input: Partial<CompetitionBranding>,
  ): Promise<CompetitionBranding> {
    return this.transaction(async (tx) => {
      await this.assertCompetitionBelongsToOrganisation(tx, competitionId, organisationId);
      await this.assertOrganisationEditor(tx, organisationId, actor);
      const hasCustomBranding = Boolean(
        input.primary_color || input.secondary_color || input.logo_url || input.banner_url || input.hide_platform_badge,
      );
      if (hasCustomBranding) await this.assertCompetitionFeatureAllowed(tx, competitionId, "custom_branding");
      return (
        await tx.unsafe<CompetitionBranding>(
          `INSERT INTO competition_branding
             (competition_id,primary_color,secondary_color,logo_url,banner_url,hide_platform_badge,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,now())
           ON CONFLICT (competition_id) DO UPDATE SET
             primary_color=COALESCE(EXCLUDED.primary_color,competition_branding.primary_color),
             secondary_color=COALESCE(EXCLUDED.secondary_color,competition_branding.secondary_color),
             logo_url=COALESCE(EXCLUDED.logo_url,competition_branding.logo_url),
             banner_url=COALESCE(EXCLUDED.banner_url,competition_branding.banner_url),
             hide_platform_badge=COALESCE(EXCLUDED.hide_platform_badge,competition_branding.hide_platform_badge),updated_at=now()
           RETURNING competition_id,primary_color,secondary_color,logo_url,banner_url,hide_platform_badge`,
          [
            competitionId,
            input.primary_color ?? null,
            input.secondary_color ?? null,
            input.logo_url ?? null,
            input.banner_url ?? null,
            input.hide_platform_badge ?? false,
          ],
        )
      )[0]!;
    });
  }

  async getSponsors(competitionId: string): Promise<CompetitionSponsor[]> {
    return [
      ...(await this.sql.unsafe<CompetitionSponsor>(
        `SELECT id,competition_id,name,tier,logo_url,website_url,sort_order
         FROM competition_sponsors WHERE competition_id=$1 ORDER BY sort_order,created_at`,
        [competitionId],
      )),
    ];
  }

  async addSponsor(
    actor: Phase3Actor,
    organisationId: string,
    competitionId: string,
    input: {
      name: string;
      tier?: "headline" | "tier1" | "tier2" | "community";
      logo_url?: string | null;
      website_url?: string | null;
      sort_order?: number;
    },
  ): Promise<CompetitionSponsor> {
    return this.transaction(async (tx) => {
      await this.assertCompetitionBelongsToOrganisation(tx, competitionId, organisationId);
      await this.assertOrganisationEditor(tx, organisationId, actor);
      await this.assertCompetitionFeatureAllowed(tx, competitionId, "sponsor_placements");
      return (
        await tx.unsafe<CompetitionSponsor>(
          `INSERT INTO competition_sponsors (competition_id,name,tier,logo_url,website_url,sort_order)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,competition_id,name,tier,logo_url,website_url,sort_order`,
          [
            competitionId,
            input.name.trim(),
            input.tier ?? "community",
            input.logo_url ?? null,
            input.website_url ?? null,
            input.sort_order ?? 0,
          ],
        )
      )[0]!;
    });
  }

  async setSponsors(
    actor: Phase3Actor,
    organisationId: string,
    competitionId: string,
    sponsors: Array<{
      name: string;
      tier: "headline" | "tier1" | "tier2" | "community";
      logo_url?: string;
      website_url?: string;
      sort_order: number;
    }>,
  ): Promise<CompetitionSponsor[]> {
    return this.transaction(async (tx) => {
      await this.assertCompetitionBelongsToOrganisation(tx, competitionId, organisationId);
      await this.assertOrganisationEditor(tx, organisationId, actor);
      await this.assertCompetitionFeatureAllowed(tx, competitionId, "sponsor_placements");
      await tx.unsafe(`DELETE FROM competition_sponsors WHERE competition_id=$1`, [competitionId]);
      const insertedList: CompetitionSponsor[] = [];
      for (const s of sponsors) {
        insertedList.push(
          (
            await tx.unsafe<CompetitionSponsor>(
              `INSERT INTO competition_sponsors (competition_id,name,tier,logo_url,website_url,sort_order)
               VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,competition_id,name,tier,logo_url,website_url,sort_order`,
              [competitionId, s.name.trim(), s.tier, s.logo_url ?? null, s.website_url ?? null, s.sort_order],
            )
          )[0]!,
        );
      }
      return insertedList;
    });
  }

  private async assertCompetitionBelongsToOrganisation(
    tx: PostgresJsSql,
    competitionId: string,
    organisationId: string,
  ): Promise<void> {
    const rows = await tx.unsafe<{ organisation_id: string }>(`SELECT organisation_id FROM competitions WHERE id=$1`, [
      competitionId,
    ]);
    if (!rows[0] || rows[0].organisation_id !== organisationId) {
      throw new ApiError(404, ErrorCode.COMPETITION_NOT_FOUND, "Competition not found in organisation");
    }
  }

  private async assertOrganisationMember(tx: PostgresJsSql, organisationId: string, actor: Phase3Actor): Promise<void> {
    const rows = await tx.unsafe(
      `SELECT 1 FROM organisation_memberships WHERE organisation_id=$1 AND account_id=$2 AND status='active'`,
      [organisationId, actor.accountId],
    );
    if (!rows[0]) throw new ApiError(403, ErrorCode.ORGANISATION_ACCESS_DENIED, "Access denied to organisation");
  }

  private async assertOrganisationEditor(tx: PostgresJsSql, organisationId: string, actor: Phase3Actor): Promise<void> {
    const rows = await tx.unsafe(
      `SELECT 1 FROM organisation_memberships
       WHERE organisation_id=$1 AND account_id=$2 AND status='active' AND role IN ('owner','organiser')`,
      [organisationId, actor.accountId],
    );
    if (!rows[0])
      throw new ApiError(403, ErrorCode.ORGANISATION_ACCESS_DENIED, "Write access to organisation required");
  }
}
