import { DETECTION_DEBOUNCE_MS } from "../shared/constants";
import type {
  ActivityCompletedEvent,
  ActivityType,
  DashboardState,
  DashboardTimeline,
  ExtensionMessage,
  MessageResponse
} from "../shared/types";

const APP_HOST = "notebooklm.google.com";
const ROOT_ID = "notebooklm-srs-root";

async function start(): Promise<void> {
  const detector = new ActivityDetector();
  const panel = new SrsPanel();
  panel.mount();

  detector.onCompletion = async (event) => {
    await sendMessage({ type: "activity.completed", payload: event });
    await panel.refresh();
  };

  detector.start();
  await panel.refresh();
}

class ActivityDetector {
  onCompletion: ((event: ActivityCompletedEvent) => Promise<void>) | null = null;
  private observer: MutationObserver | null = null;
  private lastEmitAt: Record<string, number> = {};

  start(): void {
    this.bindAudioListeners();
    this.observer = new MutationObserver(() => {
      this.scan("mutation");
    });
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    window.addEventListener("popstate", () => this.scan("navigation"));
    window.addEventListener("hashchange", () => this.scan("navigation"));
    setInterval(() => this.scan("heartbeat"), 15000);
    this.scan("initial");
  }

  private bindAudioListeners(): void {
    document.addEventListener(
      "ended",
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLAudioElement || target instanceof HTMLVideoElement)) {
          return;
        }

        if (!this.detectActivityType().includes("podcast")) {
          return;
        }

        this.emit("podcast", "media-ended");
      },
      true
    );
  }

  private scan(signal: string): void {
    const activityTypes = this.detectActivityType();
    const text = this.safeTextSnapshot();

    for (const type of activityTypes) {
      if (this.isCompletionSignal(type, text)) {
        this.emit(type, `${signal}-keyword`);
      }
    }
  }

  private detectActivityType(): ActivityType[] {
    const value = `${location.pathname} ${location.search} ${document.title}`.toLowerCase();
    const matches: ActivityType[] = [];

    if (value.includes("quiz")) {
      matches.push("quiz");
    }

    if (value.includes("flashcard") || value.includes("cards")) {
      matches.push("flashcards");
    }

    if (value.includes("podcast") || value.includes("audio")) {
      matches.push("podcast");
    }

    if (matches.length > 0) {
      return matches;
    }

    const bodyText = this.safeTextSnapshot();
    if (containsAny(bodyText, ["quiz", "question", "score"])) {
      matches.push("quiz");
    }
    if (containsAny(bodyText, ["flashcard", "flip card", "card review"])) {
      matches.push("flashcards");
    }
    if (containsAny(bodyText, ["podcast", "audio overview", "listen"])) {
      matches.push("podcast");
    }

    return matches;
  }

  private safeTextSnapshot(): string {
    const slice = document.body?.innerText?.slice(0, 10000) ?? "";
    return slice.toLowerCase();
  }

  private isCompletionSignal(type: ActivityType, text: string): boolean {
    if (type === "quiz") {
      return containsAny(text, [
        "quiz complete",
        "quiz completed",
        "your score",
        "final score",
        "review answers"
      ]);
    }

    if (type === "flashcards") {
      return containsAny(text, [
        "flashcards complete",
        "session complete",
        "finished reviewing",
        "all cards reviewed"
      ]);
    }

    return containsAny(text, [
      "podcast complete",
      "audio complete",
      "finished listening",
      "listen again"
    ]);
  }

  private emit(activityType: ActivityType, signal: string): void {
    const contentTitle = deriveContentTitle(activityType);
    const contentItemKey = deriveContentItemKey(activityType, contentTitle);
    const dedupeKey = `${activityType}:${contentItemKey}`;
    const lastAt = this.lastEmitAt[dedupeKey] ?? 0;
    const current = Date.now();

    if (current - lastAt < DETECTION_DEBOUNCE_MS) {
      return;
    }

    this.lastEmitAt[dedupeKey] = current;

    const payload: ActivityCompletedEvent = {
      activityType,
      contentItemKey,
      contentTitle,
      sourceUrl: location.href,
      detectedSignal: signal,
      occurredAt: current
    };

    if (this.onCompletion) {
      void this.onCompletion(payload);
    }
  }
}

