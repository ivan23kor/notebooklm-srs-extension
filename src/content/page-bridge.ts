// Runs in the page's MAIN world — has access to page JS globals.
// Responds to requests from the content script (isolated world) via CustomEvents.

const BRIDGE_LOG = "[Page-Bridge]";
console.warn(BRIDGE_LOG, "Injected into MAIN world");

document.addEventListener("__srs_request_at_token__", () => {
  const wizData = (window as any).WIZ_global_data;
  const token = wizData?.SNlM0e || null;
  document.dispatchEvent(
    new CustomEvent("__srs_at_token__", { detail: token }),
  );
});

// --- Notebook ID discovery via XHR interception ---

const discoveredNotebooks = new Map<string, string>(); // id -> title

function dispatchNotebookMap(): void {
  if (discoveredNotebooks.size === 0) return;
  const entries = Array.from(discoveredNotebooks.entries()).map(([id, title]) => ({ id, title }));
  console.warn(BRIDGE_LOG, "[Dispatch] Sending", entries.length, "notebooks:", entries);
  document.dispatchEvent(new CustomEvent("__srs_notebook_ids__", { detail: entries }));
}

document.addEventListener("__srs_request_notebook_ids__", () => {
  dispatchNotebookMap();
});

function extractNotebooksFromResponse(text: string): void {
  // Google batchexecute responses: lines prefixed with )]}'
  // Each subsequent line alternates between a byte-length number and a JSON array.
  const lines = text.split("\n");
  console.debug(BRIDGE_LOG, "[Parse] Response has", lines.length, "lines");
  let found = 0;
  let parsedCount = 0;
  for (const line of lines) {
    if (!line.startsWith("[")) continue;
    try {
      const parsed = JSON.parse(line);
      parsedCount++;
      found += walkForNotebooks(parsed, 0);
    } catch {}
  }
  console.debug(BRIDGE_LOG, "[Parse] Parsed", parsedCount, "JSON arrays, found", found, "notebooks");
  if (found > 0) {
    console.debug(BRIDGE_LOG, "Discovered", found, "notebook(s) from XHR, total map size:", discoveredNotebooks.size);
    dispatchNotebookMap();
  }
}

function walkForNotebooks(data: unknown, depth: number): number {
  if (depth > 15 || !Array.isArray(data)) return 0;
  let found = 0;

  // Heuristic: look for arrays where one element is a UUID and a nearby element
  // looks like a title string. NotebookLM API typically returns arrays like:
  // [notebookId, title, ...]  or  [..., notebookId, ..., title, ...]
  // Also accept shorter notebook IDs (hex strings or alphanumeric)
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const shortIdRe = /^[0-9a-f]{8,32}$/i; // hex or short alphanumeric ID

  for (let i = 0; i < data.length; i++) {
    const val = data[i];
    const isUuid = typeof val === "string" && uuidRe.test(val);
    const isShortId = typeof val === "string" && shortIdRe.test(val) && val.length >= 12; // at least 12 chars
    
    if (isUuid || isShortId) {
      // Search nearby elements (within 5 positions) for a title-like string
      for (let j = Math.max(0, i - 5); j < Math.min(data.length, i + 6); j++) {
        if (j === i) continue;
        const candidate = data[j];
        if (
          typeof candidate === "string" &&
          candidate.length >= 2 &&
          candidate.length <= 300 &&
          !uuidRe.test(candidate) &&
          !shortIdRe.test(candidate) &&
          !candidate.startsWith("http") &&
          !candidate.startsWith("/")
        ) {
          if (!discoveredNotebooks.has(val)) {
            discoveredNotebooks.set(val, candidate);
            found++;
            if (depth === 0) console.debug(BRIDGE_LOG, "[Walk] Found ID:", val, "->", candidate);
          }
          break;
        }
      }
    }

    if (Array.isArray(val)) {
      found += walkForNotebooks(val, depth + 1);
    }
  }
  return found;
}

// Hook XMLHttpRequest to intercept batchexecute responses
const _xhrOpen = XMLHttpRequest.prototype.open;
const _xhrSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function (
  method: string,
  url: string | URL,
  ...rest: unknown[]
) {
  (this as any)._srsUrl = String(url);
  return (_xhrOpen as Function).apply(this, [method, url, ...rest]);
};

XMLHttpRequest.prototype.send = function (body?: unknown) {
  const url = (this as any)._srsUrl as string;
  if (url?.includes("batchexecute")) {
    console.debug(BRIDGE_LOG, "[XHR] Request to:", url.slice(0, 100));
    console.debug(BRIDGE_LOG, "[XHR] Hooked batchexecute request");
    this.addEventListener("load", () => {
      try {
        console.debug(BRIDGE_LOG, "[XHR] Response received, length:", this.responseText.length);
        extractNotebooksFromResponse(this.responseText);
      } catch (e) {
        console.debug(BRIDGE_LOG, "[XHR] Parse error:", e);
      }
    });
  }
  return (_xhrSend as Function).apply(this, arguments);
};

// --- Notebook ID discovery via pushState interception ---

const _pushState = history.pushState.bind(history);
const _replaceState = history.replaceState.bind(history);

function handleNavigation(url: string | URL | null | undefined): void {
  if (!url) return;
  const s = String(url);
  const match = s.match(/\/notebook\/([0-9a-f-]{36}|[a-zA-Z0-9_-]+)/);
  if (!match?.[1]) return;
  const id = match[1];
  // Grab the page title after a short delay (SPA updates title async)
  setTimeout(() => {
    const title = document.title.replace(/ - NotebookLM$/, "").trim();
    if (title && title !== "NotebookLM") {
      if (!discoveredNotebooks.has(id)) {
        console.debug(BRIDGE_LOG, "pushState discovered notebook:", id, "->", title);
      }
      discoveredNotebooks.set(id, title);
      dispatchNotebookMap();
    }
  }, 500);
}

history.pushState = function (data: unknown, unused: string, url?: string | URL | null) {
  handleNavigation(url);
  return _pushState(data, unused, url);
};

history.replaceState = function (data: unknown, unused: string, url?: string | URL | null) {
  handleNavigation(url);
  return _replaceState(data, unused, url);
};

window.addEventListener("popstate", () => {
  handleNavigation(location.pathname);
});
