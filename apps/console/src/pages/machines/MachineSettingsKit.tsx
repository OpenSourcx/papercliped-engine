import { useState, type ReactNode } from "react";
import { ApiError } from "../../data/api.ts";
import { errorText } from "../../data/engine/guestApi.ts";
import type { MachineApi, Saved, SettingsView } from "../../data/engine/machineApi.ts";
import { Chip, Notice, Toggle } from "../../ui/primitives.tsx";

/** What the machine settings cards share: the loaded settings, the API, how to reload, and one way to run a change. */
export interface SCtx {
  vmid: number;
  s: SettingsView;
  api: MachineApi;
  reload: () => void;
}

export function useRun(reload: () => void, onClose?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const run = async <T extends Saved | { ok: true } | { task: string }>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if ("warnings" in r && r.warnings.length) setWarnings(r.warnings);
      reload();
      setBusy(false);
      if (!("warnings" in r) || !r.warnings.length) onClose?.();
      return r;
    } catch (e) {
      setError(errorText(e, "Couldn't save that"));
      if (e instanceof ApiError && e.code === "stale") reload();
      setBusy(false);
      return null;
    }
  };
  return { run, busy, error, warnings, setError };
}

export function Warnings({ list }: { list: string[] }) {
  if (!list.length) return null;
  return <Notice tone="warning" title="Saved. Please note">{list.map((w) => <p key={w}>{w}</p>)}</Notice>;
}

export const PendingMark = ({ s, keys }: { s: SettingsView; keys: string[] }) => (keys.some((k) => s.pendingKeys.includes(k)) ? <Chip tone="warning">Pending restart</Chip> : null);

/** A label, the control, an optional hint; one row of a form. */
export function FormRow({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 basis-56 flex-1">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-ink-3">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function SwitchRow({ label, hint, checked, onChange }: { label: string; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return <FormRow label={label} hint={hint}><Toggle checked={checked} onChange={onChange} label={label} /></FormRow>;
}

export const Heading = ({ children }: { children: ReactNode }) => <h3 className="text-micro font-semibold uppercase tracking-label text-ink-3 pt-1">{children}</h3>;

/** "" to null, and a number or null for an empty or invalid box. */
export const toNum = (v: string): number | null => (v.trim() === "" || !/^-?\d+(\.\d+)?$/.test(v.trim()) ? null : Number(v));

export function Dl({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">{children}</dl>;
}
export const Dt = ({ children }: { children: ReactNode }) => <dt className="text-ink-3">{children}</dt>;
export const Dd = ({ children }: { children: ReactNode }) => <dd className="min-w-0 break-words">{children}</dd>;
export const Off = ({ children = "Default" }: { children?: ReactNode }) => <span className="text-ink-3">{children}</span>;
