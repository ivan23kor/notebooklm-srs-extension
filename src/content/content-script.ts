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
const LOG_PREFIX = "[SRS]";

function srsLog(...args: unknown[]): void {
  console.debug(LOG_PREFIX, ...args);
}

async function start(): Promise<void> {
  srsLog("init", location.href);
  const detector = new ActivityDetector();
  const panel = new SrsPanel();
  panel.mount();
  srsLog("panel mounted");

  detector.onCompletion = async (event) => {
    srsLog("completion", event.activityType, event.detectedSignal);
    await sendMessage({ type: "activity.completed", payload: event });
    await panel.refresh();
  };

  detector.start();
  srsLog("detector started");
  await panel.refresh();
  srsLog("ready");
}

class FloatingCompleteButton {
  private host: HTMLElement | null = null;
  private shadow: ShadowRoot | null = null;
  private currentType: ActivityType | null = null;
  private onManualComplete: ((type: ActivityType) => Promise<void>) | null = null;
  private isSubmitting = false;
  private feedbackResetTimer: number | null = null;

  constructor(onComplete: (type: ActivityType) => Promise<void>) {
    this.onManualComplete = onComplete;
  }

  mount(): void {
    if (document.getElementById("notebooklm-srs-float-btn")) {
      return;
    }

    this.host = document.createElement("div");
    this.host.id = "notebooklm-srs-float-btn";
    this.host.style.cssText = "position:fixed;bottom:24px;right:24px;z-index:9999;";
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.shadow.innerHTML = this.template();

    document.body.appendChild(this.host);
    {
      const button = this.shadow.querySelector<HTMLButtonElement>("#srs-float-complete");
      button?.addEventListener("click", async () => {
        if (!this.currentType || !this.onManualComplete || this.isSubmitting) {
          return;
        }
        this.setButtonState("loading");
        this.isSubmitting = true;
        try {
          await this.onManualComplete(this.currentType);
          this.setButtonState("success");
        } catch {
          this.setButtonState("idle");
        } finally {
          this.isSubmitting = false;
        }
      });
    }
    this.hide();
  }

  show(type: ActivityType): void {
    this.currentType = type;
    if (this.host) {
      this.host.style.display = "block";
      if (!this.isSubmitting) {
        this.setButtonState("idle");
      }
    }
  }

  hide(): void {
    if (this.host) {
      this.host.style.display = "none";
    }
  }

  private template(): string {
    return `
      <style>
        :host {
          display: block;
        }
        .float-btn {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 16px;
          border-radius: 24px;
          border: none;
          cursor: pointer;
          font-family: ui-sans-serif, system-ui, sans-serif;
          font-size: 13px;
          font-weight: 500;
          box-shadow: 0 4px 12px rgba(0,0,0,0.15);
          transition: transform 0.2s, box-shadow 0.2s;
        }
        .float-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 16px rgba(0,0,0,0.2);
        }
        @media (prefers-color-scheme: dark) {
          .float-btn {
            background: #8ab4f8;
            color: #202124;
          }
        }
        @media (prefers-color-scheme: light) {
          .float-btn {
            background: #2563eb;
            color: #ffffff;
          }
        }
      </style>
      <button class="float-btn" id="srs-float-complete">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        <span id="srs-float-label">Mark complete</span>
      </button>
    `;
  }

  private setButtonState(state: "idle" | "loading" | "success"): void {
    const button = this.shadow?.querySelector<HTMLButtonElement>("#srs-float-complete");
    const label = this.shadow?.querySelector<HTMLElement>("#srs-float-label");
    if (!button || !label) {
      return;
    }

    if (this.feedbackResetTimer) {
      window.clearTimeout(this.feedbackResetTimer);
      this.feedbackResetTimer = null;
    }

    if (state === "loading") {
      button.disabled = true;
      button.style.opacity = "0.8";
      label.textContent = "Saving…";
      return;
    }

    button.disabled = false;
    button.style.opacity = "1";

    if (state === "success") {
      label.textContent = "Marked ✓";
      this.feedbackResetTimer = window.setTimeout(() => {
        this.setButtonState("idle");
      }, 1200);
      return;
    }

    label.textContent = this.currentType ? `Mark ${this.currentType} complete` : "Mark complete";
  }
}

class ActivityDetector {
  onCompletion: ((event: ActivityCompletedEvent) => Promise<void>) | null = null;
  private observer: MutationObserver | null = null;
  private lastEmitAt: Record<string, number> = {};
  private floatButton: FloatingCompleteButton | null = null;
  private scanPending = false;

