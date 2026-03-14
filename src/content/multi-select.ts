/**
 * Multi-select functionality for NotebookLM homepage
 * Adds checkboxes to notebook rows and bulk actions
 */

const LOG_PREFIX = "[Multi-Select]";

function log(...args: unknown[]): void {
  console.debug(LOG_PREFIX, ...args);
}

interface NotebookRow {
  row: HTMLElement;
  checkbox: HTMLInputElement;
  title: string;
  notebookId: string;
}

export class MultiSelectManager {
  private selectedNotebooks = new Set<string>();
  private selectAllCheckbox: HTMLInputElement | null = null;
  private actionToolbar: HTMLElement | null = null;
  private observer: MutationObserver | null = null;
  private rowCheckboxes = new Map<string, NotebookRow>();

  constructor() {
    this.init();
  }

  private init(): void {
    log("Initializing multi-select manager");
    this.observeTable();
    this.injectActionToolbar();
    this.updateSelectionState();

    // Initial sync after a short delay to ensure DOM is ready
    setTimeout(() => this.syncRows(), 500);
    // Retry select-all checkbox after delay in case table wasn't ready initially
    setTimeout(() => this.injectSelectAllCheckbox(true), 500);

    // Also sync when URL changes (SPA navigation)
    let lastPathname = location.pathname;
    const urlCheckInterval = setInterval(() => {
      if (location.pathname !== lastPathname) {
        lastPathname = location.pathname;
        if (lastPathname === "/") {
          log("URL changed to homepage, syncing rows");
          setTimeout(() => this.syncRows(), 300);
          setTimeout(() => this.injectSelectAllCheckbox(true), 300);
        }
      }
    }, 500);
  }

