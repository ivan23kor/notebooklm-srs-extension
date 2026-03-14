import type {
  ActivityType,
  DashboardState,
} from "../shared/types";
import { getNotebookTimerMap } from "./homepage-badges";
import { MultiSelectManager } from "./multi-select";

const APP_HOST = "notebooklm.google.com";
const LOG_PREFIX = "[SRS]";

function srsLog(...args: unknown[]): void {
  console.debug(LOG_PREFIX, ...args);
}

async function start(): Promise<void> {
  srsLog("init", location.href);
  const homepageInjector = new HomepageTimerInjector();
  await homepageInjector.refresh();

  // Initialize multi-select manager
  new MultiSelectManager();

  // Always start the studio injector — NotebookLM is a SPA, so the user
  // may navigate to a notebook page after the content script has loaded.
  const studioInjector = new StudioRefreshButtonInjector();
  studioInjector.setHomepageInjector(homepageInjector);
  studioInjector.start();
  srsLog("studio injector started");

  srsLog("ready");
}

class HomepageTimerInjector {
  private notebookTableObserver: MutationObserver | null = null;
  private latestDashboardState: DashboardState | null = null;
  private timerSyncPending = false;

  constructor() {
    this.bindNotebookTableObserver();
    this.setupStateRefreshListener();
    this.setupUrlChangeListener();
  }

  private setupUrlChangeListener(): void {
    let lastPathname = location.pathname;
    // Poll for URL changes since SPA navigation doesn't always trigger events
    setInterval(() => {
      if (location.pathname !== lastPathname) {
        lastPathname = location.pathname;
        if (lastPathname === "/") {
          srsLog("[DEBUG] URL changed to homepage, refreshing timers");
          void this.refresh();
        }
      }
    }, 1000);
  }

  private setupStateRefreshListener(): void {
    chrome.runtime.onMessage.addListener((message: { type: string; payload?: unknown }) => {
      if (message.type === "state.refresh") {
        srsLog("received state.refresh, refreshing timers. pathname =", location.pathname);
        void this.refresh();
      }
      return true;
    });
  }

  async refresh(): Promise<void> {
    srsLog("[DEBUG] refresh() called, pathname =", location.pathname);
    const response = await sendMessage({ type: "dashboard.get" });
    if (!response.ok || !response.data) {
      console.warn(LOG_PREFIX, response.error ?? "Failed to load state");
      return;
    }

    srsLog("[DEBUG] dashboard.get response:", JSON.stringify({
      overdue: response.data.overdue?.map(t => ({ id: t.id, title: t.contentTitle, lastCompletionAt: t.lastCompletionAt })),
      due: response.data.due?.map(t => ({ id: t.id, title: t.contentTitle, lastCompletionAt: t.lastCompletionAt })),
      upcoming: response.data.upcoming?.map(t => ({ id: t.id, title: t.contentTitle, lastCompletionAt: t.lastCompletionAt })),
    }));
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
      srsLog("[DEBUG] syncHomepageTimers: no dashboard state, skipping");
      return;
    }

