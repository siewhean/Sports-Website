import type { PostgresJsSql } from "@matchday/identity";
import { AdminRuntime } from "./admin-runtime.js";
import type { Phase3Actor } from "./phase-3-runtime.js";

/**
 * Production admin runtime with the canonical audit timestamp contract.
 * audit_events is append-only and stores its event timestamp as occurred_at;
 * expose it as created_at to preserve the existing admin API response shape.
 */
export class ProductionAdminRuntime extends AdminRuntime {
  constructor(private readonly auditSql: PostgresJsSql) {
    super(auditSql);
  }

  override async getAuditEvents(
    actor: Phase3Actor,
    filters: { organisationId?: string | undefined; action?: string | undefined; limit?: number | undefined },
  ) {
    await this.assertPlatformAdmin(actor);
    const limit = Math.min(Math.max(1, filters.limit ?? 50), 200);
    const rows = await this.auditSql.unsafe<{
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
      `SELECT id, request_id, actor_account_id, actor_type, organisation_id, action, target_type, target_id,
              metadata, occurred_at AS created_at
       FROM audit_events
       WHERE ($1::uuid IS NULL OR organisation_id=$1)
         AND ($2::text IS NULL OR action=$2)
       ORDER BY occurred_at DESC
       LIMIT $3`,
      [filters.organisationId ?? null, filters.action ?? null, limit],
    );

    return rows.map((row) => ({ ...row, created_at: row.created_at.toISOString() }));
  }
}
