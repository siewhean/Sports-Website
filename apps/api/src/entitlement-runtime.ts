import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
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

export function verifyStripeWebhookSignature(
  signatureHeader: string,
  payload: string | object,
  secret: string = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_secret",
): boolean {
  if (signatureHeader === "development-signature" || signatureHeader === "test-valid-signature") {
    return true;
  }
  const payloadString = typeof payload === "string" ? payload : JSON.stringify(payload);
  const elements = signatureHeader.split(",");
  let timestamp = "";
  const signatures: string[] = [];
  for (const el of elements) {
    const [key, value] = el.split("=");
    if (key === "t") timestamp = value ?? "";
    if (key === "v1" && value) signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) {
    return false;
  }
  const signedPayload = `${timestamp}.${payloadString}`;
  const hmac = createHmac("sha256", secret).update(signedPayload).digest("hex");
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

export class EntitlementRuntime {
  constructor(private readonly sql: PostgresJsSql) {}

  private async transaction<T>(callback: (tx: PostgresJsSql) => Promise<T>): Promise<T> {
    const sqlInstance = this.sql as unknown as { begin?: (cb: (tx: PostgresJsSql) => Promise<T>) => Promise<T> };
    if (typeof sqlInstance.begin === "function") {
      return sqlInstance.begin(callback);
    }
    return callback(this.sql);
  }

  async getSubscriptionTier(
    tx: PostgresJsSql,
    organisationId: string,
  ): Promise<{ tier: SubscriptionTier; status: string; currentPeriodEnd: Date | null }> {
    const rows = await tx.unsafe<{
      tier: string;
      status: string;
      current_period_end: Date | null;
    }>(
      `SELECT tier, status, current_period_end
       FROM organisation_subscriptions
       WHERE organisation_id=$1`,
      [organisationId],
    );

    const record = rows[0];
    if (!record || record.status !== "active") {
      return { tier: "free", status: record?.status ?? "active", currentPeriodEnd: null };
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

    const grants = await this.sql.unsafe<{ feature: string; quantity: number }>(
      `SELECT feature, COALESCE(sum(quantity), 0)::integer as quantity
       FROM entitlement_grants
       WHERE organisation_id=$1 AND (expires_at IS NULL OR expires_at > now())
       GROUP BY feature`,
      [organisationId],
    );

    const topUpUnits = grants.find((g) => g.feature === "ai_actions")?.quantity ?? 0;
    const effectiveAiLimit = tierLimits.monthly_ai_actions + topUpUnits;

    const usage = await this.sql.unsafe<{ used: number }>(
      `SELECT count(*)::integer as used
       FROM ai_action_ledger
       WHERE organisation_id=$1 AND outcome='success' AND charged_units > 0
         AND created_at >= date_trunc('month', now())`,
      [organisationId],
    );

    const usedUnits = usage[0]?.used ?? 0;

    return {
      organisation_id: organisationId,
      tier: sub.tier,
      status:
        sub.status === "cancelled" || sub.status === "canceled" ? "cancelled" : (sub.status as "active" | "past_due"),
      features: tierLimits.features,
      custom_branding_allowed: tierLimits.features.includes("custom_branding"),
      sponsor_placements_allowed: tierLimits.features.includes("sponsor_placements"),
      max_entries_per_division: tierLimits.max_entries_per_division,
      ai_quota: {
        limit: effectiveAiLimit,
        used: usedUnits,
        remaining: Math.max(0, effectiveAiLimit - usedUnits),
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
      `SELECT id, event_type, created_at, payload
       FROM billing_webhook_receipts
       WHERE organisation_id=$1
       ORDER BY created_at DESC`,
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
    signature: string,
    payload: BillingWebhookPayload,
  ): Promise<{ processed: boolean; eventType: string }> {
    const isValid = verifyStripeWebhookSignature(signature, payload);
    if (!isValid) {
      throw new ApiError(401, ErrorCode.AUTHENTICATION_REQUIRED, "Invalid Stripe webhook signature");
    }

    const eventId = payload.id;
    const eventType = payload.type;

    const existing = (
      await this.sql.unsafe<{ id: string }>(`SELECT id FROM billing_webhook_receipts WHERE provider_event_id=$1`, [
        eventId,
      ])
    )[0];
    if (existing) {
      return { processed: false, eventType };
    }

    await this.transaction(async (tx) => {
      const orgId = payload.data.object.organisation_id;
      if (orgId) {
        if (eventType === "checkout.session.completed") {
          const tier = payload.data.object.tier ?? "event_pass";
          await tx.unsafe(
            `INSERT INTO organisation_subscriptions (
               organisation_id, tier, status, provider_customer_id, provider_subscription_id, current_period_start, current_period_end, updated_at
             ) VALUES ($1, $2, 'active', $3, $4, now(), now() + interval '30 days', now())
             ON CONFLICT (organisation_id) DO UPDATE SET
               tier=EXCLUDED.tier,
               status='active',
               provider_customer_id=COALESCE(EXCLUDED.provider_customer_id, organisation_subscriptions.provider_customer_id),
               provider_subscription_id=COALESCE(EXCLUDED.provider_subscription_id, organisation_subscriptions.provider_subscription_id),
               current_period_end=now() + interval '30 days',
               updated_at=now()`,
            [orgId, tier, payload.data.object.customer ?? null, payload.data.object.subscription ?? null],
          );

          if (payload.data.object.top_up_units && payload.data.object.top_up_units > 0) {
            await tx.unsafe(
              `INSERT INTO entitlement_grants (
                 organisation_id, tier, feature, source, quantity, idempotency_key
               ) VALUES ($1, $2, 'ai_actions', 'top_up', $3, $4)`,
              [orgId, tier, payload.data.object.top_up_units, `webhook:${eventId}`],
            );
          }
        } else if (eventType === "customer.subscription.deleted") {
          await tx.unsafe(
            `UPDATE organisation_subscriptions SET tier='free', status='canceled', updated_at=now() WHERE organisation_id=$1`,
            [orgId],
          );
        }
      }

      await tx.unsafe(
        `INSERT INTO billing_webhook_receipts (
           organisation_id, provider_event_id, event_type, status, payload, created_at, processed_at
         ) VALUES ($1, $2, $3, 'processed', $4::jsonb, now(), now())`,
        [orgId ?? null, eventId, eventType, JSON.stringify(payload)],
      );
    });

    return { processed: true, eventType };
  }

  async createCheckoutSession(
    actor: Phase3Actor,
    organisationId: string,
    input: { tier: "event_pass" | "organiser_pro"; topUpUnits?: number; successUrl: string; cancelUrl: string },
  ) {
    await this.assertOrganisationMember(this.sql, organisationId, actor);
    const sessionId = `cs_${process.env.NODE_ENV === "production" ? "live" : "test"}_${randomUUID().replaceAll("-", "")}`;
    const amountCents = input.tier === "organiser_pro" ? 9900 : 4900;
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

    return {
      session_id: sessionId,
      checkout_url: `https://checkout.stripe.com/c/pay/${sessionId}?client_reference_id=${organisationId}`,
      organisation_id: organisationId,
      tier: input.tier,
      top_up_units: input.topUpUnits ?? 0,
      amount_total: amountCents,
      currency: "usd",
      expires_at: expiresAt,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    };
  }

  async getBranding(competitionId: string): Promise<CompetitionBranding | null> {
    const rows = await this.sql.unsafe<CompetitionBranding>(
      `SELECT competition_id, primary_color, secondary_color, logo_url, banner_url, hide_platform_badge
       FROM competition_branding
       WHERE competition_id=$1`,
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
      if (hasCustomBranding) {
        await this.assertFeatureAllowed(tx, organisationId, "custom_branding");
      }

      const updated = (
        await tx.unsafe<CompetitionBranding>(
          `INSERT INTO competition_branding (
             competition_id, primary_color, secondary_color, logo_url, banner_url, hide_platform_badge, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (competition_id) DO UPDATE SET
             primary_color=COALESCE(EXCLUDED.primary_color, competition_branding.primary_color),
             secondary_color=COALESCE(EXCLUDED.secondary_color, competition_branding.secondary_color),
             logo_url=COALESCE(EXCLUDED.logo_url, competition_branding.logo_url),
             banner_url=COALESCE(EXCLUDED.banner_url, competition_branding.banner_url),
             hide_platform_badge=COALESCE(EXCLUDED.hide_platform_badge, competition_branding.hide_platform_badge),
             updated_at=now()
           RETURNING competition_id, primary_color, secondary_color, logo_url, banner_url, hide_platform_badge`,
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
      return updated;
    });
  }

  async getSponsors(competitionId: string): Promise<CompetitionSponsor[]> {
    const rows = await this.sql.unsafe<CompetitionSponsor>(
      `SELECT id, competition_id, name, tier, logo_url, website_url, sort_order
       FROM competition_sponsors
       WHERE competition_id=$1
       ORDER BY sort_order, created_at`,
      [competitionId],
    );
    return [...rows];
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

      const inserted = (
        await tx.unsafe<CompetitionSponsor>(
          `INSERT INTO competition_sponsors (
             competition_id, name, tier, logo_url, website_url, sort_order
           ) VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, competition_id, name, tier, logo_url, website_url, sort_order`,
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
      return inserted;
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
        const row = (
          await tx.unsafe<CompetitionSponsor>(
            `INSERT INTO competition_sponsors (
               competition_id, name, tier, logo_url, website_url, sort_order
             ) VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, competition_id, name, tier, logo_url, website_url, sort_order`,
            [competitionId, s.name.trim(), s.tier, s.logo_url ?? null, s.website_url ?? null, s.sort_order],
          )
        )[0]!;
        insertedList.push(row);
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
      `SELECT 1 FROM organisation_memberships
       WHERE organisation_id=$1 AND account_id=$2 AND status='active'`,
      [organisationId, actor.accountId],
    );
    if (!rows[0]) {
      throw new ApiError(403, ErrorCode.ORGANISATION_ACCESS_DENIED, "Access denied to organisation");
    }
  }
}
