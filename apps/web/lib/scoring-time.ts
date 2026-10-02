export const MAX_MANUAL_TIME_SECONDS = 3_599;

export function parseRecordedTime(value: string): number | null {
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(value.trim());
  const compact = /^(\d{1,2})([0-5]\d)$/.exec(value.trim());
  const parts = match ?? compact;
  if (!parts) return null;
  const total = Number(parts[1]) * 60 + Number(parts[2]);
  return total <= MAX_MANUAL_TIME_SECONDS ? total : null;
}

export function recordedElapsedSeconds(
  input: string,
  mode: "elapsed" | "remaining",
  periodDurationMinutes: number | null,
): number | null {
  const seconds = parseRecordedTime(input);
  if (seconds === null) return null;
  if (periodDurationMinutes === null) return mode === "elapsed" ? seconds : null;
  const duration = periodDurationMinutes * 60;
  if (seconds > duration) return null;
  const elapsed = mode === "remaining" ? duration - seconds : seconds;
  return elapsed <= MAX_MANUAL_TIME_SECONDS ? elapsed : null;
}

export function formatRecordedTime(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
export const elapsedTimeMode = "elapsed" as const;
