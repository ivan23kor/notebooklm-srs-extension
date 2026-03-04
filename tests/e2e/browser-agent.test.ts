/**
 * E2E tests for the NotebookLM SRS extension on the live notebooklm.google.com site.
 *
 * Prerequisites:
 *   1. `browser-ctl start` running (browser-agent WS server)
 *   2. browser-agent Chrome extension loaded
 *   3. NotebookLM SRS extension loaded from dist/
 *   4. Signed in to notebooklm.google.com in the browser
 *   5. At least one notebook exists on the account
 *
 * Run:
 *   bun test tests/e2e/browser-agent.e2e.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";

const NOTEBOOKLM_ORIGIN = "https://notebooklm.google.com";
const SRS_ROOT_ID = "notebooklm-srs-root";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run browser-ctl action DSL commands. */
async function browserRun(code: string): Promise<BrowserResult> {
  const buf = Buffer.from(code);
  const text = await $`browser-ctl run < ${buf}`.quiet().text();
  return JSON.parse(text.trim()) as BrowserResult;
}

/** Navigate to a URL and wait for page + content script to load. */
async function browserGoto(url: string): Promise<BrowserResult> {
  const res = await browserRun(`goto ${url}`);
  // Give the content script time to inject after navigation
  await Bun.sleep(3000);
  return res;
}

/** Evaluate a JS expression in the current agent tab and return the result. */
async function browserEval(expression: string): Promise<string | null> {
  const res = await browserRun(`eval ${expression}`);
  if (!res.success) {
    console.error("browserEval failed:", res.error);
    return null;
  }
  return String(res.result ?? "null");
}

/** Read a value from the SRS panel shadow DOM. */
async function shadowText(selector: string): Promise<string | null> {
  const raw = await browserEval(
    `document.getElementById('${SRS_ROOT_ID}')?.shadowRoot?.querySelector('${selector}')?.textContent?.trim() ?? null`
  );
  return raw === "null" ? null : raw;
}

/** Click an element inside the SRS panel shadow DOM. */
async function shadowClick(selector: string): Promise<BrowserResult> {
  return browserRun(
    `eval document.getElementById('${SRS_ROOT_ID}')?.shadowRoot?.querySelector('${selector}')?.click()`
  );
}

/** Poll until `fn` returns a truthy value, with timeout. */
async function waitFor<T>(
  fn: () => Promise<T>,
  opts: { timeout?: number; interval?: number; label?: string } = {}
): Promise<T> {
  const { timeout = 15_000, interval = 500, label = "condition" } = opts;
  const deadline = Date.now() + timeout;
  let last: T;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await Bun.sleep(interval);
  }
  throw new Error(`waitFor(${label}) timed out after ${timeout}ms — last value: ${JSON.stringify(last!)}`);
}

/** Clear all SRS timelines via shadow DOM Clear All button (with dialog accept). */
async function clearAllTimelines(): Promise<void> {
  // Use eval to programmatically send the message, bypassing the confirm dialog
  await browserRun(
    `eval chrome.runtime.sendMessage({type:'timeline.clearAll'}, function(){})`
  );
  await Bun.sleep(500);
}

/** Navigate to the first own notebook by clicking a row on the homepage. */
async function navigateToFirstOwnNotebook(): Promise<string | null> {
  // Ensure we're on the homepage
  await browserGoto(`${NOTEBOOKLM_ORIGIN}/`);

  // Click the first "My notebooks" row (skip featured/shared)
  // Own notebooks have "Owner" role text
  await browserRun(
    `eval document.querySelector('tr.mat-mdc-row')?.click()`
  );
  await Bun.sleep(4000);

  const url = await browserEval("location.href");
  if (url && url.includes("/notebook/")) {
    return url;
  }
  return null;
}

interface BrowserResult {
  success: boolean;
  result?: string | null;
  url?: string;
  title?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NotebookLM SRS extension — browser-agent live e2e", () => {

