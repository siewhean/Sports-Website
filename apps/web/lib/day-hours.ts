export type DayBreak = {
  start: string;
  end: string;
};

export type DaySchedule = {
  date: string; // YYYY-MM-DD
  opens: string; // HH:MM
  closes: string; // HH:MM
  breaks: DayBreak[];
};

export const DAY_SELECTION_MODE = {
  RANGE: "range",
  PICK: "pick",
} as const;

export type DaySelectionMode = (typeof DAY_SELECTION_MODE)[keyof typeof DAY_SELECTION_MODE];

export const BREAK_FIELD = {
  START: "start",
  END: "end",
} as const;

export type BreakField = (typeof BREAK_FIELD)[keyof typeof BREAK_FIELD];

export function generateDaysInRange(start: string, end: string, template?: Partial<DaySchedule>): DaySchedule[] {
  if (!start || !end || start > end) return [];
  const result: DaySchedule[] = [];
  const current = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`);

  while (current <= stop) {
    const dateStr = current.toISOString().slice(0, 10);
    result.push({
      date: dateStr,
      opens: template?.opens ?? "09:00",
      closes: template?.closes ?? "18:00",
      breaks: template?.breaks ? [...template.breaks] : [],
    });
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return result;
}

export function formatDateLabel(dateStr: string): string {
  try {
    const parts = dateStr.split("-").map(Number);
    const date = new Date(Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!));
    return new Intl.DateTimeFormat("en", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(date);
  } catch {
    return dateStr;
  }
}
