import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const NOTEBOOKLM_ORIGIN = "https://notebooklm.google.com";
const EXTENSION_ROOT_ID = "notebooklm-srs-root";

interface Harness {
  context: BrowserContext;
  page: Page;
  worker: ExtensionWorker;
  extensionId: string;
  userDataDir: string;
}

interface ExtensionWorker {
  url(): string;
  evaluate<R>(pageFunction: () => R | Promise<R>): Promise<R>;
}

test.describe("NotebookLM SRS extension e2e", () => {
  test.skip(process.platform === "linux" && !process.env.DISPLAY, "Requires a DISPLAY to run Chromium extension tests.");

  test("injects the in-page panel on NotebookLM pages", async () => {
    const harness = await launchHarness();
    try {
      await setupNotebookRoute(harness.context, {
        title: "OpenStax Biology",
        body: "Notebook overview"
      });

      await harness.page.goto(`${NOTEBOOKLM_ORIGIN}/notebook/abc123`);
      await expect.poll(() => getShadowText(harness.page, "#srs-status")).not.toBeNull();

      const total = await getShadowText(harness.page, "#srs-total");
      expect(total).toBe("0");
    } finally {
      await closeHarness(harness);
    }
  });

  test("tracks a completion signal and persists timeline data", async () => {
    const harness = await launchHarness();
    try {
      await setupNotebookRoute(harness.context, {
        title: "Cell Biology Quiz",
        body: "Start your quiz"
      });

      await harness.page.goto(`${NOTEBOOKLM_ORIGIN}/notebook/quiz-1?mode=quiz&id=quiz-1`);
      await expect.poll(() => getShadowText(harness.page, "#srs-total")).toBe("0");

      await harness.page.evaluate(() => {
        const marker = document.createElement("div");
        marker.textContent = "quiz complete final score review answers";
        document.body.appendChild(marker);
      });

      await expect.poll(() => getShadowText(harness.page, "#srs-total")).toBe("1");
      await expect.poll(() => getListCount(harness.page, "#srs-upcoming")).toBe(1);

      const timelines = await readTimelinesFromServiceWorker(harness.worker);
      const values = Object.values(timelines) as Array<{
        activityType: string;
        contentTitle: string;
        intervalDays: number[];
      }>;
      expect(values.length).toBe(1);
      expect(values[0]?.activityType).toBe("quiz");
      expect(values[0]?.contentTitle).toContain("Cell Biology Quiz");
      expect(values[0]?.intervalDays).toEqual([1, 7, 14, 30]);
    } finally {
      await closeHarness(harness);
    }
  });

  test("updates intervals and supports item deletion + clear all", async () => {
    const harness = await launchHarness();
    try {
      await setupNotebookRoute(harness.context, {
        title: "Podcast: Genome Basics",
        body: "Audio overview"
      });

      await harness.page.goto(`${NOTEBOOKLM_ORIGIN}/notebook/podcast-1?mode=podcast&id=podcast-1`);
      await expect.poll(() => getShadowText(harness.page, "#srs-total")).toBe("0");

      await harness.page.evaluate(() => {
        const marker = document.createElement("div");
        marker.textContent = "podcast complete finished listening";
        document.body.appendChild(marker);
      });

      await expect.poll(() => getShadowText(harness.page, "#srs-total")).toBe("1");

      await setShadowInputValue(harness.page, "#srs-intervals", "2, 5, 9");
      await clickShadow(harness.page, "#srs-save-intervals");

      await expect.poll(() => getShadowInputValue(harness.page, "#srs-intervals")).toBe("2, 5, 9");

      await clickShadow(harness.page, "button[data-delete-timeline]");
      await expect.poll(() => getShadowText(harness.page, "#srs-total")).toBe("0");

      await setupNotebookRoute(harness.context, {
        title: "Podcast: Genome Basics Part 2",
        body: "Audio overview"
      });
      await harness.page.goto(`${NOTEBOOKLM_ORIGIN}/notebook/podcast-2?mode=podcast&id=podcast-2`);

      await harness.page.evaluate(() => {
        const marker = document.createElement("div");
        marker.textContent = "podcast complete listen again";
        document.body.appendChild(marker);
      });
      await expect.poll(() => getShadowText(harness.page, "#srs-total")).toBe("1");

      harness.page.once("dialog", (dialog) => dialog.accept());
      await clickShadow(harness.page, "#srs-clear-all");
      await expect.poll(() => getShadowText(harness.page, "#srs-total")).toBe("0");

      const timelines = await readTimelinesFromServiceWorker(harness.worker);
      expect(Object.keys(timelines)).toHaveLength(0);
    } finally {
      await closeHarness(harness);
    }
  });
});

