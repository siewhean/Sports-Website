"use client";

import { useId, useState } from "react";
import { messages } from "@matchday/ui";
import {
  BREAK_FIELD,
  DAY_SELECTION_MODE,
  type BreakField,
  type DayBreak,
  type DaySchedule,
  type DaySelectionMode,
  generateDaysInRange,
  formatDateLabel,
} from "@/lib/day-hours";
import styles from "./DayHoursEditor.module.css";

export type { DayBreak, DaySchedule };

export type DayHoursEditorProps = {
  days: DaySchedule[];
  onChange: (days: DaySchedule[]) => void;
  startDate?: string;
  endDate?: string;
  onRangeChange?: (start: string, end: string) => void;
};

const copy = messages.dayHoursEditor;

export function DayHoursEditor({ days, onChange, startDate = "", endDate = "", onRangeChange }: DayHoursEditorProps) {
  const [mode, setMode] = useState<DaySelectionMode>(DAY_SELECTION_MODE.RANGE);
  const [pickNewDate, setPickNewDate] = useState("");
  const editorId = useId();

  function handleStartDateChange(newStart: string) {
    const end = endDate && endDate >= newStart ? endDate : newStart;
    onRangeChange?.(newStart, end);
    const updated = generateDaysInRange(newStart, end, days[0]);
    onChange(updated);
  }

  function handleEndDateChange(newEnd: string) {
    const start = startDate && startDate <= newEnd ? startDate : newEnd;
    onRangeChange?.(start, newEnd);
    const updated = generateDaysInRange(start, newEnd, days[0]);
    onChange(updated);
  }

  function handleAddPickedDate() {
    if (!pickNewDate) return;
    if (days.some((d) => d.date === pickNewDate)) return;
    const template = days[days.length - 1];
    const newDay: DaySchedule = {
      date: pickNewDate,
      opens: template?.opens ?? "09:00",
      closes: template?.closes ?? "18:00",
      breaks: template?.breaks ? [...template.breaks] : [],
    };
    const updated = [...days, newDay].sort((a, b) => a.date.localeCompare(b.date));
    onChange(updated);
    setPickNewDate("");
  }

  function handleRemoveDay(dateToRemove: string) {
    onChange(days.filter((d) => d.date !== dateToRemove));
  }

  function handleUpdateDay(date: string, patch: Partial<DaySchedule>) {
    onChange(days.map((d) => (d.date === date ? { ...d, ...patch } : d)));
  }

  function handleCopyToAllDays(sourceDay: DaySchedule) {
    onChange(
      days.map((d) => ({
        ...d,
        opens: sourceDay.opens,
        closes: sourceDay.closes,
        breaks: sourceDay.breaks.map((b) => ({ ...b })),
      })),
    );
  }

  function handleAddBreak(date: string) {
    const day = days.find((d) => d.date === date);
    if (!day) return;
    const newBreaks = [...day.breaks, { start: "12:00", end: "13:00" }];
    handleUpdateDay(date, { breaks: newBreaks });
  }

  function handleRemoveBreak(date: string, breakIndex: number) {
    const day = days.find((d) => d.date === date);
    if (!day) return;
    const newBreaks = day.breaks.filter((_, idx) => idx !== breakIndex);
    handleUpdateDay(date, { breaks: newBreaks });
  }

  function handleUpdateBreak(date: string, breakIndex: number, field: BreakField, value: string) {
    const day = days.find((d) => d.date === date);
    if (!day) return;
    const newBreaks = day.breaks.map((b, idx) => (idx === breakIndex ? { ...b, [field]: value } : b));
    handleUpdateDay(date, { breaks: newBreaks });
  }

  return (
    <div className={styles.container}>
      <div className={styles.modeSwitch} role="radiogroup" aria-label={copy.dateModeLabel}>
        <button
          type="button"
          role="radio"
          aria-checked={mode === DAY_SELECTION_MODE.RANGE}
          className={`${styles.modeButton} ${mode === DAY_SELECTION_MODE.RANGE ? styles.modeButtonActive : ""}`}
          onClick={() => setMode(DAY_SELECTION_MODE.RANGE)}
        >
          {copy.dateRange}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === DAY_SELECTION_MODE.PICK}
          className={`${styles.modeButton} ${mode === DAY_SELECTION_MODE.PICK ? styles.modeButtonActive : ""}`}
          onClick={() => setMode(DAY_SELECTION_MODE.PICK)}
        >
          {copy.pickDays}
        </button>
      </div>

      {mode === DAY_SELECTION_MODE.RANGE ? (
        <div className={styles.rangeInputs}>
          <div className={styles.fieldGroup}>
            <label htmlFor={`${editorId}-start`} className={styles.label}>
              {copy.startDate}
            </label>
            <input
              id={`${editorId}-start`}
              type="date"
              className={styles.input}
              value={startDate}
              onChange={(e) => handleStartDateChange(e.target.value)}
              required
            />
          </div>
          <div className={styles.fieldGroup}>
            <label htmlFor={`${editorId}-end`} className={styles.label}>
              {copy.endDate}
            </label>
            <input
              id={`${editorId}-end`}
              type="date"
              className={styles.input}
              value={endDate}
              onChange={(e) => handleEndDateChange(e.target.value)}
              required
            />
          </div>
        </div>
      ) : (
        <div className={styles.rangeInputs}>
          <div className={styles.fieldGroup}>
            <label htmlFor={`${editorId}-add-day`} className={styles.label}>
              {copy.addDate}
            </label>
            <input
              id={`${editorId}-add-day`}
              type="date"
              className={styles.input}
              value={pickNewDate}
              onChange={(e) => setPickNewDate(e.target.value)}
            />
          </div>
          <div className={styles.addDateAction}>
            <button type="button" className={styles.copyButton} onClick={handleAddPickedDate} disabled={!pickNewDate}>
              {copy.addDateButton}
            </button>
          </div>
        </div>
      )}

      {days.length > 0 ? (
        <div className={styles.daysList}>
          {days.map((day) => (
            <div key={day.date} className={styles.dayCard}>
              <div className={styles.dayHeader}>
                <span className={styles.dayTitle}>{formatDateLabel(day.date)}</span>
                <div className={styles.dayActions}>
                  {days.length > 1 ? (
                    <button type="button" className={styles.copyButton} onClick={() => handleCopyToAllDays(day)}>
                      {copy.copyToAllDays}
                    </button>
                  ) : null}
                  {mode === DAY_SELECTION_MODE.PICK ? (
                    <button
                      type="button"
                      className={styles.removeBreakButton}
                      onClick={() => handleRemoveDay(day.date)}
                      aria-label={copy.removeDay}
                    >
                      {copy.remove}
                    </button>
                  ) : null}
                </div>
              </div>

              <div className={styles.hoursRow}>
                <div className={styles.fieldGroup}>
                  <label htmlFor={`${editorId}-opens-${day.date}`} className={styles.label}>
                    {copy.opens}
                  </label>
                  <input
                    id={`${editorId}-opens-${day.date}`}
                    type="time"
                    className={styles.input}
                    value={day.opens}
                    onChange={(e) => handleUpdateDay(day.date, { opens: e.target.value })}
                  />
                </div>
                <div className={styles.fieldGroup}>
                  <label htmlFor={`${editorId}-closes-${day.date}`} className={styles.label}>
                    {copy.closes}
                  </label>
                  <input
                    id={`${editorId}-closes-${day.date}`}
                    type="time"
                    className={styles.input}
                    value={day.closes}
                    onChange={(e) => handleUpdateDay(day.date, { closes: e.target.value })}
                  />
                </div>
              </div>

              <div className={styles.breaksContainer}>
                <span className={styles.label}>{copy.scheduledBreaks}</span>
                {day.breaks.length > 0 ? (
                  <div className={styles.breaksList}>
                    {day.breaks.map((brk, idx) => (
                      <div key={idx} className={styles.breakRow}>
                        <input
                          type="time"
                          aria-label={copy.breakStart}
                          className={styles.input}
                          value={brk.start}
                          onChange={(e) => handleUpdateBreak(day.date, idx, BREAK_FIELD.START, e.target.value)}
                        />
                        <span className={styles.breakTo}>{copy.to}</span>
                        <input
                          type="time"
                          aria-label={copy.breakEnd}
                          className={styles.input}
                          value={brk.end}
                          onChange={(e) => handleUpdateBreak(day.date, idx, BREAK_FIELD.END, e.target.value)}
                        />
                        <button
                          type="button"
                          className={styles.removeBreakButton}
                          onClick={() => handleRemoveBreak(day.date, idx)}
                          aria-label={copy.removeBreak}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <button type="button" className={styles.addBreakButton} onClick={() => handleAddBreak(day.date)}>
                  {copy.addBreak}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
