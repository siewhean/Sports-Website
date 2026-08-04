import { createHash } from "node:crypto";
import { assertPublicProjectionPrivacy } from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import { ApiError } from "./errors.js";
import type { GateCC4PublicationPort, GateCC4PublicationResult } from "./gate-c-c4-runtime.js";
import type { Phase2Runtime } from "./phase-2-runtime.js";

type ScheduleRevisionRow = {
  id: string;
  competition_id: string;
  format_revision_id: string;
  revision: number;
  input_hash: string;
  status: string;
  warnings: unknown | string;
  quality: unknown | string;
};

type ScheduleAssignmentRow = {
  match_id: string;
  playing_area_id: string;
  starts_at: Date | string;
  ends_at: Date | string;
};

type PublicProjectionRow = {
  projection: Record<string, unknown> | string;
  generated_at: Date | string;
  updated_at: Date | string;
  schedule_version: number;
  result_version: number;
};

function first<T>(rows: readonly T[], code: string, message: string): T {
  const row = rows[0];
  if (!row) throw new ApiError(409, code, message);
  return row;
}

function json<T>(value: T | string): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function jsonArray(value: unknown): unknown[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed : [];
}

function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Public projection fingerprint contains an unsupported value");
  return encoded;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function divisionPackages(projection: Record<string, unknown>): readonly Record<string, unknown>[] {
  const divisions = projection.divisions;
  if (!Array.isArray(divisions)) throw new Error("Public competition projection has no division packages");
  return divisions.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
}

