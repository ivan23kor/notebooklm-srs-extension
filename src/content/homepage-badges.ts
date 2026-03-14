import { getNotebookTitleKey } from "../shared/notebook-title";
import { sanitizeIntervals } from "../shared/time";
import type { DashboardState, DashboardTimeline } from "../shared/types";

const HOUR_MS = 60 * 60 * 1000;

export interface HomepageBadgeInfo {
  label: string;
  isOverdue: boolean;
  intervalDays: number;
  elapsedHours: number;
}

function getElapsedHours(lastCompletionAt: number, now: number): number {
  return Math.max(0, Math.floor((now - lastCompletionAt) / HOUR_MS));
}

export function getDisplayIntervalDays(
  intervalDays: number[],
  lastCompletionAt: number,
  now: number
): number {
  const cleanIntervals = sanitizeIntervals(intervalDays);
  if (cleanIntervals.length === 0) {
    return 1;
  }

  const elapsedHours = getElapsedHours(lastCompletionAt, now);
  const elapsedDays = elapsedHours / 24;
  let currentInterval = cleanIntervals[0]!;

  for (const day of cleanIntervals) {
    if (elapsedDays >= day) {
      currentInterval = day;
      continue;
    }
    break;
  }

  return currentInterval;
}

export function formatTimerBadge(
  item: Pick<DashboardTimeline, "lastCompletionAt">,
  intervalDays: number[],
  now: number
): HomepageBadgeInfo {
  const elapsedHours = getElapsedHours(item.lastCompletionAt, now);
  const currentIntervalDays = getDisplayIntervalDays(intervalDays, item.lastCompletionAt, now);

  const elapsedStr = elapsedHours < 24
    ? `${elapsedHours}h`
    : `${(elapsedHours / 24).toFixed(1)}d`;
  
  const label = `${elapsedStr}/${currentIntervalDays}d`;

  return {
    label,
    isOverdue: elapsedHours >= currentIntervalDays * 24,
    intervalDays: currentIntervalDays,
    elapsedHours
  };
}

function compareBadgePriority(left: HomepageBadgeInfo, right: HomepageBadgeInfo): number {
  if (left.isOverdue !== right.isOverdue) {
    return left.isOverdue ? -1 : 1;
  }

  if (left.intervalDays !== right.intervalDays) {
    return left.intervalDays - right.intervalDays;
  }

  if (left.elapsedHours !== right.elapsedHours) {
    return right.elapsedHours - left.elapsedHours;
  }

  return 0;
}

export function getNotebookTimerMap(
  data: DashboardState,
  now: number
): Map<string, HomepageBadgeInfo> {
  const map = new Map<string, HomepageBadgeInfo>();
  const items = [...data.overdue, ...data.due, ...data.upcoming];

  for (const item of items) {
    const key = getNotebookTitleKey(item.contentTitle);
    const badge = formatTimerBadge(item, data.settings.intervalDays, now);
    const existing = map.get(key);

    if (!existing || compareBadgePriority(badge, existing) < 0) {
      map.set(key, badge);
    }
  }

  return map;
}

/**
 * Build a map from notebook title (lowercase) to notebook ID.
 * Extracts notebook ID from timeline.id which is in format "review:notebook-id" or "quiz:notebook-id".
 */
export function getNotebookIdMap(data: DashboardState): Map<string, string> {
  const map = new Map<string, string>();
  const items = [...data.overdue, ...data.due, ...data.upcoming];

  for (const item of items) {
    const key = getNotebookTitleKey(item.contentTitle);
    // Extract notebook ID from timeline.id (format: "activityType:notebookId")
    const notebookId = item.id.split(":").slice(1).join(":");
    if (notebookId && !map.has(key)) {
      map.set(key, notebookId);
    }
  }

  return map;
}
