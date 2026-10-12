import { Children, cloneElement, isValidElement, useId, useState, type ReactElement, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Lock } from "lucide-react";
import { useSession } from "../../auth/session.tsx";
import { iac } from "../../data/engine/host.ts";
import { Button, Field, Notice, Spinner } from "../../ui/primitives.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { errorText } from "../../data/engine/queries.ts";

/** What the Access tabs share: the people list, error and loading states, and the "shown once" dialog. */

export const IAC_KEY = ["iac"] as const;
export const useIac = () => useQuery({ queryKey: IAC_KEY, queryFn: iac.get, retry: 1, refetchInterval: 60_000 });

/** The signed-in person's Proxmox user id. */
export function useMe(): string {
  const { session } = useSession();
  return session.mode === "live" ? session.user.username : "";
}

export const dateOf = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000).toLocaleDateString() : "never");
export const dateOfMs = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleDateString() : "never");
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A Field whose label is tied to its control (the control gets an id unless it has one), so screen readers announce it. */
export function AField({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string }) {
  const auto = useId();
  const items = Children.toArray(children);
  const first = items[0];
  let id: string | undefined;
  let control = children;
  if (isValidElement(first)) {
    const el = first as ReactElement<{ id?: string }>;
    id = el.props.id ?? auto;
    control = [cloneElement(el, { id }), ...items.slice(1)];
  }
  return <Field label={label} hint={hint} error={error} className={className} htmlFor={id}>{control}</Field>;
}

export function Loading() {
  return <div className="py-16 grid place-items-center"><Spinner label="Loading" /></div>;
}

export function QueryState({ query, children }: { query: { isPending: boolean; error: unknown; refetch?: () => unknown }; children: ReactNode }) {
  if (query.isPending) return <Loading />;
  if (query.error) {
    return (
      <Notice tone="critical" title="This couldn't be loaded" action={query.refetch ? <Button size="sm" onClick={() => void query.refetch?.()}>Try again</Button> : undefined}>
        {errorText(query.error)}
      </Notice>
    );
  }
  return <>{children}</>;
}

export function ReadOnlyNote({ what }: { what: string }) {
  return <p className="text-compact text-ink-3 mb-4 flex items-center gap-2"><Lock className="h-4 w-4" aria-hidden />Your Proxmox account can't {what}, so this is read-only.</p>;
}

export function Warnings({ items }: { items: string[] }) {
  if (!items.length) return null;
  return <ul className="text-compact text-warning space-y-1 list-disc pl-5 mb-3">{items.map((w, i) => <li key={i}>{w}</li>)}</ul>;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {
          /* the text is selectable on screen */
        }
      }}
    >
      {done ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
      {done ? "Copied" : label}
    </Button>
  );
}

/**
 * A secret the host will never show again (an API token, a Proxmox token value, recovery keys). It stays on screen only
 * until the dialog is closed, and the person has to confirm they've kept it.
 */
export function SecretOnce({ title, subtitle, secrets, children, onClose }: { title: string; subtitle?: string; secrets: { label: string; value: string }[]; children?: ReactNode; onClose: () => void }) {
  const [kept, setKept] = useState(false);
  return (
    <Modal
      size="md"
      title={title}
      subtitle={subtitle ?? "This is the only time it is shown. Copy it somewhere safe now."}
      onClose={() => kept && onClose()}
      footer={
        <>
          <label className="mr-auto flex items-center gap-2 text-compact text-ink-2">
            <input type="checkbox" checked={kept} onChange={(e) => setKept(e.target.checked)} className="h-4 w-4 accent-(--accent)" />
            I've saved it
          </label>
          <Button variant="primary" disabled={!kept} onClick={onClose}>Done</Button>
        </>
      }
    >
      <div className="space-y-4">
        {secrets.map((s) => (
          <div key={s.label}>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className="text-compact font-medium text-ink-2">{s.label}</span>
              <CopyButton text={s.value} />
            </div>
            <pre data-testid="secret-value" className="rounded-lg bg-code border border-line p-3 text-compact font-mono whitespace-pre-wrap break-all select-all">{s.value}</pre>
          </div>
        ))}
        {children}
      </div>
    </Modal>
  );
}

export function Table({ children, min = "min-w-[640px]" }: { children: ReactNode; min?: string }) {
  return <div className="overflow-x-auto rounded-xl border border-line bg-surface"><table className={`w-full text-sm ${min}`}>{children}</table></div>;
}
export const Th = ({ children, className = "" }: { children?: ReactNode; className?: string }) => <th className={`font-normal text-xs text-ink-3 text-left px-4 h-11 ${className}`}>{children}</th>;
export const Td = ({ children, className = "" }: { children?: ReactNode; className?: string }) => <td className={`px-4 py-3 align-middle ${className}`}>{children}</td>;
