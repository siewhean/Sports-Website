import { randomUUID } from "node:crypto";
import type { PostgresJsSql } from "@matchday/identity";
import { AdminRuntime } from "./admin-runtime.js";
import type { Phase3Actor } from "./phase-3-runtime.js";

/**
 * Production admin runtime with canonical, append-only support audit evidence.
 * audit_events stores timestamps as occurred_at; expose it as created_at to
 * preserve the existing admin API response shape.
 */
export class ProductionAdminRuntime extends AdminRuntime {
  constructor(sql: PostgresJsSql) {
    super(sql);
  }

  private async recordSupportAudit(
    tx: PostgresJsSql,
    actor: Phase3Actor,
    action: string,
    targetType: string,
    targetId: string,
    organisationId: string | null,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await tx.unsafe(
      `INSERT INTO audit_events
         (request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id,metadata)
       VALUES ($1,$2,'platform_admin',$3,$4,$5,$6,$7::jsonb)`,
      [`admin:${action}:${randomUUID()}`, actor.accountId, organisationId, action, targetType, targetId, metadata],
    );
  }

  private async accessPassOrganisation(tx: PostgresJsSql, passId: string): Promise<string | null> {
    const row = (
      await tx.unsafe<{ organisation_id: string }>(
        `SELECT c.organisation_id
         FROM scoring_access_passes pass
         JOIN competitions c ON c.id=pass.competition_id
         WHERE pass.id=$1`,
        [passId],
      )
    )[0];
    return row?.organisation_id ?? null;
  }

  override async revokeAccessPass(actor: Phase3Actor, passId: string, reason?: string) {
    await this.assertPlatformAdmin(actor);
    return this.inTransaction(async (tx) => {
      const organisationId = await this.accessPassOrganisation(tx, passId);
      const result = await this.revokeAccessPassInTransaction(tx, actor, passId, reason);
      await this.recordSupportAudit(
        tx,
        actor,
        "admin.access_pass.revoked",
        "scoring_access_pass",
        passId,
        organisationId,
        { status: result.status, revocation_reason: result.revocation_reason },
      );
      return result;
    });
  }

  override async resetAccessPass(actor: Phase3Actor, passId: string) {
    await this.assertPlatformAdmin(actor);
    return this.inTransaction(async (tx) => {
      const organisationId = await this.accessPassOrganisation(tx, passId);
      const result = await this.resetAccessPassInTransaction(tx, actor, passId);
      await this.recordSupportAudit(
        tx,
        actor,
        "admin.access_pass.reset",
        "scoring_access_pass",
        passId,
        organisationId,
        { status: result.status, expires_at: result.expires_at },
      );
      return result;
    });
  }

  override async updateSportDefaults(actor: Phase3Actor, sportCode: string, definition: Record<string, unknown>) {
    await this.assertPlatformAdmin(actor);
    return this.inTransaction(async (tx) => {
      const result = await this.updateSportDefaultsInTransaction(tx, actor, sportCode, definition);
      await this.recordSupportAudit(tx, actor, "admin.sport_defaults.updated", "sport_pack", sportCode, null, {
        version: result.version,
        definition_hash: result.definition_hash,
        status: result.status,
      });
      return result;
    });
  }

  override async getAuditEvents(
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
