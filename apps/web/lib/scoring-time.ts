export function parseRecordedTime(value: string): number | null {
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(value.trim());
  const compact = /^(\d{1,2})([0-5]\d)$/.exec(value.trim());
  const parts = match ?? compact;
  if (!parts) return null;
  const total = Number(parts[1]) * 60 + Number(parts[2]);
  return total <= 3_600 ? total : null;
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
  return mode === "remaining" ? duration - seconds : seconds;
}

export function formatRecordedTime(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
export const elapsedTimeMode = "elapsed" as const;
