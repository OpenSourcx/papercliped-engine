import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Params } from "@papercliped-engine/proxmox-client/wizard-schema";
import { cn } from "../../../lib/storage.ts";
import { Notice, Spinner } from "../../../ui/primitives.tsx";
import { SwitchRow } from "./fields.tsx";
import type { Row } from "./summary.ts";

/** The last step: what will be created in plain words, every warning, and the exact Proxmox request with secrets hidden. */
export function ConfirmStep({ kind, rows, warnings, error, params, loading, start, setStart, startHint }: { kind: "vm" | "ct"; rows: Row[] | null; warnings: string[]; error: { message: string; step: string } | null; params: Params | null; loading: boolean; start: boolean; setStart: (v: boolean) => void; startHint: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-5">
      {error ? (
        <Notice tone="critical" title="One thing needs fixing before this can be created">{error.message} <span className="text-ink-3">(Go back to the {error.step} step.)</span></Notice>
      ) : (
        warnings.length > 0 && (
          <Notice tone="warning" title={warnings.length === 1 ? "Worth a look" : "Worth a look before you create it"}>
            <ul className="list-disc pl-4 space-y-0.5">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          </Notice>
        )
      )}
      {rows && (
        <dl className="rounded-xl border border-line divide-y divide-line">
          {rows.map((r) => (
            <div key={r.label} className="grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-x-4 gap-y-0.5 px-4 py-2.5">
              <dt className="text-compact text-ink-3">{r.label}</dt>
              <dd className="text-compact text-ink min-w-0">{r.value.map((v) => <div key={v} className="break-words">{v}</div>)}</dd>
            </div>
          ))}
        </dl>
      )}
      <SwitchRow label="Start after created" hint={startHint} checked={start} onChange={setStart} />
      <div>
        <button type="button" onClick={() => setOpen((x) => !x)} aria-expanded={open} className="text-compact text-ink-2 hover:text-ink inline-flex items-center gap-1">
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />What will be sent to Proxmox
        </button>
        {open && (
          <div className="mt-2 fade-in">
            {loading && !params ? (
              <Spinner label="Checking with the device" />
            ) : params ? (
              <pre aria-label="Proxmox request" className="rounded-lg bg-code border border-line p-3 text-xs leading-relaxed font-mono text-ink-2 max-h-72 overflow-auto whitespace-pre-wrap break-all">{Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k} = ${typeof v === "boolean" ? (v ? 1 : 0) : v}`).join("\n")}</pre>
            ) : (
              <p className="text-xs text-ink-3">Fix the problem above to see the request.</p>
            )}
            <p className="text-xs text-ink-3 mt-1.5">Passwords and keys are sent to Proxmox but never shown here.</p>
          </div>
        )}
      </div>
    </div>
  );
}
