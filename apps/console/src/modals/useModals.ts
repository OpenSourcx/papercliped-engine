import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * Modals are addressable: `?settings=<section>` opens the settings modal and `?modal=new-org` opens "Create an
 * organization", over whatever page is showing. Links can open them, and Back closes them.
 */
export const settingsHref = (section = "general") => `?settings=${section}`;
export const modalHref = (name: string) => `?modal=${name}`;

export function useModals() {
  const [params, setParams] = useSearchParams();
  const settings = params.get("settings");
  const modal = params.get("modal");
  const update = useCallback(
    (fn: (p: URLSearchParams) => void, replace = false) =>
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        fn(next);
        return next;
      }, { replace }),
    [setParams],
  );
  return {
    settings,
    modal,
    openSettings: (section = "general") => update((p) => { p.set("settings", section); p.delete("modal"); }),
    selectSection: (section: string) => update((p) => p.set("settings", section), true),
    openModal: (name: string) => update((p) => { p.set("modal", name); }),
    close: () => update((p) => { for (const k of ["settings", "modal", "storage", "content", "kind", "upid", "id", "vmid", "vmids", "all", "volid"]) p.delete(k); }),
  };
}
