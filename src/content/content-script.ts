import type {
  DashboardState,
} from "../shared/types";
import { getNotebookTimerMap } from "./homepage-badges";

const APP_HOST = "notebooklm.google.com";
const LOG_PREFIX = "[SRS]";

function srsLog(...args: unknown[]): void {
  console.debug(LOG_PREFIX, ...args);
}

async function start(): Promise<void> {
  srsLog("init", location.href);
  const injector = new HomepageTimerInjector();
  await injector.refresh();
  srsLog("ready");
}

class HomepageTimerInjector {
  private notebookTableObserver: MutationObserver | null = null;
  private latestDashboardState: DashboardState | null = null;
  private timerSyncPending = false;

  constructor() {
    this.bindNotebookTableObserver();
  }

  async refresh(): Promise<void> {
    const response = await sendMessage({ type: "dashboard.get" });
    if (!response.ok || !response.data) {
      console.warn(LOG_PREFIX, response.error ?? "Failed to load state");
      return;
    }

    this.latestDashboardState = response.data;
    this.syncHomepageTimers();
  }

  private bindNotebookTableObserver(): void {
    this.notebookTableObserver = new MutationObserver(() => {
      this.scheduleTimerSync();
    });
    this.notebookTableObserver.observe(document.body, { childList: true, subtree: true });
  }

  private scheduleTimerSync(): void {
    if (this.timerSyncPending || !this.latestDashboardState) {
      return;
    }
    this.timerSyncPending = true;
    requestAnimationFrame(() => {
      this.timerSyncPending = false;
      this.syncHomepageTimers();
    });
  }

  private syncHomepageTimers(): void {
    if (!this.latestDashboardState) {
      return;
    }

    if (location.pathname !== "/") {
      return;
    }

    const timerMap = getNotebookTimerMap(this.latestDashboardState, Date.now());
    if (timerMap.size === 0) {
      return;
    }

    this.notebookTableObserver?.disconnect();

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const text = node.textContent?.trim();
      if (!text || text.length < 2) {
        continue;
      }

      const key = text.toLowerCase();
      const timerInfo = timerMap.get(key);
      if (!timerInfo) {
        continue;
      }

      const parent = node.parentElement;
      if (!parent || parent.closest("[data-srs-timer]")) {
        continue;
      }

      const existing = parent.querySelector<HTMLElement>("[data-srs-timer]");
      if (existing) {
        existing.textContent = timerInfo.label;
        this.applyBadgeStyle(existing, timerInfo.isOverdue);
        continue;
      }

      const badge = document.createElement("span");
      badge.setAttribute("data-srs-timer", "true");
      this.applyBadgeStyle(badge, timerInfo.isOverdue);
      badge.textContent = timerInfo.label;
      parent.appendChild(badge);
    }

    this.notebookTableObserver?.observe(document.body, { childList: true, subtree: true });
  }

  private applyBadgeStyle(el: HTMLElement, isOverdue: boolean): void {
    el.style.cssText =
      "margin-left:6px;font-size:11px;padding:1px 5px;border-radius:4px;white-space:nowrap;font-weight:600;" +
      (isOverdue
        ? "background:#fef2f2;color:#be123c;"
        : "background:#f0fdf4;color:#15803d;");
  }
}

async function sendMessage(message: { type: string; payload?: unknown }): Promise<{ ok: boolean; data?: DashboardState; error?: string }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response: { ok: boolean; data?: DashboardState; error?: string } | undefined) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response ?? { ok: false, error: "No response" });
    });
  });
}

if (location.host === APP_HOST) {
  start().catch((error) => {
    console.error("NotebookLM SRS extension failed to initialize", error);
  });
}
