import { describe, expect, it } from "bun:test";
import { buildTimelineFromCompletion, refreshTimeline } from "../src/shared/scheduler";
import { sanitizeIntervals } from "../src/shared/time";

describe("sanitizeIntervals", () => {
  it("sorts, dedupes, and removes invalid values", () => {
    expect(sanitizeIntervals([7, 1, 14, 7, -3, 0, Number.NaN])).toEqual([1, 7, 14]);
  });
});

describe("scheduler", () => {
  it("creates timeline with expected id and pending intervals", () => {
    const startAt = Date.UTC(2026, 1, 1, 12, 0, 0);
    const timeline = buildTimelineFromCompletion(
      {
        activityType: "quiz",
        contentItemKey: "abc123",
        contentTitle: "Cell Biology Quiz",
        sourceUrl: "https://notebooklm.google.com/",
        detectedSignal: "test",
        occurredAt: startAt
      },
      [1, 7, 14, 30],
      startAt
    );

    expect(timeline.id).toBe("quiz:abc123");
    expect(timeline.pendingIntervalDays).toEqual([1, 7, 14, 30]);
  });

  it("marks timeline due when next due time is reached", () => {
    const startAt = Date.UTC(2026, 1, 1, 12, 0, 0);
    const timeline = buildTimelineFromCompletion(
      {
        activityType: "podcast",
        contentItemKey: "episode-01",
        contentTitle: "Podcast",
        sourceUrl: "https://notebooklm.google.com/",
        detectedSignal: "test",
        occurredAt: startAt
      },
      [1],
      startAt
    );

    const oneDayLater = startAt + 24 * 60 * 60 * 1000;
    const refreshed = refreshTimeline(timeline, oneDayLater);

    expect(refreshed.status).toBe("overdue");
    expect(refreshed.pendingIntervalDays).toEqual([]);
  });
});
