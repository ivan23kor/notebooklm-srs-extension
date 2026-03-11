import type { Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  intervalDays: [1, 7, 14, 30],
  version: 1
};

export const STORAGE_KEYS = {
  settings: "settings",
  timelines: "timelines",
  notifications: "notificationMeta"
} as const;

export const ALARM_PREFIX = "timeline_due:";
export const NOTIFICATION_PREFIX = "timeline_notification:";
export const NOTIFICATION_DEDUPE_MS = 60 * 60 * 1000;
export const DETECTION_DEBOUNCE_MS = 30 * 1000;

export const PROCRASTINATION_HOSTS = [
  "youtube.com",
  "www.youtube.com",
  "reddit.com",
  "www.reddit.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "www.instagram.com",
  "tiktok.com",
  "www.tiktok.com",
  "facebook.com",
  "www.facebook.com",
  "twitch.tv",
  "www.twitch.tv",
];

export const NAG_COOLDOWN_MS = 30 * 1000;
