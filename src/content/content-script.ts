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
  const panel = new SrsPanel();
  panel.mount();
  srsLog("panel mounted");
  await panel.refresh();
  srsLog("ready");
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
    const markTrainedButton = this.shadow.querySelector<HTMLButtonElement>("#srs-mark-trained");

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

    markTrainedButton?.addEventListener("click", () => {
      void this.handleMarkTrained();
    });

    this.shadow.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

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

  private async handleMarkTrained(): Promise<void> {
    const button = this.shadow?.querySelector<HTMLButtonElement>("#srs-mark-trained");
    if (!button || button.disabled) {
      return;
    }

    button.disabled = true;
    button.textContent = "Saving…";

    try {
      await this.manualComplete("review");
      button.textContent = "Trained ✓";
    } catch {
      button.textContent = "Mark Trained";
      button.disabled = false;
      return;
    }

    setTimeout(() => {
      button.textContent = "Mark Trained";
      button.disabled = false;
    }, 1200);
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
    const firstId = timelineIds[0]!;
    const response = await sendMessage({
      type: "timeline.delete",
      payload: { timelineId: firstId }
    });

    if (!response.ok || !response.data) {
      this.setStatus(response.error ?? "Failed to delete timeline.");
      return;
    }

    for (const id of timelineIds.slice(1)) {
      await sendMessage({
        type: "timeline.delete",
        payload: { timelineId: id }
      });
    }

    await this.refresh();
    this.setStatus("Deleted notebook activities.");
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

    const allItems = [...data.due, ...data.overdue, ...data.upcoming];
    const notebooks = this.groupByNotebook(allItems);
    this.latestDashboardState = data;
    this.renderNotebookList(notebooks);
    this.syncHomepageTimers();

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

  private formatTimerBadge(item: DashboardTimeline): string {
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

    const timerMap = this.getNotebookTimerMap(this.latestDashboardState);
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

      const existing = parent.querySelector("[data-srs-timer]");
      if (existing) {
        existing.textContent = timerInfo.label;
        continue;
      }

      const badge = document.createElement("span");
      badge.setAttribute("data-srs-timer", "true");
      badge.style.cssText =
        "margin-left:6px;font-size:11px;padding:1px 5px;border-radius:4px;white-space:nowrap;" +
        (timerInfo.status === "overdue"
          ? "background:#fef2f2;color:#be123c;"
          : timerInfo.status === "due"
            ? "background:#eff6ff;color:#1d4ed8;"
            : "background:#f0fdf4;color:#15803d;");
      badge.textContent = timerInfo.label;
      parent.appendChild(badge);
    }

    this.notebookTableObserver?.observe(document.body, { childList: true, subtree: true });
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
          label: this.formatTimerBadge(item),
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
          color: #1e293b;
        }
        :host([data-theme="dark"]) .title {
          color: #e8eaed;
        }
        .meta {
          font-size: 10px;
          margin-top: 1px;
        }
        :host([data-theme="light"]) .meta {
          color: #64748b;
        }
        :host([data-theme="dark"]) .meta {
          color: #9aa0a6;
        }
        .collapse-btn {
          background: none;
          border: none;
          cursor: pointer;
          padding: 4px;
          border-radius: 6px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        :host([data-theme="light"]) .collapse-btn {
          color: #64748b;
        }
        :host([data-theme="light"]) .collapse-btn:hover {
          background: #e2e8f0;
        }
        :host([data-theme="dark"]) .collapse-btn {
          color: #9aa0a6;
        }
        :host([data-theme="dark"]) .collapse-btn:hover {
          background: #3c4043;
        }
        :host([data-collapsed="true"]) .collapse-btn svg {
          transform: rotate(180deg);
        }
        .panel-body {
          flex: 1;
          overflow-y: auto;
          padding: 8px 0;
        }
        :host([data-theme="light"]) .panel-body {
          background: #ffffff;
        }
        :host([data-theme="dark"]) .panel-body {
          background: #292a2d;
        }
        .section {
          padding: 6px 12px;
        }
        h4 {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin: 0 0 6px 0;
          font-weight: 600;
        }
        :host([data-theme="light"]) h4 {
          color: #94a3b8;
        }
        :host([data-theme="dark"]) h4 {
          color: #5f6368;
        }
        ul {
          list-style: none;
          margin: 0;
          padding: 0;
        }
        li {
          padding: 6px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 11px;
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        :host([data-theme="light"]) li:hover {
          background: #f1f5f9;
        }
        :host([data-theme="dark"]) li:hover {
          background: #35363a;
        }
        li.empty {
          cursor: default;
          padding: 6px;
          text-align: center;
        }
        :host([data-theme="light"]) li.empty {
          color: #94a3b8;
        }
        :host([data-theme="dark"]) li.empty {
          color: #5f6368;
        }
        .line1 {
          font-weight: 600;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        :host([data-theme="light"]) .line1 {
          color: #1e293b;
        }
        :host([data-theme="dark"]) .line1 {
          color: #e8eaed;
        }
        .line2 {
          font-size: 10px;
        }
        :host([data-theme="light"]) .line2 {
          color: #64748b;
        }
        :host([data-theme="dark"]) .line2 {
          color: #9aa0a6;
        }
        .line3 {
          display: flex;
          gap: 6px;
        }
        .line3 button {
          font-size: 10px;
          padding: 2px 6px;
          border: 1px solid;
          border-radius: 4px;
          cursor: pointer;
        }
        :host([data-theme="light"]) .line3 button {
          background: #fef2f2;
          border-color: #fecaca;
          color: #be123c;
        }
        :host([data-theme="light"]) .line3 button:hover {
          background: #fee2e2;
        }
        :host([data-theme="dark"]) .line3 button {
          background: #3d2020;
          border-color: #5f3838;
          color: #f28b82;
        }
        :host([data-theme="dark"]) .line3 button:hover {
          background: #4d2828;
        }
        .activities {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .activity-row {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 10px;
        }
        .activity-type {
          font-weight: 500;
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
        button.trained {
          width: 100%;
          border: 1px solid;
          border-radius: 6px;
          padding: 8px 10px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        :host([data-theme="light"]) button.trained {
          background: #2563eb;
          border-color: #2563eb;
          color: #ffffff;
        }
        :host([data-theme="light"]) button.trained:hover {
          background: #1d4ed8;
        }
        :host([data-theme="light"]) button.trained:disabled {
          background: #93c5fd;
          border-color: #93c5fd;
          cursor: default;
        }
        :host([data-theme="dark"]) button.trained {
          background: #8ab4f8;
          border-color: #8ab4f8;
          color: #202124;
        }
        :host([data-theme="dark"]) button.trained:hover {
          background: #aecbfa;
        }
        :host([data-theme="dark"]) button.trained:disabled {
          background: #5f8a9e;
          border-color: #5f8a9e;
          cursor: default;
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
            <button class="trained" id="srs-mark-trained">Mark Trained</button>
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
