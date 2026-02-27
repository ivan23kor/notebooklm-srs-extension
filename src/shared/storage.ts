import { DEFAULT_SETTINGS, STORAGE_KEYS } from "./constants";
import type { StoreState, Timeline } from "./types";

interface RawStore {
  settings?: StoreState["settings"];
  timelines?: Record<string, Timeline>;
  notificationMeta?: Record<string, { timelineId: string; scheduledFor: number }>;
}

function storageGet<T>(keys: string[]): Promise<T> {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result as T));
  });
}

function storageSet(values: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(values, () => resolve());
  });
}

function storageRemove(keys: string[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, () => resolve());
  });
}

export async function loadState(): Promise<StoreState> {
  const raw = await storageGet<RawStore>([STORAGE_KEYS.settings, STORAGE_KEYS.timelines]);
  return {
    settings: raw.settings ?? DEFAULT_SETTINGS,
    timelines: raw.timelines ?? {}
  };
}

export async function saveState(state: StoreState): Promise<void> {
  await storageSet({
    [STORAGE_KEYS.settings]: state.settings,
    [STORAGE_KEYS.timelines]: state.timelines
  });
}

export async function loadNotificationMeta(): Promise<
  Record<string, { timelineId: string; scheduledFor: number }>
> {
  const raw = await storageGet<RawStore>([STORAGE_KEYS.notifications]);
  return raw.notificationMeta ?? {};
}

export async function saveNotificationMeta(
  notificationMeta: Record<string, { timelineId: string; scheduledFor: number }>
): Promise<void> {
  await storageSet({
    [STORAGE_KEYS.notifications]: notificationMeta
  });
}

export async function clearAllState(): Promise<void> {
  await storageRemove([STORAGE_KEYS.timelines, STORAGE_KEYS.notifications]);
}