class SrsPanel {
  private host: HTMLElement | null = null;
  private shadow: ShadowRoot | null = null;
  private isCollapsed = false;
  private mainContainer: HTMLElement | null = null;
  private PANEL_WIDTH = 360;
  private COLLAPSED_WIDTH = 48;

  mount(): void {
    if (document.getElementById(ROOT_ID)) {
      return;
    }

    this.host = document.createElement("div");
    this.host.id = ROOT_ID;
    this.host.style.position = "fixed";
    this.host.style.zIndex = "1";
    this.host.style.top = "64px";
    this.host.style.left = "0";
    this.host.style.height = "calc(100vh - 64px)";

    this.shadow = this.host.attachShadow({ mode: "open" });
    this.shadow.innerHTML = this.template();

    document.body.appendChild(this.host);

    this.mainContainer = this.findMainContainer();
    this.updatePageMargin();

    this.bindActions();
    this.bindThemeObserver();
  }

  private findMainContainer(): HTMLElement | null {
    const selectors = [
      "[class*='main-content']",
      "[class*='content']",
      "main",
      "[role='main']",
      "[class*='workspace']",
      "[class*='notebook']",
      "[class*='editor']",
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector) as HTMLElement;
      if (el && el.offsetWidth > 200) {
        return el;
      }
    }

