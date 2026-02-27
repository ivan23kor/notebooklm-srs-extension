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
  private isDragging = false;
  private dragOffsetX = 0;
  private dragOffsetY = 0;

  mount(): void {
    if (document.getElementById(ROOT_ID)) {
      return;
    }

    this.host = document.createElement("div");
    this.host.id = ROOT_ID;
    this.host.style.position = "fixed";
    this.host.style.zIndex = "2147483647";
    this.host.style.left = "16px";
    this.host.style.bottom = "220px";

    this.shadow = this.host.attachShadow({ mode: "open" });
    this.shadow.innerHTML = this.template();

    document.body.appendChild(this.host);
    this.bindActions();
    this.bindDrag();
  }

  private bindDrag(): void {
    const header = this.shadow?.querySelector<HTMLElement>(".header");
    if (!header || !this.host) {
      return;
    }

    header.style.cursor = "grab";

    header.addEventListener("mousedown", (event: MouseEvent) => {
      if (!this.host) return;
      this.isDragging = true;
      header.style.cursor = "grabbing";
      const rect = this.host.getBoundingClientRect();
      this.dragOffsetX = event.clientX - rect.left;
      this.dragOffsetY = event.clientY - rect.top;
      event.preventDefault();
    });

    document.addEventListener("mousemove", (event: MouseEvent) => {
      if (!this.isDragging || !this.host) return;
      const x = event.clientX - this.dragOffsetX;
      const y = event.clientY - this.dragOffsetY;
      this.host.style.left = `${x}px`;
      this.host.style.top = `${y}px`;
      this.host.style.right = "auto";
      this.host.style.bottom = "auto";
    });

    document.addEventListener("mouseup", () => {
      if (!this.isDragging) return;
      this.isDragging = false;
      if (header) header.style.cursor = "grab";
    });
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
        .panel {
          width: 360px;
          max-height: 80vh;
          overflow: auto;
          border-radius: 12px;
          border: 1px solid #d8dee9;
          background: #fbfcfe;
          box-shadow: 0 12px 32px rgba(33, 45, 72, 0.24);
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
          color: #111827;
        }
        .header {
          padding: 12px 14px;
          border-bottom: 1px solid #e5e7eb;
          background: linear-gradient(135deg, #f3f9ff, #eefbf5);
          user-select: none;
        }
        .title {
          font-size: 14px;
          font-weight: 700;
        }
        .meta {
          font-size: 12px;
          color: #4b5563;
          margin-top: 4px;
        }
        .section {
          padding: 10px 14px;
          border-bottom: 1px solid #f0f2f6;
        }
        .section h4 {
          margin: 0 0 8px;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.03em;
          color: #374151;
        }
        ul {
          list-style: none;
          margin: 0;
          padding: 0;
        }
        li {
          padding: 8px;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          background: white;
          margin-bottom: 8px;
        }
        .empty {
          border-style: dashed;
          color: #6b7280;
          background: #f9fafb;
        }
        .line1 {
          font-size: 13px;
          font-weight: 600;
        }
        .line2 {
          margin-top: 4px;
          font-size: 12px;
          color: #4b5563;
        }
        .line3 {
          margin-top: 7px;
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .line3 a {
          font-size: 12px;
          color: #0f62fe;
          text-decoration: none;
        }
        .line3 button {
          font-size: 12px;
          border: 1px solid #fca5a5;
          background: #fff1f2;
          color: #9f1239;
          border-radius: 6px;
          padding: 2px 8px;
          cursor: pointer;
        }
        .controls {
          display: grid;
          gap: 8px;
        }
        .controls .row {
          display: flex;
          gap: 8px;
        }
        input {
          flex: 1;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          padding: 6px 8px;
          font-size: 12px;
        }
        button.main {
          border: 1px solid #bfdbfe;
          background: #eff6ff;
          color: #1d4ed8;
          border-radius: 8px;
          padding: 6px 8px;
          font-size: 12px;
          cursor: pointer;
        }
        .footer {
          padding: 8px 14px;
          font-size: 11px;
          color: #6b7280;
        }
      </style>
      <div class="panel">
        <div class="header">
          <div class="title">NotebookLM Spaced Repetition</div>
          <div class="meta">Tracked timelines: <span id="srs-total">0</span></div>
        </div>

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

        <div class="footer" id="srs-status">Ready</div>
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
