"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { interpolate, opaqueId } from "@matchday/ui";
import {
  ArrowLeft,
  CalendarBlank,
  Check,
  CheckCircle,
  Clock,
  LockKey,
  ShieldWarning,
  UsersThree,
  Warning,
} from "@phosphor-icons/react";
import {
  assignmentForMatch,
  commandErrorMessage,
  createIdempotencyKey,
  formatScheduleDay,
  formatScheduleTime,
  moveSlotsForMatch,
  parseScheduleMoveResponse,
  phase4ScheduleCopy,
  phase4ScheduleMachine,
  type MoveConsequence,
  type ScheduleDocument,
  type ScheduleMatch,
} from "@/lib/phase4-schedule";
import styles from "./ScheduleMoveFlow.module.css";

type MoveValidation = Readonly<{
  valid: boolean;
  violations: readonly Readonly<{ message: string }>[];
  consequences: MoveConsequence;
}>;

const emptyConsequences: MoveConsequence = {
  affectedMatchIds: [],
  lockedMatchIds: [],
  dependencyMatchIds: [],
  messages: [],
};

export function ScheduleMoveFlow({ document, match }: { document: ScheduleDocument; match: ScheduleMatch }) {
  const router = useRouter();
  const current = assignmentForMatch(document.currentRevision, match.id);
  const moveSlots = useMemo(() => moveSlotsForMatch(document, match.id), [document, match.id]);
  const days = useMemo(
    () => [...new Set(moveSlots.map((slot) => formatDayKey(slot.startsAt, document.timeZone)))],
    [moveSlots, document.timeZone],
  );
  const [day, setDay] = useState(current ? formatDayKey(current.startsAt, document.timeZone) : (days[0] ?? ""));
  const [areaId, setAreaId] = useState(current?.areaId ?? document.areas[0]?.id ?? "");
  const eligibleSlots = moveSlots.filter(
    (slot) => slot.areaId === areaId && formatDayKey(slot.startsAt, document.timeZone) === day,
  );
  const [slotId, setSlotId] = useState(
    eligibleSlots.find((slot) => slot.id !== current?.slotId && slot.available)?.id ?? "",
  );
  const [showAllSlots, setShowAllSlots] = useState(false);
  const selectedSlot = moveSlots.find((slot) => slot.id === slotId) ?? null;
  const [validation, setValidation] = useState<Readonly<{ slotId: string; result: MoveValidation }> | null>(null);
  const [validatingSlotId, setValidatingSlotId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canEdit = document.canEdit && document.currentRevision?.status !== "expired";
  const currentRevisionId = document.currentRevision?.id;

  useEffect(() => {
    if (!selectedSlot?.available || !canEdit) return;
    let active = true;
    let settled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setValidatingSlotId(selectedSlot.id);
      setError("");
      try {
        const response = await fetch(
          `/api/phase4/schedule/revisions/${encodeURIComponent(currentRevisionId!)}/moves/validate`,
          {
            method: phase4ScheduleMachine.post,
            headers: { "content-type": phase4ScheduleMachine.json },
            signal: controller.signal,
            body: JSON.stringify({
              match_id: match.id,
              playing_area_id: selectedSlot.areaId,
              slot_id: selectedSlot.id,
              start_epoch_ms: Date.parse(selectedSlot.startsAt),
              end_epoch_ms: Date.parse(selectedSlot.endsAt),
            }),
          },
        );
        const payload: unknown = await response.json().catch(() => null);
        if (!active) return;
        if (!response.ok) {
          setValidation(null);
          setError(commandErrorMessage(response.status, responseErrorCode(payload)));
          return;
        }
        const parsed = parseMoveValidation(payload);
        if (!parsed) {
          setValidation(null);
          setError(phase4ScheduleCopy.malformed);
          return;
        }
        setValidation({ slotId: selectedSlot.id, result: parsed });
      } catch (caught) {
        if (active && !(caught instanceof DOMException && caught.name === "AbortError")) {
          setValidation(null);
          setError(phase4ScheduleCopy.offlineBody);
        }
      } finally {
        settled = true;
        if (active) setValidatingSlotId((current) => (current === selectedSlot.id ? null : current));
      }
    }, 180);
    return () => {
      active = false;
      if (!settled) controller.abort();
      window.clearTimeout(timer);
    };
  }, [canEdit, currentRevisionId, match.id, selectedSlot]);

  function chooseDay(value: string) {
    setShowAllSlots(false);
    setDay(value);
    const first = moveSlots.find(
      (slot) => slot.areaId === areaId && formatDayKey(slot.startsAt, document.timeZone) === value && slot.available,
    );
    if (first) {
      setSlotId(first.id);
      return;
    }
    const available = moveSlots.find(
      (slot) => formatDayKey(slot.startsAt, document.timeZone) === value && slot.available,
    );
    if (available) {
      setAreaId(available.areaId);
      setSlotId(available.id);
    } else setSlotId("");
  }

  function chooseArea(value: string) {
    setShowAllSlots(false);
    setAreaId(value);
    const first = moveSlots.find(
      (slot) => slot.areaId === value && formatDayKey(slot.startsAt, document.timeZone) === day && slot.available,
    );
    if (first) setSlotId(first.id);
  }

  const displayedValidation = validation !== null && validation.slotId === selectedSlot?.id ? validation.result : null;
  const validating = validatingSlotId === selectedSlot?.id;

  async function confirmMove() {
    if (!selectedSlot?.available || !displayedValidation?.valid || !document.currentRevision || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/phase4/schedule/revisions/${encodeURIComponent(document.currentRevision.id)}/moves`,
        {
          method: phase4ScheduleMachine.post,
          headers: { "content-type": phase4ScheduleMachine.json },
          body: JSON.stringify({
            idempotency_key: createIdempotencyKey(phase4ScheduleMachine.moveKey),
            expected_revision: document.currentRevision.revision,
            match_id: match.id,
            playing_area_id: selectedSlot.areaId,
            slot_id: selectedSlot.id,
            start_epoch_ms: Date.parse(selectedSlot.startsAt),
            end_epoch_ms: Date.parse(selectedSlot.endsAt),
          }),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setError(commandErrorMessage(response.status, responseErrorCode(payload)));
        return;
      }
      const moved = parseScheduleMoveResponse(payload);
      if (!moved) {
        setError(phase4ScheduleCopy.malformed);
        return;
      }
      const isAdvanced =
        typeof window !== "undefined" && new URLSearchParams(window.location.search).get(opaqueId("advanced")) === "1";
      const query = new URLSearchParams({
        match: match.id,
        notice: phase4ScheduleMachine.moveNotice,
        ...(isAdvanced ? { advanced: "1" } : {}),
      });
      router.replace(`/organiser/competitions/${document.competitionId}/schedule?${query.toString()}`, {
        scroll: false,
      });
    } catch {
      setError(phase4ScheduleCopy.offlineBody);
    } finally {
      setBusy(false);
    }
  }

  const isAdvanced =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get(opaqueId("advanced")) === "1";
  const consequences = displayedValidation?.consequences ?? emptyConsequences;
  return (
    <main className={styles.page} data-testid="phase4-move-flow">
      <p className={styles.live} aria-live="polite" aria-atomic="true">
        {validating ? phase4ScheduleCopy.validating : error}
      </p>
      <header className={styles.topbar}>
        <Link href={`/organiser/competitions/${document.competitionId}/schedule${isAdvanced ? "?advanced=1" : ""}`}>
          <ArrowLeft />
          {phase4ScheduleCopy.backToSchedule}
        </Link>
        <div>
          <strong>{document.competitionName}</strong>
          <small>{document.publicationRevision}</small>
        </div>
      </header>
      <section className={styles.heading}>
        <div>
          <h1>{phase4ScheduleCopy.move}</h1>
          <p>
            {match.roundLabel} · {match.code}
          </p>
        </div>
        {document.currentRevision?.editableUntil ? (
          <span>
            <Clock />
            {interpolate(phase4ScheduleCopy.draftExpires, {
              date: formatScheduleDay(document.currentRevision.editableUntil, document.timeZone),
            })}
          </span>
        ) : null}
      </section>

      <section className={styles.slotSummary} aria-label={phase4ScheduleCopy.currentAndProposed}>
        <div>
          <span>{phase4ScheduleCopy.currentSlot}</span>
          <strong>{current ? slotLabel(current, document) : phase4ScheduleCopy.unscheduled}</strong>
        </div>
        <div>
          <span>{phase4ScheduleCopy.proposedSlot}</span>
          <strong>{selectedSlot ? slotLabel(selectedSlot, document) : phase4ScheduleCopy.chooseSlot}</strong>
        </div>
      </section>

      {!canEdit ? (
        <div className={styles.boundary} role="alert">
          <LockKey />
          <div>
            <strong>
              {document.currentRevision?.status === "expired"
                ? phase4ScheduleCopy.expired
                : phase4ScheduleCopy.readOnly}
            </strong>
            <p>{phase4ScheduleCopy.expiredBody}</p>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className={styles.error} role="alert">
          <ShieldWarning />
          {error}
        </div>
      ) : null}

      <ol className={styles.steps}>
        <li>
          <StepNumber value="1" />
          <fieldset disabled={!canEdit}>
            <legend>{phase4ScheduleCopy.selectDay}</legend>
            <div className={styles.dayChoices}>
              {days.map((value) => {
                const representative = moveSlots.find(
                  (slot) => formatDayKey(slot.startsAt, document.timeZone) === value,
                )!;
                return (
                  <label key={value}>
                    <input
                      type="radio"
                      name="day"
                      value={value}
                      checked={day === value}
                      onChange={() => chooseDay(value)}
                    />
                    <CalendarBlank />
                    <span>{formatScheduleDay(representative.startsAt, document.timeZone)}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        </li>
        <li>
          <StepNumber value="2" />
          <fieldset disabled={!canEdit}>
            <legend>{phase4ScheduleCopy.selectArea}</legend>
            <div className={styles.choices}>
              {document.areas.map((area) => {
                const hasSlot = moveSlots.some(
                  (slot) =>
                    slot.areaId === area.id && formatDayKey(slot.startsAt, document.timeZone) === day && slot.available,
                );
                return (
                  <label key={area.id} data-disabled={!hasSlot || undefined}>
                    <input
                      type="radio"
                      name="area"
                      value={area.id}
                      checked={areaId === area.id}
                      disabled={!hasSlot}
                      onChange={() => chooseArea(area.id)}
                    />
                    <span>
                      <strong>{area.name}</strong>
                      <small>{hasSlot ? area.kind : phase4ScheduleCopy.noValidSlots}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        </li>
        <li>
          <StepNumber value="3" />
          <fieldset disabled={!canEdit}>
            <legend>{phase4ScheduleCopy.selectTime}</legend>
            <div
              id="move-slot-options"
              className={styles.choices}
              data-expanded={showAllSlots || undefined}
              data-testid="move-slot-choices"
            >
              {eligibleSlots.map((slot) => (
                <label key={slot.id} data-disabled={!slot.available || undefined}>
                  <input
                    type="radio"
                    name="slot"
                    value={slot.id}
                    checked={slotId === slot.id}
                    disabled={!slot.available}
                    onChange={() => setSlotId(slot.id)}
                  />
                  <span>
                    <strong>
                      {formatScheduleTime(slot.startsAt, document.timeZone)}–
                      {formatScheduleTime(slot.endsAt, document.timeZone)}
                    </strong>
                    {!slot.available ? (
                      <small>
                        <LockKey />
                        {slot.disabledReason ?? phase4ScheduleCopy.unavailable}
                      </small>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
            {eligibleSlots.length > 6 ? (
              <button
                className={styles.slotDisclosure}
                type="button"
                aria-expanded={showAllSlots}
                aria-controls="move-slot-options"
                onClick={() => setShowAllSlots((value) => !value)}
              >
                {showAllSlots
                  ? phase4ScheduleCopy.showFewerTimes
                  : interpolate(phase4ScheduleCopy.showAllTimes, { count: eligibleSlots.length })}
              </button>
            ) : null}
          </fieldset>
          {displayedValidation && !displayedValidation.valid ? (
            <div className={styles.validation} role="alert">
              <Warning />
              <div>
                <strong>{phase4ScheduleCopy.timeValidation}</strong>
                {displayedValidation.violations.map((violation) => (
                  <p key={violation.message}>{violation.message}</p>
                ))}
              </div>
            </div>
          ) : null}
        </li>
        <li>
          <StepNumber value="4" />
          <section className={styles.consequences} aria-labelledby="consequences-title">
            <h2 id="consequences-title">{phase4ScheduleCopy.reviewConsequences}</h2>
            {validating ? (
              <div className={styles.validating} aria-busy="true">
                <span />
                {phase4ScheduleCopy.checking}
              </div>
            ) : (
              <>
                <div>
                  <UsersThree />
                  <p>
                    {interpolate(phase4ScheduleCopy.consequencesAffected, {
                      count: consequences.affectedMatchIds.length,
                    })}
                  </p>
                </div>
                <div>
                  <LockKey />
                  <p>
                    {interpolate(phase4ScheduleCopy.consequencesLocked, { count: consequences.lockedMatchIds.length })}
                  </p>
                </div>
                {consequences.dependencyMatchIds.length ? (
                  <ul>
                    {consequences.dependencyMatchIds.map((id) => (
                      <li key={id}>
                        {interpolate(phase4ScheduleCopy.requiresCompletion, {
                          match: document.matches.find((item) => item.id === id)?.code ?? id,
                        })}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {consequences.messages.map((item) => (
                  <p key={item}>{item}</p>
                ))}
                {displayedValidation?.valid ? (
                  <div className={styles.valid}>
                    <CheckCircle />
                    <p>
                      {consequences.affectedMatchIds.length
                        ? phase4ScheduleCopy.exactAffectedSet
                        : phase4ScheduleCopy.onlySelectedChanges}
                    </p>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </li>
      </ol>

      <footer className={styles.actions}>
        <Link href={`/organiser/competitions/${document.competitionId}/schedule`}>{phase4ScheduleCopy.cancel}</Link>
        <button
          type="button"
          disabled={!canEdit || !displayedValidation?.valid || validating || busy}
          onClick={() => void confirmMove()}
        >
          <Check />
          {busy ? phase4ScheduleCopy.confirming : phase4ScheduleCopy.confirmMove}
        </button>
      </footer>
    </main>
  );
}

function StepNumber({ value }: { value: string }) {
  return (
    <span className={styles.stepNumber} data-testid="move-step-number" aria-hidden="true">
      {value}
    </span>
  );
}

function slotLabel(slot: { areaId: string; startsAt: string; endsAt: string }, document: ScheduleDocument): string {
  return `${document.areas.find((area) => area.id === slot.areaId)?.name ?? phase4ScheduleCopy.unknownArea} · ${formatScheduleTime(slot.startsAt, document.timeZone)}–${formatScheduleTime(slot.endsAt, document.timeZone)}`;
}

function formatDayKey(value: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat(phase4ScheduleMachine.locale, {
    timeZone,
    year: phase4ScheduleMachine.numeric,
    month: phase4ScheduleMachine.twoDigit,
    day: phase4ScheduleMachine.twoDigit,
  }).formatToParts(new Date(value));
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read(phase4ScheduleMachine.year)}-${read(phase4ScheduleMachine.month)}-${read(phase4ScheduleMachine.day)}`;
}

function responseErrorCode(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const error = (value as { error?: unknown }).error;
  return error &&
    typeof error === "object" &&
    !Array.isArray(error) &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}

function parseMoveValidation(value: unknown): MoveValidation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const validation = root.validation;
  const consequences = root.consequences;
  if (
    !validation ||
    typeof validation !== "object" ||
    Array.isArray(validation) ||
    !consequences ||
    typeof consequences !== "object" ||
    Array.isArray(consequences)
  )
    return null;
  const validRecord = validation as Record<string, unknown>;
  const consequenceRecord = consequences as Record<string, unknown>;
  if (
    typeof validRecord.valid !== "boolean" ||
    !Array.isArray(validRecord.violations) ||
    !validRecord.violations.every(
      (item) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof (item as { message?: unknown }).message === "string",
    )
  )
    return null;
  for (const key of [
    phase4ScheduleMachine.affectedMatchIds,
    phase4ScheduleMachine.lockedMatchIds,
    phase4ScheduleMachine.dependencyMatchIds,
    phase4ScheduleMachine.messages,
  ] as const)
    if (
      !Array.isArray(consequenceRecord[key]) ||
      !(consequenceRecord[key] as unknown[]).every((item) => typeof item === "string")
    )
      return null;
  return {
    valid: validRecord.valid,
    violations: validRecord.violations as readonly { message: string }[],
    consequences: {
      affectedMatchIds: consequenceRecord[phase4ScheduleMachine.affectedMatchIds] as string[],
      lockedMatchIds: consequenceRecord[phase4ScheduleMachine.lockedMatchIds] as string[],
      dependencyMatchIds: consequenceRecord[phase4ScheduleMachine.dependencyMatchIds] as string[],
      messages: consequenceRecord[phase4ScheduleMachine.messages] as string[],
    },
  };
}