    return null;
  }

  private updatePageMargin(): void {
    const margin = this.isCollapsed ? this.COLLAPSED_WIDTH : this.PANEL_WIDTH;

    if (this.mainContainer) {
      this.mainContainer.style.marginLeft = `${margin}px`;
      this.mainContainer.style.transition = "margin-left 0.2s ease";
    } else {
      document.body.style.marginLeft = `${margin}px`;
      document.body.style.transition = "margin-left 0.2s ease";
    }
  }

  private bindThemeObserver(): void {
    const updateTheme = () => {
      const isDark = document.documentElement.classList.contains("dark") ||
                     document.body.classList.contains("dark") ||
                     window.matchMedia("(prefers-color-scheme: dark)").matches;
      if (this.host) {
        this.host.setAttribute("data-theme", isDark ? "dark" : "light");
      }
    };

    updateTheme();
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateTheme);

    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }

  private toggleCollapse(): void {
    this.isCollapsed = !this.isCollapsed;
    if (this.host) {
      this.host.setAttribute("data-collapsed", String(this.isCollapsed));
    }
    this.updatePageMargin();
  }

  async refresh(): Promise<void> {
    if (!this.shadow) {
      return;
    }

    const response = await sendMessage({ type: "dashboard.get" });
    if (!response.ok || !response.data) {
      this.setStatus(response.error ?? "Failed to load state");
      return;
    }

    const { data } = response;
    this.renderDashboard(data);
  }

  private bindActions(): void {
    if (!this.shadow) {
      return;
    }

    const refreshButton = this.shadow.querySelector<HTMLButtonElement>("#srs-refresh");
    const saveIntervalsButton = this.shadow.querySelector<HTMLButtonElement>("#srs-save-intervals");
    const clearButton = this.shadow.querySelector<HTMLButtonElement>("#srs-clear-all");
    const collapseButton = this.shadow.querySelector<HTMLButtonElement>("#srs-collapse");

    refreshButton?.addEventListener("click", () => {
      void this.refresh();
    });

    saveIntervalsButton?.addEventListener("click", () => {
      void this.updateIntervals();
    });

    clearButton?.addEventListener("click", () => {
      const confirmed = confirm("Clear all spaced repetition timelines?");
      if (!confirmed) {
        return;
      }
      void this.clearAll();
    });

    collapseButton?.addEventListener("click", () => {
      this.toggleCollapse();
    });

    this.shadow.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const deleteId = target.dataset.deleteTimeline;
      if (!deleteId) {
        return;
      }

      void this.deleteTimeline(deleteId);
    });
  }

  private async updateIntervals(): Promise<void> {
    if (!this.shadow) {
      return;
    }

    const input = this.shadow.querySelector<HTMLInputElement>("#srs-intervals");
    if (!input) {
      return;
    }

    const parsed = input.value
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => Math.floor(value));

    const response = await sendMessage({
      type: "settings.updateIntervals",
      payload: { intervalDays: parsed }
    });

    if (!response.ok || !response.data) {
      this.setStatus(response.error ?? "Failed to update intervals.");
      return;
    }

    this.renderDashboard(response.data);
    this.setStatus("Intervals updated.");
  }

  private async deleteTimeline(timelineId: string): Promise<void> {
    const response = await sendMessage({
      type: "timeline.delete",
      payload: { timelineId }
    });

    if (!response.ok || !response.data) {
      this.setStatus(response.error ?? "Failed to delete timeline.");
      return;
    }

    this.renderDashboard(response.data);
  }

  private async clearAll(): Promise<void> {
    const response = await sendMessage({ type: "timeline.clearAll" });
    if (!response.ok || !response.data) {
      this.setStatus(response.error ?? "Failed to clear timelines.");
      return;
    }

    this.renderDashboard(response.data);
  }

  private renderDashboard(data: DashboardState): void {
    if (!this.shadow) {
      return;
    }

    const input = this.shadow.querySelector<HTMLInputElement>("#srs-intervals");
    if (input) {
      input.value = data.settings.intervalDays.join(", ");
    }

    this.renderList("#srs-due", data.due, "No due reviews.");
    this.renderList("#srs-overdue", data.overdue, "No overdue reviews.");
    this.renderList("#srs-upcoming", data.upcoming, "No upcoming reviews.");

    this.setText("#srs-total", String(data.totalTimelines));
    this.setStatus(`Updated ${new Date().toLocaleTimeString()}`);
  }

  private renderList(selector: string, items: DashboardTimeline[], empty: string): void {
    if (!this.shadow) {
      return;
    }

    const element = this.shadow.querySelector(selector);
    if (!element) {
      return;
    }

    if (items.length === 0) {
      element.innerHTML = `<li class="empty">${empty}</li>`;
      return;
    }

    element.innerHTML = items
      .map(
        (item) =>
          `<li>
            <div class="line1">${escapeHtml(item.contentTitle)}</div>
            <div class="line2">${item.activityType} · due ${new Date(item.nextDueAt).toLocaleString()}</div>
            <div class="line3">
              <a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">Open</a>
              <button data-delete-timeline="${escapeHtml(item.id)}">Delete</button>
            </div>
          </li>`
      )
      .join("");
  }

  private setText(selector: string, value: string): void {
    const element = this.shadow?.querySelector(selector);
    if (element) {
      element.textContent = value;
    }
  }

  private setStatus(value: string): void {
    this.setText("#srs-status", value);
  }

  private template(): string {
    return `
      <style>
        :host {
          display: block;
        }
        .panel {
          width: 360px;
          height: calc(100vh - 64px);
          overflow: hidden;
          display: flex;
          flex-direction: column;
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
          transition: width 0.2s ease;
          box-shadow: 2px 0 12px rgba(0, 0, 0, 0.1);
        }
        :host([data-theme="dark"]) .panel {
          box-shadow: 2px 0 12px rgba(0, 0, 0, 0.3);
        }
        :host([data-collapsed="true"]) .panel {
          width: 48px;
        }
        :host([data-collapsed="true"]) .panel-body,
        :host([data-collapsed="true"]) .panel-footer {
          display: none;
        }
        .drag-handle {
          padding: 10px 12px;
          display: flex;
          align-items: center;
          gap: 8px;
          border-bottom: 1px solid;
          user-select: none;
          flex-shrink: 0;
        }
        :host([data-theme="light"]) .drag-handle {
          background: #f8fafc;
          border-color: #e2e8f0;
        }
        :host([data-theme="dark"]) .drag-handle {
          background: #202124;
          border-color: #3c4043;
        }
        :host([data-collapsed="true"]) .drag-handle {
          justify-content: center;
          padding: 10px;
        }
        .drag-handle .title-group {
          flex: 1;
          min-width: 0;
        }
        :host([data-collapsed="true"]) .drag-handle .title-group {
          display: none;
        }
        .title {
          font-size: 13px;
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        :host([data-theme="light"]) .title {
          color: #0f172a;
        }
        :host([data-theme="dark"]) .title {
          color: #e8eaed;
        }
        .meta {
          font-size: 11px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        :host([data-theme="light"]) .meta {
          color: #64748b;
        }
        :host([data-theme="dark"]) .meta {
          color: #9aa0a6;
        }
        .collapse-btn {
          width: 28px;
          height: 28px;
          border: none;
          border-radius: 6px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          flex-shrink: 0;
        }
        :host([data-theme="light"]) .collapse-btn {
          background: #e2e8f0;
          color: #475569;
        }
        :host([data-theme="light"]) .collapse-btn:hover {
          background: #cbd5e1;
        }
        :host([data-theme="dark"]) .collapse-btn {
          background: #303134;
          color: #e8eaed;
        }
        :host([data-theme="dark"]) .collapse-btn:hover {
          background: #3c4043;
        }
        .panel-body {
          flex: 1;
          overflow-y: auto;
        }
        :host([data-theme="light"]) .panel-body {
          background: #ffffff;
        }
        :host([data-theme="dark"]) .panel-body {
          background: #1f1f1f;
        }
        .section {
          padding: 12px;
          border-bottom: 1px solid;
        }
        :host([data-theme="light"]) .section {
          border-color: #f1f5f9;
        }
        :host([data-theme="dark"]) .section {
          border-color: #2d2e30;
        }
        .section h4 {
          margin: 0 0 8px;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        :host([data-theme="light"]) .section h4 {
          color: #64748b;
        }
        :host([data-theme="dark"]) .section h4 {
          color: #9aa0a6;
        }
        ul {
          list-style: none;
          margin: 0;
          padding: 0;
        }
        li {
          padding: 8px;
          border: 1px solid;
          border-radius: 8px;
          margin-bottom: 8px;
        }
        :host([data-theme="light"]) li {
          background: #ffffff;
          border-color: #e2e8f0;
        }
        :host([data-theme="dark"]) li {
          background: #2d2e30;
          border-color: #3c4043;
        }
        .empty {
          border-style: dashed;
          font-size: 12px;
        }
        :host([data-theme="light"]) .empty {
          color: #94a3b8;
          background: #f8fafc;
        }
        :host([data-theme="dark"]) .empty {
          color: #5f6368;
          background: #2d2e30;
        }
        .line1 {
          font-size: 12px;
          font-weight: 600;
        }
        :host([data-theme="light"]) .line1 {
          color: #0f172a;
        }
        :host([data-theme="dark"]) .line1 {
          color: #e8eaed;
        }
        .line2 {
          margin-top: 4px;
          font-size: 11px;
        }
        :host([data-theme="light"]) .line2 {
          color: #64748b;
        }
        :host([data-theme="dark"]) .line2 {
          color: #9aa0a6;
        }
        .line3 {
          margin-top: 6px;
          display: flex;
          gap: 6px;
        }
        .line3 a {
          font-size: 11px;
          text-decoration: none;
          border-radius: 4px;
          padding: 3px 6px;
        }
        :host([data-theme="light"]) .line3 a {
          color: #0369a1;
          background: #e0f2fe;
        }
        :host([data-theme="dark"]) .line3 a {
          color: #8ab4f8;
          background: #1f1f1f;
        }
        .line3 button {
          font-size: 11px;
          border: 1px solid;
          border-radius: 4px;
          padding: 3px 6px;
          cursor: pointer;
        }
        :host([data-theme="light"]) .line3 button {
          background: #fef2f2;
          border-color: #fca5a5;
          color: #be123c;
        }
        :host([data-theme="light"]) .line3 button:hover {
          background: #fee2e2;
        }
        :host([data-theme="dark"]) .line3 button {
          background: #3c2b2b;
          border-color: #5f4b4b;
          color: #f28b82;
        }
        :host([data-theme="dark"]) .line3 button:hover {
          background: #5f4b4b;
        }
        .controls {
          display: grid;
          gap: 8px;
        }
        .controls .row {
          display: flex;
          gap: 6px;
        }
        input {
          flex: 1;
          border: 1px solid;
          border-radius: 6px;
          padding: 6px 8px;
          font-size: 12px;
        }
        :host([data-theme="light"]) input {
          background: #ffffff;
          border-color: #cbd5e1;
          color: #0f172a;
        }
        :host([data-theme="light"]) input::placeholder {
          color: #94a3b8;
        }
        :host([data-theme="dark"]) input {
          background: #2d2e30;
          border-color: #3c4043;
          color: #e8eaed;
        }
        :host([data-theme="dark"]) input::placeholder {
          color: #5f6368;
        }
        button.main {
          border: 1px solid;
          border-radius: 6px;
          padding: 6px 10px;
          font-size: 12px;
          cursor: pointer;
        }
        :host([data-theme="light"]) button.main {
          background: #eff6ff;
          border-color: #93c5fd;
          color: #1d4ed8;
        }
        :host([data-theme="light"]) button.main:hover {
          background: #dbeafe;
        }
        :host([data-theme="dark"]) button.main {
          background: #1f1f1f;
          border-color: #5f6368;
          color: #8ab4f8;
        }
        :host([data-theme="dark"]) button.main:hover {
          background: #2d2e30;
        }
        .panel-footer {
          padding: 8px 12px;
          font-size: 10px;
          border-top: 1px solid;
        }
        :host([data-theme="light"]) .panel-footer {
          color: #94a3b8;
          background: #f8fafc;
          border-color: #e2e8f0;
        }
        :host([data-theme="dark"]) .panel-footer {
          color: #9aa0a6;
          background: #202124;
          border-color: #3c4043;
        }
      </style>
      <div class="panel">
        <div class="drag-handle">
          <div class="title-group">
            <div class="title">NotebookLM Spaced Repetition</div>
            <div class="meta">Tracked: <span id="srs-total">0</span></div>
          </div>
          <button class="collapse-btn" id="srs-collapse" title="Toggle panel">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 19l-7-7 7-7m8 14l-7-7 7-7"/>
            </svg>
          </button>
        </div>

        <div class="panel-body">
          <div class="section controls">
            <h4>Intervals (days)</h4>
            <div class="row">
              <input id="srs-intervals" type="text" placeholder="1, 7, 14, 30" />
              <button class="main" id="srs-save-intervals">Save</button>
            </div>
            <div class="row">
              <button class="main" id="srs-refresh">Refresh</button>
              <button class="main" id="srs-clear-all">Clear All</button>
            </div>
          </div>

          <div class="section">
            <h4>Due Now</h4>
            <ul id="srs-due"></ul>
          </div>

          <div class="section">
            <h4>Overdue</h4>
            <ul id="srs-overdue"></ul>
          </div>

          <div class="section">
            <h4>Upcoming</h4>
            <ul id="srs-upcoming"></ul>
          </div>
        </div>

        <div class="panel-footer" id="srs-status">Ready</div>
      </div>
    `;
  }
}

