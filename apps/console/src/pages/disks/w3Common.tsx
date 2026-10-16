import { useState, type ReactNode } from "react";
import { ClipboardCopy } from "lucide-react";
import { Button, Chip, Notice, type StatusKind } from "../../ui/primitives.tsx";

/** A command to copy, in a code block. Nothing is run by the console: the person pastes it on the node. */
export function CommandBlock({ command, label }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2">
      <pre aria-label={label ?? "Command"} className="flex-1 min-w-0 rounded-lg bg-code border border-line p-2.5 text-xs font-mono text-ink-2 whitespace-pre-wrap break-all">{command}</pre>
      <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard?.writeText(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
        <ClipboardCopy className="h-4 w-4" />{copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

export interface GuideStep { title: string; where?: string; command: string | null; note: string | null; risk?: "none" | "low" | "high" }

/** Steps with commands for the things Proxmox's API cannot do, with cautions first. */
export function Guide({ steps, cautions }: { steps: GuideStep[]; cautions: string[] }) {
  return (
    <div className="space-y-4">
      {cautions.length > 0 && <Notice tone="warning" title="Before you start"><ul className="list-disc pl-5 space-y-1">{cautions.map((c) => <li key={c}>{c}</li>)}</ul></Notice>}
      <ol className="space-y-4">
        {steps.map((s, i) => (
          <li key={`${i}-${s.title}`} className="space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap"><span className="font-medium text-compact">{i + 1}. {s.title}</span>{s.risk === "high" && <Chip tone="critical">Changes data</Chip>}</div>
            {s.where && <div className="text-xs text-ink-3">On {s.where}</div>}
            {s.command && <CommandBlock command={s.command} />}
            {s.note && <p className="text-compact text-ink-2">{s.note}</p>}
          </li>
        ))}
      </ol>
      <p className="text-xs text-ink-3">Proxmox's API has no call for this, so ePaperclip gives you the exact commands rather than a button that cannot work. Run them in the node's shell.</p>
    </div>
  );
}

export const LEVEL: Record<string, { kind: StatusKind; label: string }> = { ok: { kind: "good", label: "Healthy" }, warning: { kind: "warning", label: "Needs attention" }, critical: { kind: "critical", label: "Act now" } };

export function Section({ title, hint, children, actions }: { title: string; hint?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div><h2 className="font-medium">{title}</h2>{hint && <p className="text-compact text-ink-3 mt-0.5">{hint}</p>}</div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Whole GiB or a plain number, for form fields. */
export const numOrUndef = (s: string): number | undefined => (s.trim() === "" || !Number.isFinite(Number(s)) ? undefined : Number(s));