async function launchHarness(): Promise<Harness> {
  const extensionPath = resolve(process.cwd(), "dist");
  const userDataDir = await mkdtemp(join(tmpdir(), "notebooklm-srs-e2e-"));

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });

  let [worker] = context.serviceWorkers();
  if (!worker) {
    worker = await context.waitForEvent("serviceworker");
  }

  const extensionId = worker.url().split("/")[2] ?? "";
  if (!extensionId) {
    throw new Error("Failed to resolve extension ID.");
  }

  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page, worker, extensionId, userDataDir };
}

async function closeHarness(harness: Harness): Promise<void> {
  await harness.context.close();
  await rm(harness.userDataDir, { recursive: true, force: true });
}

async function setupNotebookRoute(
  context: BrowserContext,
  options: { title: string; body: string }
): Promise<void> {
  await context.route(`${NOTEBOOKLM_ORIGIN}/**`, async (route) => {
    const html = `<!doctype html>
<html>
  <head>
    <title>${escapeHtml(options.title)}</title>
    <meta charset="utf-8" />
  </head>
  <body>
    <h1>${escapeHtml(options.title)}</h1>
    <main>${escapeHtml(options.body)}</main>
  </body>
</html>`;

    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: html
    });
  });
}

async function readTimelinesFromServiceWorker(worker: ExtensionWorker): Promise<Record<string, unknown>> {
  return worker.evaluate(async () => {
    return await new Promise<Record<string, unknown>>((resolve) => {
      chrome.storage.local.get(["timelines"], (result) => {
        resolve((result.timelines ?? {}) as Record<string, unknown>);
      });
    });
  });
}

async function getShadowText(page: Page, selector: string): Promise<string | null> {
  return page.evaluate(
    ({ rootId, selector: innerSelector }) => {
      const host = document.getElementById(rootId);
      const root = host?.shadowRoot;
      const target = root?.querySelector(innerSelector);
      return target?.textContent?.trim() ?? null;
    },
    { rootId: EXTENSION_ROOT_ID, selector }
  );
}

async function getListCount(page: Page, listSelector: string): Promise<number> {
  return page.evaluate(
    ({ rootId, listSelector }) => {
      const host = document.getElementById(rootId);
      const root = host?.shadowRoot;
      const list = root?.querySelector(listSelector);
      if (!list) {
        return 0;
      }
      return list.querySelectorAll("li:not(.empty)").length;
    },
    { rootId: EXTENSION_ROOT_ID, listSelector }
  );
}

async function setShadowInputValue(page: Page, selector: string, value: string): Promise<void> {
  await page.evaluate(
    ({ rootId, selector, value }) => {
      const host = document.getElementById(rootId);
      const root = host?.shadowRoot;
      const input = root?.querySelector<HTMLInputElement>(selector);
      if (!input) {
        throw new Error(`Missing input ${selector}`);
      }
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { rootId: EXTENSION_ROOT_ID, selector, value }
  );
}

async function getShadowInputValue(page: Page, selector: string): Promise<string | null> {
  return page.evaluate(
    ({ rootId, selector }) => {
      const host = document.getElementById(rootId);
      const root = host?.shadowRoot;
      const input = root?.querySelector<HTMLInputElement>(selector);
      return input?.value ?? null;
    },
    { rootId: EXTENSION_ROOT_ID, selector }
  );
}

async function clickShadow(page: Page, selector: string): Promise<void> {
  await page.evaluate(
    ({ rootId, selector }) => {
      const host = document.getElementById(rootId);
      const root = host?.shadowRoot;
      const button = root?.querySelector<HTMLElement>(selector);
      if (!button) {
        throw new Error(`Missing click target ${selector}`);
      }
      button.click();
    },
    { rootId: EXTENSION_ROOT_ID, selector }
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
