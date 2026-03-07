import { describe, expect, it } from "bun:test";
import { formatTimerBadge, getDisplayIntervalDays, getNotebookTimerMap } from "../src/content/homepage-badges";
import type { DashboardState, DashboardTimeline } from "../src/shared/types";

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 2, 7, 12, 0, 0);

function makeTimeline(
  title: string,
  elapsedHours: number,
  activityType: DashboardTimeline["activityType"] = "review"
): DashboardTimeline {
  const lastCompletionAt = NOW - elapsedHours * HOUR_MS;

  return {
    id: `${activityType}:${title}:${elapsedHours}`,
    activityType,
    contentTitle: title,
    sourceUrl: "https://notebooklm.google.com/",
    nextDueAt: lastCompletionAt + 24 * HOUR_MS,
    status: "active",
    pendingIntervalDays: [],
    lastCompletionAt
  };
}

function makeState(items: DashboardTimeline[]): DashboardState {
  return {
    settings: {
      intervalDays: [1, 7, 14, 30],
      version: 1
    },
    due: [],
    upcoming: items,
    overdue: [],
    totalTimelines: items.length
  };
}

describe("homepage badges", () => {
  it("formats an upcoming first repetition as hours over the 1 day target", () => {
    const badge = formatTimerBadge(makeTimeline("Biology", 3), [1, 7, 14, 30], NOW);

    expect(badge.label).toBe("3h/1d");
    expect(badge.isOverdue).toBe(false);
    expect(badge.intervalDays).toBe(1);
  });

  it("keeps the first interval label once it is overdue", () => {
    const badge = formatTimerBadge(makeTimeline("Biology", 93), [1, 7, 14, 30], NOW);

    expect(badge.label).toBe("93h/1d");
    expect(badge.isOverdue).toBe(true);
    expect(badge.intervalDays).toBe(1);
  });

  it("advances the displayed interval only after the next repetition window starts", () => {
    const badge = formatTimerBadge(makeTimeline("Biology", 8 * 24 + 2), [1, 7, 14, 30], NOW);

    expect(badge.label).toBe("194h/7d");
    expect(badge.isOverdue).toBe(true);
    expect(badge.intervalDays).toBe(7);
  });

  it("caps the display interval at the largest configured repetition", () => {
    expect(getDisplayIntervalDays([1, 7, 14, 30], NOW - 40 * 24 * HOUR_MS, NOW)).toBe(30);
  });

  it("shows the most urgent notebook badge when multiple timelines share a title", () => {
    const state = makeState([
      makeTimeline("Biology Notes", 3, "quiz"),
      makeTimeline("biology notes", 93, "flashcards"),
      makeTimeline("Chemistry", 12, "podcast")
    ]);

    const map = getNotebookTimerMap(state, NOW);

    expect(map.size).toBe(2);
    expect(map.get("biology notes")).toEqual({
      label: "93h/1d",
      isOverdue: true,
      intervalDays: 1,
      elapsedHours: 93
    });
    expect(map.get("chemistry")).toEqual({
      label: "12h/1d",
      isOverdue: false,
      intervalDays: 1,
      elapsedHours: 12
    });
  });
});
