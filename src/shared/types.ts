export type ActivityType = "quiz" | "flashcards" | "podcast";

export type TimelineStatus = "active" | "due" | "overdue";

export interface CompletionRecord {
  completedAt: number;
  detectedFromUrl: string;
  detectedSignal: string;
}

export interface Timeline {
  id: string;
  activityType: ActivityType;
  contentItemKey: string;
  contentTitle: string;
  lastCompletionAt: number;
  intervalDays: number[];
  sourceUrl: string;
  nextDueAt: number;
  status: TimelineStatus;
  pendingIntervalDays: number[];
  history: CompletionRecord[];
  lastNotificationAt?: number;
}

export interface Settings {
  intervalDays: number[];
  version: number;
}

export interface StoreState {
  settings: Settings;
  timelines: Record<string, Timeline>;
}

export interface ActivityCompletedEvent {
  activityType: ActivityType;
  contentItemKey: string;
  contentTitle: string;
  sourceUrl: string;
  detectedSignal: string;
  occurredAt: number;
}

export interface DashboardTimeline {
  id: string;
  activityType: ActivityType;
  contentTitle: string;
  sourceUrl: string;
  nextDueAt: number;
  status: TimelineStatus;
  pendingIntervalDays: number[];
  lastCompletionAt: number;
}

export interface DashboardState {
  settings: Settings;
  due: DashboardTimeline[];
  upcoming: DashboardTimeline[];
  overdue: DashboardTimeline[];
  totalTimelines: number;
}

export type ExtensionMessage =
  | { type: "activity.completed"; payload: ActivityCompletedEvent }
  | { type: "dashboard.get" }
  | { type: "settings.updateIntervals"; payload: { intervalDays: number[] } }
  | { type: "timeline.delete"; payload: { timelineId: string } }
  | { type: "timeline.complete"; payload: { timelineId: string } }
  | { type: "timeline.clearAll" };

export interface MessageResponse {
  ok: boolean;
  data?: DashboardState;
  error?: string;
}

export interface NotificationMeta {
  timelineId: string;
  scheduledFor: number;
}
