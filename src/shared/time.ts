const DAY_MS = 24 * 60 * 60 * 1000;

export function sanitizeIntervals(intervalDays: number[]): number[] {
  const clean = Array.from(
    new Set(
      intervalDays
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.floor(value))
    )
  ).sort((a, b) => a - b);

  return clean;
}

export function computeDueTimestamps(startAt: number, intervalDays: number[]): number[] {
  return sanitizeIntervals(intervalDays).map((day) => startAt + day * DAY_MS);
}

export function pickNextDue(now: number, timestamps: number[]): number | null {
  const future = timestamps.filter((timestamp) => timestamp > now).sort((a, b) => a - b);
  return future.length > 0 ? (future[0] ?? null) : null;
}

export function computePendingIntervals(
  lastCompletionAt: number,
  intervalDays: number[],
  now: number
): number[] {
  return sanitizeIntervals(intervalDays).filter((day) => lastCompletionAt + day * DAY_MS > now);
}

export function computeStatus(nextDueAt: number, now: number): "active" | "due" | "overdue" {
  if (nextDueAt > now) {
    return "active";
  }
  if (now - nextDueAt <= DAY_MS) {
    return "due";
  }
  return "overdue";
}