  constructor() {
    this.floatButton = new FloatingCompleteButton(async (type) => {
      await this.emitAndWait(type, "manual-float");
    });
  }

  start(): void {
    if (!this.floatButton) return;
    this.floatButton.mount();
    this.bindAudioListeners();
    this.observer = new MutationObserver(() => {
      this.scheduleScan("mutation");
    });
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    window.addEventListener("popstate", () => this.scheduleScan("navigation"));
    window.addEventListener("hashchange", () => this.scheduleScan("navigation"));
    setInterval(() => this.scan("heartbeat"), 15000);
    this.scan("initial");
  }

  private scheduleScan(signal: string): void {
    if (this.scanPending) {
      return;
    }
    this.scanPending = true;
    setTimeout(() => {
      this.scanPending = false;
      this.scan(signal);
    }, 500);
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

    if (activityTypes.length === 0) {
      if (this.floatButton) {
        this.floatButton.hide();
      }
      return;
    }

    // Only read innerText when we have a detected activity type (expensive reflow)
    const text = this.safeTextSnapshot();
    for (const type of activityTypes) {
      if (this.isCompletionSignal(type, text)) {
        srsLog("signal", type, signal);
        this.emit(type, `${signal}-keyword`);
      }
    }

    if (this.floatButton) {
      this.floatButton.show(activityTypes[0]!);
    }
  }

  private detectActivityType(): ActivityType[] {
    // Fast path: check URL and title only (no DOM access)
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

    // Only fall back to body text scan on heartbeat (every 15s),
    // never on mutation — innerText forces synchronous reflow
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
    const payload = this.buildEventPayload(activityType, signal);
    if (!payload) {
      return;
    }

    if (this.onCompletion) {
      void this.onCompletion(payload);
    }
  }

  private async emitAndWait(activityType: ActivityType, signal: string): Promise<void> {
    const payload = this.buildEventPayload(activityType, signal);
    if (!payload) {
      return;
    }
    if (this.onCompletion) {
      await this.onCompletion(payload);
    }
  }

  private buildEventPayload(activityType: ActivityType, signal: string): ActivityCompletedEvent | null {
    const contentTitle = deriveContentTitle(activityType);
    const contentItemKey = deriveContentItemKey(activityType, contentTitle);
    const dedupeKey = `${activityType}:${contentItemKey}`;
    const lastAt = this.lastEmitAt[dedupeKey] ?? 0;
    const current = Date.now();

    if (current - lastAt < DETECTION_DEBOUNCE_MS) {
      return null;
    }

    this.lastEmitAt[dedupeKey] = current;

    return {
      activityType,
      contentItemKey,
      contentTitle,
      sourceUrl: location.href,
      detectedSignal: signal,
      occurredAt: current
    };
  }
}