  let originalTimelineCount: string | null = null;

  beforeAll(async () => {
    // Verify browser-ctl is running
    const status = (await $`browser-ctl status`.text()).trim();
    const parsed = JSON.parse(status);
    expect(parsed.success).toBe(true);

    // Navigate to NotebookLM homepage
    const nav = await browserGoto(`${NOTEBOOKLM_ORIGIN}/`);
    expect(nav.success).toBe(true);

    // Verify the SRS extension panel is injected
    await waitFor(
      () => browserEval(`document.getElementById('${SRS_ROOT_ID}') !== null`).then(v => v === "true" ? true : null),
      { label: "SRS panel injected", timeout: 10_000 }
    );

    // Store original timeline count so we can restore state later
    originalTimelineCount = await shadowText("#srs-total");
  });

  afterAll(async () => {
    // Navigate back to homepage to leave browser in clean state
    await browserGoto(`${NOTEBOOKLM_ORIGIN}/`);
  });

  test("SRS panel is present and shows tracked count on homepage", async () => {
    await browserGoto(`${NOTEBOOKLM_ORIGIN}/`);

    const total = await shadowText("#srs-total");
    expect(total).not.toBeNull();
    // total is a numeric string
    expect(Number(total)).toBeGreaterThanOrEqual(0);

    const status = await shadowText("#srs-status");
    expect(status).not.toBeNull();
    expect(status!.length).toBeGreaterThan(0);
  });

  test("Mark Trained button exists and is clickable", async () => {
    const btnText = await shadowText("#srs-mark-trained");
    expect(btnText).toBe("Mark Trained");

    // Verify it's not disabled
    const disabled = await browserEval(
      `document.getElementById('${SRS_ROOT_ID}')?.shadowRoot?.querySelector('#srs-mark-trained')?.disabled ?? false`
    );
    expect(disabled).toBe("false");
  });

  test("navigating to a notebook page shows the SRS panel", async () => {
    const notebookUrl = await navigateToFirstOwnNotebook();

    if (!notebookUrl) {
      console.warn("No notebook found on homepage — skipping notebook navigation test");
      return;
    }

    // Panel should be present on the notebook page
    await waitFor(
      () => browserEval(`document.getElementById('${SRS_ROOT_ID}') !== null`).then(v => v === "true" ? true : null),
      { label: "SRS panel on notebook page" }
    );

    const btnText = await shadowText("#srs-mark-trained");
    expect(btnText).toBe("Mark Trained");
  });

  test("Mark Trained creates a timeline and shows feedback", async () => {
    const notebookUrl = await navigateToFirstOwnNotebook();
    if (!notebookUrl) {
      console.warn("No notebook found — skipping");
      return;
    }

    await waitFor(
      () => shadowText("#srs-mark-trained").then(v => v === "Mark Trained" ? true : null),
      { label: "Mark Trained button ready" }
    );

    // Record the timeline count before
    const countBefore = Number(await shadowText("#srs-total") ?? "0");

    // Click Mark Trained
    await shadowClick("#srs-mark-trained");

    // Button should show "Saving…" or "Trained ✓" feedback
    const feedback = await waitFor(
      () => shadowText("#srs-mark-trained").then(v =>
        v === "Saving…" || v === "Trained ✓" ? v : null
      ),
      { label: "Mark Trained feedback", interval: 200 }
    );
    expect(["Saving…", "Trained ✓"]).toContain(feedback);

    // Wait for "Trained ✓" specifically
    await waitFor(
      () => shadowText("#srs-mark-trained").then(v => v === "Trained ✓" ? true : null),
      { label: "Trained ✓ shown", timeout: 10_000 }
    );

    // Timeline count should have increased (or stayed same if re-completing same notebook)
    const countAfter = Number(await shadowText("#srs-total") ?? "0");
    expect(countAfter).toBeGreaterThanOrEqual(countBefore);

    // Button should reset back to "Mark Trained" after ~1.2s
    await waitFor(
      () => shadowText("#srs-mark-trained").then(v => v === "Mark Trained" ? true : null),
      { label: "button reset", timeout: 5_000 }
    );
  });

