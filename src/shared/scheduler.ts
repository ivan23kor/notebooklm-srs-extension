import { computeDueTimestamps, pickNextDue, computePendingIntervals, sanitizeIntervals } from "./time";
import type { ActivityCompletedEvent, Timeline } from "./types";

export function buildTimelineFromCompletion(
  event: ActivityCompletedEvent,
  intervalDays: number[],
  now: number
): Timeline {
  const cleanIntervals = sanitizeIntervals(intervalDays);
  const dueTimestamps = computeDueTimestamps(event.occurredAt, cleanIntervals);
  const nextDueAt = pickNextDue(now, dueTimestamps) ?? dueTimestamps[dueTimestamps.length - 1] ?? now;

  return {
    id: makeTimelineId(event.activityType, event.contentItemKey),
    activityType: event.activityType,
    contentItemKey: event.contentItemKey,
    contentTitle: event.contentTitle,
    lastCompletionAt: event.occurredAt,
    intervalDays: cleanIntervals,
    sourceUrl: event.sourceUrl,
    nextDueAt,
    status: nextDueAt > now ? "active" : "due",
    pendingIntervalDays: computePendingIntervals(event.occurredAt, cleanIntervals, now),
    history: [
      {
        completedAt: event.occurredAt,
        detectedFromUrl: event.sourceUrl,
        detectedSignal: event.detectedSignal
      }
    ]
  };
}

export function refreshTimeline(timeline: Timeline, now: number): Timeline {
  const dueTimestamps = computeDueTimestamps(timeline.lastCompletionAt, timeline.intervalDays);
  const nextDueAt = pickNextDue(now, dueTimestamps);
  const pendingIntervalDays = computePendingIntervals(
    timeline.lastCompletionAt,
    timeline.intervalDays,
    now
  );

  if (nextDueAt === null) {
    return {
      ...timeline,
      pendingIntervalDays: [],
      status: "overdue"
    };
  }

  const status = nextDueAt > now ? "active" : now - nextDueAt < 24 * 60 * 60 * 1000 ? "due" : "overdue";

  return {
    ...timeline,
    nextDueAt,
    pendingIntervalDays,
    status
  };
}

export function applyIntervalSettings(timeline: Timeline, intervalDays: number[], now: number): Timeline {
  const next = {
    ...timeline,
    intervalDays: sanitizeIntervals(intervalDays)
  };

  return refreshTimeline(next, now);
}

export function makeTimelineId(activityType: string, contentItemKey: string): string {
  return `${activityType}:${contentItemKey}`;
}
