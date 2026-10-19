import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "../../ui/primitives.tsx";

/** Small helpers shared by the hardware, backup, SDN, mapping and bulk screens. */

export const when = (ts: number | null | undefined) => (ts ? new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "–");

/** One labelled fact: a caption above a value. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-ink-3">{label}</div>
      <div className="text-compact mt-0.5 break-words">{children}</div>
    </div>
  );
}

/** A table that scrolls sideways on a phone instead of breaking the page. */
export function DataTable({ head, children, min = 520, label }: { head: ReactNode[]; children: ReactNode; min?: number; label: string }) {
  return (
    <div className="overflow-x-auto edge-fade-x">
      <table className="w-full text-compact" style={{ minWidth: min }} aria-label={label}>
        <thead>
          <tr className="border-b border-line text-ink-3 text-left">
            {head.map((h, i) => <th key={i} scope="col" className="font-normal px-3 h-10 first:px-4 whitespace-nowrap">{h}</th>)}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export const Td = ({ children, mono, className }: { children?: ReactNode; mono?: boolean; className?: string }) => (
  <td className={`px-3 py-2.5 first:px-4 align-top ${mono ? "font-mono text-xs tabular-nums" : ""} ${className ?? ""}`}>{children}</td>
);

/** Copies text; says so for a moment. Clipboard access can be refused, so a failure is silent and the text stays selectable. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          },
          () => undefined,
        );
      }}
    >
      {done ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {done ? "Copied" : label}
    </Button>
  );
}

/** Splits "a=1,b=2" style Proxmox values for display. */
export const pairs = (s: string) => s.split(",").map((p) => p.trim()).filter(Boolean);
