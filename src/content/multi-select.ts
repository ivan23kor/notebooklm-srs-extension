/**
 * Multi-select functionality for NotebookLM homepage
 * Adds checkboxes to notebook rows and bulk actions
 */

import { getNotebookTitleKey } from "../shared/notebook-title";

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
  private notebookIdMap = new Map<string, string>();
  private diagDumpedTitles = new Set<string>();

  constructor() {
    this.init();
  }

  setNotebookIdMap(map: Map<string, string>): void {
    const next = new Map(this.notebookIdMap);
    for (const [key, value] of map) {
      if (!next.has(key)) {
        next.set(key, value);
      }
    }
    this.notebookIdMap = next;
    log("Updated notebook ID map with", map.size, "dashboard entries; total map size:", this.notebookIdMap.size);
  }

  mergeDiscoveredNotebooks(entries: Array<{ id: string; title: string }>): void {
    let added = 0;
    for (const { id, title } of entries) {
      const key = getNotebookTitleKey(title);
      if (key && !this.notebookIdMap.has(key)) {
        this.notebookIdMap.set(key, id);
        added++;
      }
    }
    if (added > 0) {
      log("Merged", added, "discovered notebook IDs, map size:", this.notebookIdMap.size);
      this.retryUnresolvedRows();
    }
  }

  private retryUnresolvedRows(): void {
    let resolved = 0;
    const unresolved = [...this.rowCheckboxes.entries()].filter(([id]) => this.isPlaceholderId(id));
    log("Retrying", unresolved.length, "unresolved rows");
    
    for (const [id, data] of unresolved) {
      const titleKey = getNotebookTitleKey(data.title);
      const newId = this.resolveNotebookId(data.row, titleKey);
      log("Retry for", data.title, "-> oldId:", id, "newId:", newId, "isPlaceholder:", this.isPlaceholderId(newId || ""));
      
      if (newId && !this.isPlaceholderId(newId)) {
        const wasSelected = this.selectedNotebooks.has(id);
        this.rowCheckboxes.delete(id);
        this.selectedNotebooks.delete(id);
        this.rowCheckboxes.set(newId, { ...data, notebookId: newId });
        if (wasSelected) {
          this.selectedNotebooks.add(newId);
        }
        resolved++;
        log("RESOLVED:", data.title, "->", newId);
      }
    }
    if (resolved > 0) {
      log("Re-resolved", resolved, "previously-unresolved notebook(s)");
    }
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
    const clone = titleCell.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("[data-srs-timer], [data-multi-select-checkbox]")
      .forEach(el => el.remove());
    return clone.textContent?.trim() ?? "";
  }

  private generateNotebookId(row: HTMLElement, title: string): string {
    const titleKey = getNotebookTitleKey(title);
    const resolved = this.resolveNotebookId(row, titleKey);
    if (resolved) return resolved;

    const placeholder = this.createPlaceholderId(titleKey);
    if (!this.diagDumpedTitles.has(titleKey)) {
      this.diagDumpedTitles.add(titleKey);
      console.warn(LOG_PREFIX, "Could not find notebook ID for:", title, "Using placeholder:", placeholder);
      this.dumpRowDiagnostics(row, title);
    }
    return placeholder;
  }

  private dumpRowDiagnostics(row: HTMLElement, title: string): void {
    const diag: Record<string, unknown> = {
      title,
      titleKey: getNotebookTitleKey(title),
    };

    // Row's own attributes
    const rowAttrs: Record<string, string> = {};
    for (const attr of Array.from(row.attributes)) {
      rowAttrs[attr.name] = attr.value.slice(0, 200);
    }
    diag.rowAttrs = rowAttrs;

    // Angular context on row and ancestors (up to 3 levels)
    const ngContexts: unknown[] = [];
    let el: HTMLElement | null = row;
    for (let i = 0; i < 4 && el; i++) {
      const ctx = (el as any).__ngContext__;
      if (ctx) {
        ngContexts.push({
          tag: el.tagName,
          contextType: typeof ctx,
          isArray: Array.isArray(ctx),
          length: Array.isArray(ctx) ? ctx.length : undefined,
          sample: Array.isArray(ctx)
            ? ctx.slice(0, 30).map((v: unknown) => {
                if (v == null) return null;
                if (typeof v === "string") return v.slice(0, 120);
                if (typeof v === "number" || typeof v === "boolean") return v;
                if (typeof v === "object" && v !== null) {
                  const keys = Object.keys(v).slice(0, 10);
                  return `{${keys.join(",")}}`;
                }
                return typeof v;
              })
            : String(ctx).slice(0, 200),
        });
      }
      el = el.parentElement;
    }
    diag.ngContexts = ngContexts;

    // Check project-action-button component inside row
    const actionBtn = row.querySelector("project-action-button");
    if (actionBtn) {
      const btnCtx = (actionBtn as any).__ngContext__;
      diag.actionBtnContext = btnCtx
        ? {
            isArray: Array.isArray(btnCtx),
            length: Array.isArray(btnCtx) ? btnCtx.length : undefined,
            sample: Array.isArray(btnCtx)
              ? btnCtx.slice(0, 30).map((v: unknown) => {
                  if (v == null) return null;
                  if (typeof v === "string") return v.slice(0, 120);
                  if (typeof v === "number" || typeof v === "boolean") return v;
                  if (typeof v === "object" && v !== null) {
                    const keys = Object.keys(v).slice(0, 10);
                    return `{${keys.join(",")}}`;
                  }
                  return typeof v;
                })
              : String(btnCtx).slice(0, 200),
          }
        : "no __ngContext__";
    }

    // Check for any element with properties containing "notebook" or UUID patterns
    const allEls = row.querySelectorAll<HTMLElement>("*");
    const propsWithIds: string[] = [];
    for (const child of allEls) {
      for (const key of Object.getOwnPropertyNames(child)) {
        if (key.startsWith("__") || key === "innerHTML" || key === "outerHTML") continue;
        try {
          const val = (child as any)[key];
          if (typeof val === "string" && val.match(/[0-9a-f]{8}-[0-9a-f]{4}/i)) {
            propsWithIds.push(`${child.tagName}.${key}=${val.slice(0, 100)}`);
          }
        } catch {}
      }
    }
    if (propsWithIds.length) diag.propsWithUUIDs = propsWithIds;

    // ID map state
    diag.idMapSize = this.notebookIdMap.size;
    diag.idMapKeys = [...this.notebookIdMap.keys()].slice(0, 5);

    console.warn(LOG_PREFIX, "[DIAG] Row diagnostics for:", title, diag);
  }

  private resolveNotebookId(row: HTMLElement, titleKey: string): string | null {
    // 1. Link href inside the row
    const link = row.querySelector('a[href*="/notebook/"]');
    if (link) {
      const fromLink = this.extractNotebookIdFromValue(link.getAttribute("href") ?? "");
      if (fromLink) return fromLink;
    }

    // 2. Attribute scan across the row subtree
    const fromAttributes = this.extractNotebookIdFromAttributes(row);
    if (fromAttributes) return fromAttributes;

    // 3. ID map from dashboard state (fallback; may not be a real notebook ID)
    const idFromMap = this.notebookIdMap.get(titleKey);
    if (idFromMap) return idFromMap;

    // 4. Row innerHTML as last resort (only if it contains notebook hints)
    if (row.innerHTML.includes("notebook")) {
      const fromHtml = this.extractNotebookIdFromValue(row.innerHTML);
      if (fromHtml) return fromHtml;
    }

    return null;
  }

  private extractNotebookIdFromAttributes(root: HTMLElement): string | null {
    const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
    for (const el of elements) {
      for (const attr of Array.from(el.attributes)) {
        if (!attr.value) continue;
        const id = this.extractNotebookIdFromAttribute(attr.name, attr.value);
        if (id) return id;
      }
    }
    return null;
  }

  private extractNotebookIdFromAttribute(name: string, value: string): string | null {
    const nameLower = name.toLowerCase();
    const allowBare = nameLower.includes("notebook");
    if (!allowBare) {
      const lower = value.toLowerCase();
      if (!lower.includes("notebook") && !lower.includes("/notebook/")) {
        return null;
      }
    }
    return this.extractNotebookIdFromValue(value, allowBare);
  }

  private extractNotebookIdFromValue(value: string, allowBare = false): string | null {
    if (!value) return null;
    const decoded = this.safeDecodeURIComponent(value);

    const linkMatch = decoded.match(/\/notebook\/([a-zA-Z0-9_-]+)/);
    if (linkMatch?.[1]) return linkMatch[1];

    const jsonMatch = decoded.match(/notebookId\"?\s*[:=]\s*\"([a-zA-Z0-9_-]+)\"/i);
    if (jsonMatch?.[1]) return jsonMatch[1];

    if (allowBare) {
      const uuidMatch = decoded.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (uuidMatch?.[0]) return uuidMatch[0];
    }

    return null;
  }

  private safeDecodeURIComponent(value: string): string {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  private createPlaceholderId(titleLower: string): string {
    const ascii = titleLower
      .normalize("NFKD")
      .replace(/[^\x00-\x7F]/g, "")
      .trim();
    const slug = ascii
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return `unresolved-${slug || "notebook"}`;
  }

  private isPlaceholderId(id: string): boolean {
    return id.startsWith("unresolved-");
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
      row: this.rowCheckboxes.get(id)?.row ?? null,
    }));

    log("Moving notebooks to trash:", toDelete.length, "IDs:", toDelete.map(d => d.id));

    // Pause observer during bulk delete to prevent DOM sync interference
    this.observer?.disconnect();

    const atToken = await this.getAtToken();
    log("Retrieved auth token:", atToken ? `${atToken.substring(0, 10)}...` : "NULL");
    
    if (!atToken) {
      console.error(LOG_PREFIX, "Failed to get auth token, cannot delete");
      this.observer?.observe(document.body, { childList: true, subtree: true });
      alert("Failed to get authentication token. Please refresh the page and try again.");
      return;
    }

    let successCount = 0;
    let failCount = 0;
    let skippedCount = 0;

    for (const { id, title, row } of toDelete) {
      try {
        const resolvedId = this.isPlaceholderId(id) && row
          ? this.resolveNotebookId(row, title.toLowerCase())
          : id;

        if (!resolvedId || this.isPlaceholderId(resolvedId)) {
          skippedCount++;
          console.warn(LOG_PREFIX, "Skipping delete; could not resolve notebook ID for:", title);
          continue;
        }

        const result = await this.deleteNotebookViaRpc(resolvedId, atToken);
        if (result.success) {
          successCount++;
          log("Notebook deleted:", title, "ID:", resolvedId, "Result:", result.data);
        } else {
          failCount++;
          console.error(LOG_PREFIX, "Delete failed for:", title, "ID:", resolvedId, "Error:", result.error);
        }
      } catch (error) {
        console.error(LOG_PREFIX, "Failed to delete notebook:", title, error);
        failCount++;
      }
    }

    log("Bulk delete completed:", { success: successCount, failed: failCount, skipped: skippedCount });

    if (skippedCount > 0) {
      alert(
        `Skipped ${skippedCount} notebook(s) because their IDs could not be resolved. ` +
          `Open each notebook once or refresh the page, then try again.`,
      );
    } else if (failCount > 0 && successCount === 0) {
      alert(`Failed to delete all ${failCount} notebook(s). Check console for details.`);
    }

    this.clearSelection();

    // Re-enable observer and sync after delete completes
    this.observer?.observe(document.body, { childList: true, subtree: true });
    // Reload page to reflect deletions
    if (successCount > 0) {
      location.reload();
    }
  }

  private async deleteNotebookViaRpc(
    notebookId: string,
    atToken: string,
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const rpcId = "WWINqb";
    // Args format: [notebookId, action] where action 2 = move to trash
    const args = JSON.stringify([notebookId, 2]);
    const fReq = JSON.stringify([[[rpcId, args, null, "generic"]]]);

    log("RPC request for notebook:", notebookId);

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

    const url = `https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?${params}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "x-same-domain": "1",
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const text = await response.text();
    log("RPC response (first 500 chars):", text.substring(0, 500));

    if (!text.includes(")]}'")) {
      return { success: false, error: "Unexpected response format" };
    }

    const lines = text.split("\n");
    for (const line of lines) {
      if (!line.includes(rpcId)) continue;
      try {
        const parsed = JSON.parse(line);
        const wrb = parsed.find(
          (item: unknown) => Array.isArray(item) && item[0] === "wrb.fr",
        );
        if (
          wrb &&
          Array.isArray(wrb[5]) &&
          typeof wrb[5][0] === "number" &&
          wrb[5][0] !== 0
        ) {
          return { success: false, data: parsed, error: `RPC error status ${wrb[5][0]}` };
        }
        return { success: true, data: parsed };
      } catch {
        return { success: false, error: "Failed to parse RPC response" };
      }
    }

    return { success: false, error: "RPC ID not found in response" };
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