async function sendMessage(message: ExtensionMessage): Promise<MessageResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response: MessageResponse | undefined) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response ?? { ok: false, error: "No response" });
    });
  });
}

function deriveContentTitle(activityType: ActivityType): string {
  const heading =
    document.querySelector("h1")?.textContent?.trim() ||
    document.querySelector("[role='heading']")?.textContent?.trim() ||
    document.title;
  if (heading.length > 0) {
    return heading;
  }
  return `${activityType} activity`;
}

function deriveContentItemKey(activityType: ActivityType, contentTitle: string): string {
  const url = new URL(location.href);
  const idCandidate =
    url.searchParams.get("id") ||
    url.searchParams.get("note") ||
    url.searchParams.get("resource") ||
    findPathId(url.pathname);

  if (idCandidate) {
    return stableHash(`${activityType}:${idCandidate}`);
  }

  return stableHash(`${activityType}:${contentTitle.toLowerCase().trim()}:${url.pathname}`);
}

function findPathId(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  for (const part of parts) {
    if (part.length >= 12 && /[a-z0-9_-]{12,}/i.test(part)) {
      return part;
    }
  }
  return null;
}

function containsAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

if (location.host === APP_HOST) {
  start().catch((error) => {
    console.error("NotebookLM SRS extension failed to initialize", error);
  });
}