function divisionId(projection: Record<string, unknown>): string | null {
  const division = projection.division;
  if (!division || typeof division !== "object" || Array.isArray(division)) return null;
  const id = (division as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

export class GateCC4PostgresPublicationPort implements GateCC4PublicationPort {
  constructor(
    private readonly publicProjection: Pick<Phase2Runtime, "writePublicProjection">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async publish(
    tx: PostgresJsSql,
    input: Parameters<GateCC4PublicationPort["publish"]>[1],
  ): Promise<GateCC4PublicationResult> {
    const current = first(
      await tx.unsafe<ScheduleRevisionRow>(
        `SELECT revision.*
         FROM competition_publications publication
         JOIN schedule_revisions revision ON revision.id=publication.published_schedule_revision_id
         WHERE publication.competition_id=$1
           AND publication.schedule_version=$2
           AND publication.result_version=$3
           AND revision.status='published'
         FOR UPDATE OF revision,publication`,
        [input.competitionId, input.expectedScheduleVersion, input.expectedResultVersion],
      ),
      "REPAIR_PUBLISHED_SCHEDULE_REQUIRED",
      "Repair publication requires the exact currently published schedule",
    );

    await tx.unsafe(`SELECT 1 FROM competitions WHERE id=$1 FOR UPDATE`, [input.competitionId]);
    const [allocated] = await tx.unsafe<{ revision: number }>(
      `SELECT COALESCE(max(revision),0)::integer+1 AS revision
       FROM schedule_revisions WHERE competition_id=$1`,
      [input.competitionId],
    );
    if (!allocated) throw new Error("Unable to allocate repaired schedule revision");

    const inputHash = sha256(
      stableJson({
        schema_version: 1,
        competition_id: input.competitionId,
        parent_schedule_revision_id: current.id,
        source_repair_revision_id: input.repairRevision.id,
        publication_fingerprint: input.repairRevision.publication_fingerprint,
      }),
    );
    const warnings = [
      ...jsonArray(current.warnings),
      {
        code: "repair_revision",
        repair_case_id: input.repairCase.id,
        repair_revision_id: input.repairRevision.id,
      },
    ];
    const [created] = await tx.unsafe<{ id: string }>(
      `INSERT INTO schedule_revisions(
         competition_id,format_revision_id,revision,input_hash,status,warnings,created_by,
         parent_revision_id,quality,source_repair_revision_id,updated_at
       ) VALUES($1,$2,$3,$4,'draft',$5::jsonb,$6,$7,$8::jsonb,$9,$10)
       RETURNING id`,
      [
        input.competitionId,
        current.format_revision_id,
        allocated.revision,
        inputHash,
        JSON.stringify(warnings),
        input.actor.accountId,
        current.id,
        JSON.stringify(json(current.quality)),
        input.repairRevision.id,
        this.now(),
      ],
    );
    if (!created) throw new Error("Repaired schedule revision was not created");

    await tx.unsafe(
      `INSERT INTO schedule_revision_formats(schedule_revision_id,competition_id,division_id,format_revision_id)
       SELECT $1,competition_id,division_id,format_revision_id
       FROM schedule_revision_formats WHERE schedule_revision_id=$2
       ORDER BY division_id`,
      [created.id, current.id],
    );

    const assignments = await tx.unsafe<ScheduleAssignmentRow>(
      `SELECT match_id,playing_area_id,starts_at,ends_at
       FROM scheduled_matches WHERE schedule_revision_id=$1 ORDER BY starts_at,playing_area_id,match_id
       FOR SHARE`,
      [current.id],
    );
    if (assignments.length === 0) {
      throw new ApiError(409, "REPAIR_SCHEDULE_EMPTY", "Published schedule contains no assignments to repair");
    }
    const adjustments = new Map(input.adjustments.map((adjustment) => [adjustment.match_id, adjustment]));
    for (const assignment of assignments) {
      const adjustment = adjustments.get(assignment.match_id);
      await tx.unsafe(
        `INSERT INTO scheduled_matches(
           schedule_revision_id,match_id,competition_id,playing_area_id,starts_at,ends_at
         ) VALUES($1,$2,$3,$4,$5,$6)`,
        [
          created.id,
          assignment.match_id,
          input.competitionId,
          adjustment?.playing_area_id ?? assignment.playing_area_id,
          adjustment?.starts_at ?? assignment.starts_at,
          adjustment?.ends_at ?? assignment.ends_at,
        ],
      );
    }

    await tx.unsafe(`SELECT set_config('matchday.phase4_accept_schedule','on',true)`);
    const [ready] = await tx.unsafe<{ assignment_hash: string }>(
      `UPDATE schedule_revisions
       SET assignment_hash=phase4_schedule_assignment_hash(id),status='ready_for_review',updated_at=$2
       WHERE id=$1 RETURNING assignment_hash`,
      [created.id, this.now()],
    );
    await tx.unsafe(`SELECT set_config('matchday.phase4_accept_schedule','off',true)`);
    if (!ready?.assignment_hash) throw new Error("Repaired schedule assignment hash was not retained");

    const [published] = await tx.unsafe<{ id: string; published_at: Date | string }>(
      `SELECT id,published_at FROM phase4_publish_schedule_revision($1,$2,$3)`,
      [created.id, input.actor.accountId, `${input.requestId}:schedule`],
    );
    if (!published) throw new Error("Repaired schedule was not published");

    const publication = first(
      await tx.unsafe<{ schedule_version: number; result_version: number; updated_at: Date | string }>(
        `SELECT schedule_version,result_version,updated_at
         FROM competition_publications WHERE competition_id=$1 FOR SHARE`,
        [input.competitionId],
      ),
      "REPAIR_PUBLICATION_STATE_MISSING",
      "Updated publication state is unavailable",
    );
    if (publication.result_version !== input.expectedResultVersion) {
      throw new ApiError(409, "REPAIR_RESULT_VERSION_CHANGED", "Result version changed during repair publication");
    }

    await this.publicProjection.writePublicProjection(
      tx,
      input.competitionId,
      publication.schedule_version,
      publication.result_version,
    );

    const stored = first(
      await tx.unsafe<PublicProjectionRow>(
        `SELECT projection.projection,projection.generated_at,publication.updated_at,
                publication.schedule_version,publication.result_version
         FROM public_competition_projections projection
         JOIN competition_publications publication ON publication.competition_id=projection.competition_id
         WHERE projection.competition_id=$1
           AND projection.schedule_version=publication.schedule_version
           AND projection.result_version=publication.result_version`,
        [input.competitionId],
      ),
      "REPAIR_PUBLIC_PROJECTION_MISSING",
      "Public projection was not regenerated",
    );
    const fullProjection = json<Record<string, unknown>>(stored.projection);
    assertPublicProjectionPrivacy(fullProjection);

    const actionDivisions = await tx.unsafe<{ division_id: string }>(
      `SELECT DISTINCT division_id FROM schedule_repair_actions
       WHERE repair_revision_id=$1 ORDER BY division_id`,
      [input.repairRevision.id],
    );
    const affectedDivisionIds = new Set(
      actionDivisions.length > 0
        ? actionDivisions.map((row) => row.division_id)
        : [input.repairCase.corrected_division_id],
    );
    const packages = divisionPackages(fullProjection).filter((division) => {
      const id = divisionId(division);
      return id !== null && affectedDivisionIds.has(id);
    });
    if (packages.length !== affectedDivisionIds.size) {
      throw new Error("Regenerated public projection is missing an affected division package");
    }

    const projections: GateCC4PublicationResult["projections"][number][] = [];
    for (const division of packages) {
      const id = divisionId(division);
      if (!id) throw new Error("Public division projection has no identifier");
      const fingerprintInput = stableJson({
        schema_version: 1,
        competition_id: input.competitionId,
        division_id: id,
        schedule_version: stored.schedule_version,
        result_version: stored.result_version,
        projection: division,
      });
      const fingerprint = sha256(fingerprintInput);
      const [version] = await tx.unsafe<{ projection_version: number }>(
        `SELECT COALESCE(max(projection_version),0)::integer+1 AS projection_version
         FROM public_projection_versions WHERE competition_id=$1 AND division_id=$2`,
        [input.competitionId, id],
      );
      if (!version) throw new Error("Unable to allocate public projection version");
      const etag = `c4-${stored.schedule_version}-${stored.result_version}-${fingerprint}`;
      const [inserted] = await tx.unsafe<{ id: string }>(
        `INSERT INTO public_projection_versions(
           competition_id,division_id,schedule_version,result_version,projection_version,
           schedule_revision_id,source_repair_revision_id,projection,projection_fingerprint,etag,
           generated_at,source_updated_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)
         RETURNING id`,
        [
          input.competitionId,
          id,
          stored.schedule_version,
          stored.result_version,
          version.projection_version,
          created.id,
          input.repairRevision.id,
          JSON.stringify(division),
          fingerprint,
          etag,
          stored.generated_at,
          stored.updated_at,
        ],
      );
      if (!inserted) throw new Error("Public projection version was not retained");
      projections.push({
        divisionId: id,
        publicProjectionVersionId: inserted.id,
        projectionVersion: version.projection_version,
      });
    }

    return {
      scheduleRevisionId: created.id,
      scheduleVersion: publication.schedule_version,
      resultVersion: publication.result_version,
      publishedAt: instant(published.published_at),
      projections,
    };
  }
}
