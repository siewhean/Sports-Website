"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { interpolate } from "@matchday/ui";
import {
  ArrowsClockwise,
  ArrowsLeftRight,
  CalendarBlank,
  CheckCircle,
  Clock,
  HourglassMedium,
  LockKey,
  LockKeyOpen,
  Play,
  ShieldWarning,
  Stop,
  Timer,
  Warning,
} from "@phosphor-icons/react";
import {
  assignmentForMatch,
  commandErrorMessage,
  createIdempotencyKey,
  formatDuration,
  formatScheduleDay,
  formatScheduleTime,
  lockForMatch,
  matchesForArea,
  objectiveLabel,
  phase4ScheduleCopy,
  phase4ScheduleMachine,
  scheduleConflictForMatch,
  parseScheduleJobEnvelope,
  parseScheduleJobView,
  type ScheduleDocument,
  type ScheduleJob,
  type ScheduleJobStatus,
  type ScheduleMatch,
  type ScheduleObjective,
  type ScheduleOption,
} from "@/lib/phase4-schedule";
import styles from "./ScheduleWorkspace.module.css";

type ErrorPayload = { error?: { code?: string } };

function errorCode(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const error = (value as ErrorPayload).error;
  return error && typeof error.code === "string" ? error.code : null;
}

const activeStatuses = new Set<ScheduleJobStatus>([
  phase4ScheduleMachine.queued,
  phase4ScheduleMachine.running,
  phase4ScheduleMachine.best,
  phase4ScheduleMachine.cancelling,
]);

function withRetainedAlternative(current: readonly ScheduleOption[], option: ScheduleOption): ScheduleOption[] {
  return [...current.filter((candidate) => candidate.objective !== option.objective), option];
}

