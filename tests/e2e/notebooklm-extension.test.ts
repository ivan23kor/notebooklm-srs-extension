/**
 * Live browser-agent smoke tests for the NotebookLM SRS extension.
 *
 * These are opt-in because they require a real signed-in browser session with
 * the browser-agent daemon and extension already connected.
 *
 * Run:
 *   SRS_RUN_LIVE_E2E=1 bun test tests/e2e/notebooklm-extension.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";

const NOTEBOOKLM_ORIGIN = "https://notebooklm.google.com";
const BADGE_SELECTOR = "[data-srs-timer]";

// ---------------------------------------------------------------------------
// browser-agent CLI helpers
// ---------------------------------------------------------------------------

interface BadgeNode {
  nodeId: number;
  text: string;
  name: string;
  tag: string;
  visible: boolean;
  bbox?: Record<string, number>;
  selectorCandidates?: string[];
}

interface BrowserAgentResult {
  success: boolean;
  error?: string;
  matched?: boolean;
  url?: string;
  title?: string;
  condition?: {
    matched: boolean;
    node?: BadgeNode;
    reason?: string;
  };
  tabs?: Array<{
    id: number;
    url: string;
    title: string;
    isAgentTab: boolean;
    isActive: boolean;
  }>;
}

async function runBrowserAgentCli(args: string): Promise<BrowserAgentResult> {
  try {
    const text = await $`bash -c ${"browser-ctl " + args}`.quiet().text();
    return JSON.parse(text.trim()) as BrowserAgentResult;
  } catch (err: unknown) {
    const shellErr = err as { stdout?: string | Buffer };
    const stdout = typeof shellErr.stdout === "string"
      ? shellErr.stdout
      : shellErr.stdout instanceof Buffer
        ? shellErr.stdout.toString()
        : "";
    if (stdout.trim()) {
      try {
        return JSON.parse(stdout.trim()) as BrowserAgentResult;
      } catch { /* fall through */ }
    }
    return { success: false, error: String(err) };
  }
}

async function navigate(url: string): Promise<BrowserAgentResult> {
  const json = JSON.stringify({ action: "navigate", url });
  return runBrowserAgentCli(`act --json '${json}'`);
}

async function waitForSelector(selector: string, timeoutMs = 15_000): Promise<BrowserAgentResult> {
  const json = JSON.stringify({ selector, state: "visible", timeoutMs });
  return runBrowserAgentCli(`wait-for --json '${json}'`);
}

async function isBrowserAgentReady(): Promise<boolean> {
  try {
    const res = await runBrowserAgentCli("status");
    return res.success === true;
  } catch {
    return false;
  }
}

async function ensureNotebookLMAttached(): Promise<boolean> {
  const status = await runBrowserAgentCli("status");
  if (status.success && status.tabs && status.tabs.length > 0) {
    const nlmTab = status.tabs.find(t => t.url?.includes("notebooklm.google.com"));
    if (nlmTab?.isActive) return true;
  }

  const listRes = await runBrowserAgentCli("list-tabs");
  if (!listRes.success || !listRes.tabs) return false;

  const nlmTab = listRes.tabs.find(t => t.url?.includes("notebooklm.google.com"));
  if (!nlmTab) return false;

  const attachRes = await runBrowserAgentCli(`attach ${nlmTab.id} --yes`);
  return attachRes.success;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const runLiveE2E = process.env.SRS_RUN_LIVE_E2E === "1";
const browserReady = runLiveE2E && await isBrowserAgentReady();

describe.skipIf(!browserReady)("NotebookLM SRS extension e2e (browser-agent)", () => {

  beforeAll(async () => {
    const attached = await ensureNotebookLMAttached();
    if (!attached) {
      throw new Error("Could not attach to a NotebookLM tab. Open notebooklm.google.com first.");
    }
    await navigate(`${NOTEBOOKLM_ORIGIN}/`);
    await Bun.sleep(4000);
  }, 30_000);

  afterAll(async () => {
    await navigate(`${NOTEBOOKLM_ORIGIN}/`);
  });

  test("timer badges exist on homepage next to tracked notebooks", async () => {
    const res = await waitForSelector(BADGE_SELECTOR, 10_000);
    expect(res.success).toBe(true);
    expect(res.matched).toBe(true);
    expect(res.condition?.node?.visible).toBe(true);
    expect(res.condition?.node?.tag).toBe("span");
  });

  test("timer badge text shows elapsed/interval format (e.g. '3h/1d')", async () => {
    const res = await waitForSelector(BADGE_SELECTOR, 10_000);
    expect(res.success).toBe(true);

    const badgeText = res.condition?.node?.text ?? res.condition?.node?.name ?? "";
    // Format: digits + h or d, slash, digits + d (e.g. "0h/1d", "3d/7d", "93h/1d")
    expect(badgeText).toMatch(/\d+[hd]\/\d+d/);
  });

  test("extension does not inject badges on non-NotebookLM pages", async () => {
    await navigate("https://www.google.com");
    await Bun.sleep(2000);

    const res = await waitForSelector(BADGE_SELECTOR, 3_000);
    expect(res.matched).not.toBe(true);

    // Navigate back
    await navigate(`${NOTEBOOKLM_ORIGIN}/`);
    await Bun.sleep(4000);
  }, 30_000);

  test("navigating away and back re-injects badges on homepage", async () => {
    // Navigate away from homepage
    await navigate(`${NOTEBOOKLM_ORIGIN}/notebook/test`);
    await Bun.sleep(2000);

    // Back to homepage
    await navigate(`${NOTEBOOKLM_ORIGIN}/`);
    await Bun.sleep(3000);

    const res = await waitForSelector(BADGE_SELECTOR, 10_000);
    expect(res.success).toBe(true);
    expect(res.matched).toBe(true);
  }, 30_000);
});
