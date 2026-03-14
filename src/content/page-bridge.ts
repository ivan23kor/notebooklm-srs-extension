// Runs in the page's MAIN world — has access to page JS globals.
// Responds to requests from the content script (isolated world) via CustomEvents.

document.addEventListener("__srs_request_at_token__", () => {
  const token = (window as any).WIZ_global_data?.SNlM0e || null;
  document.dispatchEvent(
    new CustomEvent("__srs_at_token__", { detail: token }),
  );
});
