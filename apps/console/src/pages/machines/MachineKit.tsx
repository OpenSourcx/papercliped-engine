import { useState, type ReactNode } from "react";
import { ApiError } from "../../data/api.ts";
import { errorText, type ActResult, type GuestDevices } from "../../data/engine/guestApi.ts";
import { Chip } from "../../ui/primitives.tsx";

/** What the machine page's cards share: the loaded devices, how to reload them, and one way to run a change. */
export interface DevCtx {
  vmid: number;
  d: GuestDevices;
  /** Reload the page's data; called after every change and when Proxmox says the page is stale. */
  reload: () => void;
}

/**
 * Runs one change and reports busy and error state. A change the machine refuses shows Proxmox's own words. When the
 * machine changed since the page loaded (409 stale), the data reloads so the next try works.
 */
export function useSave(ctx: DevCtx, onClose?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<ActResult>): Promise<ActResult | null> => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      ctx.reload();
      setBusy(false);
      onClose?.();
      return r;
    } catch (e) {
      setError(errorText(e, "Couldn't save that"));
      if (e instanceof ApiError && e.code === "stale") ctx.reload();
      setBusy(false);
      return null;
    }
  };
  return { run, busy, error, setError };
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">{children}</div>;
}

export const PendingChip = () => <Chip tone="warning">Pending restart</Chip>;

/** "4096" MiB as "4 GiB"; keeps odd values exact. */
export function mib(v: number): string {
  if (v >= 1024 && v % 1024 === 0) return `${v / 1024} GiB`;
  if (v >= 1024) return `${+(v / 1024).toFixed(2)} GiB`;
  return `${v} MiB`;
}

/** A busy machine can't be changed; say so once, where the changes start. */
export function busyNotice(d: GuestDevices): string | null {
  return d.locked ? `This machine is busy (${d.locked}). Changes wait until it's done.` : null;
}
