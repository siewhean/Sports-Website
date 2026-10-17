"use client";

import { useId, useState } from "react";
import { messages } from "@matchday/ui";
import { InfoTip, NumberField } from "@matchday/ui/react";
import { Clock, ShieldWarning } from "@phosphor-icons/react";
import {
  commandErrorMessage,
  createIdempotencyKey,
  parseScheduleDelayResponse,
  phase4ScheduleCopy,
  phase4ScheduleMachine,
  zonedLocalDateTimeToEpoch,
  type ScheduleArea,
  type ScheduleRevision,
} from "@/lib/phase4-schedule";
import styles from "./ScheduleWorkspace.module.css";

type UpstreamError = { error?: { code?: unknown; message?: unknown } };

function upstreamError(value: unknown): { code: string | null; message: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { code: null, message: null };
  const error = (value as UpstreamError).error;
  return {
    code: typeof error?.code === "string" ? error.code : null,
    message: typeof error?.message === "string" ? error.message : null,
  };
}

/**
 * Competition-day delay control (Track R2.2). Sends POST /schedule-revisions/:id/delays through the
 * BFF; the API validates the whole delayed revision and answers 422 naming every conflict, which is
 * shown verbatim so the organiser can see which matches block the delay.
 */
export function ScheduleDelayPanel({
  revision,
  areas,
  timeZone,
  disabled,
  onDelayed,
}: {
  revision: ScheduleRevision;
  areas: readonly ScheduleArea[];
  timeZone: string;
  disabled: boolean;
  onDelayed: (revision: ScheduleRevision, delayedCount: number) => void;
}) {
  const id = useId();
  const [minutes, setMinutes] = useState("30");
  const [areaId, setAreaId] = useState("");
  const [targetAreaId, setTargetAreaId] = useState("");
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function validate(): string | null {
    const value = Number(minutes || "0");
    if (targetAreaId) {
      if (!areaId) return phase4ScheduleCopy.delayTargetNeedsCourt;
      if (targetAreaId === areaId) return phase4ScheduleCopy.delayTargetSameCourt;
      if (!Number.isInteger(value) || value < 0 || value > 720) return phase4ScheduleCopy.delayInvalidMinutes;
      return null;
    }
    if (!Number.isInteger(value) || value < 1 || value > 720) return phase4ScheduleCopy.delayInvalidMinutes;
    return null;
  }

  async function submit() {
    if (busy || disabled) return;
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    const fromEpoch = from ? zonedLocalDateTimeToEpoch(from, timeZone) : null;
    const delayMinutes = Number(minutes || "0");
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/phase4/schedule/revisions/${encodeURIComponent(revision.id)}/delays`, {
        method: phase4ScheduleMachine.post,
        headers: { "content-type": phase4ScheduleMachine.json },
        body: JSON.stringify({
          idempotency_key: createIdempotencyKey(phase4ScheduleMachine.delayKey),
          expected_revision: revision.revision,
          ...(delayMinutes > 0 ? { delay_minutes: delayMinutes } : {}),
          ...(areaId ? { playing_area_id: areaId } : {}),
          ...(targetAreaId ? { target_playing_area_id: targetAreaId } : {}),
          ...(fromEpoch !== null ? { from_epoch_ms: fromEpoch } : {}),
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const upstream = upstreamError(payload);
        setError(
          response.status === 422 && upstream.message
            ? upstream.message
            : commandErrorMessage(response.status, upstream.code),
        );
        return;
      }
      const parsed = parseScheduleDelayResponse(payload);
      if (!parsed) {
        setError(phase4ScheduleCopy.malformed);
        return;
      }
      onDelayed(parsed.revision, parsed.delayedCount);
    } catch {
      setError(phase4ScheduleCopy.offlineBody);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.delayPanel} aria-labelledby={`${id}-title`} data-testid="schedule-delay">
      <header>
        <Clock aria-hidden="true" />
        <h2 id={`${id}-title`}>{phase4ScheduleCopy.delayTitle}</h2>
        <InfoTip label={`${messages.organiser.moreAbout} ${phase4ScheduleCopy.delayTitle.toLowerCase()}`}>
          {phase4ScheduleCopy.delayIntro}
        </InfoTip>
      </header>
      <form
        className={styles.delayForm}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label>
          <span>{phase4ScheduleCopy.delayMinutes}</span>
          <NumberField
            value={minutes === "" ? null : Number(minutes)}
            aria-describedby={`${id}-minutes-hint`}
            aria-invalid={Boolean(error) && error === phase4ScheduleCopy.delayInvalidMinutes}
            onValueChange={(next) => setMinutes(next === null ? "" : String(next))}
          />
          <small id={`${id}-minutes-hint`}>{phase4ScheduleCopy.delayMinutesHint}</small>
        </label>
        <label>
          <span>{phase4ScheduleCopy.delayCourt}</span>
          <select value={areaId} onChange={(event) => setAreaId(event.target.value)}>
            <option value="">{phase4ScheduleCopy.delayAllCourts}</option>
            {areas.map((area) => (
              <option key={area.id} value={area.id}>
                {area.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{phase4ScheduleCopy.delayTargetCourt}</span>
          <select value={targetAreaId} onChange={(event) => setTargetAreaId(event.target.value)}>
            <option value="">{phase4ScheduleCopy.delayKeepCourt}</option>
            {areas.map((area) => (
              <option key={area.id} value={area.id}>
                {area.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{phase4ScheduleCopy.delayFrom}</span>
          <input
            type="datetime-local"
            value={from}
            aria-describedby={`${id}-from-hint`}
            onChange={(event) => setFrom(event.target.value)}
          />
          <small id={`${id}-from-hint`}>{phase4ScheduleCopy.delayFromHint}</small>
        </label>
        <button type="submit" disabled={disabled || busy}>
          {busy ? phase4ScheduleCopy.delaySubmitting : phase4ScheduleCopy.delaySubmit}
        </button>
      </form>
      {error ? (
        <div className={styles.commandError} role="alert" data-testid="schedule-delay-error">
          <ShieldWarning aria-hidden="true" />
          <span>
            <strong>{phase4ScheduleCopy.delayRejected}</strong> {error}
          </span>
        </div>
      ) : null}
    </section>
  );
}