  private observeTable(): void {
    this.observer = new MutationObserver(() => {
      this.scheduleSync();
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
    this.syncRows();
  }

  private syncPending = false;
  private scheduleSync(): void {
    if (this.syncPending) return;
    this.syncPending = true;
    requestAnimationFrame(() => {
      this.syncPending = false;
      this.syncRows();
    });
  }

  private syncRows(): void {
    if (location.pathname !== "/") return;

    const tables = document.querySelectorAll("table.mat-mdc-table");
    if (tables.length === 0) return;

    this.observer?.disconnect();

    const processedIds = new Set<string>();

    for (const table of tables) {
      const rows = table.querySelectorAll<HTMLElement>("tr.mat-mdc-row");

      for (const row of rows) {
      const title = this.extractRowTitle(row);
      if (!title) continue;

      const notebookId = this.generateNotebookId(row, title);

      if (this.rowCheckboxes.has(notebookId)) {
        const existing = this.rowCheckboxes.get(notebookId)!;
        if (document.body.contains(existing.checkbox)) {
          processedIds.add(notebookId);
          continue;
        }
      }

      this.addCheckboxToRow(row, title, notebookId);
        processedIds.add(notebookId);
      }
    }

    for (const [id, data] of this.rowCheckboxes) {
      if (!processedIds.has(id) || !document.body.contains(data.checkbox)) {
        this.rowCheckboxes.delete(id);
        this.selectedNotebooks.delete(id);
      }
    }

    this.updateSelectAllState();
    this.updateToolbarVisibility();

    this.observer?.observe(document.body, { childList: true, subtree: true });
  }

  private extractRowTitle(row: HTMLElement): string {
    const titleCell = row.querySelector("td.mat-mdc-cell:first-child");
    if (!titleCell) return "";
    const text = titleCell.textContent?.trim() ?? "";
    return text;
  }

  private generateNotebookId(row: HTMLElement, title: string): string {
    const onclick = row.getAttribute("onclick") ?? "";
    const match = onclick.match(/\/notebook\/([a-zA-Z0-9_-]+)/);
    return match?.[1] ?? `notebook-${title.toLowerCase().replace(/\s+/g, "-")}`;
  }

  private addCheckboxToRow(row: HTMLElement, title: string, notebookId: string): void {
    const firstCell = row.querySelector("td.mat-mdc-cell:first-child") as HTMLElement;
    if (!firstCell) return;

    if (row.querySelector("[data-multi-select-checkbox]")) return;

    // Create a wrapper to hold checkbox and existing content
    const wrapper = document.createElement("div");
    wrapper.style.cssText = `
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
    `;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute("data-multi-select-checkbox", "true");
    checkbox.style.cssText = `
      flex-shrink: 0;
      cursor: pointer;
      width: 18px;
      height: 18px;
      accent-color: #1a73e8;
    `;

    checkbox.checked = this.selectedNotebooks.has(notebookId);
    checkbox.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    checkbox.addEventListener("change", (e) => {
      if (checkbox.checked) {
        this.selectedNotebooks.add(notebookId);
      } else {
        this.selectedNotebooks.delete(notebookId);
      }
      this.updateSelectAllState();
      this.updateToolbarVisibility();
      log("Selection changed:", {
        notebook: title,
        selected: checkbox.checked,
        total: this.selectedNotebooks.size,
      });
    });

    row.addEventListener("click", (e) => {
      if (e.target !== checkbox && !this.selectedNotebooks.has(notebookId)) {
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event("change"));
      }
    });

    // Move existing cell content into wrapper
    while (firstCell.firstChild) {
      wrapper.appendChild(firstCell.firstChild);
    }

    // Add checkbox and wrapper to cell
    wrapper.prepend(checkbox);
    firstCell.appendChild(wrapper);

    this.rowCheckboxes.set(notebookId, { row, checkbox, title, notebookId });
  }

  private injectActionToolbar(): void {
    if (document.querySelector("[data-multi-select-toolbar]")) return;

    const toolbar = document.createElement("div");
    toolbar.setAttribute("data-multi-select-toolbar", "true");
    toolbar.style.cssText = `
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: #202124;
      border: 1px solid #3c4043;
      border-radius: 8px;
      padding: 12px 20px;
      display: flex;
      align-items: center;
      gap: 16px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 10000;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;
    `;

    const counter = document.createElement("span");
    counter.setAttribute("data-multi-select-counter", "true");
    counter.style.cssText = `
      color: #e8eaed;
      font-size: 14px;
      font-weight: 500;
    `;

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Move to Trash";
    deleteBtn.setAttribute("data-multi-select-delete", "true");
    deleteBtn.style.cssText = `
      background: #d93025;
      color: white;
      border: none;
      border-radius: 4px;
      padding: 8px 16px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    `;
    deleteBtn.addEventListener("mouseenter", () => {
      deleteBtn.style.background = "#b92b20";
    });
    deleteBtn.addEventListener("mouseleave", () => {
      deleteBtn.style.background = "#d93025";
    });
    deleteBtn.addEventListener("click", () => {
      void this.handleBulkDelete();
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.setAttribute("data-multi-select-cancel", "true");
    cancelBtn.style.cssText = `
      background: transparent;
      color: #8ab4f8;
      border: none;
      border-radius: 4px;
      padding: 8px 16px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    `;
    cancelBtn.addEventListener("mouseenter", () => {
      cancelBtn.style.background = "rgba(138, 180, 248, 0.1)";
    });
    cancelBtn.addEventListener("mouseleave", () => {
      cancelBtn.style.background = "transparent";
    });
    cancelBtn.addEventListener("click", () => {
      this.clearSelection();
    });

    toolbar.appendChild(counter);
    toolbar.appendChild(deleteBtn);
    toolbar.appendChild(cancelBtn);

    document.body.appendChild(toolbar);
    this.actionToolbar = toolbar;
  }

  private updateToolbarVisibility(): void {
    if (!this.actionToolbar) return;

    const count = this.selectedNotebooks.size;
    const counter = this.actionToolbar.querySelector("[data-multi-select-counter]") as HTMLElement;
    if (counter) {
      counter.textContent = `${count} notebook${count !== 1 ? "s" : ""} selected`;
    }

    if (count > 0) {
      this.actionToolbar.style.opacity = "1";
      this.actionToolbar.style.pointerEvents = "auto";
    } else {
      this.actionToolbar.style.opacity = "0";
      this.actionToolbar.style.pointerEvents = "none";
    }
  }

  private updateSelectAllState(): void {
    if (!this.selectAllCheckbox) return;

    const totalRows = this.rowCheckboxes.size;
    const selectedCount = this.selectedNotebooks.size;

    if (selectedCount === 0) {
      this.selectAllCheckbox.checked = false;
      this.selectAllCheckbox.indeterminate = false;
    } else if (selectedCount === totalRows) {
      this.selectAllCheckbox.checked = true;
      this.selectAllCheckbox.indeterminate = false;
    } else {
      this.selectAllCheckbox.checked = false;
      this.selectAllCheckbox.indeterminate = true;
    }
  }

  private updateSelectionState(): void {
    this.injectSelectAllCheckbox();
  }

  private injectSelectAllCheckbox(forceRetry = false): void {
    const existing = document.querySelector("[data-select-all-checkbox]");
    if (existing && !forceRetry) return;

    const tableHeaders = document.querySelectorAll("table.mat-mdc-table thead tr");
    if (tableHeaders.length === 0) {
      // Table not ready yet, schedule another attempt
      if (!forceRetry) {
        setTimeout(() => this.injectSelectAllCheckbox(true), 300);
      }
      return;
    }

    // If forcing retry, remove existing checkboxes first to re-add
    if (forceRetry && existing) {
      existing.remove();
      this.selectAllCheckbox = null;
    }

    // Process all table headers (Featured notebooks and My notebooks)
    for (const tableHeader of tableHeaders) {
      const actionsHeader = tableHeader.querySelector("th:last-child") as HTMLElement;
      if (!actionsHeader) continue;

      // Check if we already added a checkbox to this header
      if (actionsHeader.querySelector("[data-select-all-checkbox]")) continue;

      const label = document.createElement("label");
      label.setAttribute("data-select-all-checkbox", "true");
      label.style.cssText = `
        display: flex;
        align-items: center;
        cursor: pointer;
        gap: 8px;
        font-size: 12px;
        color: #5f6368;
      `;

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.style.cssText = `
        width: 18px;
        height: 18px;
        cursor: pointer;
        accent-color: #1a73e8;
      `;

      const text = document.createElement("span");
      text.textContent = "Select All";

      // Store reference to first checkbox (for "My notebooks" table which user likely interacts with)
      if (!this.selectAllCheckbox) {
        this.selectAllCheckbox = checkbox;
      }

      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          this.selectAll();
        } else {
          this.clearSelection();
        }
      });

    label.appendChild(checkbox);
      label.appendChild(text);
      actionsHeader.innerHTML = "";
      actionsHeader.appendChild(label);
    }
  }