    if (location.pathname !== "/") {
      srsLog("[DEBUG] syncHomepageTimers: not on homepage (pathname =", location.pathname + "), skipping");
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

const ARTIFACT_TYPE_MAP: Record<string, ActivityType> = {
  audio_magic_eraser: "podcast",
  cards_star: "flashcards",
  quiz: "quiz",
};

function inferActivityType(card: Element): ActivityType {
  const iconEl = card.querySelector(".artifact-button-content .artifact-type-icon");
  const iconText = iconEl?.textContent?.trim() ?? "";
  return ARTIFACT_TYPE_MAP[iconText] ?? "review";
}

function extractCardTitle(card: Element): string {
  const titleEl = card.querySelector(".artifact-item-title");
  return titleEl?.textContent?.trim() ?? "";
}

function extractCardMeta(card: Element): string {
  const metaEl = card.querySelector(".artifact-item-metadata");
  return metaEl?.textContent?.trim() ?? "";
}

function getNotebookId(): string {
  const match = location.pathname.match(/\/notebook\/([^/]+)/);
  return match?.[1] ?? "";
}

function getNotebookTitle(): string {
  const input = document.querySelector<HTMLInputElement>("input.title-input");
  return input?.value?.trim() ?? "";
}

class StudioRefreshButtonInjector {
  private observer: MutationObserver | null = null;
  private syncPending = false;
  private homepageInjector: HomepageTimerInjector | null = null;

  setHomepageInjector(injector: HomepageTimerInjector): void {
    this.homepageInjector = injector;
  }

  start(): void {
    this.syncButtons();
    this.observer = new MutationObserver(() => {
      this.scheduleSync();
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
  }

  private scheduleSync(): void {
    if (this.syncPending) return;
    this.syncPending = true;
    requestAnimationFrame(() => {
      this.syncPending = false;
      this.syncButtons();
    });
  }

  private syncButtons(): void {
    if (!location.pathname.startsWith("/notebook/")) return;

    this.observer?.disconnect();

    const cards = document.querySelectorAll("artifact-library-item");
    for (const card of cards) {
      if (card.querySelector("[data-srs-refresh]")) continue;

      const actionsContainer = card.querySelector(".artifact-actions");
      if (!actionsContainer) continue;

      // Normalize spacing on all buttons in the container
      if (!actionsContainer.hasAttribute("data-srs-spacing-adjusted")) {
        actionsContainer.setAttribute("data-srs-spacing-adjusted", "true");
        actionsContainer.style.gap = "0";
        const allButtons = actionsContainer.querySelectorAll("button");
        for (const b of allButtons) {
          b.style.margin = "0 2px";
        }
      }

      const moreBtn = actionsContainer.querySelector<HTMLElement>("button[aria-label='More']");

      const btn = document.createElement("button");
      btn.setAttribute("data-srs-refresh", "true");
      btn.setAttribute("aria-label", "Mark as refreshed (SRS)");
      btn.setAttribute("title", "Mark as refreshed (SRS)");
      btn.type = "button";
      btn.style.cssText =
        "background:#1e1f21;border:none;cursor:pointer;padding:0;border-radius:50%;" +
        "width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;" +
        "color:#a8c7fa;font-size:18px;transition:background 0.15s;margin:0 2px;flex-shrink:0;";
      btn.textContent = "✓";
      btn.addEventListener("mouseenter", () => {
        btn.style.background = "#2d2e30";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.background = "#1e1f21";
      });

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        void this.handleRefreshClick(card, btn);
      });

      if (moreBtn) {
        moreBtn.insertAdjacentElement("beforebegin", btn);
      } else {
        actionsContainer.appendChild(btn);
      }

      // Ensure all buttons have consistent spacing
      btn.style.margin = "0 2px";
    }

    this.observer?.observe(document.body, { childList: true, subtree: true });
  }

  private async handleRefreshClick(card: Element, btn: HTMLButtonElement): Promise<void> {
    const artifactTitle = extractCardTitle(card);
    const activityType = inferActivityType(card);
    const notebookId = getNotebookId();
    const notebookTitle = getNotebookTitle();

    srsLog("refresh click", { artifactTitle, activityType, notebookId, notebookTitle });

    btn.disabled = true;
    btn.style.opacity = "0.5";

    const response = await sendMessage({
      type: "activity.completed",
      payload: {
        activityType,
        contentItemKey: notebookId,
        contentTitle: notebookTitle || artifactTitle,
        sourceUrl: location.href,
        detectedSignal: "manual-studio-refresh",
        occurredAt: Date.now(),
      },
    });

    srsLog("[DEBUG] activity.completed response:", JSON.stringify(response));
    if (response.ok) {
      srsLog("refresh success", { artifactTitle, activityType });
      btn.textContent = "✓";
      btn.style.color = "#15803d";
      
      if (this.homepageInjector) {
        srsLog("[DEBUG] calling homepageInjector.refresh() after activity.completed");
        await this.homepageInjector.refresh();
      }
      
      setTimeout(() => {
        btn.style.color = "#a8c7fa";
        btn.disabled = false;
        btn.style.opacity = "1";
      }, 1500);
    } else {
      console.warn(LOG_PREFIX, "refresh failed", response.error);
      btn.disabled = false;
      btn.style.opacity = "1";
    }
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
