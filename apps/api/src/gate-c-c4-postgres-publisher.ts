import { createHash } from "node:crypto";
import { assertPublicProjectionPrivacy } from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import { ApiError, ErrorCode } from "./errors.js";
import type { GateCC4PublicationPort, GateCC4PublicationResult } from "./gate-c-c4-runtime.js";
import type { Phase2Runtime } from "./phase-2-runtime.js";
import {
  ScheduleRepository,
  CompetitionRepository,
  PublicationRepository,
  PublicProjectionRepository,
  RepairRepository,
} from "./repositories/index.js";

function json<T>(value: T | string): T {
  let parsed: unknown = value;
  // postgres-js can return JSONB as either a value or an encoded value,
  // depending on the connection codec. Repair publication must preserve the
  // canonical quality object, never insert an encoded JSON string.
  while (typeof parsed === "string") parsed = JSON.parse(parsed);
  return parsed as T;
}

function warningList(value: unknown): unknown[] {
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
  if (encoded === undefined) throw new Error("Object contains an unsupported value");
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

export class GateCC4PostgresPublisher implements GateCC4PublicationPort {
  private readonly scheduleRepo: ScheduleRepository;
  private readonly competitionRepo: CompetitionRepository;
  private readonly publicationRepo: PublicationRepository;
  private readonly publicProjectionRepo: PublicProjectionRepository;
  private readonly repairRepo: RepairRepository;

  constructor(
    private readonly publicProjection: Pick<Phase2Runtime, "writePublicProjection">,
    private readonly now: () => Date = () => new Date(),
    scheduleRepo?: ScheduleRepository,
    competitionRepo?: CompetitionRepository,
    publicationRepo?: PublicationRepository,
    publicProjectionRepo?: PublicProjectionRepository,
    repairRepo?: RepairRepository,
  ) {
    const dummySql = {} as unknown as PostgresJsSql;
    this.scheduleRepo = scheduleRepo ?? new ScheduleRepository(dummySql);
    this.competitionRepo = competitionRepo ?? new CompetitionRepository(dummySql);
    this.publicationRepo = publicationRepo ?? new PublicationRepository(dummySql);
    this.publicProjectionRepo = publicProjectionRepo ?? new PublicProjectionRepository(dummySql);
    this.repairRepo = repairRepo ?? new RepairRepository(dummySql);
  }

  async publish(
    tx: PostgresJsSql,
    input: Parameters<GateCC4PublicationPort["publish"]>[1],
  ): Promise<GateCC4PublicationResult> {
    const current = await this.publicationRepo.findPublishedScheduleRevision(
      input.competitionId,
      input.expectedScheduleVersion,
      input.expectedResultVersion,
      "for_update",
      tx,
    );
    if (!current) {
      throw new ApiError(
        409,
        ErrorCode.REPAIR_PUBLISHED_SCHEDULE_REQUIRED,
        "Repair publication requires the exact currently published schedule",
      );
    }

    await this.competitionRepo.acquireCompetitionUpdateLock(input.competitionId, tx);
    const allocatedRevision = await this.scheduleRepo.allocateRevision(input.competitionId, tx);

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
      ...warningList(current.warnings),
      {
        code: "repair_revision",
        repair_case_id: input.repairCase.id,
        repair_revision_id: input.repairRevision.id,
      },
    ];

    const created = await this.scheduleRepo.createRepairedRevision(
      {
        competitionId: input.competitionId,
        formatRevisionId: current.format_revision_id,
        revision: allocatedRevision,
        inputHash,
        warnings,
        createdBy: input.actor.accountId,
        parentRevisionId: current.id,
        quality: json(current.quality),
        sourceRepairRevisionId: input.repairRevision.id,
        updatedAt: this.now(),
      },
      tx,
    );

    await this.scheduleRepo.copyRevisionFormats(created.id, current.id, tx);

    const assignments = await this.scheduleRepo.findAssignmentsForRevision(current.id, "for_share", tx);
    if (assignments.length === 0) {
      throw new ApiError(409, ErrorCode.REPAIR_SCHEDULE_EMPTY, "Published schedule contains no assignments to repair");
    }

    const adjustments = new Map(input.adjustments.map((adjustment) => [adjustment.match_id, adjustment]));
    const scheduledMatches = assignments.map((assignment) => {
      const adjustment = adjustments.get(assignment.match_id);
      return {
        scheduleRevisionId: created.id,
        matchId: assignment.match_id,
        competitionId: input.competitionId,
        playingAreaId: adjustment?.playing_area_id ?? assignment.playing_area_id,
        startsAt: adjustment?.starts_at ?? assignment.starts_at,
        endsAt: adjustment?.ends_at ?? assignment.ends_at,
      };
    });

    await this.scheduleRepo.insertScheduledMatches(scheduledMatches, tx);

    await this.scheduleRepo.acceptAndReadyRevision(created.id, this.now(), tx);

    const published = await this.scheduleRepo.publishScheduleRevision(
      created.id,
      input.actor.accountId,
      `${input.requestId}:schedule`,
      tx,
    );

    const publication = await this.publicationRepo.findPublicationStatus(input.competitionId, "for_share", tx);
    if (!publication) {
      throw new ApiError(409, ErrorCode.REPAIR_PUBLICATION_STATE_MISSING, "Updated publication state is unavailable");
    }
    if (publication.result_version !== input.expectedResultVersion) {
      throw new ApiError(
        409,
        ErrorCode.REPAIR_RESULT_VERSION_CHANGED,
        "Result version changed during repair publication",
      );
    }

    await this.publicProjection.writePublicProjection(
      tx,
      input.competitionId,
      publication.schedule_version,
      publication.result_version,
    );

    const stored = await this.publicProjectionRepo.findCompetitionProjection(input.competitionId, tx);
    if (!stored) {
      throw new ApiError(
        409,
        ErrorCode.REPAIR_PUBLIC_PROJECTION_MISSING,
        "Public competition projection is unavailable",
      );
    }
    const fullProjection = json<Record<string, unknown>>(stored.projection as string | Record<string, unknown>);
    assertPublicProjectionPrivacy(fullProjection);

    const actionDivisions = await this.repairRepo.findActionDivisions(input.repairRevision.id, tx);
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

    const projections: Array<GateCC4PublicationResult["projections"][number]> = [];
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
      const allocatedVersion = await this.publicProjectionRepo.allocateProjectionVersion(input.competitionId, id, tx);
      const etag = `c4-${stored.schedule_version}-${stored.result_version}-${fingerprint}`;
      const inserted = await this.publicProjectionRepo.insertProjectionVersion(
        {
          competitionId: input.competitionId,
          divisionId: id,
          scheduleVersion: stored.schedule_version,
          resultVersion: stored.result_version,
          projectionVersion: allocatedVersion,
          scheduleRevisionId: created.id,
          sourceRepairRevisionId: input.repairRevision.id,
          projection: division,
          projectionFingerprint: fingerprint,
          etag,
          generatedAt: stored.generated_at,
          sourceUpdatedAt: stored.updated_at,
        },
        tx,
      );
      projections.push({
        divisionId: id,
        publicProjectionVersionId: inserted.id,
        projectionVersion: allocatedVersion,
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

export { GateCC4PostgresPublisher as GateCC4PostgresPublicationPort };