  test("panel notebook list shows tracked notebooks with timer info", async () => {
    // Ensure we have at least one tracked notebook
    // (the previous test should have created one)
    const total = Number(await shadowText("#srs-total") ?? "0");
    if (total === 0) {
      console.warn("No tracked notebooks — skipping notebook list test");
      return;
    }

    // Check notebook list has entries
    const listHtml = await browserEval(
      `document.getElementById('${SRS_ROOT_ID}')?.shadowRoot?.querySelector('#srs-notebooks')?.innerHTML?.length ?? 0`
    );
    expect(Number(listHtml)).toBeGreaterThan(0);

    // Check that at least one activity row exists with time info
    const hasActivityRow = await browserEval(
      `document.getElementById('${SRS_ROOT_ID}')?.shadowRoot?.querySelector('.activity-row') !== null`
    );
    expect(hasActivityRow).toBe("true");

    // Check that activity type shows "review"
    const activityType = await browserEval(
      `document.getElementById('${SRS_ROOT_ID}')?.shadowRoot?.querySelector('.activity-type')?.textContent?.trim() ?? null`
    );
    expect(activityType).toBe("review");

    // Check that time info is present (contains "h" for hours)
    const timeInfo = await browserEval(
      `document.getElementById('${SRS_ROOT_ID}')?.shadowRoot?.querySelector('.activity-time')?.textContent?.trim() ?? null`
    );
    expect(timeInfo).not.toBeNull();
    expect(timeInfo).toContain("h");
  });

  test("homepage timer badges are injected next to tracked notebook titles", async () => {
    // First ensure we have tracked notebooks
    const total = Number(await shadowText("#srs-total") ?? "0");
    if (total === 0) {
      console.warn("No tracked notebooks — skipping timer badge test");
      return;
    }

    // Navigate to homepage
    await browserGoto(`${NOTEBOOKLM_ORIGIN}/`);

    // Wait for SRS panel to refresh on homepage
    await waitFor(
      () => shadowText("#srs-status").then(v => v?.startsWith("Updated") ? true : null),
      { label: "panel refreshed on homepage" }
    );

    // Check that at least one timer badge [data-srs-timer] exists in the page
    const badgeCount = await waitFor(
      () => browserEval(`document.querySelectorAll('[data-srs-timer]').length`).then(v =>
        Number(v) > 0 ? v : null
      ),
      { label: "timer badge injected", timeout: 10_000 }
    );
    expect(Number(badgeCount)).toBeGreaterThan(0);

    // Check the badge has text content (a timer value like "23h" or "Due now")
    const badgeText = await browserEval(
      `document.querySelector('[data-srs-timer]')?.textContent?.trim() ?? null`
    );
    expect(badgeText).not.toBeNull();
    expect(badgeText!.length).toBeGreaterThan(0);
  });

  test("timer badge has correct styling based on status", async () => {
    await browserGoto(`${NOTEBOOKLM_ORIGIN}/`);

    const badgeExists = await browserEval(
      `document.querySelector('[data-srs-timer]') !== null`
    );
    if (badgeExists !== "true") {
      console.warn("No timer badge found — skipping styling test");
      return;
    }

    // Badge should have inline styles applied
    const style = await browserEval(
      `document.querySelector('[data-srs-timer]')?.style?.cssText ?? null`
    );
    expect(style).not.toBeNull();
    expect(style).toContain("border-radius");
    expect(style).toContain("font-size");
  });

