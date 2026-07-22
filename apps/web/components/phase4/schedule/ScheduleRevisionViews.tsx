import Link from "next/link";
import {
  ArrowLeft,
  ArrowsLeftRight,
  CalendarBlank,
  ClockCounterClockwise,
  LockKey,
} from "@phosphor-icons/react/dist/ssr";
import { interpolate } from "@matchday/ui";
import {
  formatScheduleDay,
  formatScheduleTime,
  objectiveLabel,
  phase4ScheduleCopy,
  type ScheduleDocument,
  type ScheduleRevision,
  type ScheduleRevisionComparison as RevisionComparison,
} from "@/lib/phase4-schedule";
import styles from "./ScheduleRevisionViews.module.css";

export function ScheduleRevisionHistory({ document }: { document: ScheduleDocument }) {
  return (
    <section className={styles.history} data-testid="phase4-schedule-revisions">
      <header>
        <div>
          <p>{phase4ScheduleCopy.immutablePrivateHistory}</p>
          <h2>{phase4ScheduleCopy.revisionHistory}</h2>
        </div>
        <Link href={`/organiser/competitions/${document.competitionId}/schedule`}>
          <ArrowLeft />
          {phase4ScheduleCopy.backToSchedule}
        </Link>
      </header>
      {document.revisions.length ? (
        <ol>
          {document.revisions.map((revision) => (
            <li key={revision.id}>
              <div className={styles.revisionNumber}>
                <span>{phase4ScheduleCopy.draft}</span>
                <strong>{revision.revision}</strong>
              </div>
              <div>
                <h3>{revision.status.replaceAll("_", " ")}</h3>
                <p>{phase4ScheduleCopy.immutablePrivateHistory}</p>
              </div>
              <dl>
                <div>
                  <dt>{phase4ScheduleCopy.savedOn}</dt>
                  <dd>{formatScheduleDay(revision.updatedAt, document.timeZone)}</dd>
                </div>
                <div>
                  <dt>{phase4ScheduleCopy.editableUntil}</dt>
                  <dd>
                    {revision.editableUntil
                      ? formatScheduleDay(revision.editableUntil, document.timeZone)
                      : phase4ScheduleCopy.immutable}
                  </dd>
                </div>
              </dl>
              <Link href={`/organiser/competitions/${document.competitionId}/schedule/revisions/${revision.id}`}>
                {phase4ScheduleCopy.inspectRevision}
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <div className={styles.empty}>
          <CalendarBlank />
          <h2>{phase4ScheduleCopy.noRevisions}</h2>
          <p>{phase4ScheduleCopy.noRevisionsBody}</p>
        </div>
      )}
    </section>
  );
}

export function ScheduleRevisionDetail({
  document,
  revision,
}: {
  document: ScheduleDocument;
  revision: ScheduleRevision;
}) {
  return (
    <section className={styles.detail} data-testid="phase4-schedule-revision-detail">
      <header>
        <div>
          <p>{phase4ScheduleCopy.scheduleRevision}</p>
          <h2>
            {phase4ScheduleCopy.draft} {revision.revision}
          </h2>
          <span data-status={revision.status}>{revision.status.replaceAll("_", " ")}</span>
        </div>
        <div className={styles.detailActions}>
          <Link href={`/organiser/competitions/${document.competitionId}/schedule/revisions`}>
            <ClockCounterClockwise />
            {phase4ScheduleCopy.revisions}
          </Link>
          {revision.parentRevisionId ? (
            <Link
              href={`/organiser/competitions/${document.competitionId}/schedule/compare?left=${revision.parentRevisionId}&right=${revision.id}`}
            >
              <ArrowsLeftRight />
              {phase4ScheduleCopy.compareWithParent}
            </Link>
          ) : null}
        </div>
      </header>
      <dl className={styles.summary}>
        <div>
          <dt>{phase4ScheduleCopy.status}</dt>
          <dd>{revision.status.replaceAll("_", " ")}</dd>
        </div>
        <div>
          <dt>{phase4ScheduleCopy.assignments}</dt>
          <dd>{revision.assignments.length}</dd>
        </div>
        <div>
          <dt>{phase4ScheduleCopy.objective}</dt>
          <dd>{revision.quality ? objectiveLabel(revision.quality.objective) : "—"}</dd>
        </div>
        <div>
          <dt>{phase4ScheduleCopy.quality}</dt>
          <dd>{revision.quality?.score ?? "—"}</dd>
        </div>
      </dl>
      <div className={styles.assignmentList}>
        <div className={styles.listHeading}>
          <span>{phase4ScheduleCopy.match}</span>
          <span>{phase4ScheduleCopy.playingArea}</span>
          <span>{phase4ScheduleCopy.time}</span>
          <span>{phase4ScheduleCopy.protection}</span>
        </div>
        {revision.assignments.map((assignment) => {
          const match = document.matches.find((item) => item.id === assignment.matchId);
          const area = document.areas.find((item) => item.id === assignment.areaId);
          return (
            <div key={assignment.matchId}>
              <strong>{match?.code ?? assignment.matchId}</strong>
              <span>{area?.name ?? assignment.areaId}</span>
              <time>
                {formatScheduleDay(assignment.startsAt, document.timeZone)} ·{" "}
                {formatScheduleTime(assignment.startsAt, document.timeZone)}–
                {formatScheduleTime(assignment.endsAt, document.timeZone)}
              </time>
              <span>
                {assignment.fixed ? (
                  <>
                    <LockKey />
                    {phase4ScheduleCopy.fixed}
                  </>
                ) : (
                  phase4ScheduleCopy.movable
                )}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function ScheduleRevisionComparison({
  document,
  comparison,
}: {
  document: ScheduleDocument;
  comparison: RevisionComparison | null;
}) {
  if (!comparison)
    return (
      <section className={styles.empty}>
        <ArrowsLeftRight />
        <h2>{phase4ScheduleCopy.selectTwo}</h2>
        <p>{phase4ScheduleCopy.selectTwoBody}</p>
        <Link href={`/organiser/competitions/${document.competitionId}/schedule/revisions`}>
          {phase4ScheduleCopy.chooseHistory}
        </Link>
      </section>
    );
  const { left, right } = comparison;
  const leftByMatch = new Map(left.assignments.map((assignment) => [assignment.matchId, assignment]));
  const rightByMatch = new Map(right.assignments.map((assignment) => [assignment.matchId, assignment]));
  return (
    <section className={styles.comparison} data-testid="phase4-schedule-comparison">
      <header>
        <div>
          <p>{phase4ScheduleCopy.immutableDiff}</p>
          <h2>{interpolate(phase4ScheduleCopy.revisionDiffTitle, { left: left.revision, right: right.revision })}</h2>
        </div>
        <strong>{interpolate(phase4ScheduleCopy.changedMatches, { count: comparison.changedMatchIds.length })}</strong>
      </header>
      <div className={styles.compareQuality}>
        <Quality revision={left} />
        <ArrowsLeftRight />
        <Quality revision={right} />
      </div>
      <dl className={styles.changeMetrics} aria-label={phase4ScheduleCopy.immutableDiff}>
        <ComparisonMetric
          label={phase4ScheduleCopy.movedMatchCount}
          before={String(0)}
          after={String(comparison.movedMatchIds.length)}
          delta={signed(comparison.movedMatchIds.length)}
        />
        <ComparisonMetric
          label={phase4ScheduleCopy.restChange}
          before={minutes(comparison.minimumRestMinutes.before)}
          after={minutes(comparison.minimumRestMinutes.after)}
          delta={minuteDelta(comparison.minimumRestMinutes.delta)}
        />
        <ComparisonMetric
          label={phase4ScheduleCopy.completionChange}
          before={instantLabel(comparison.completion.beforeEpochMs, document.timeZone)}
          after={instantLabel(comparison.completion.afterEpochMs, document.timeZone)}
          delta={minuteDelta(comparison.completion.deltaMinutes)}
        />
        <ComparisonMetric
          label={phase4ScheduleCopy.conflictChange}
          before={String(comparison.conflicts.before)}
          after={String(comparison.conflicts.after)}
          delta={signed(comparison.conflicts.delta)}
        />
      </dl>
      <ol>
        {comparison.changedMatchIds.map((id) => {
          const match = document.matches.find((item) => item.id === id);
          return (
            <li key={id}>
              <h3>
                {match?.code ?? id}
                <small>{match?.roundLabel}</small>
              </h3>
              <AssignmentSide document={document} revision={left} assignment={leftByMatch.get(id) ?? null} />
              <AssignmentSide document={document} revision={right} assignment={rightByMatch.get(id) ?? null} />
            </li>
          );
        })}
      </ol>
      {!comparison.changedMatchIds.length ? (
        <div className={styles.noChange}>
          <CalendarBlank />
          {phase4ScheduleCopy.identical}
        </div>
      ) : null}
    </section>
  );
}

function ComparisonMetric({
  label,
  before,
  after,
  delta,
}: {
  label: string;
  before: string;
  after: string;
  delta: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <span>{before}</span>
        <ArrowsLeftRight aria-hidden="true" />
        <span>{after}</span>
        <strong>{delta}</strong>
      </dd>
    </div>
  );
}

function signed(value: number): string {
  return value === 0 ? phase4ScheduleCopy.noMetricChange : `${value > 0 ? "+" : ""}${value}`;
}

function minutes(value: number | null): string {
  return value === null ? "—" : `${value} min`;
}

function minuteDelta(value: number | null): string {
  return value === null
    ? "—"
    : value === 0
      ? phase4ScheduleCopy.noMetricChange
      : interpolate(phase4ScheduleCopy.minutesDelta, { delta: `${value > 0 ? "+" : ""}${value}` });
}

function instantLabel(value: number | null, timeZone: string): string {
  if (value === null) return "—";
  const instant = new Date(value).toISOString();
  return `${formatScheduleDay(instant, timeZone)} · ${formatScheduleTime(instant, timeZone)}`;
}

function Quality({ revision }: { revision: ScheduleRevision }) {
  return (
    <div>
      <span>
        {phase4ScheduleCopy.draft} {revision.revision}
      </span>
      <strong>{revision.quality?.score ?? "—"}</strong>
      <small>{revision.quality ? objectiveLabel(revision.quality.objective) : phase4ScheduleCopy.noQualityShort}</small>
    </div>
  );
}

function AssignmentSide({
  document,
  revision,
  assignment,
}: {
  document: ScheduleDocument;
  revision: ScheduleRevision;
  assignment: ScheduleRevision["assignments"][number] | null;
}) {
  if (!assignment)
    return (
      <div className={styles.assignmentSide}>
        <span>
          {phase4ScheduleCopy.draft} {revision.revision}
        </span>
        <strong>{phase4ScheduleCopy.unscheduled}</strong>
      </div>
    );
  return (
    <div className={styles.assignmentSide}>
      <span>
        {phase4ScheduleCopy.draft} {revision.revision}
      </span>
      <strong>{document.areas.find((area) => area.id === assignment.areaId)?.name ?? assignment.areaId}</strong>
      <small>
        {formatScheduleDay(assignment.startsAt, document.timeZone)} ·{" "}
        {formatScheduleTime(assignment.startsAt, document.timeZone)}–
        {formatScheduleTime(assignment.endsAt, document.timeZone)}
      </small>
    </div>
  );
}
