/**
 * After a deploy the console's files get new names, and a tab opened before the deploy asks for screens that no longer exist: the
 * import fails and, without this, the page goes blank. A failed screen load is recognised here and the page reloads ONCE to pick up
 * the new files (a second failure in the same minute is shown to the person instead of looping).
 */
const KEY = "epc.reloaded-for-update";

export function isStaleAssetError(e: unknown): boolean {
  const text = e instanceof Error ? `${e.name} ${e.message}` : String(e ?? "");
  return /dynamically imported module|Importing a module script failed|Failed to fetch dynamically|error loading dynamically|Unable to preload CSS|ChunkLoadError|Loading chunk .* failed/i.test(text);
}

/** True when it reloaded; false when it already did a moment ago (the caller then shows the problem). */
export function reloadOnceForUpdate(now = Date.now(), store: Pick<Storage, "getItem" | "setItem"> | null = safeStore(), reload: () => void = () => window.location.reload()): boolean {
  try {
    const last = Number(store?.getItem(KEY) ?? 0);
    if (last && now - last < 60_000) return false;
    store?.setItem(KEY, String(now));
  } catch { /* storage blocked: reload anyway, once per page load is bounded by the browser */ }
  reload();
  return true;
}

function safeStore(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

/** Vite fires this when a preloaded screen can't be fetched; handling it here covers links the person clicks after a deploy. */
export function installStaleAssetHandler(): void {
  window.addEventListener("vite:preloadError", (e) => {
    e.preventDefault();
    reloadOnceForUpdate();
  });
}