export function ScheduleWorkspace({ document }: { document: ScheduleDocument }) {
  const router = useRouter();
  const liveRef = useRef<HTMLParagraphElement>(null);
  const [job, setJob] = useState(document.activeJob);
  const [retainedAlternatives, setRetainedAlternatives] = useState(document.alternatives);
  const [objective, setObjective] = useState<ScheduleObjective>(job?.objective ?? "balanced");
  const [selectedMatchId, setSelectedMatchId] = useState(
    document.currentRevision?.assignments[0]?.matchId ?? document.matches[0]?.id ?? null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [commandError, setCommandError] = useState("");
  const selectedMatch = document.matches.find((match) => match.id === selectedMatchId) ?? null;
  const assignment = selectedMatch ? assignmentForMatch(document.currentRevision, selectedMatch.id) : null;
  const selectedLock = selectedMatch ? lockForMatch(document.locks, selectedMatch.id) : null;
  const currentOption = job?.currentBest ?? null;
  const options = useMemo(() => {
    const byObjective = new Map<ScheduleObjective, ScheduleOption>();
    for (const option of retainedAlternatives) byObjective.set(option.objective, option);
    if (currentOption) byObjective.set(currentOption.objective, currentOption);
    return [...byObjective.values()];
  }, [currentOption, retainedAlternatives]);
  const expired = document.currentRevision?.status === "expired";
  const disabled = !document.canEdit || expired || busy !== null;
  const polledJobId = job?.id;
  const polledJobStatus = job?.status;

  function refreshWorkspace(announcement: string) {
    setMessage(announcement);
    router.refresh();
    window.requestAnimationFrame(() => liveRef.current?.focus({ preventScroll: true }));
  }

  useEffect(() => {
    if (!polledJobId || !polledJobStatus || !activeStatuses.has(polledJobStatus)) return;
    let live = true;
    const poll = async () => {
      try {
        const response = await fetch(`/api/phase4/schedule/jobs/${encodeURIComponent(polledJobId)}`, {
          cache: phase4ScheduleMachine.noStore,
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!live) return;
        if (!response.ok) {
          setCommandError(commandErrorMessage(response.status, errorCode(payload)));
          return;
        }
        const parsed = parseScheduleJobView(payload);
        if (!parsed) {
          setCommandError(phase4ScheduleCopy.malformed);
          return;
        }
        if (parsed.currentBest)
          setRetainedAlternatives((current) => withRetainedAlternative(current, parsed.currentBest!));
        setJob(parsed);
        if (!activeStatuses.has(parsed.status)) setMessage(jobStatusMessage(parsed));
      } catch {
        if (live) setCommandError(phase4ScheduleCopy.offlineBody);
      }
    };
    const timer = window.setInterval(() => void poll(), 1_500);
    void poll();
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [polledJobId, polledJobStatus]);

  async function command(
    name: string,
    url: string,
    body: Record<string, unknown>,
    onSuccess?: (payload: unknown) => void,
    method: "POST" | "DELETE" = phase4ScheduleMachine.post,
  ) {
    if (busy) return;
    setBusy(name);
    setCommandError("");
    setMessage("");
    try {
      const response = await fetch(url, {
        method,
        headers: { "content-type": phase4ScheduleMachine.json },
        body: JSON.stringify(body),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setCommandError(commandErrorMessage(response.status, errorCode(payload)));
        return;
      }
      onSuccess?.(payload);
    } catch {
      setCommandError(phase4ScheduleCopy.offlineBody);
    } finally {
      setBusy(null);
    }
  }

  async function generate() {
    if (job?.currentBest) setRetainedAlternatives((current) => withRetainedAlternative(current, job.currentBest!));
    await command(
      phase4ScheduleMachine.generateAction,
      `/api/phase4/competitions/${encodeURIComponent(document.competitionId)}/schedule/jobs`,
      {
        idempotency_key: createIdempotencyKey(phase4ScheduleMachine.generateKey),
        expected_source_revision: document.sourceRevision,
        expected_capacity_revision: document.capacityRevision,
        objective,
        constraints: document.constraints,
      },
      (payload) => {
        const nextJob = parseScheduleJobEnvelope(payload);
        if (!nextJob) {
          setCommandError(phase4ScheduleCopy.malformed);
          return;
        }
        setJob(nextJob);
        setMessage(phase4ScheduleCopy.generationQueued);
      },
    );
  }

  async function continueOptimising() {
    if (!job) return;
    await command(
      phase4ScheduleMachine.continueAction,
      `/api/phase4/schedule/jobs/${encodeURIComponent(job.id)}/continue`,
      { idempotency_key: createIdempotencyKey(phase4ScheduleMachine.continueKey), expected_revision: job.revision },
      (payload) => {
        const nextJob = parseScheduleJobEnvelope(payload);
        if (!nextJob) setCommandError(phase4ScheduleCopy.malformed);
        else {
          setJob(nextJob);
          setMessage(phase4ScheduleCopy.continued);
        }
      },
    );
  }

  async function cancelJob() {
    if (!job) return;
    await command(
      phase4ScheduleMachine.cancelAction,
      `/api/phase4/schedule/jobs/${encodeURIComponent(job.id)}/cancel`,
      { idempotency_key: createIdempotencyKey(phase4ScheduleMachine.cancelKey), expected_revision: job.revision },
      (payload) => {
        const nextJob = parseScheduleJobView(payload, true);
        if (!nextJob) setCommandError(phase4ScheduleCopy.malformed);
        else {
          setJob(nextJob);
          setMessage(phase4ScheduleCopy.cancellationRequested);
        }
      },
    );
  }

  async function acceptOption(option: ScheduleOption) {
    if (option.jobRevision === null) {
      setCommandError(phase4ScheduleCopy.malformed);
      return;
    }
    await command(
      phase4ScheduleMachine.acceptAction,
      `/api/phase4/schedule/jobs/${encodeURIComponent(option.jobId)}/options/${encodeURIComponent(option.id)}/accept`,
      {
        idempotency_key: createIdempotencyKey(phase4ScheduleMachine.acceptKey),
        expected_job_revision: option.jobRevision,
      },
      () => {
        setJob(null);
        setRetainedAlternatives([]);
        refreshWorkspace(phase4ScheduleCopy.optionSaved);
      },
    );
  }

  async function publish() {
    if (!document.currentRevision) return;
    await command(
      phase4ScheduleMachine.publishAction,
      `/api/phase4/schedule/revisions/${encodeURIComponent(document.currentRevision.id)}/publish`,
      {
        idempotency_key: createIdempotencyKey(phase4ScheduleMachine.publishKey),
        expected_revision: document.currentRevision.revision,
      },
      () => refreshWorkspace(phase4ScheduleCopy.publishSuccess),
    );
  }

  async function toggleLock() {
    if (!selectedMatch || !assignment) return;
    const url = selectedLock
      ? `/api/phase4/schedule/revisions/${encodeURIComponent(document.currentRevision!.id)}/locks/${encodeURIComponent(selectedMatch.id)}`
      : `/api/phase4/schedule/revisions/${encodeURIComponent(document.currentRevision!.id)}/locks`;
    await command(
      phase4ScheduleMachine.lockAction,
      url,
      selectedLock
        ? { idempotency_key: createIdempotencyKey(phase4ScheduleMachine.unlockKey) }
        : {
            idempotency_key: createIdempotencyKey(phase4ScheduleMachine.lockKey),
            match_id: selectedMatch.id,
            playing_area_id: assignment.areaId,
            start_epoch_ms: Date.parse(assignment.startsAt),
            end_epoch_ms: Date.parse(assignment.endsAt),
          },
      () => refreshWorkspace(phase4ScheduleCopy.saved),
      selectedLock ? phase4ScheduleMachine.delete : phase4ScheduleMachine.post,
    );
  }

  if (document.state === "loading") return <ScheduleSkeleton />;
  if (document.state !== "ready" && document.state !== "read-only") {
    return <ScheduleState state={document.state} />;
  }

  return (
    <div className={styles.workspace} data-testid="phase4-schedule">
      <p ref={liveRef} className={styles.live} aria-live="polite" aria-atomic="true" tabIndex={-1}>
        {message || commandError}
      </p>

      {document.state === "read-only" ? (
        <StatusRail icon={<LockKey />} title={phase4ScheduleCopy.readOnly} body={phase4ScheduleCopy.readOnlyBody} />
      ) : null}
      {expired ? (
        <StatusRail
          icon={<Clock />}
          title={phase4ScheduleCopy.expired}
          body={phase4ScheduleCopy.expiredBody}
          tone="danger"
        />
      ) : null}
      {document.warnings.map((warning) => (
        <StatusRail
          key={`${warning.code}-${warning.message}`}
          icon={<Warning />}
          title={warning.code === "expired" ? phase4ScheduleCopy.expired : phase4ScheduleCopy.expiry}
          body={warning.message}
          tone={warning.code === "expired" ? "danger" : "warning"}
        />
      ))}
      {commandError ? (
        <div className={styles.commandError} role="alert">
          <ShieldWarning aria-hidden="true" />
          {commandError}
        </div>
      ) : null}

      <section className={styles.commandBar} aria-labelledby="strategy-title">
        <div className={styles.strategy}>
          <p id="strategy-title">{phase4ScheduleCopy.strategy}</p>
          <div role="radiogroup" aria-labelledby="strategy-title">
            {(
              [
                phase4ScheduleMachine.fastest,
                phase4ScheduleMachine.balanced,
                phase4ScheduleMachine.restFocused,
              ] as const
            ).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={objective === value}
                disabled={disabled || Boolean(job && activeStatuses.has(job.status))}
                onClick={() => setObjective(value)}
              >
                {value === "fastest" ? <Timer /> : value === "rest_focused" ? <HourglassMedium /> : <ArrowsLeftRight />}
                {objectiveLabel(value)}
              </button>
            ))}
          </div>
        </div>
        <QualityOverview option={currentOption ?? options.find((option) => option.objective === objective) ?? null} />
        <div className={styles.headerActions}>
          <Link href={`/organiser/competitions/${document.competitionId}/schedule/compare`}>
            {phase4ScheduleCopy.compare}
          </Link>
          <button type="button" onClick={() => void publish()} disabled={!document.canPublish || disabled}>
            {busy === phase4ScheduleMachine.publishAction ? phase4ScheduleCopy.publishing : phase4ScheduleCopy.publish}
          </button>
        </div>
      </section>

      {options.length ? (
        <OptionComparison
          options={options}
          currentRevision={document.currentRevision?.revision ?? null}
          onAccept={acceptOption}
          disabled={disabled}
        />
      ) : null}

      {document.currentRevision ? (
        <div className={styles.planner}>
          <UnscheduledTray document={document} onSelect={setSelectedMatchId} selectedMatchId={selectedMatchId} />
          <Timeline document={document} selectedMatchId={selectedMatchId} onSelect={setSelectedMatchId} />
          <MatchInspector
            document={document}
            match={selectedMatch}
            locked={Boolean(selectedLock)}
            onToggleLock={toggleLock}
            disabled={disabled || !assignment}
          />
        </div>
      ) : (
        <ScheduleEmpty objective={objective} disabled={disabled} busy={busy === "generate"} onGenerate={generate} />
      )}

      <JobRail
        job={job}
        disabled={disabled}
        busy={busy}
        onGenerate={generate}
        onContinue={continueOptimising}
        onCancel={cancelJob}
        onAccept={acceptOption}
        objective={objective}
      />
    </div>
  );
}

function QualityOverview({ option }: { option: ScheduleOption | null }) {
  return (
    <dl className={styles.quality} aria-label={phase4ScheduleCopy.quality}>
      <div>
        <dt>{phase4ScheduleCopy.duration}</dt>
        <dd>{option ? formatDuration(option.quality.makespanMinutes) : "—"}</dd>
      </div>
      <div>
        <dt>{phase4ScheduleCopy.minimumRest}</dt>
        <dd>{option?.quality.minimumRestMinutes == null ? "—" : `${option.quality.minimumRestMinutes} min`}</dd>
      </div>
      <div>
        <dt>{phase4ScheduleCopy.dailyLoad}</dt>
        <dd>{option ? `${option.quality.maximumMatchesPerEntryDay} matches` : "—"}</dd>
      </div>
      <div>
        <dt>{phase4ScheduleCopy.penalty}</dt>
        <dd>{option ? String(option.quality.preferredPenalty) : "—"}</dd>
      </div>
    </dl>
  );
}

function OptionComparison({
  options,
  currentRevision,
  onAccept,
  disabled,
}: {
  options: readonly ScheduleOption[];
  currentRevision: number | null;
  onAccept: (option: ScheduleOption) => Promise<void>;
  disabled: boolean;
}) {
  return (
    <section className={styles.options} aria-labelledby="option-comparison-title">
      <header>
        <div>
          <p>{phase4ScheduleCopy.measurableAlternatives}</p>
          <h2 id="option-comparison-title">{phase4ScheduleCopy.compareQuality}</h2>
        </div>
        {currentRevision ? (
          <span>{interpolate(phase4ScheduleCopy.draftRemainsSelected, { revision: currentRevision })}</span>
        ) : null}
      </header>
      <div className={styles.optionRows}>
        {options.map((option) => (
          <article key={option.id}>
            <div>
              <h3>{objectiveLabel(option.objective)}</h3>
              <p>{objectiveExplanation(option)}</p>
            </div>
            <dl>
              <div>
                <dt>{phase4ScheduleCopy.duration}</dt>
                <dd>{formatDuration(option.quality.makespanMinutes)}</dd>
              </div>
              <div>
                <dt>{phase4ScheduleCopy.minimumRest}</dt>
                <dd>
                  {option.quality.minimumRestMinutes == null ? "—" : formatDuration(option.quality.minimumRestMinutes)}
                </dd>
              </div>
              <div>
                <dt>{phase4ScheduleCopy.movement}</dt>
                <dd>
                  {qualityMetric(option, phase4ScheduleMachine.schedulePreservation)}
                  <small>{qualityExplanation(option, phase4ScheduleMachine.schedulePreservation)}</small>
                </dd>
              </div>
              <div>
                <dt>{phase4ScheduleCopy.unassigned}</dt>
                <dd>{option.assignments.length ? 0 : "—"}</dd>
              </div>
            </dl>
            <button type="button" disabled={disabled || !option.quality.valid} onClick={() => void onAccept(option)}>
              {interpolate(phase4ScheduleCopy.useObjective, { objective: objectiveLabel(option.objective) })}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function objectiveExplanation(option: ScheduleOption): string {
  const key =
    option.objective === phase4ScheduleMachine.fastest
      ? phase4ScheduleMachine.completionQuality
      : option.objective === phase4ScheduleMachine.restFocused
        ? phase4ScheduleMachine.restQuality
        : phase4ScheduleMachine.dailyBalanceQuality;
  return (
    option.quality.components.find((component) => component.key === key)?.explanation ??
    phase4ScheduleCopy.validSchedule
  );
}

function qualityMetric(option: ScheduleOption, key: string): string {
  const component = option.quality.components.find((item) => item.key === key);
  return component ? `${component.measured}${component.unit === "percent" ? "%" : ` ${component.unit}`}` : "—";
}

function qualityExplanation(option: ScheduleOption, key: string): string {
  return option.quality.components.find((item) => item.key === key)?.explanation ?? phase4ScheduleCopy.validSchedule;
}

function UnscheduledTray({
  document,
  onSelect,
  selectedMatchId,
}: {
  document: ScheduleDocument;
  onSelect: (id: string) => void;
  selectedMatchId: string | null;
}) {
  const assignedIds = new Set(document.currentRevision?.assignments.map((assignment) => assignment.matchId) ?? []);
  const unscheduled = document.matches.filter((match) => !assignedIds.has(match.id));
  return (
    <aside className={styles.tray} aria-labelledby="unscheduled-title">
      <header>
        <h2 id="unscheduled-title">{phase4ScheduleCopy.unscheduled}</h2>
        <span>{unscheduled.length}</span>
      </header>
      {unscheduled.length ? (
        <ul>
          {unscheduled.map((match) => (
            <li key={match.id}>
              <button type="button" aria-pressed={selectedMatchId === match.id} onClick={() => onSelect(match.id)}>
                <span>{match.roundLabel}</span>
                <strong>{match.code}</strong>
                <small>
                  {match.homeLabel} {phase4ScheduleCopy.versus} {match.awayLabel}
                </small>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>{phase4ScheduleCopy.allScheduled}</p>
      )}
    </aside>
  );
}

function Timeline({
  document,
  selectedMatchId,
  onSelect,
}: {
  document: ScheduleDocument;
  selectedMatchId: string | null;
  onSelect: (id: string) => void;
}) {
  const allAssignments = document.currentRevision?.assignments ?? [];
  const start = allAssignments.length
    ? Math.min(...allAssignments.map((assignment) => Date.parse(assignment.startsAt)))
    : 0;
  const end = allAssignments.length
    ? Math.max(...allAssignments.map((assignment) => Date.parse(assignment.endsAt)))
    : 0;
  const span = Math.max(end - start, 30 * 60_000);
  const ticks = start
    ? Array.from(
        { length: Math.min(10, Math.max(2, Math.ceil(span / 3_600_000) + 1)) },
        (_, index) => start + index * 3_600_000,
      )
    : [];
  return (
    <section className={styles.timeline} aria-labelledby="timeline-title">
      <header>
        <div>
          <p>{interpolate(phase4ScheduleCopy.privateDraft, { revision: document.currentRevision?.revision ?? "—" })}</p>
          <h2 id="timeline-title">{phase4ScheduleCopy.timeline}</h2>
        </div>
        <Link href={`/organiser/competitions/${document.competitionId}/schedule/revisions`}>
          {phase4ScheduleCopy.revisions}
        </Link>
      </header>
      <div className={styles.desktopTimeline} role="region" aria-label={phase4ScheduleCopy.timelineRegion} tabIndex={0}>
        <div className={styles.axis} aria-hidden="true">
          <span />
          {ticks.map((tick) => (
            <time key={tick}>{formatScheduleTime(new Date(tick).toISOString(), document.timeZone)}</time>
          ))}
        </div>
        {document.areas.map((area) => (
          <div className={styles.areaRow} key={area.id}>
            <div className={styles.areaLabel}>
              <strong>{area.name}</strong>
              <span>{area.kind}</span>
            </div>
            <div className={styles.areaTrack}>
              {matchesForArea(document, area.id).map(({ match, assignment }) => {
                const left = ((Date.parse(assignment.startsAt) - start) / span) * 100;
                const width = ((Date.parse(assignment.endsAt) - Date.parse(assignment.startsAt)) / span) * 100;
                const locked = Boolean(lockForMatch(document.locks, match.id));
                const conflict = scheduleConflictForMatch(document, match.id);
                const timeLabel = `${formatScheduleTime(assignment.startsAt, document.timeZone)}–${formatScheduleTime(assignment.endsAt, document.timeZone)}`;
                return (
                  <button
                    key={match.id}
                    type="button"
                    className={styles.matchBlock}
                    style={{ left: `${left}%`, width: `${Math.max(width, 9)}%` }}
                    data-conflict={conflict || undefined}
                    aria-pressed={selectedMatchId === match.id}
                    aria-label={`${match.code}, ${match.roundLabel}, ${match.homeLabel} ${phase4ScheduleCopy.versus} ${match.awayLabel}, ${timeLabel}${conflict ? `, ${phase4ScheduleCopy.conflictLegend}` : ""}${locked ? `, ${phase4ScheduleCopy.locked}` : ""}`}
                    onClick={() => onSelect(match.id)}
                  >
                    <span>{match.roundLabel}</span>
                    <strong>{match.code}</strong>
                    <small>{timeLabel}</small>
                    <span className={styles.matchStatus} aria-hidden="true">
                      {conflict ? <Warning /> : null}
                      {locked ? <LockKey /> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className={styles.semanticTimeline}>
        <p>{phase4ScheduleCopy.timelineMobileExplanation}</p>
        {document.areas.map((area) => (
          <section key={area.id} aria-labelledby={`area-${area.id}`}>
            <h3 id={`area-${area.id}`}>{area.name}</h3>
            <ol>
              {matchesForArea(document, area.id).map(({ match, assignment }) => {
                const locked = Boolean(lockForMatch(document.locks, match.id));
                const conflict = scheduleConflictForMatch(document, match.id);
                return (
                  <li key={match.id} data-conflict={conflict || undefined}>
                    <button
                      type="button"
                      onClick={() => onSelect(match.id)}
                      aria-pressed={selectedMatchId === match.id}
                      aria-label={`${match.code}, ${match.roundLabel}, ${match.homeLabel} ${phase4ScheduleCopy.versus} ${match.awayLabel}, ${formatScheduleTime(assignment.startsAt, document.timeZone)}${conflict ? `, ${phase4ScheduleCopy.conflictLegend}` : ""}${locked ? `, ${phase4ScheduleCopy.locked}` : ""}`}
                    >
                      <time>{formatScheduleTime(assignment.startsAt, document.timeZone)}</time>
                      <span>
                        <strong>
                          {match.code} · {match.roundLabel}
                        </strong>
                        <small>
                          {match.homeLabel} {phase4ScheduleCopy.versus} {match.awayLabel}
                        </small>
                        {conflict || locked ? (
                          <small className={styles.semanticStatus} aria-hidden="true">
                            {conflict ? (
                              <>
                                <Warning /> {phase4ScheduleCopy.conflictLegend}
                              </>
                            ) : null}
                            {locked ? (
                              <>
                                <LockKey /> {phase4ScheduleCopy.locked}
                              </>
                            ) : null}
                          </small>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
      <footer className={styles.legend}>
        <span>
          <LockKey /> {phase4ScheduleCopy.locked}
        </span>
        <span>
          <ArrowsLeftRight /> {phase4ScheduleCopy.dependency}
        </span>
        <span>
          <Warning /> {phase4ScheduleCopy.conflictLegend}
        </span>
      </footer>
    </section>
  );
}

function MatchInspector({
  document,
  match,
  locked,
  onToggleLock,
  disabled,
}: {
  document: ScheduleDocument;
  match: ScheduleMatch | null;
  locked: boolean;
  onToggleLock: () => Promise<void>;
  disabled: boolean;
}) {
  const assignment = match ? assignmentForMatch(document.currentRevision, match.id) : null;
  return (
    <aside className={styles.inspector} aria-labelledby="selected-match-title">
      <header>
        <p>{phase4ScheduleCopy.selectedMatch}</p>
        <h2 id="selected-match-title">{match?.code ?? phase4ScheduleCopy.noMatchSelected}</h2>
      </header>
      {!match ? (
        <p>{phase4ScheduleCopy.noSelection}</p>
      ) : (
        <>
          <dl>
            <div>
              <dt>{phase4ScheduleCopy.division}</dt>
              <dd>{match.divisionName}</dd>
            </div>
            <div>
              <dt>{phase4ScheduleCopy.round}</dt>
              <dd>{match.roundLabel}</dd>
            </div>
            <div>
              <dt>{phase4ScheduleCopy.teams}</dt>
              <dd>
                {match.homeLabel}
                <br />
                {match.awayLabel}
              </dd>
            </div>
            <div>
              <dt>{phase4ScheduleCopy.playingArea}</dt>
              <dd>
                {document.areas.find((area) => area.id === assignment?.areaId)?.name ?? phase4ScheduleCopy.unscheduled}
              </dd>
            </div>
            <div>
              <dt>{phase4ScheduleCopy.date}</dt>
              <dd>{assignment ? formatScheduleDay(assignment.startsAt, document.timeZone) : "—"}</dd>
            </div>
            <div>
              <dt>{phase4ScheduleCopy.time}</dt>
              <dd>
                {assignment
                  ? `${formatScheduleTime(assignment.startsAt, document.timeZone)}–${formatScheduleTime(assignment.endsAt, document.timeZone)}`
                  : "—"}
              </dd>
            </div>
          </dl>
          <section>
            <h3>{phase4ScheduleCopy.dependencies}</h3>
            {match.dependencyMatchIds.length ? (
              <ul>
                {match.dependencyMatchIds.map((id) => (
                  <li key={id}>{document.matches.find((candidate) => candidate.id === id)?.code ?? id}</li>
                ))}
              </ul>
            ) : (
              <p>{phase4ScheduleCopy.noDependencies}</p>
            )}
          </section>
          <button className={styles.lockButton} type="button" disabled={disabled} onClick={() => void onToggleLock()}>
            {locked ? <LockKeyOpen /> : <LockKey />}
            {locked ? phase4ScheduleCopy.unlock : phase4ScheduleCopy.lock}
          </button>
          {assignment ? (
            <Link
              className={styles.moveLink}
              href={`/organiser/competitions/${document.competitionId}/schedule/revisions/${document.currentRevision!.id}/matches/${match.id}/move`}
            >
              {phase4ScheduleCopy.move}
            </Link>
          ) : null}
        </>
      )}
    </aside>
  );
}

function JobRail({
  job,
  disabled,
  busy,
  onGenerate,
  onContinue,
  onCancel,
  onAccept,
  objective,
}: {
  job: ScheduleJob | null;
  disabled: boolean;
  busy: string | null;
  onGenerate: () => Promise<void>;
  onContinue: () => Promise<void>;
  onCancel: () => Promise<void>;
  onAccept: (option: ScheduleOption) => Promise<void>;
  objective: ScheduleObjective;
}) {
  if (!job)
    return (
      <footer className={styles.jobRail}>
        <div>
          <CalendarBlank />
          <span>
            <strong>{phase4ScheduleCopy.noOptimisation}</strong>
            <small>{phase4ScheduleCopy.generateLatest}</small>
          </span>
        </div>
        <button type="button" disabled={disabled} onClick={() => void onGenerate()}>
          <Play />
          {phase4ScheduleCopy.generate}
        </button>
      </footer>
    );
  const active = activeStatuses.has(job.status);
  return (
    <footer className={styles.jobRail} data-job-status={job.status}>
      <div>
        {job.currentBest ? <CheckCircle /> : <ArrowsClockwise />}
        <span>
          <strong>{jobStatusTitle(job)}</strong>
          <small>
            {job.currentBest
              ? interpolate(phase4ScheduleCopy.objectiveQuality, {
                  objective: objectiveLabel(job.objective),
                  quality: job.currentBest.quality.score,
                })
              : phase4ScheduleCopy.selectedUnchanged}
            {job.exploredCandidates > 0
              ? ` ${interpolate(
                  job.exploredCandidates === 1
                    ? phase4ScheduleCopy.candidateExplored
                    : phase4ScheduleCopy.candidatesExplored,
                  { count: job.exploredCandidates },
                )}`
              : ""}
          </small>
        </span>
      </div>
      <div className={styles.jobActions}>
        {!active && job.currentBest ? (
          <button type="button" disabled={disabled || busy !== null} onClick={() => void onContinue()}>
            <ArrowsClockwise />
            {phase4ScheduleCopy.continue}
          </button>
        ) : null}
        {!active ? (
          <button type="button" disabled={disabled || busy !== null} onClick={() => void onGenerate()}>
            <Play />
            {interpolate(phase4ScheduleCopy.generateObjective, { objective: objectiveLabel(objective) })}
          </button>
        ) : null}
        {active ? (
          <button
            type="button"
            disabled={disabled || busy !== null || job.status === phase4ScheduleMachine.cancelling}
            onClick={() => void onCancel()}
          >
            <Stop />
            {job.status === phase4ScheduleMachine.cancelling ? phase4ScheduleCopy.cancelling : phase4ScheduleCopy.stop}
          </button>
        ) : null}
        {job.currentBest ? (
          <button
            className={styles.useButton}
            type="button"
            disabled={disabled || busy !== null}
            onClick={() => void onAccept(job.currentBest!)}
          >
            <CheckCircle />
            {phase4ScheduleCopy.use}
          </button>
        ) : null}
      </div>
    </footer>
  );
}

function jobStatusTitle(job: ScheduleJob): string {
  switch (job.status) {
    case "queued":
      return phase4ScheduleCopy.optimisationQueued;
    case "running":
      return phase4ScheduleCopy.searching;
    case "valid_best_found":
      return phase4ScheduleCopy.currentBest;
    case "cancelling":
      return phase4ScheduleCopy.stopping;
    case "cancelled":
      return job.currentBest ? phase4ScheduleCopy.cancelledRetained : phase4ScheduleCopy.cancelled;
    case "completed":
      return job.currentBest ? phase4ScheduleCopy.complete : phase4ScheduleCopy.ended;
    case "failed":
      return job.currentBest ? phase4ScheduleCopy.failedRetained : phase4ScheduleCopy.failed;
    case "no_solution":
      return phase4ScheduleCopy.noSolution;
    case "stale":
      return phase4ScheduleCopy.inputsChanged;
  }
}

function jobStatusMessage(job: ScheduleJob): string {
  return `${jobStatusTitle(job)}. ${job.currentBest ? phase4ScheduleCopy.bestAvailable : phase4ScheduleCopy.selectedUnchanged}`;
}

function ScheduleEmpty({
  objective,
  disabled,
  busy,
  onGenerate,
}: {
  objective: ScheduleObjective;
  disabled: boolean;
  busy: boolean;
  onGenerate: () => Promise<void>;
}) {
  return (
    <section className={styles.empty}>
      <CalendarBlank />
      <div>
        <h2>{phase4ScheduleCopy.noSchedule}</h2>
        <p>{phase4ScheduleCopy.noScheduleBody}</p>
      </div>
      <button type="button" disabled={disabled} onClick={() => void onGenerate()}>
        {busy
          ? phase4ScheduleCopy.generating
          : interpolate(phase4ScheduleCopy.generateObjective, { objective: objectiveLabel(objective) })}
      </button>
    </section>
  );
}

function StatusRail({
  icon,
  title,
  body,
  tone = phase4ScheduleMachine.neutral,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  tone?: "neutral" | "warning" | "danger";
}) {
  return (
    <div className={styles.statusRail} data-tone={tone} role={tone === "danger" ? "alert" : "note"}>
      {icon}
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
    </div>
  );
}

function ScheduleState({ state }: { state: ScheduleDocument["state"] }) {
  const content =
    state === "permission"
      ? [phase4ScheduleCopy.permission, phase4ScheduleCopy.permissionBody]
      : state === "offline"
        ? [phase4ScheduleCopy.offline, phase4ScheduleCopy.offlineBody]
        : state === "empty"
          ? [phase4ScheduleCopy.noSchedule, phase4ScheduleCopy.noScheduleBody]
          : [phase4ScheduleCopy.error, phase4ScheduleCopy.errorBody];
  return (
    <section className={styles.state} role={state === "error" || state === "offline" ? "alert" : "status"}>
      <ShieldWarning />
      <div>
        <h2>{content[0]}</h2>
        <p>{content[1]}</p>
      </div>
    </section>
  );
}

function ScheduleSkeleton() {
  return (
    <div className={styles.skeleton} role="status" aria-label={phase4ScheduleCopy.loading} aria-busy="true">
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}
