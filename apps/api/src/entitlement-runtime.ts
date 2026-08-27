import { createHmac, timingSafeEqual } from "node:crypto";
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
import { type StripeCheckoutClientPort, HttpStripeCheckoutClient } from "./stripe-checkout-client.js";

export function verifyStripeWebhookSignature(
  signatureHeader: string | undefined,
  rawPayload: string,
  secret: string | undefined = process.env.STRIPE_WEBHOOK_SECRET,
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

export class EntitlementRuntime {
  constructor(
    private readonly sql: PostgresJsSql,
    private readonly stripeClient?: StripeCheckoutClientPort,
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
      record &&
      ["active", "trialing"].includes(record.status) &&
      (!record.current_period_end || record.current_period_end.getTime() > Date.now()),
    );
    if (!record || !paidState) {
      return { tier: "free", status: record?.status ?? "active", currentPeriodEnd: record?.current_period_end ?? null };
    }
    return {
      tier: record.tier as SubscriptionTier,
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
    payload: BillingWebhookPayload,
    secret: string | undefined = process.env.STRIPE_WEBHOOK_SECRET,
  ): Promise<{ processed: boolean; eventType: string }> {
    if (!verifyStripeWebhookSignature(signature, rawPayload, secret)) {
      throw new ApiError(401, ErrorCode.AUTHENTICATION_REQUIRED, "Invalid Stripe webhook signature");
    }
    const eventId = payload.id;
    const eventType = payload.type;
    const processed = await this.transaction(async (tx) => {
      const object = payload.data.object;
      let orgId = object.metadata?.organisation_id ?? object.client_reference_id ?? null;
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
         VALUES ($1,$2,$3,'processed',$4::jsonb,now(),now())
         ON CONFLICT (provider_event_id) DO NOTHING RETURNING id`,
        [orgId, eventId, eventType, JSON.stringify(payload)],
      );
      if (!claim[0]) {
        const existing = (
          await tx.unsafe<{ id: string }>(`SELECT id FROM billing_webhook_receipts WHERE provider_event_id=$1`, [
            eventId,
          ])
        )[0];
        if (existing) return false;
      }

      if (eventType === "checkout.session.completed" && orgId) {
        const purchaseType = object.metadata?.purchase_type ?? (object.metadata?.tier ? "plan" : "ai_top_up");
        const topUpUnits = Number.parseInt(object.metadata?.top_up_units ?? "0", 10);
        if (purchaseType !== "ai_top_up") {
          const tierRaw = object.metadata?.tier ?? "event_pass";
          const tier: SubscriptionTier = ["event_pass", "organiser_pro"].includes(tierRaw)
            ? (tierRaw as SubscriptionTier)
            : "event_pass";
          await tx.unsafe(
            `INSERT INTO organisation_subscriptions
               (organisation_id,tier,status,provider_customer_id,provider_subscription_id,current_period_start,current_period_end,updated_at)
             VALUES ($1,$2,'active',$3,$4,
               COALESCE(to_timestamp($5::double precision),now()),
               COALESCE(to_timestamp($6::double precision),now()+interval '30 days'),now())
             ON CONFLICT (organisation_id) DO UPDATE SET
               tier=EXCLUDED.tier,status='active',
               provider_customer_id=COALESCE(EXCLUDED.provider_customer_id,organisation_subscriptions.provider_customer_id),
               provider_subscription_id=COALESCE(EXCLUDED.provider_subscription_id,organisation_subscriptions.provider_subscription_id),
               current_period_start=EXCLUDED.current_period_start,current_period_end=EXCLUDED.current_period_end,updated_at=now()`,
            [
              orgId,
              tier,
              object.customer ?? null,
              object.subscription ?? null,
              object.current_period_start ?? null,
              object.current_period_end ?? null,
            ],
          );
        }
        if (Number.isSafeInteger(topUpUnits) && topUpUnits > 0) {
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
            [orgId, tier, topUpUnits, `webhook:${eventId}`],
          );
        }
      } else if (eventType === "customer.subscription.updated" && orgId) {
        const status = providerSubscriptionStatus(object.status);
        await tx.unsafe(
          `UPDATE organisation_subscriptions SET status=$2,
             current_period_start=COALESCE(to_timestamp($3::double precision),current_period_start),
             current_period_end=COALESCE(to_timestamp($4::double precision),current_period_end),updated_at=now()
           WHERE organisation_id=$1`,
          [orgId, status, object.current_period_start ?? null, object.current_period_end ?? null],
        );
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

  async createCheckoutSession(
    actor: Phase3Actor,
    organisationId: string,
    input:
      | { tier: "event_pass" | "organiser_pro"; topUpUnits?: number; successUrl: string; cancelUrl: string }
      | { purchaseType: "ai_top_up"; topUpUnits: number; successUrl: string; cancelUrl: string },
  ) {
    await this.assertOrganisationMember(this.sql, organisationId, actor);
    const client =
      this.stripeClient ??
      (process.env.STRIPE_SECRET_KEY ? new HttpStripeCheckoutClient(process.env.STRIPE_SECRET_KEY) : null);
    if (!client) throw new ApiError(503, ErrorCode.SERVICE_UNAVAILABLE, "Stripe payment provider is not configured");

    if ("purchaseType" in input) {
      if (!client.createTopUpSession) {
        throw new ApiError(503, ErrorCode.SERVICE_UNAVAILABLE, "Stripe AI top-up checkout is not configured");
      }
      const session = await client.createTopUpSession({
        organisationId,
        topUpUnits: input.topUpUnits,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
      });
      return {
        session_id: session.sessionId,
        checkout_url: session.checkoutUrl,
        organisation_id: session.organisationId,
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

    const session = await client.createSession({
      organisationId,
      tier: input.tier,
      topUpUnits: input.topUpUnits,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
    });
    return {
      session_id: session.sessionId,
      checkout_url: session.checkoutUrl,
      organisation_id: session.organisationId,
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
      await this.assertOrganisationMember(tx, organisationId, actor);
      const hasCustomBranding = Boolean(
        input.primary_color || input.secondary_color || input.logo_url || input.banner_url || input.hide_platform_badge,
      );
      if (hasCustomBranding) await this.assertFeatureAllowed(tx, organisationId, "custom_branding");
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
      await this.assertOrganisationMember(tx, organisationId, actor);
      await this.assertFeatureAllowed(tx, organisationId, "sponsor_placements");
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
      await this.assertOrganisationMember(tx, organisationId, actor);
      await this.assertFeatureAllowed(tx, organisationId, "sponsor_placements");
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
}
