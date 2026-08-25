import { randomUUID } from "node:crypto";
import type { PostgresJsSql } from "@matchday/identity";
import { type SubscriptionTier, ErrorCode } from "@matchday/contracts";
import { ApiError } from "./errors.js";
import type { Phase3Actor } from "./phase-3-runtime.js";

export class AdminRuntime {
  constructor(private readonly sql: PostgresJsSql) {}

  async assertPlatformAdmin(actor: Phase3Actor): Promise<void> {
    const rows = await this.sql.unsafe(
      `SELECT 1 FROM account_platform_roles
       WHERE account_id=$1 AND role='platform_admin' AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())`,
      [actor.accountId],
    );
    if (!rows[0]) {
      throw new ApiError(403, ErrorCode.PLATFORM_ADMIN_REQUIRED, "Platform administrator privileges required");
    }
  }

  async listOrganisations(actor: Phase3Actor) {
    await this.assertPlatformAdmin(actor);
    const rows = await this.sql.unsafe<{
      id: string;
      name: string;
      created_at: Date;
      tier: string | null;
      sub_status: string | null;
      competition_count: number;
      member_count: number;
    }>(
      `SELECT
         o.id,
         o.name,
         o.created_at,
         s.tier,
         s.status as sub_status,
         (SELECT count(*)::integer FROM competitions WHERE organisation_id=o.id) as competition_count,
         (SELECT count(*)::integer FROM organisation_memberships WHERE organisation_id=o.id) as member_count
       FROM organisations o
       LEFT JOIN organisation_subscriptions s ON s.organisation_id = o.id
       ORDER BY o.created_at DESC`,
    );

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      tier: (r.tier ?? "free") as SubscriptionTier,
      status: r.sub_status ?? "active",
      competition_count: r.competition_count,
      member_count: r.member_count,
      created_at: r.created_at.toISOString(),
    }));
  }

  async getOrganisationDetails(actor: Phase3Actor, orgId: string) {
    await this.assertPlatformAdmin(actor);
    const org = (
      await this.sql.unsafe<{ id: string; name: string; created_at: Date }>(
        `SELECT id, name, created_at FROM organisations WHERE id=$1`,
        [orgId],
      )
    )[0];
    if (!org) {
      throw new ApiError(404, ErrorCode.ORGANISATION_ACCESS_DENIED, "Organisation not found");
    }

    const sub = (
      await this.sql.unsafe<{
        tier: string;
        status: string;
        current_period_start: Date;
        current_period_end: Date | null;
      }>(
        `SELECT tier, status, current_period_start, current_period_end
         FROM organisation_subscriptions WHERE organisation_id=$1`,
        [orgId],
      )
    )[0];

    const grants = await this.sql.unsafe<{
      id: string;
      tier: string;
      feature: string;
      source: string;
      quantity: number;
      created_at: Date;
    }>(
      `SELECT id, tier, feature, source, quantity, created_at
       FROM entitlement_grants WHERE organisation_id=$1 ORDER BY created_at DESC`,
      [orgId],
    );

    const competitions = await this.sql.unsafe<{
      id: string;
      name: string;
      sport_code: string;
      status: string;
      created_at: Date;
    }>(
      `SELECT id, name, sport_code, status, created_at
       FROM competitions WHERE organisation_id=$1 ORDER BY created_at DESC`,
      [orgId],
    );

    return {
      organisation: {
        id: org.id,
        name: org.name,
        created_at: org.created_at.toISOString(),
      },
      subscription: sub
        ? {
            tier: sub.tier,
            status: sub.status,
            current_period_start: sub.current_period_start.toISOString(),
            current_period_end: sub.current_period_end ? sub.current_period_end.toISOString() : null,
          }
        : {
            tier: "free",
            status: "active",
            current_period_start: org.created_at.toISOString(),
            current_period_end: null,
          },
      entitlement_grants: grants.map((g) => ({
        ...g,
        created_at: g.created_at.toISOString(),
      })),
      competitions: competitions.map((c) => ({
        ...c,
        created_at: c.created_at.toISOString(),
      })),
    };
  }

  async updateEntitlements(
    actor: Phase3Actor,
    orgId: string,
    input: { tier?: SubscriptionTier; topUpAiUnits?: number; reason?: string },
    requestId: string,
  ) {
    await this.assertPlatformAdmin(actor);
    const sqlInstance = this.sql as unknown as {
      begin?: <T>(cb: (tx: PostgresJsSql) => Promise<T>) => Promise<T>;
    };
    const beginFn =
      typeof sqlInstance.begin === "function"
        ? sqlInstance.begin.bind(sqlInstance)
        : async <T>(cb: (tx: PostgresJsSql) => Promise<T>) => cb(this.sql);
    return beginFn(async (tx: PostgresJsSql) => {
      if (input.tier) {
        await tx.unsafe(
          `INSERT INTO organisation_subscriptions (organisation_id, tier, status, updated_at)
           VALUES ($1, $2, 'active', now())
           ON CONFLICT (organisation_id) DO UPDATE SET tier=EXCLUDED.tier, status='active', updated_at=now()`,
          [orgId, input.tier],
        );
      }
      if (input.topUpAiUnits && input.topUpAiUnits > 0) {
        await tx.unsafe(
          `INSERT INTO entitlement_grants (organisation_id, tier, feature, source, quantity, idempotency_key)
           VALUES ($1, $2, 'ai_actions', 'admin_grant', $3, $4)`,
          [orgId, input.tier ?? "free", input.topUpAiUnits, `admin:${randomUUID()}`],
        );
      }

      await tx.unsafe(
        `INSERT INTO audit_events (request_id, actor_account_id, actor_type, organisation_id, action, target_type, target_id, metadata)
         VALUES ($1, $2, 'platform_admin', $3, 'admin.entitlements.updated', 'organisation', $3, $4::jsonb)`,
        [
          requestId,
          actor.accountId,
          orgId,
          JSON.stringify({
            tier: input.tier,
            top_up_ai_units: input.topUpAiUnits,
            reason: input.reason ?? "Admin grant",
          }),
        ],
      );

      return { success: true };
    });
  }

  async getAiAccountingSummary(actor: Phase3Actor) {
    await this.assertPlatformAdmin(actor);
    const summary = (
      await this.sql.unsafe<{
        total_requests: number;
        cache_hits: number;
        total_prompt_tokens: number;
        total_completion_tokens: number;
        total_cost_usd: number;
        avg_latency_ms: number;
      }>(
        `SELECT
           count(*)::integer as total_requests,
           count(*) FILTER (WHERE cache_status='hit')::integer as cache_hits,
           COALESCE(sum(prompt_tokens), 0)::integer as total_prompt_tokens,
           COALESCE(sum(completion_tokens), 0)::integer as total_completion_tokens,
           COALESCE(sum(estimated_cost_usd), 0)::numeric as total_cost_usd,
           COALESCE(avg(latency_ms), 0)::integer as avg_latency_ms
         FROM ai_action_ledger`,
      )
    )[0]!;

    const byAction = await this.sql.unsafe<{
      action: string;
      request_count: number;
      total_tokens: number;
      total_cost_usd: number;
    }>(
      `SELECT
         action,
         count(*)::integer as request_count,
         COALESCE(sum(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)), 0)::integer as total_tokens,
         COALESCE(sum(estimated_cost_usd), 0)::numeric as total_cost_usd
       FROM ai_action_ledger
       GROUP BY action
       ORDER BY request_count DESC`,
    );

    return {
      total_requests: summary.total_requests,
      cache_hits: summary.cache_hits,
      cache_hit_rate: summary.total_requests > 0 ? summary.cache_hits / summary.total_requests : 0,
      total_prompt_tokens: summary.total_prompt_tokens,
      total_completion_tokens: summary.total_completion_tokens,
      total_tokens: summary.total_prompt_tokens + summary.total_completion_tokens,
      total_cost_usd: Number(summary.total_cost_usd),
      avg_latency_ms: summary.avg_latency_ms,
      actions: byAction.map((a) => ({
        action: a.action,
        request_count: a.request_count,
        total_tokens: a.total_tokens,
        total_cost_usd: Number(a.total_cost_usd),
      })),
    };
  }

  async getAuditEvents(
    actor: Phase3Actor,
    filters: { organisationId?: string | undefined; action?: string | undefined; limit?: number | undefined },
  ) {
    await this.assertPlatformAdmin(actor);
    const limit = Math.min(Math.max(1, filters.limit ?? 50), 200);

    const rows = await this.sql.unsafe<{
      id: string;
      request_id: string;
      actor_account_id: string;
      actor_type: string;
      organisation_id: string | null;
      action: string;
      target_type: string;
      target_id: string;
      metadata: unknown;
      created_at: Date;
    }>(
      `SELECT id, request_id, actor_account_id, actor_type, organisation_id, action, target_type, target_id, metadata, created_at
       FROM audit_events
       WHERE ($1::uuid IS NULL OR organisation_id=$1)
         AND ($2::text IS NULL OR action=$2)
       ORDER BY created_at DESC
       LIMIT $3`,
      [filters.organisationId ?? null, filters.action ?? null, limit],
    );

    return rows.map((r) => ({
      ...r,
      created_at: r.created_at.toISOString(),
    }));
  }
}
