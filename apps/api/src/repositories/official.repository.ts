import { randomUUID } from "node:crypto";
import type {
  SqlExecutor,
  LockMode,
  OfficialRecord,
  OfficialAvailabilityWindowRecord,
  MatchOfficialAssignmentRecord,
} from "./types.js";

const OFFICIAL_COLUMNS = `id, competition_id, organisation_id, name, default_role, archived_at, created_at, updated_at`;
const WINDOW_COLUMNS = `id, competition_id, organisation_id, official_id, starts_at, ends_at, created_at, updated_at`;
const ASSIGNMENT_COLUMNS = `id, competition_id, organisation_id, match_id, official_id, assigned_role, created_at, updated_at`;

export class OfficialRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async findById(
    id: string,
    competitionId: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<OfficialRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : lock === "for_share" ? " FOR SHARE" : "";
    const rows = await executor.unsafe<OfficialRecord>(
      `SELECT ${OFFICIAL_COLUMNS}
       FROM competition_officials
       WHERE id = $1 AND competition_id = $2${lockClause}`,
      [id, competitionId],
    );
    return rows[0] ?? null;
  }

  async listByCompetitionId(
    competitionId: string,
    options: { includeArchived?: boolean } = {},
    executor: SqlExecutor = this.sql,
  ): Promise<readonly OfficialRecord[]> {
    const filter = options.includeArchived ? "" : " AND archived_at IS NULL";
    return executor.unsafe<OfficialRecord>(
      `SELECT ${OFFICIAL_COLUMNS}
       FROM competition_officials
       WHERE competition_id = $1${filter}
       ORDER BY created_at ASC, id ASC`,
      [competitionId],
    );
  }

  async createOfficial(
    params: {
      id?: string | undefined;
      competitionId: string;
      organisationId: string;
      name: string;
      defaultRole?: string | null | undefined;
      actorId?: string | undefined;
      requestId?: string | undefined;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<OfficialRecord> {
    const id = params.id ?? randomUUID();
    const trimmedName = params.name.trim();
    if (trimmedName.length < 1 || trimmedName.length > 80) {
      throw new Error("Official name must be between 1 and 80 characters");
    }
    const defaultRole = params.defaultRole ? params.defaultRole.trim() : null;
    if (defaultRole && defaultRole.length > 40) {
      throw new Error("Official default role must not exceed 40 characters");
    }

    const rows = await executor.unsafe<OfficialRecord>(
      `INSERT INTO competition_officials (id, competition_id, organisation_id, name, default_role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${OFFICIAL_COLUMNS}`,
      [id, params.competitionId, params.organisationId, trimmedName, defaultRole],
    );
    const created = rows[0]!;

    await this.recordEvidence(executor, {
      action: "official.created",
      targetType: "competition_official",
      targetId: id,
      organisationId: params.organisationId,
      competitionId: params.competitionId,
      actorId: params.actorId,
      requestId: params.requestId,
      metadata: { official_id: id, name: trimmedName },
    });

    return created;
  }

  async updateOfficialMetadata(
    params: {
      competitionId: string;
      officialId: string;
      name?: string | undefined;
      defaultRole?: string | null | undefined;
      actorId?: string | undefined;
      requestId?: string | undefined;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<OfficialRecord | null> {
    const existing = await this.findById(params.officialId, params.competitionId, "for_update", executor);
    if (!existing) return null;

    const trimmedName = params.name !== undefined ? params.name.trim() : existing.name;
    if (trimmedName.length < 1 || trimmedName.length > 80) {
      throw new Error("Official name must be between 1 and 80 characters");
    }
    const defaultRole =
      params.defaultRole !== undefined
        ? params.defaultRole
          ? params.defaultRole.trim()
          : null
        : (existing.default_role ?? null);
    if (defaultRole && defaultRole.length > 40) {
      throw new Error("Official default role must not exceed 40 characters");
    }

    const rows = await executor.unsafe<OfficialRecord>(
      `UPDATE competition_officials
       SET name = $1, default_role = $2, updated_at = now()
       WHERE id = $3 AND competition_id = $4
       RETURNING ${OFFICIAL_COLUMNS}`,
      [trimmedName, defaultRole, params.officialId, params.competitionId],
    );
    const updated = rows[0] ?? null;

    if (updated) {
      await this.recordEvidence(executor, {
        action: "official.updated",
        targetType: "competition_official",
        targetId: params.officialId,
        organisationId: existing.organisation_id,
        competitionId: params.competitionId,
        actorId: params.actorId,
        requestId: params.requestId,
        metadata: { official_id: params.officialId, name: trimmedName },
      });
    }

    return updated;
  }

  async archiveOfficial(
    params: {
      competitionId: string;
      officialId: string;
      actorId?: string | undefined;
      requestId?: string | undefined;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<{ official: OfficialRecord | null; bumpedRevision: boolean }> {
    const existing = await this.findById(params.officialId, params.competitionId, "for_update", executor);
    if (!existing) return { official: null, bumpedRevision: false };

    const assignmentRows = await executor.unsafe<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM match_official_assignments
       WHERE competition_id = $1 AND official_id = $2`,
      [params.competitionId, params.officialId],
    );
    const hasAssignments = Number.parseInt(assignmentRows[0]?.count ?? "0", 10) > 0;

    let bumpedRevision = false;
    if (hasAssignments) {
      await this.incrementCompetitionRevision(params.competitionId, executor);
      bumpedRevision = true;
    }

    const rows = await executor.unsafe<OfficialRecord>(
      `UPDATE competition_officials
       SET archived_at = now(), updated_at = now()
       WHERE id = $1 AND competition_id = $2
       RETURNING ${OFFICIAL_COLUMNS}`,
      [params.officialId, params.competitionId],
    );
    const archived = rows[0] ?? null;

    if (archived) {
      await this.recordEvidence(executor, {
        action: "official.archived",
        targetType: "competition_official",
        targetId: params.officialId,
        organisationId: existing.organisation_id,
        competitionId: params.competitionId,
        actorId: params.actorId,
        requestId: params.requestId,
        metadata: { official_id: params.officialId, had_assignments: hasAssignments },
      });
    }

    return { official: archived, bumpedRevision };
  }

  async restoreOfficial(
    params: {
      competitionId: string;
      officialId: string;
      actorId?: string | undefined;
      requestId?: string | undefined;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<{ official: OfficialRecord | null; bumpedRevision: boolean }> {
    const existing = await this.findById(params.officialId, params.competitionId, "for_update", executor);
    if (!existing) return { official: null, bumpedRevision: false };

    const assignmentRows = await executor.unsafe<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM match_official_assignments
       WHERE competition_id = $1 AND official_id = $2`,
      [params.competitionId, params.officialId],
    );
    const hasAssignments = Number.parseInt(assignmentRows[0]?.count ?? "0", 10) > 0;

    let bumpedRevision = false;
    if (hasAssignments) {
      await this.incrementCompetitionRevision(params.competitionId, executor);
      bumpedRevision = true;
    }

    const rows = await executor.unsafe<OfficialRecord>(
      `UPDATE competition_officials
       SET archived_at = NULL, updated_at = now()
       WHERE id = $1 AND competition_id = $2
       RETURNING ${OFFICIAL_COLUMNS}`,
      [params.officialId, params.competitionId],
    );
    const restored = rows[0] ?? null;

    if (restored) {
      await this.recordEvidence(executor, {
        action: "official.restored",
        targetType: "competition_official",
        targetId: params.officialId,
        organisationId: existing.organisation_id,
        competitionId: params.competitionId,
        actorId: params.actorId,
        requestId: params.requestId,
        metadata: { official_id: params.officialId, had_assignments: hasAssignments },
      });
    }

    return { official: restored, bumpedRevision };
  }

  async listAvailability(
    competitionId: string,
    officialId?: string,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly OfficialAvailabilityWindowRecord[]> {
    if (officialId) {
      return executor.unsafe<OfficialAvailabilityWindowRecord>(
        `SELECT ${WINDOW_COLUMNS}
         FROM official_availability_windows
         WHERE competition_id = $1 AND official_id = $2
         ORDER BY starts_at ASC, ends_at ASC, id ASC`,
        [competitionId, officialId],
      );
    }
    return executor.unsafe<OfficialAvailabilityWindowRecord>(
      `SELECT ${WINDOW_COLUMNS}
       FROM official_availability_windows
       WHERE competition_id = $1
       ORDER BY official_id ASC, starts_at ASC, ends_at ASC, id ASC`,
      [competitionId],
    );
  }

  async replaceAvailability(
    params: {
      competitionId: string;
      organisationId: string;
      officialId: string;
      windows: ReadonlyArray<{ startsAt: Date | string; endsAt: Date | string }>;
      actorId?: string | undefined;
      requestId?: string | undefined;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<{ windows: readonly OfficialAvailabilityWindowRecord[]; bumpedRevision: boolean }> {
    const official = await this.findById(params.officialId, params.competitionId, "for_update", executor);
    if (!official) {
      throw new Error(`Official not found in competition: ${params.officialId}`);
    }

    for (const w of params.windows) {
      const start = new Date(w.startsAt).getTime();
      const end = new Date(w.endsAt).getTime();
      if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
        throw new Error("Availability window must have positive duration (endsAt > startsAt)");
      }
    }

    const assignmentRows = await executor.unsafe<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM match_official_assignments
       WHERE competition_id = $1 AND official_id = $2`,
      [params.competitionId, params.officialId],
    );
    const hasAssignments = Number.parseInt(assignmentRows[0]?.count ?? "0", 10) > 0;

    let bumpedRevision = false;
    if (hasAssignments) {
      await this.incrementCompetitionRevision(params.competitionId, executor);
      bumpedRevision = true;
    }

    await executor.unsafe(
      `DELETE FROM official_availability_windows
       WHERE competition_id = $1 AND official_id = $2`,
      [params.competitionId, params.officialId],
    );

    const inserted: OfficialAvailabilityWindowRecord[] = [];
    for (const w of params.windows) {
      const rows = await executor.unsafe<OfficialAvailabilityWindowRecord>(
        `INSERT INTO official_availability_windows (
           competition_id, organisation_id, official_id, starts_at, ends_at
         )
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${WINDOW_COLUMNS}`,
        [params.competitionId, params.organisationId, params.officialId, w.startsAt, w.endsAt],
      );
      if (rows[0]) inserted.push(rows[0]);
    }

    await this.recordEvidence(executor, {
      action: "official.availability.updated",
      targetType: "competition_official",
      targetId: params.officialId,
      organisationId: params.organisationId,
      competitionId: params.competitionId,
      actorId: params.actorId,
      requestId: params.requestId,
      metadata: { official_id: params.officialId, window_count: inserted.length },
    });

    return { windows: inserted, bumpedRevision };
  }

  async listMatchAssignments(
    competitionId: string,
    matchId?: string,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly MatchOfficialAssignmentRecord[]> {
    if (matchId) {
      return executor.unsafe<MatchOfficialAssignmentRecord>(
        `SELECT ${ASSIGNMENT_COLUMNS}
         FROM match_official_assignments
         WHERE competition_id = $1 AND match_id = $2
         ORDER BY created_at ASC, id ASC`,
        [competitionId, matchId],
      );
    }
    return executor.unsafe<MatchOfficialAssignmentRecord>(
      `SELECT ${ASSIGNMENT_COLUMNS}
         FROM match_official_assignments
         WHERE competition_id = $1
         ORDER BY match_id ASC, created_at ASC, id ASC`,
      [competitionId],
    );
  }

  async listAssignmentsByOfficial(
    competitionId: string,
    officialId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly MatchOfficialAssignmentRecord[]> {
    return executor.unsafe<MatchOfficialAssignmentRecord>(
      `SELECT ${ASSIGNMENT_COLUMNS}
       FROM match_official_assignments
       WHERE competition_id = $1 AND official_id = $2
       ORDER BY created_at ASC, id ASC`,
      [competitionId, officialId],
    );
  }

  async replaceMatchAssignments(
    params: {
      competitionId: string;
      organisationId: string;
      matchId: string;
      assignments: ReadonlyArray<{ officialId: string; assignedRole?: string | null | undefined }>;
      actorId?: string | undefined;
      requestId?: string | undefined;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<{ assignments: readonly MatchOfficialAssignmentRecord[]; bumpedRevision: boolean }> {
    const matchRows = await executor.unsafe<{ id: string }>(
      `SELECT id FROM matches WHERE id = $1 AND competition_id = $2`,
      [params.matchId, params.competitionId],
    );
    if (!matchRows[0]) {
      throw new Error(`Match not found in competition: ${params.matchId}`);
    }

    const uniqueOfficialIds = new Set<string>();
    for (const a of params.assignments) {
      if (uniqueOfficialIds.has(a.officialId)) {
        throw new Error(`Duplicate official assignment for match: ${a.officialId}`);
      }
      uniqueOfficialIds.add(a.officialId);
      const official = await this.findById(a.officialId, params.competitionId, "none", executor);
      if (!official) {
        throw new Error(`Official not found in competition: ${a.officialId}`);
      }
      if (a.assignedRole && a.assignedRole.trim().length > 40) {
        throw new Error("Assigned role must not exceed 40 characters");
      }
    }

    await this.incrementCompetitionRevision(params.competitionId, executor);

    await executor.unsafe(
      `DELETE FROM match_official_assignments
       WHERE competition_id = $1 AND match_id = $2`,
      [params.competitionId, params.matchId],
    );

    const inserted: MatchOfficialAssignmentRecord[] = [];
    for (const a of params.assignments) {
      const rows = await executor.unsafe<MatchOfficialAssignmentRecord>(
        `INSERT INTO match_official_assignments (
           competition_id, organisation_id, match_id, official_id, assigned_role
         )
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${ASSIGNMENT_COLUMNS}`,
        [
          params.competitionId,
          params.organisationId,
          params.matchId,
          a.officialId,
          a.assignedRole ? a.assignedRole.trim() : null,
        ],
      );
      if (rows[0]) inserted.push(rows[0]);
    }

    await this.recordEvidence(executor, {
      action: "official.assignments.updated",
      targetType: "match",
      targetId: params.matchId,
      organisationId: params.organisationId,
      competitionId: params.competitionId,
      actorId: params.actorId,
      requestId: params.requestId,
      metadata: { match_id: params.matchId, count: inserted.length },
    });

    return { assignments: inserted, bumpedRevision: true };
  }

  async assignOfficial(
    params: {
      competitionId: string;
      organisationId: string;
      matchId: string;
      officialId: string;
      assignedRole?: string | null | undefined;
      actorId?: string | undefined;
      requestId?: string | undefined;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<{ assignment: MatchOfficialAssignmentRecord; bumpedRevision: boolean }> {
    const matchRows = await executor.unsafe<{ id: string }>(
      `SELECT id FROM matches WHERE id = $1 AND competition_id = $2`,
      [params.matchId, params.competitionId],
    );
    if (!matchRows[0]) {
      throw new Error(`Match not found in competition: ${params.matchId}`);
    }
    const official = await this.findById(params.officialId, params.competitionId, "none", executor);
    if (!official) {
      throw new Error(`Official not found in competition: ${params.officialId}`);
    }

    await this.incrementCompetitionRevision(params.competitionId, executor);

    const rows = await executor.unsafe<MatchOfficialAssignmentRecord>(
      `INSERT INTO match_official_assignments (
         competition_id, organisation_id, match_id, official_id, assigned_role
       )
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${ASSIGNMENT_COLUMNS}`,
      [
        params.competitionId,
        params.organisationId,
        params.matchId,
        params.officialId,
        params.assignedRole ? params.assignedRole.trim() : null,
      ],
    );
    const created = rows[0]!;

    await this.recordEvidence(executor, {
      action: "official.assignments.updated",
      targetType: "match",
      targetId: params.matchId,
      organisationId: params.organisationId,
      competitionId: params.competitionId,
      actorId: params.actorId,
      requestId: params.requestId,
      metadata: { match_id: params.matchId, official_id: params.officialId, added: true },
    });

    return { assignment: created, bumpedRevision: true };
  }

  async unassignOfficial(
    params: {
      competitionId: string;
      organisationId: string;
      matchId: string;
      officialId: string;
      actorId?: string | undefined;
      requestId?: string | undefined;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<{ unassigned: boolean; bumpedRevision: boolean }> {
    const existing = await executor.unsafe<{ id: string }>(
      `SELECT id FROM match_official_assignments
       WHERE competition_id = $1 AND match_id = $2 AND official_id = $3`,
      [params.competitionId, params.matchId, params.officialId],
    );
    if (!existing[0]) {
      return { unassigned: false, bumpedRevision: false };
    }

    await this.incrementCompetitionRevision(params.competitionId, executor);

    await executor.unsafe(
      `DELETE FROM match_official_assignments
       WHERE competition_id = $1 AND match_id = $2 AND official_id = $3`,
      [params.competitionId, params.matchId, params.officialId],
    );

    await this.recordEvidence(executor, {
      action: "official.assignments.updated",
      targetType: "match",
      targetId: params.matchId,
      organisationId: params.organisationId,
      competitionId: params.competitionId,
      actorId: params.actorId,
      requestId: params.requestId,
      metadata: { match_id: params.matchId, official_id: params.officialId, removed: true },
    });

    return { unassigned: true, bumpedRevision: true };
  }

  private async incrementCompetitionRevision(competitionId: string, executor: SqlExecutor): Promise<number> {
    const rows = await executor.unsafe<{ revision: number }>(
      `UPDATE competitions
       SET revision = revision + 1, updated_at = now()
       WHERE id = $1
       RETURNING revision`,
      [competitionId],
    );
    return rows[0]?.revision ?? 0;
  }

  private async recordEvidence(
    executor: SqlExecutor,
    params: {
      action: string;
      targetType: string;
      targetId: string;
      organisationId: string;
      competitionId: string;
      actorId?: string | undefined;
      requestId?: string | undefined;
      metadata?: Record<string, unknown> | undefined;
    },
  ): Promise<void> {
    const requestId = params.requestId ?? randomUUID();
    const actorId = params.actorId ?? null;
    const metadata = { competition_id: params.competitionId, ...(params.metadata ?? {}) };

    await executor.unsafe(
      `INSERT INTO audit_events (request_id, actor_account_id, actor_type, organisation_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        requestId,
        actorId,
        actorId ? "account" : "system",
        params.organisationId,
        params.action,
        params.targetType,
        params.targetId,
        JSON.stringify(metadata),
      ],
    );

    await executor.unsafe(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, idempotency_key)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        params.targetType,
        params.targetId,
        params.action,
        JSON.stringify({ target_id: params.targetId, ...metadata }),
        `official:${params.action}:${requestId}:${params.targetId}`,
      ],
    );
  }
}
