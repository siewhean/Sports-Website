export type CanonicalInterval = {
  startEpochMs: number;
  endEpochMs: number;
};

export type InputInterval =
  | { startsAt: Date | string | number; endsAt: Date | string | number }
  | { startEpochMs: number; endEpochMs: number }
  | { start: Date | string | number; end: Date | string | number }
  | { starts_at: Date | string | number; ends_at: Date | string | number };

function toEpochMs(value: Date | string | number, fieldName: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid interval timestamp for ${fieldName}: non-finite number`);
    }
    return Math.trunc(value);
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) {
      throw new Error(`Invalid interval timestamp for ${fieldName}: invalid Date`);
    }
    return ms;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) {
      throw new Error(`Invalid interval timestamp for ${fieldName}: unparseable string "${value}"`);
    }
    return ms;
  }
  throw new Error(`Invalid interval timestamp for ${fieldName}: unsupported type`);
}

function parseInputInterval(raw: InputInterval): CanonicalInterval {
  let startMs: number;
  let endMs: number;

  if ("startsAt" in raw && "endsAt" in raw) {
    startMs = toEpochMs(raw.startsAt, "startsAt");
    endMs = toEpochMs(raw.endsAt, "endsAt");
  } else if ("starts_at" in raw && "ends_at" in raw) {
    startMs = toEpochMs(raw.starts_at, "starts_at");
    endMs = toEpochMs(raw.ends_at, "ends_at");
  } else if ("startEpochMs" in raw && "endEpochMs" in raw) {
    startMs = toEpochMs(raw.startEpochMs, "startEpochMs");
    endMs = toEpochMs(raw.endEpochMs, "endEpochMs");
  } else if ("start" in raw && "end" in raw) {
    startMs = toEpochMs(raw.start, "start");
    endMs = toEpochMs(raw.end, "end");
  } else {
    throw new Error("Invalid interval shape: must provide start and end timestamps");
  }

  if (endMs <= startMs) {
    throw new Error(`Availability window must have positive duration: endsAt (${endMs}) <= startsAt (${startMs})`);
  }

  return { startEpochMs: startMs, endEpochMs: endMs };
}

/**
 * Parses, validates, sorts, and merges overlapping or adjacent intervals
 * into a minimal, canonical, deterministically ordered list.
 */
export function canonicaliseIntervals(rawIntervals: Iterable<InputInterval>): CanonicalInterval[] {
  const parsed: CanonicalInterval[] = [];
  for (const raw of rawIntervals) {
    parsed.push(parseInputInterval(raw));
  }

  if (parsed.length === 0) {
    return [];
  }

  // Sort primary by startEpochMs ascending, secondary by endEpochMs ascending
  parsed.sort((a, b) => {
    if (a.startEpochMs !== b.startEpochMs) {
      return a.startEpochMs - b.startEpochMs;
    }
    return a.endEpochMs - b.endEpochMs;
  });

  const merged: CanonicalInterval[] = [];
  for (const current of parsed) {
    if (merged.length === 0) {
      merged.push({ startEpochMs: current.startEpochMs, endEpochMs: current.endEpochMs });
      continue;
    }
    const last = merged[merged.length - 1]!;
    // Adjacent (current.startEpochMs === last.endEpochMs) or overlapping (current.startEpochMs <= last.endEpochMs)
    if (current.startEpochMs <= last.endEpochMs) {
      if (current.endEpochMs > last.endEpochMs) {
        last.endEpochMs = current.endEpochMs;
      }
    } else {
      merged.push({ startEpochMs: current.startEpochMs, endEpochMs: current.endEpochMs });
    }
  }

  return merged;
}

/**
 * Checks whether two sets of intervals are canonical semantically equal.
 */
export function areCanonicalIntervalsEqual(left: Iterable<InputInterval>, right: Iterable<InputInterval>): boolean {
  const canonicalLeft = canonicaliseIntervals(left);
  const canonicalRight = canonicaliseIntervals(right);

  if (canonicalLeft.length !== canonicalRight.length) {
    return false;
  }

  for (let i = 0; i < canonicalLeft.length; i++) {
    const l = canonicalLeft[i]!;
    const r = canonicalRight[i]!;
    if (l.startEpochMs !== r.startEpochMs || l.endEpochMs !== r.endEpochMs) {
      return false;
    }
  }

  return true;
}

/**
 * Formats canonical intervals to ISO strings for API representations.
 */
export function toIsoIntervals(intervals: readonly CanonicalInterval[]): Array<{ starts_at: string; ends_at: string }> {
  return intervals.map((i) => ({
    starts_at: new Date(i.startEpochMs).toISOString(),
    ends_at: new Date(i.endEpochMs).toISOString(),
  }));
}
