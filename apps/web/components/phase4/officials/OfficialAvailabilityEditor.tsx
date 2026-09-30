"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { civilMinuteAtEpoch, parseDate, parseTime, resolveCivilMinute } from "@matchday/domain";
import {
  phase4OfficialsCopy,
  phase4OfficialsMachine,
  type AvailabilityWindowView,
  type OfficialView,
} from "@/lib/phase4-officials";
import styles from "./OfficialsRosterView.module.css";

export type AvailabilityDraftRow = {
  key: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
};

type InvalidTarget = {
  rowKey: string;
  field: "startDate" | "startTime" | "endDate" | "endTime";
} | null;

export function OfficialAvailabilityEditor({
  official,
  initialWindows,
  timeZone,
  onSubmit,
  onCancel,
  busy,
  serverError,
}: {
  official: OfficialView;
  initialWindows: AvailabilityWindowView[];
  timeZone: string;
  onSubmit: (data: { windows: { starts_at: string; ends_at: string }[] }) => void;
  onCancel: () => void;
  busy: boolean;
  serverError?: string | null;
}) {
  const counterRef = useRef(initialWindows.length);
  const [rows, setRows] = useState<AvailabilityDraftRow[]>(() => {
    return initialWindows.map((w, index) => {
      const startCivil = civilMinuteAtEpoch(Date.parse(w.startsAt), timeZone);
      const endCivil = civilMinuteAtEpoch(Date.parse(w.endsAt), timeZone);
      return {
        key: `canonical-${index}-${w.startsAt}`,
        startDate: startCivil.date,
        startTime: startCivil.time,
        endDate: endCivil.date,
        endTime: endCivil.time,
      };
    });
  });

  const [clientError, setClientError] = useState<string | null>(null);
  const [invalidTarget, setInvalidTarget] = useState<InvalidTarget>(null);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const inputRefs = useRef<
    Map<
      string,
      {
        startDate: HTMLInputElement | null;
        startTime: HTMLInputElement | null;
        endDate: HTMLInputElement | null;
        endTime: HTMLInputElement | null;
        removeBtn: HTMLButtonElement | null;
      }
    >
  >(new Map());

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const getRowRef = (key: string) => {
    let r = inputRefs.current.get(key);
    if (!r) {
      r = { startDate: null, startTime: null, endDate: null, endTime: null, removeBtn: null };
      inputRefs.current.set(key, r);
    }
    return r;
  };

  const handleAddRow = () => {
    if (rows.length >= 512) {
      setClientError(phase4OfficialsCopy.maxWindowsReached);
      return;
    }
    setClientError(null);
    setInvalidTarget(null);
    counterRef.current += 1;
    const newKey = `draft-${counterRef.current}`;
    setRows((prev) => [
      ...prev,
      {
        key: newKey,
        startDate: "",
        startTime: "",
        endDate: "",
        endTime: "",
      },
    ]);
    setTimeout(() => {
      getRowRef(newKey).startDate?.focus();
    }, 0);
  };

  const handleRemoveRow = (key: string, index: number) => {
    setClientError(null);
    setInvalidTarget(null);

    let nextFocusTarget: HTMLElement | null = null;
    if (rows.length === 1) {
      nextFocusTarget = addButtonRef.current;
    } else if (index > 0) {
      const prevKey = rows[index - 1]?.key;
      nextFocusTarget = prevKey ? getRowRef(prevKey).removeBtn : null;
    } else if (index < rows.length - 1) {
      const nextKey = rows[index + 1]?.key;
      nextFocusTarget = nextKey ? getRowRef(nextKey).removeBtn : null;
    }

    setRows((prev) => prev.filter((r) => r.key !== key));
    inputRefs.current.delete(key);

    setTimeout(() => {
      if (nextFocusTarget) {
        nextFocusTarget.focus();
      } else {
        addButtonRef.current?.focus();
      }
    }, 0);
  };

  const handleFieldChange = (key: string, field: "startDate" | "startTime" | "endDate" | "endTime", value: string) => {
    if (clientError) setClientError(null);
    if (invalidTarget && invalidTarget.rowKey === key && invalidTarget.field === field) {
      setInvalidTarget(null);
    }
    setRows((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        return { ...r, [field]: value };
      }),
    );
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setClientError(null);
    setInvalidTarget(null);

    if (rows.length === 0) {
      onSubmit({ windows: [] });
      return;
    }

    const compiledWindows: { starts_at: string; ends_at: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;

      // 1. Start date required and valid
      if (!row.startDate.trim()) {
        setInvalidTarget({ rowKey: row.key, field: phase4OfficialsMachine.startDate });
        setClientError(phase4OfficialsCopy.startDateRequired);
        getRowRef(row.key).startDate?.focus();
        return;
      }
      try {
        parseDate(row.startDate, phase4OfficialsCopy.startDateLabel);
      } catch {
        setInvalidTarget({ rowKey: row.key, field: phase4OfficialsMachine.startDate });
        setClientError(phase4OfficialsCopy.startDateTimeInvalid);
        getRowRef(row.key).startDate?.focus();
        return;
      }

      // 2. Start time required and valid
      if (!row.startTime.trim()) {
        setInvalidTarget({ rowKey: row.key, field: phase4OfficialsMachine.startTime });
        setClientError(phase4OfficialsCopy.startTimeRequired);
        getRowRef(row.key).startTime?.focus();
        return;
      }
      try {
        parseTime(row.startTime, phase4OfficialsCopy.startTimeLabel);
      } catch {
        setInvalidTarget({ rowKey: row.key, field: phase4OfficialsMachine.startTime });
        setClientError(phase4OfficialsCopy.startDateTimeInvalid);
        getRowRef(row.key).startTime?.focus();
        return;
      }

      // 3. End date required and valid
      if (!row.endDate.trim()) {
        setInvalidTarget({ rowKey: row.key, field: phase4OfficialsMachine.endDate });
        setClientError(phase4OfficialsCopy.endDateRequired);
        getRowRef(row.key).endDate?.focus();
        return;
      }
      try {
        parseDate(row.endDate, phase4OfficialsCopy.endDateLabel);
      } catch {
        setInvalidTarget({ rowKey: row.key, field: phase4OfficialsMachine.endDate });
        setClientError(phase4OfficialsCopy.endDateTimeInvalid);
        getRowRef(row.key).endDate?.focus();
        return;
      }

      // 4. End time required and valid
      if (!row.endTime.trim()) {
        setInvalidTarget({ rowKey: row.key, field: phase4OfficialsMachine.endTime });
        setClientError(phase4OfficialsCopy.endTimeRequired);
        getRowRef(row.key).endTime?.focus();
        return;
      }
      try {
        parseTime(row.endTime, phase4OfficialsCopy.endTimeLabel);
      } catch {
        setInvalidTarget({ rowKey: row.key, field: phase4OfficialsMachine.endTime });
        setClientError(phase4OfficialsCopy.endDateTimeInvalid);
        getRowRef(row.key).endTime?.focus();
        return;
      }

      // 5. Start minute DST existence in timeZone
      let startEpoch: number;
      try {
        startEpoch = resolveCivilMinute({ date: row.startDate, time: row.startTime }, timeZone);
      } catch {
        setInvalidTarget({ rowKey: row.key, field: phase4OfficialsMachine.startTime });
        setClientError(phase4OfficialsCopy.dstGapError(row.startTime, timeZone, row.startDate));
        getRowRef(row.key).startTime?.focus();
        return;
      }

      // 6. End minute DST existence in timeZone
      let endEpoch: number;
      try {
        endEpoch = resolveCivilMinute({ date: row.endDate, time: row.endTime }, timeZone);
      } catch {
        setInvalidTarget({ rowKey: row.key, field: phase4OfficialsMachine.endTime });
        setClientError(phase4OfficialsCopy.dstGapError(row.endTime, timeZone, row.endDate));
        getRowRef(row.key).endTime?.focus();
        return;
      }

      // 7. End > Start
      if (endEpoch <= startEpoch) {
        setInvalidTarget({ rowKey: row.key, field: phase4OfficialsMachine.endTime });
        setClientError(phase4OfficialsCopy.endMustBeAfterStart);
        getRowRef(row.key).endTime?.focus();
        return;
      }

      compiledWindows.push({
        starts_at: new Date(startEpoch).toISOString(),
        ends_at: new Date(endEpoch).toISOString(),
      });
    }

    onSubmit({ windows: compiledWindows });
  };

  const displayError = clientError || serverError;

  return (
    <section className={styles.panel} aria-labelledby="availability-editor-heading">
      <div className={styles.detailsHeader}>
        <div>
          <h3 id="availability-editor-heading" tabIndex={-1} ref={headingRef}>
            {phase4OfficialsCopy.availabilityEditorTitle} — {official.name}
          </h3>
          <p className={styles.timezoneNotice}>{phase4OfficialsCopy.timesEnteredIn(timeZone)}</p>
        </div>
      </div>

      {displayError ? (
        <div id="availability-editor-error" className={`${styles.errorAlert} ${styles.formAlert}`} role="alert">
          {displayError}
        </div>
      ) : null}

      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <div className={styles.editorRows}>
          {rows.map((row, index) => {
            const isStartDateInvalid =
              invalidTarget?.rowKey === row.key && invalidTarget.field === phase4OfficialsMachine.startDate;
            const isStartTimeInvalid =
              invalidTarget?.rowKey === row.key && invalidTarget.field === phase4OfficialsMachine.startTime;
            const isEndDateInvalid =
              invalidTarget?.rowKey === row.key && invalidTarget.field === phase4OfficialsMachine.endDate;
            const isEndTimeInvalid =
              invalidTarget?.rowKey === row.key && invalidTarget.field === phase4OfficialsMachine.endTime;

            return (
              <div key={row.key} className={styles.editorRow}>
                <div className={styles.rowHeader}>
                  <h4 className={styles.rowTitle}>{phase4OfficialsCopy.windowIndex(index + 1)}</h4>
                  <button
                    type="button"
                    ref={(el) => {
                      getRowRef(row.key).removeBtn = el;
                    }}
                    className={styles.dangerButton}
                    onClick={() => handleRemoveRow(row.key, index)}
                    disabled={busy}
                  >
                    {phase4OfficialsCopy.removeWindow}
                  </button>
                </div>

                <div className={styles.rowInputs}>
                  <div className={styles.rowField}>
                    <label htmlFor={`${row.key}-start-date`} className={styles.rowLabel}>
                      {phase4OfficialsCopy.startDateLabel}
                    </label>
                    <input
                      id={`${row.key}-start-date`}
                      ref={(el) => {
                        getRowRef(row.key).startDate = el;
                      }}
                      type="date"
                      className={styles.input}
                      value={row.startDate}
                      onChange={(e) => handleFieldChange(row.key, phase4OfficialsMachine.startDate, e.target.value)}
                      disabled={busy}
                      aria-invalid={isStartDateInvalid}
                      aria-describedby={displayError && isStartDateInvalid ? "availability-editor-error" : undefined}
                      required
                    />
                  </div>

                  <div className={styles.rowField}>
                    <label htmlFor={`${row.key}-start-time`} className={styles.rowLabel}>
                      {phase4OfficialsCopy.startTimeLabel}
                    </label>
                    <input
                      id={`${row.key}-start-time`}
                      ref={(el) => {
                        getRowRef(row.key).startTime = el;
                      }}
                      type="time"
                      className={styles.input}
                      value={row.startTime}
                      onChange={(e) => handleFieldChange(row.key, phase4OfficialsMachine.startTime, e.target.value)}
                      disabled={busy}
                      aria-invalid={isStartTimeInvalid}
                      aria-describedby={displayError && isStartTimeInvalid ? "availability-editor-error" : undefined}
                      required
                    />
                  </div>

                  <div className={styles.rowField}>
                    <label htmlFor={`${row.key}-end-date`} className={styles.rowLabel}>
                      {phase4OfficialsCopy.endDateLabel}
                    </label>
                    <input
                      id={`${row.key}-end-date`}
                      ref={(el) => {
                        getRowRef(row.key).endDate = el;
                      }}
                      type="date"
                      className={styles.input}
                      value={row.endDate}
                      onChange={(e) => handleFieldChange(row.key, phase4OfficialsMachine.endDate, e.target.value)}
                      disabled={busy}
                      aria-invalid={isEndDateInvalid}
                      aria-describedby={displayError && isEndDateInvalid ? "availability-editor-error" : undefined}
                      required
                    />
                  </div>

                  <div className={styles.rowField}>
                    <label htmlFor={`${row.key}-end-time`} className={styles.rowLabel}>
                      {phase4OfficialsCopy.endTimeLabel}
                    </label>
                    <input
                      id={`${row.key}-end-time`}
                      ref={(el) => {
                        getRowRef(row.key).endTime = el;
                      }}
                      type="time"
                      className={styles.input}
                      value={row.endTime}
                      onChange={(e) => handleFieldChange(row.key, phase4OfficialsMachine.endTime, e.target.value)}
                      disabled={busy}
                      aria-invalid={isEndTimeInvalid}
                      aria-describedby={displayError && isEndTimeInvalid ? "availability-editor-error" : undefined}
                      required
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className={styles.editorRowActions}>
          <button
            type="button"
            ref={addButtonRef}
            className={styles.secondaryButton}
            onClick={handleAddRow}
            disabled={busy || rows.length >= 512}
          >
            {phase4OfficialsCopy.addWindow}
          </button>
        </div>

        <div className={styles.formActions}>
          <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={busy}>
            {phase4OfficialsCopy.cancel}
          </button>
          <button type="submit" className={styles.primaryButton} disabled={busy}>
            {busy ? phase4OfficialsCopy.savingAvailability : phase4OfficialsCopy.saveAvailability}
          </button>
        </div>
      </form>
    </section>
  );
}
