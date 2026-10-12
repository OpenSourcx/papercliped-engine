import { useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Field, Input, Notice } from "../../ui/primitives.tsx";
import { errorText } from "../../data/engine/disks.ts";

/** Pieces the disk screens share. */

/** Runs a loader, keeps its result, and reloads when `deps` change or `reload()` is called. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    load().then(
      (v) => alive && (setData(v), setError(null)),
      (e) => alive && setError(errorText(e, "Couldn't read this from the device")),
    );
    return () => {
      alive = false;
    };
  }, [...deps, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload: () => setTick((n) => n + 1), loading: data === null && error === null };
}

/**
 * A destructive action behind a typed confirmation. The button stays off until the exact name is typed; the host
 * service enforces the same rule, so this is a convenience and not the safeguard.
 */
export function ConfirmTypeModal({ title, subtitle, expected, accepts, actionLabel, warning, children, onConfirm, onClose, onDone }: {
  title: string;
  subtitle?: ReactNode;
  /** What to type. */
  expected: string;
  /** Other spellings that count (a disk's "sdb" and "/dev/sdb"). */
  accepts?: string[];
  actionLabel: string;
  warning?: ReactNode;
  children?: ReactNode;
  onConfirm: (typed: string) => Promise<unknown>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = typed === expected || (accepts ?? []).includes(typed);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(typed);
      onDone();
      onClose();
    } catch (e) {
      setError(errorText(e, "That didn't work"));
      setBusy(false);
    }
  };
  return (
    <Modal
      size="sm"
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" onClick={go} disabled={!ok} loading={busy}>{actionLabel}</Button></>}
    >
      <div className="space-y-4">
        {warning && <Notice tone="warning">{warning}</Notice>}
        {children}
        <Field label={<>Type <span className="font-mono text-ink">{expected}</span> to confirm</>} error={error}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" aria-label={`Type ${expected} to confirm`} />
        </Field>
      </div>
    </Modal>
  );
}

export function Loading({ label = "Reading from the device" }: { label?: string }) {
  return <div className="p-8 text-center text-ink-3 text-sm inline-flex items-center justify-center gap-2 w-full"><Loader2 className="h-4 w-4 animate-spin" />{label}…</div>;
}

/** A labelled checkbox row for options that read better as a sentence than as a switch. */
export function Check({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-1 h-4 w-4 accent-(--accent)" />
      <span className="min-w-0"><span className="block text-sm">{label}</span>{hint && <span className="block text-xs text-ink-3">{hint}</span>}</span>
    </label>
  );
}

/** Disks are sold in decimal units, so their sizes are shown that way (formatBytes is for what the file system sees). */
export const diskSize = (bytes: number) => (bytes >= 1e12 ? `${+(bytes / 1e12).toFixed(2)} TB` : `${+(bytes / 1e9).toFixed(bytes >= 1e11 ? 0 : 1)} GB`);
