import {
  ALARM_PREFIX,
  NOTIFICATION_DEDUPE_MS,
  NOTIFICATION_PREFIX
} from "../shared/constants";
import { applyIntervalSettings, buildTimelineFromCompletion, refreshTimeline } from "../shared/scheduler";
import { loadNotificationMeta, loadState, saveNotificationMeta, saveState, clearAllState } from "../shared/storage";
import { sanitizeIntervals } from "../shared/time";
import type {
  DashboardState,
  DashboardTimeline,
  ExtensionMessage,
  MessageResponse,
  Timeline
} from "../shared/types";

function now(): number {
  return Date.now();
}

function alarmNameForTimeline(timelineId: string): string {
  return `${ALARM_PREFIX}${timelineId}`;
}

function timelineIdFromAlarm(alarmName: string): string | null {
  if (!alarmName.startsWith(ALARM_PREFIX)) {
    return null;
  }
  return alarmName.slice(ALARM_PREFIX.length);
}

async function scheduleAlarm(timeline: Timeline): Promise<void> {
  await chrome.alarms.clear(alarmNameForTimeline(timeline.id));
  chrome.alarms.create(alarmNameForTimeline(timeline.id), {
    when: timeline.nextDueAt
  });
}

async function scheduleAllAlarms(timelines: Record<string, Timeline>): Promise<void> {
  await Promise.all(Object.values(timelines).map((timeline) => scheduleAlarm(timeline)));
}

async function notifyTimelineDue(timeline: Timeline, reason: "alarm" | "startup"): Promise<void> {
  const notificationId = `${NOTIFICATION_PREFIX}${timeline.id}:${timeline.nextDueAt}`;
  const notificationMeta = await loadNotificationMeta();

  const existing = notificationMeta[notificationId];
  if (existing) {
    return;
  }

  if (timeline.lastNotificationAt && now() - timeline.lastNotificationAt < NOTIFICATION_DEDUPE_MS) {
    return;
  }

  chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: "icon-128.png",
    title: "NotebookLM review due",
    message: `${timeline.contentTitle} (${timeline.activityType}) is due for spaced repetition.`,
    priority: reason === "startup" ? 0 : 1
  });

  notificationMeta[notificationId] = {
    timelineId: timeline.id,
    scheduledFor: timeline.nextDueAt
  };
  await saveNotificationMeta(notificationMeta);
}

function groupTimelines(timelines: Timeline[], current: number): DashboardState {
  const due: DashboardTimeline[] = [];
  const upcoming: DashboardTimeline[] = [];
  const overdue: DashboardTimeline[] = [];

  for (const timeline of timelines) {
    const item: DashboardTimeline = {
      id: timeline.id,
      activityType: timeline.activityType,
      contentTitle: timeline.contentTitle,
      sourceUrl: timeline.sourceUrl,
      nextDueAt: timeline.nextDueAt,
      status: timeline.status,
      pendingIntervalDays: timeline.pendingIntervalDays,
      lastCompletionAt: timeline.lastCompletionAt
    };

    if (timeline.nextDueAt <= current && current - timeline.nextDueAt > 24 * 60 * 60 * 1000) {
      overdue.push(item);
      continue;
    }

    if (timeline.nextDueAt <= current) {
      due.push(item);
      continue;
    }

    upcoming.push(item);
  }

  const sortByDue = (a: DashboardTimeline, b: DashboardTimeline) => a.nextDueAt - b.nextDueAt;
  due.sort(sortByDue);
  upcoming.sort(sortByDue);
  overdue.sort(sortByDue);

  return {
    settings: { intervalDays: [], version: 1 },
    due,
    upcoming,
    overdue,
    totalTimelines: timelines.length
  };
}

async function rebuildDashboardState(): Promise<DashboardState> {
  const state = await loadState();
  const current = now();
  const refreshed: Record<string, Timeline> = {};

  for (const [id, timeline] of Object.entries(state.timelines)) {
    refreshed[id] = refreshTimeline(timeline, current);
  }

  state.timelines = refreshed;
  await saveState(state);
  await scheduleAllAlarms(refreshed);

  const grouped = groupTimelines(Object.values(refreshed), current);
  grouped.settings = state.settings;
  return grouped;
}

async function handleActivityCompleted(message: ExtensionMessage & { type: "activity.completed" }): Promise<void> {
  const state = await loadState();
  const current = now();
  const timeline = buildTimelineFromCompletion(message.payload, state.settings.intervalDays, current);
  const existing = state.timelines[timeline.id];

  if (existing) {
    timeline.history = [
      ...existing.history,
      {
        completedAt: message.payload.occurredAt,
        detectedFromUrl: message.payload.sourceUrl,
        detectedSignal: message.payload.detectedSignal
      }
    ].slice(-20);
  }

  state.timelines[timeline.id] = timeline;
  await saveState(state);
  await scheduleAlarm(timeline);
}