  test("Refresh button reloads dashboard data", async () => {
    await browserGoto(`${NOTEBOOKLM_ORIGIN}/`);

    const statusBefore = await shadowText("#srs-status");

    // Click refresh
    await shadowClick("#srs-refresh");
    await Bun.sleep(1000);

    // Status should update with a new timestamp
    const statusAfter = await shadowText("#srs-status");
    expect(statusAfter).not.toBeNull();
    expect(statusAfter).toContain("Updated");
  });

  test("intervals input shows current intervals and can be updated", async () => {
    // Read current interval values
    const currentIntervals = await browserEval(
      `document.getElementById('${SRS_ROOT_ID}')?.shadowRoot?.querySelector('#srs-intervals')?.value ?? null`
    );
    expect(currentIntervals).not.toBeNull();
    expect(currentIntervals!.length).toBeGreaterThan(0);

    // Set new intervals
    await browserRun(
      `eval document.getElementById('${SRS_ROOT_ID}').shadowRoot.querySelector('#srs-intervals').value = '2, 5, 10'`
    );

    // Click save
    await shadowClick("#srs-save-intervals");
    await Bun.sleep(1000);

    // Verify status shows update confirmation
    const status = await shadowText("#srs-status");
    expect(status).toContain("Intervals updated");

    // Verify input has the new value
    const updatedIntervals = await browserEval(
      `document.getElementById('${SRS_ROOT_ID}')?.shadowRoot?.querySelector('#srs-intervals')?.value ?? null`
    );
    expect(updatedIntervals).toBe("2, 5, 10");

    // Restore original intervals
    await browserRun(
      `eval document.getElementById('${SRS_ROOT_ID}').shadowRoot.querySelector('#srs-intervals').value = '${currentIntervals}'`
    );
    await shadowClick("#srs-save-intervals");
    await Bun.sleep(500);
  });

  test("collapse button toggles the panel", async () => {
    // Panel should start expanded
    const collapsedBefore = await browserEval(
      `document.getElementById('${SRS_ROOT_ID}')?.getAttribute('data-collapsed') ?? 'false'`
    );
    expect(collapsedBefore).toBe("false");

    // Click collapse
    await shadowClick("#srs-collapse");
    await Bun.sleep(500);

    // Panel should now be collapsed
    const collapsedAfter = await browserEval(
      `document.getElementById('${SRS_ROOT_ID}')?.getAttribute('data-collapsed') ?? 'false'`
    );
    expect(collapsedAfter).toBe("true");

    // Expand again
    await shadowClick("#srs-collapse");
    await Bun.sleep(500);

    const collapsedReset = await browserEval(
      `document.getElementById('${SRS_ROOT_ID}')?.getAttribute('data-collapsed') ?? 'false'`
    );
    expect(collapsedReset).toBe("false");
  });

  test("complete button in notebook list marks a timeline complete", async () => {
    const total = Number(await shadowText("#srs-total") ?? "0");
    if (total === 0) {
      console.warn("No tracked notebooks — skipping complete button test");
      return;
    }

    // Click the first Complete button in the notebook list
    const hasCompleteBtn = await browserEval(
      `document.getElementById('${SRS_ROOT_ID}')?.shadowRoot?.querySelector('button[data-complete]') !== null`
    );
    if (hasCompleteBtn !== "true") {
      console.warn("No complete button found — skipping");
      return;
    }

    await browserRun(
      `eval document.getElementById('${SRS_ROOT_ID}')?.shadowRoot?.querySelector('button[data-complete]')?.click()`
    );
    await Bun.sleep(1500);

    // Status should show "Completed"
    const status = await shadowText("#srs-status");
    expect(status).toBe("Completed");
  });

  test("no SRS panel on non-NotebookLM pages", async () => {
    await browserGoto("https://www.google.com");

    const hasPanel = await browserEval(
      `document.getElementById('${SRS_ROOT_ID}') !== null`
    );
    expect(hasPanel).toBe("false");

    // Navigate back for other tests
    await browserGoto(`${NOTEBOOKLM_ORIGIN}/`);
  });
});