  private selectAll(): void {
    for (const [id, data] of this.rowCheckboxes) {
      this.selectedNotebooks.add(id);
      data.checkbox.checked = true;
    }
    this.updateSelectAllState();
    this.updateToolbarVisibility();
    log("All notebooks selected:", this.selectedNotebooks.size);
  }

  private clearSelection(): void {
    for (const data of this.rowCheckboxes.values()) {
      data.checkbox.checked = false;
    }
    this.selectedNotebooks.clear();
    this.updateSelectAllState();
    this.updateToolbarVisibility();
    log("Selection cleared");
  }

  private async handleBulkDelete(): Promise<void> {
    const selectedCount = this.selectedNotebooks.size;
    if (selectedCount === 0) return;

    // Snapshot selected IDs before any async work (syncRows rAF can clear them)
    const toDelete = [...this.selectedNotebooks].map((id) => ({
      id,
      title: this.rowCheckboxes.get(id)?.title ?? id,
    }));

    log("Moving notebooks to trash:", toDelete.length);

    // Pause observer during bulk delete to prevent DOM sync interference
    this.observer?.disconnect();

    const atToken = await this.getAtToken();
    if (!atToken) {
      console.error(LOG_PREFIX, "Failed to get auth token, cannot delete");
      this.observer?.observe(document.body, { childList: true, subtree: true });
      return;
    }

    let successCount = 0;
    let failCount = 0;

    for (const { id, title } of toDelete) {
      try {
        await this.deleteNotebookViaRpc(id, atToken);
        successCount++;
        log("Notebook deleted:", title);
      } catch (error) {
        console.error(LOG_PREFIX, "Failed to delete notebook:", title, error);
        failCount++;
      }
    }

    log("Bulk delete completed:", { success: successCount, failed: failCount });

    this.clearSelection();

    // Re-enable observer and sync after delete completes
    this.observer?.observe(document.body, { childList: true, subtree: true });
    // Reload page to reflect deletions
    if (successCount > 0) {
      location.reload();
    }
  }

  private async deleteNotebookViaRpc(notebookId: string, atToken: string): Promise<void> {
    const rpcId = "WWINqb";
    const args = JSON.stringify([[notebookId], [2]]);
    const fReq = JSON.stringify([[[rpcId, args, null, "generic"]]]);

    const formData = new URLSearchParams();
    formData.set("f.req", fReq);
    formData.set("at", atToken);

    const params = new URLSearchParams({
      rpcids: rpcId,
      "source-path": "/",
      hl: "en",
      authuser: "0",
      _reqid: String(Math.floor(Math.random() * 900000) + 100000),
    });

    const response = await fetch(
      `https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?${params}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "x-same-domain": "1",
        },
        body: formData.toString(),
      },
    );

    if (!response.ok) {
      throw new Error(`RPC failed: ${response.status}`);
    }
  }

  private getAtToken(): Promise<string | null> {
    return new Promise((resolve) => {
      const handler = (e: Event) => {
        document.removeEventListener("__srs_at_token__", handler);
        resolve((e as CustomEvent).detail as string | null);
      };
      document.addEventListener("__srs_at_token__", handler);
      document.dispatchEvent(new CustomEvent("__srs_request_at_token__"));

      setTimeout(() => {
        document.removeEventListener("__srs_at_token__", handler);
        resolve(null);
      }, 2000);
    });
  }

  destroy(): void {
    this.observer?.disconnect();
    this.actionToolbar?.remove();
    this.rowCheckboxes.clear();
    this.selectedNotebooks.clear();
    log("Multi-select manager destroyed");
  }
}
