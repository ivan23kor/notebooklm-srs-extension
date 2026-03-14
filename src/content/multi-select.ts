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

    // Also sync when URL changes (SPA navigation)
    let lastPathname = location.pathname;
    const urlCheckInterval = setInterval(() => {
      if (location.pathname !== lastPathname) {
        lastPathname = location.pathname;
        if (lastPathname === "/") {
          log("URL changed to homepage, syncing rows");
          setTimeout(() => this.syncRows(), 300);
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

    const table = document.querySelector("table.mat-mdc-table");
    if (!table) return;

    this.observer?.disconnect();

    const rows = table.querySelectorAll<HTMLElement>("tr.mat-mdc-row");
    const processedIds = new Set<string>();

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

  private injectSelectAllCheckbox(): void {
    if (document.querySelector("[data-select-all-checkbox]")) return;

    const tableHeader = document.querySelector("table.mat-mdc-table thead tr");
    if (!tableHeader) return;

    const actionsHeader = tableHeader.querySelector("th:last-child") as HTMLElement;
    if (!actionsHeader) return;

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

    this.selectAllCheckbox = checkbox;
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

    log("Moving notebooks to trash:", selectedCount);

    let successCount = 0;
    let failCount = 0;

    for (const [id, data] of this.rowCheckboxes) {
      if (!this.selectedNotebooks.has(id)) continue;

      try {
        await this.deleteNotebook(data.row, data.title);
        successCount++;
        // Wait between deletions to avoid overwhelming the UI
        await this.delay(300);
      } catch (error) {
        console.error(LOG_PREFIX, "Failed to delete notebook:", data.title, error);
        failCount++;
      }
    }

    log("Bulk delete completed:", { success: successCount, failed: failCount });

    this.clearSelection();
    setTimeout(() => {
      this.syncRows();
    }, 500);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async deleteNotebook(row: HTMLElement, title: string): Promise<void> {
    const moreBtn = row.querySelector<HTMLElement>("button[aria-label='Project Actions Menu']");
    if (!moreBtn) {
      throw new Error("More button not found");
    }

    moreBtn.click();
    await this.waitForMenu();

    const deleteBtn = Array.from(document.querySelectorAll<HTMLElement>("button")).find(
      (btn) => btn.textContent?.toLowerCase().includes("trash") || btn.textContent?.toLowerCase().includes("delete")
    );

    if (!deleteBtn) {
      moreBtn.blur();
      throw new Error("Delete button not found");
    }

    deleteBtn.click();
    await this.waitForConfirmation();

    // Find and click the confirm button in the dialog
    const confirmBtn = await this.waitForConfirmButton();
    if (confirmBtn) {
      confirmBtn.click();
      await this.delay(200); // Wait for dialog to close and action to complete
    }

    log("Notebook moved to trash:", title);
  }

  private waitForConfirmButton(): Promise<HTMLElement | null> {
    return new Promise((resolve) => {
      const checkButton = () => {
        // Look for confirm button in dialog
        const buttons = Array.from(document.querySelectorAll<HTMLElement>("button"));
        const confirmBtn = buttons.find(btn => {
          const text = btn.textContent?.toLowerCase().trim() ?? "";
          return (
            (text === "move" || text === "delete" || text === "confirm" || text === "ok") &&
            btn.offsetParent !== null
          );
        });

        if (confirmBtn) {
          resolve(confirmBtn);
        } else {
          requestAnimationFrame(checkButton);
        }
      };
      checkButton();
    });
  }

  private waitForMenu(): Promise<void> {
    return new Promise((resolve) => {
      const checkMenu = () => {
        const menu = document.querySelector("[role='menu']");
        if (menu && menu.offsetParent !== null) {
          resolve();
        } else {
          requestAnimationFrame(checkMenu);
        }
      };
      checkMenu();
    });
  }

  private waitForConfirmation(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, 100);
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