async function handleIntervalsUpdate(
  message: ExtensionMessage & { type: "settings.updateIntervals" }
): Promise<DashboardState> {
  const state = await loadState();
  const cleanIntervals = sanitizeIntervals(message.payload.intervalDays);
  if (cleanIntervals.length === 0) {
    throw new Error("At least one interval is required.");
  }

  state.settings.intervalDays = cleanIntervals;

  const current = now();
  for (const [id, timeline] of Object.entries(state.timelines)) {
    state.timelines[id] = applyIntervalSettings(timeline, cleanIntervals, current);
  }

  await saveState(state);
  await scheduleAllAlarms(state.timelines);

  const grouped = groupTimelines(Object.values(state.timelines), current);
  grouped.settings = state.settings;
  return grouped;
}

async function handleDeleteTimeline(timelineId: string): Promise<DashboardState> {
  const state = await loadState();
  delete state.timelines[timelineId];
  await chrome.alarms.clear(alarmNameForTimeline(timelineId));
  await saveState(state);

  const grouped = groupTimelines(Object.values(state.timelines), now());
  grouped.settings = state.settings;
  return grouped;
}

async function handleCompleteTimeline(timelineId: string): Promise<DashboardState> {
  const state = await loadState();
  const timeline = state.timelines[timelineId];
  if (!timeline) {
    throw new Error("Timeline not found");
  }

  const current = now();
  timeline.lastCompletionAt = current;
  timeline.history = [
    ...timeline.history,
    {
      completedAt: current,
      detectedFromUrl: timeline.sourceUrl,
      detectedSignal: "manual-complete"
    }
  ].slice(-20);

  const refreshed = refreshTimeline(timeline, current);
  state.timelines[timelineId] = refreshed;
  await saveState(state);
  await scheduleAlarm(refreshed);

  const grouped = groupTimelines(Object.values(state.timelines), current);
  grouped.settings = state.settings;
  return grouped;
}

async function handleClearAll(): Promise<DashboardState> {
  const alarms = await chrome.alarms.getAll();
  await Promise.all(alarms.filter((a) => a.name.startsWith(ALARM_PREFIX)).map((a) => chrome.alarms.clear(a.name)));
  await clearAllState();

  const state = await loadState();
  return {
    settings: state.settings,
    due: [],
    upcoming: [],
    overdue: [],
    totalTimelines: 0
  };
}

chrome.runtime.onInstalled.addListener(() => {
  void rebuildDashboardState();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    const state = await loadState();
    const current = now();

    for (const timeline of Object.values(state.timelines)) {
      const refreshed = refreshTimeline(timeline, current);
      state.timelines[refreshed.id] = refreshed;

      if (refreshed.nextDueAt <= current) {
        await notifyTimelineDue(refreshed, "startup");
      }
      await scheduleAlarm(refreshed);
    }

    await saveState(state);
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  const timelineId = timelineIdFromAlarm(alarm.name);
  if (!timelineId) {
    return;
  }

  void (async () => {
    const state = await loadState();
    const timeline = state.timelines[timelineId];
    if (!timeline) {
      return;
    }

    const refreshed = refreshTimeline(timeline, now());
    refreshed.lastNotificationAt = now();
    state.timelines[timelineId] = refreshed;

    await saveState(state);
    await notifyTimelineDue(refreshed, "alarm");
    await scheduleAlarm(refreshed);
  })();
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith(NOTIFICATION_PREFIX)) {
    return;
  }

  void (async () => {
    const notificationMeta = await loadNotificationMeta();
    const meta = notificationMeta[notificationId];
    if (!meta) {
      return;
    }

    const state = await loadState();
    const timeline = state.timelines[meta.timelineId];
    const targetUrl = timeline?.sourceUrl ?? "https://notebooklm.google.com/";

    chrome.tabs.create({ url: targetUrl });
  })();
});

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  void (async () => {
    try {
      if (message.type === "activity.completed") {
        await handleActivityCompleted(message);
        sendResponse({ ok: true } satisfies MessageResponse);
        return;
      }

      if (message.type === "dashboard.get") {
        const data = await rebuildDashboardState();
        sendResponse({ ok: true, data } satisfies MessageResponse);
        return;
      }

      if (message.type === "settings.updateIntervals") {
        const data = await handleIntervalsUpdate(message);
        sendResponse({ ok: true, data } satisfies MessageResponse);
        return;
      }

      if (message.type === "timeline.delete") {
        const data = await handleDeleteTimeline(message.payload.timelineId);
        sendResponse({ ok: true, data } satisfies MessageResponse);
        return;
      }

      if (message.type === "timeline.complete") {
        const data = await handleCompleteTimeline(message.payload.timelineId);
        sendResponse({ ok: true, data } satisfies MessageResponse);
        return;
      }

      if (message.type === "timeline.clearAll") {
        const data = await handleClearAll();
        sendResponse({ ok: true, data } satisfies MessageResponse);
        return;
      }

      sendResponse({ ok: false, error: "Unsupported message." } satisfies MessageResponse);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Unknown error";
      sendResponse({ ok: false, error: messageText } satisfies MessageResponse);
    }
  })();

  return true;
});