class SrsPanel {
  private host: HTMLElement | null = null;
  private shadow: ShadowRoot | null = null;
  private isCollapsed = false;
  private mainContainer: HTMLElement | null = null;
  private notebookTableObserver: MutationObserver | null = null;
  private latestDashboardState: DashboardState | null = null;
  private timerSyncPending = false;
  private PANEL_WIDTH = 180;
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
    this.bindNotebookTableObserver();
  }

  private findMainContainer(): HTMLElement | null {
    const selectors = [
      "body > div",
      "[class*='main']",
      "[class*='workspace']",
      "[class*='notebook']",
      "[class*='editor']",
      "[class*='container']",
      "main",
      "[role='main']",
    ];

    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (rect.width > 300 && rect.left < 50) {
          return el as HTMLElement;
        }
      }
    }

    return document.body;
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
    const completeQuizButton = this.shadow.querySelector<HTMLButtonElement>("#srs-complete-quiz");
    const completeFlashcardsButton = this.shadow.querySelector<HTMLButtonElement>("#srs-complete-flashcards");
    const completePodcastButton = this.shadow.querySelector<HTMLButtonElement>("#srs-complete-podcast");

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

    completeQuizButton?.addEventListener("click", () => {
      void this.manualComplete("quiz");
    });

    completeFlashcardsButton?.addEventListener("click", () => {
      void this.manualComplete("flashcards");
    });

    completePodcastButton?.addEventListener("click", () => {
      void this.manualComplete("podcast");
    });

    this.shadow.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      // Find button elements in the click path (handles clicks on button children)
      const completeBtn = target.closest<HTMLElement>("button[data-complete]");
      if (completeBtn) {
        event.preventDefault();
        event.stopPropagation();
        const timelineId = completeBtn.dataset.complete;
        if (timelineId) {
          void this.completeTimelineById(timelineId);
        }
        return;
      }

      const deleteBtn = target.closest<HTMLElement>("button[data-delete-notebook]");
      if (deleteBtn) {
        event.preventDefault();
        event.stopPropagation();
        const deleteNotebookIds = deleteBtn.dataset.deleteNotebook;
        if (deleteNotebookIds && confirm("Delete all activities for this notebook?")) {
          const ids = deleteNotebookIds.split(",");
          void this.deleteNotebooks(ids);
        }
        return;
      }

      const card = target.closest<HTMLElement>("li[data-open-url]");
      if (card && target.tagName !== "BUTTON") {
        const url = card.dataset.openUrl;
        if (url) {
          window.open(url, "_blank");
        }
      }
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

  private async completeTimelineById(timelineId: string): Promise<void> {
    const response = await sendMessage({ type: "timeline.complete", payload: { timelineId } });
    if (!response.ok) {
      this.setStatus(response.error ?? "Failed to mark complete");
      return;
    }

    await this.refresh();
    this.setStatus("Completed");
  }

  private async deleteNotebooks(timelineIds: string[]): Promise<void> {
    if (timelineIds.length === 0) return;
    // Delete first timeline
    const firstId = timelineIds[0]!;
    const response = await sendMessage({
      type: "timeline.delete",
      payload: { timelineId: firstId }
    });

    if (!response.ok || !response.data) {
      this.setStatus(response.error ?? "Failed to delete timeline.");
      return;
    }

    // Delete remaining timelines
    for (const id of timelineIds.slice(1)) {
      await sendMessage({
        type: "timeline.delete",
        payload: { timelineId: id }
      });
    }

    // Refresh once at the end
    await this.refresh();
    this.setStatus("Deleted notebook activities.");
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

  private async manualComplete(activityType: ActivityType): Promise<void> {
    const contentTitle = deriveContentTitle(activityType);
    const contentItemKey = deriveContentItemKey(activityType, contentTitle);

    const event: ActivityCompletedEvent = {
      activityType,
      contentItemKey,
      contentTitle,
      sourceUrl: location.href,
      detectedSignal: "manual",
      occurredAt: Date.now()
    };

    await sendMessage({ type: "activity.completed", payload: event });
    await this.refresh();
    this.setStatus(`Marked ${activityType} complete.`);
  }

  private renderDashboard(data: DashboardState): void {
    if (!this.shadow) {
      return;
    }

    const input = this.shadow.querySelector<HTMLInputElement>("#srs-intervals");
    if (input) {
      input.value = data.settings.intervalDays.join(", ");
    }

    // Combine all timelines and group by notebook
    const allItems = [...data.due, ...data.overdue, ...data.upcoming];
    const notebooks = this.groupByNotebook(allItems);
    this.latestDashboardState = data;
    this.renderNotebookList(notebooks);
    this.syncNotebookTimerColumn();

    this.setText("#srs-total", String(data.totalTimelines));
    this.setStatus(`Updated ${new Date().toLocaleTimeString()}`);
  }

  private groupByNotebook(items: DashboardTimeline[]): Map<string, DashboardTimeline[]> {
    const notebooks = new Map<string, DashboardTimeline[]>();
    for (const item of items) {
      const existing = notebooks.get(item.contentTitle) ?? [];
      existing.push(item);
      notebooks.set(item.contentTitle, existing);
    }
    return notebooks;
  }

  private formatTimeStatus(item: DashboardTimeline): string {
    const now = Date.now();
    const elapsedHours = Math.floor((now - item.lastCompletionAt) / (60 * 60 * 1000));
    const remainingHours = Math.floor((item.nextDueAt - now) / (60 * 60 * 1000));

    if (item.status === "overdue") {
      return `${elapsedHours}h elapsed, ${Math.abs(remainingHours)}h overdue`;
    }
    if (item.status === "due") {
      return `${elapsedHours}h elapsed, due now`;
    }
    return `${elapsedHours}h elapsed, ${remainingHours}h remaining`;
  }

  private formatTimerColumn(item: DashboardTimeline): string {
    const now = Date.now();
    if (item.status === "overdue") {
      const overdueHours = Math.max(1, Math.floor((now - item.nextDueAt) / (60 * 60 * 1000)));
      return `${overdueHours}h overdue`;
    }
    if (item.status === "due") {
      return "Due now";
    }
    const remainingMs = Math.max(0, item.nextDueAt - now);
    const remainingHours = Math.floor(remainingMs / (60 * 60 * 1000));
    if (remainingHours <= 0) {
      return "<1h";
    }
    return `${remainingHours}h`;
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
      this.syncNotebookTimerColumn();
    });
  }

  private syncNotebookTimerColumn(): void {
    if (!this.latestDashboardState) {
      return;
    }

    const table = this.findNotebookTable();
    if (!table) {
      return;
    }

    const headerRow = this.getHeaderRow(table);
    if (!headerRow) {
      return;
    }

    // Disconnect observer while we write to avoid feedback loop
    this.notebookTableObserver?.disconnect();

    let timerHeader = headerRow.querySelector<HTMLTableCellElement>("th[data-srs-timer-header='true']");
    if (!timerHeader) {
      timerHeader = document.createElement("th");
      timerHeader.dataset.srsTimerHeader = "true";
      timerHeader.textContent = "Timer";
      headerRow.appendChild(timerHeader);
    }

    const notebookMap = this.getNotebookTimerMap(this.latestDashboardState);
    const bodyRows = Array.from(table.tBodies).flatMap((body) => Array.from(body.rows));
    for (const row of bodyRows) {
      const title = row.cells.item(0)?.textContent?.trim().toLowerCase() ?? "";
      const timerInfo = notebookMap.get(title);
      let timerCell = row.querySelector<HTMLTableCellElement>("td[data-srs-timer-cell='true']");
      if (!timerCell) {
        timerCell = row.insertCell(-1);
        timerCell.dataset.srsTimerCell = "true";
      }
      timerCell.textContent = timerInfo?.label ?? "—";
      timerCell.style.whiteSpace = "nowrap";
      timerCell.style.fontWeight = timerInfo && (timerInfo.status === "overdue" || timerInfo.status === "due") ? "600" : "400";
    }

    // Reconnect observer
    this.notebookTableObserver?.observe(document.body, { childList: true, subtree: true });
  }

  private findNotebookTable(): HTMLTableElement | null {
    const tables = Array.from(document.querySelectorAll("table"));
    for (const table of tables) {
      const headerRow = this.getHeaderRow(table);
      if (!headerRow) {
        continue;
      }
      const headerText = headerRow.textContent?.toLowerCase() ?? "";
      if (
        headerText.includes("title") &&
        headerText.includes("sources") &&
        headerText.includes("created") &&
        headerText.includes("role")
      ) {
        return table;
      }
    }
    return null;
  }

  private getHeaderRow(table: HTMLTableElement): HTMLTableRowElement | null {
    if (table.tHead?.rows.length) {
      return table.tHead.rows[0] ?? null;
    }
    const firstRow = table.querySelector("tr");
    return firstRow instanceof HTMLTableRowElement ? firstRow : null;
  }

  private getNotebookTimerMap(data: DashboardState): Map<string, { label: string; status: DashboardTimeline["status"] }> {
    const map = new Map<string, { label: string; status: DashboardTimeline["status"]; score: number; nextDueAt: number }>();
    const items = [...data.overdue, ...data.due, ...data.upcoming];
    const scoreForStatus = (status: DashboardTimeline["status"]): number => {
      if (status === "overdue") return 0;
      if (status === "due") return 1;
      return 2;
    };

    for (const item of items) {
      const key = item.contentTitle.trim().toLowerCase();
      const existing = map.get(key);
      const score = scoreForStatus(item.status);
      const shouldReplace =
        !existing || score < existing.score || (score === existing.score && item.nextDueAt < existing.nextDueAt);

      if (shouldReplace) {
        map.set(key, {
          label: this.formatTimerColumn(item),
          status: item.status,
          score,
          nextDueAt: item.nextDueAt
        });
      }
    }

    return new Map(Array.from(map.entries()).map(([key, value]) => [key, { label: value.label, status: value.status }]));
  }

  private renderNotebookList(notebooks: Map<string, DashboardTimeline[]>): void {
    if (!this.shadow) {
      return;
    }

    const element = this.shadow.querySelector("#srs-notebooks");
    if (!element) {
      return;
    }

    if (notebooks.size === 0) {
      element.innerHTML = `<li class="empty">No notebooks tracked.</li>`;
      return;
    }

    const sortedEntries = Array.from(notebooks.entries()).sort((a, b) => {
      const aEarliest = Math.min(...a[1].map(i => i.nextDueAt));
      const bEarliest = Math.min(...b[1].map(i => i.nextDueAt));
      return aEarliest - bEarliest;
    });

    element.innerHTML = sortedEntries
      .map(([title, items]) => {
        const activityRows = items.map(item =>
          `<div class="activity-row">
            <span class="activity-type">${item.activityType}</span>
            <span class="activity-time">${this.formatTimeStatus(item)}</span>
            <button class="complete-btn" data-complete="${escapeHtml(item.id)}">Complete</button>
          </div>`
        ).join("");

        const firstItem = items[0]!;
        const timelineIds = items.map(i => i.id).join(",");

        return `<li data-open-url="${escapeHtml(firstItem.sourceUrl)}" data-timeline-ids="${escapeHtml(timelineIds)}">
            <div class="line1">${escapeHtml(title)}</div>
            <div class="activities">${activityRows}</div>
            <div class="line3">
              <button data-delete-notebook="${escapeHtml(timelineIds)}">Delete</button>
            </div>
          </li>`;
      })
      .join("");
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
          `<li data-open-url="${escapeHtml(item.sourceUrl)}">
            <div class="line1">${escapeHtml(item.contentTitle)}</div>
            <div class="line2">${item.activityType} · due ${new Date(item.nextDueAt).toLocaleString()}</div>
            <div class="line3">
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
          width: 180px;
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
          padding: 6px 8px;
          display: flex;
          align-items: center;
          gap: 6px;
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
          cursor: pointer;
          transition: background 0.15s, transform 0.1s;
        }
        li:hover {
          transform: translateY(-1px);
        }
        :host([data-theme="light"]) li {
          background: #ffffff;
          border-color: #e2e8f0;
        }
        :host([data-theme="light"]) li:hover {
          background: #f8fafc;
          border-color: #93c5fd;
        }
        :host([data-theme="dark"]) li {
          background: #2d2e30;
          border-color: #3c4043;
        }
        :host([data-theme="dark"]) li:hover {
          background: #3c4043;
          border-color: #8ab4f8;
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
        .activities {
          margin-top: 6px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .activity-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          font-size: 11px;
        }
        .activity-type {
          text-transform: capitalize;
          flex-shrink: 0;
        }
        :host([data-theme="light"]) .activity-type {
          color: #64748b;
        }
        :host([data-theme="dark"]) .activity-type {
          color: #9aa0a6;
        }
        .activity-time {
          flex: 1;
          text-align: right;
        }
        :host([data-theme="light"]) .activity-time {
          color: #64748b;
        }
        :host([data-theme="dark"]) .activity-time {
          color: #9aa0a6;
        }
        .activity-row.due .activity-time,
        .activity-row.overdue .activity-time {
          font-weight: 600;
        }
        :host([data-theme="light"]) .activity-row.due .activity-time {
          color: #1d4ed8;
        }
        :host([data-theme="dark"]) .activity-row.due .activity-time {
          color: #8ab4f8;
        }
        :host([data-theme="light"]) .activity-row.overdue .activity-time {
          color: #be123c;
        }
        :host([data-theme="dark"]) .activity-row.overdue .activity-time {
          color: #f28b82;
        }
        .complete-btn {
          font-size: 10px;
          padding: 2px 6px;
          border: 1px solid;
          border-radius: 4px;
          cursor: pointer;
          flex-shrink: 0;
        }
        :host([data-theme="light"]) .complete-btn {
          background: #f0fdf4;
          border-color: #86efac;
          color: #15803d;
        }
        :host([data-theme="light"]) .complete-btn:hover {
          background: #dcfce7;
        }
        :host([data-theme="dark"]) .complete-btn {
          background: #1f3d28;
          border-color: #5f8a6b;
          color: #86efac;
        }
        :host([data-theme="dark"]) .complete-btn:hover {
          background: #2d4a35;
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
            <h4>Manual Complete</h4>
            <div class="row">
              <button class="main" id="srs-complete-quiz">Quiz</button>
              <button class="main" id="srs-complete-flashcards">Cards</button>
              <button class="main" id="srs-complete-podcast">Podcast</button>
            </div>
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
            <h4>Notebooks</h4>
            <ul id="srs-notebooks"></ul>
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
