import { describe, expect, it } from "bun:test";
import { formatTimerBadge, getDisplayIntervalDays, getNotebookTimerMap, getNotebookIdMap } from "../src/content/homepage-badges";
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
  it("formats an upcoming first repetition as hours when under 24h", () => {
    const badge = formatTimerBadge(makeTimeline("Biology", 3), [1, 7, 14, 30], NOW);

    expect(badge.label).toBe("3h/1d");
    expect(badge.isOverdue).toBe(false);
    expect(badge.intervalDays).toBe(1);
  });

  it("formats elapsed time as days with decimals when 24h or more", () => {
    const badge = formatTimerBadge(makeTimeline("Biology", 93), [1, 7, 14, 30], NOW);

    expect(badge.label).toBe("3.9d/1d");
    expect(badge.isOverdue).toBe(true);
    expect(badge.intervalDays).toBe(1);
  });

  it("advances the displayed interval only after the next repetition window starts", () => {
    const badge = formatTimerBadge(makeTimeline("Biology", 8 * 24 + 2), [1, 7, 14, 30], NOW);

    expect(badge.label).toBe("8.1d/7d");
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
      label: "3.9d/1d",
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

  it("normalizes leading emoji when building timer keys", () => {
    const state = makeState([
      makeTimeline("🧠 Influence: The Psychology of Persuasion", 3, "quiz"),
      makeTimeline("Influence: The Psychology of Persuasion", 93, "flashcards")
    ]);

    const map = getNotebookTimerMap(state, NOW);

    expect(map.size).toBe(1);
    expect(map.get("influence: the psychology of persuasion")).toEqual({
      label: "3.9d/1d",
      isOverdue: true,
      intervalDays: 1,
      elapsedHours: 93
    });
  });
});

describe("getNotebookIdMap", () => {
  it("extracts notebook IDs from timeline.id format", () => {
    const state: DashboardState = {
      settings: { intervalDays: [1, 7, 14, 30], version: 1 },
      due: [],
      upcoming: [
        {
          id: "review:abc123def456",
          activityType: "review",
          contentTitle: "Test Notebook",
          sourceUrl: "https://notebooklm.google.com/notebook/abc123def456",
          nextDueAt: NOW + 24 * HOUR_MS,
          status: "active",
          pendingIntervalDays: [1, 7],
          lastCompletionAt: NOW - 12 * HOUR_MS
        },
        {
          id: "quiz:xyz789uvw012",
          activityType: "quiz",
          contentTitle: "Another Notebook",
          sourceUrl: "https://notebooklm.google.com/notebook/xyz789uvw012",
          nextDueAt: NOW + 48 * HOUR_MS,
          status: "active",
          pendingIntervalDays: [1, 7],
          lastCompletionAt: NOW - 6 * HOUR_MS
        }
      ],
      overdue: [],
      totalTimelines: 2
    };

    const map = getNotebookIdMap(state);

    expect(map.size).toBe(2);
    expect(map.get("test notebook")).toBe("abc123def456");
    expect(map.get("another notebook")).toBe("xyz789uvw012");
  });

  it("handles notebook IDs with colons in them", () => {
    const state: DashboardState = {
      settings: { intervalDays: [1, 7, 14, 30], version: 1 },
      due: [],
      upcoming: [
        {
          id: "review:abc:123:def",
          activityType: "review",
          contentTitle: "Colon Notebook",
          sourceUrl: "https://notebooklm.google.com/",
          nextDueAt: NOW + 24 * HOUR_MS,
          status: "active",
          pendingIntervalDays: [1, 7],
          lastCompletionAt: NOW - 12 * HOUR_MS
        }
      ],
      overdue: [],
      totalTimelines: 1
    };

    const map = getNotebookIdMap(state);

    expect(map.get("colon notebook")).toBe("abc:123:def");
  });

  it("deduplicates by title (case insensitive)", () => {
    const state: DashboardState = {
      settings: { intervalDays: [1, 7, 14, 30], version: 1 },
      due: [],
      upcoming: [
        {
          id: "review:first-id",
          activityType: "review",
          contentTitle: "Duplicate Title",
          sourceUrl: "https://notebooklm.google.com/",
          nextDueAt: NOW + 24 * HOUR_MS,
          status: "active",
          pendingIntervalDays: [1, 7],
          lastCompletionAt: NOW - 12 * HOUR_MS
        },
        {
          id: "quiz:second-id",
          activityType: "quiz",
          contentTitle: "duplicate title",
          sourceUrl: "https://notebooklm.google.com/",
          nextDueAt: NOW + 48 * HOUR_MS,
          status: "active",
          pendingIntervalDays: [1, 7],
          lastCompletionAt: NOW - 6 * HOUR_MS
        }
      ],
      overdue: [],
      totalTimelines: 2
    };

    const map = getNotebookIdMap(state);

    // Should keep first entry
    expect(map.size).toBe(1);
    expect(map.get("duplicate title")).toBe("first-id");
  });

  it("normalizes leading emoji in notebook titles", () => {
    const state: DashboardState = {
      settings: { intervalDays: [1, 7, 14, 30], version: 1 },
      due: [],
      upcoming: [
        {
          id: "review:first-id",
          activityType: "review",
          contentTitle: "🧠 Influence: The Psychology of Persuasion",
          sourceUrl: "https://notebooklm.google.com/",
          nextDueAt: NOW + 24 * HOUR_MS,
          status: "active",
          pendingIntervalDays: [1, 7],
          lastCompletionAt: NOW - 12 * HOUR_MS
        }
      ],
      overdue: [],
      totalTimelines: 1
    };

    const map = getNotebookIdMap(state);

    expect(map.get("influence: the psychology of persuasion")).toBe("first-id");
  });
});
