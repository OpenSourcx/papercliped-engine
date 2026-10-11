import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../lib/storage.ts";
import { usePin } from "./PinContext.tsx";
import type { QuickAction } from "./quickActions.ts";

/** Pin's quick actions for the current page: main actions in a row, the rest under More, risky ones confirmed first. */
export function QuickActionBar({ compact, onDone }: { compact?: boolean; onDone?: () => void }) {
  const pin = usePin();
  const [more, setMore] = useState(false);
  const actions = pin.actions;
  if (!actions || actions.items.length === 0) return null;
  const main = actions.items.filter((a) => !a.more);
  const extra = actions.items.filter((a) => a.more);

  const run = (a: QuickAction) => {
    // Always run the newest version of the action, never a stale copy.
    const current = pin.findLatest(a.id) ?? a;
    if (current.disabled) return;
    if (current.confirm) {
      pin.setConfirm(current);
      onDone?.();
      return;
    }
    current.run();
    setMore(false);
    onDone?.();
  };

  const btn = (a: QuickAction) => (
    <button
      key={a.id}
      onClick={() => run(a)}
      disabled={a.disabled}
      title={a.title ?? a.label}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border text-[13px] font-medium whitespace-nowrap transition disabled:opacity-40 disabled:cursor-not-allowed",
        compact ? "h-8 px-3" : "h-9 px-3.5",
        a.danger ? "border-critical/35 text-critical hover:bg-critical/10" : "border-line-strong bg-surface/70 hover:bg-surface-3 text-ink",
      )}
    >
      <span className={a.danger ? "" : "text-ink-2"}>{a.icon}</span>
      {a.label}
    </button>
  );

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
        {main.map(btn)}
        {extra.length > 0 && (
          <button onClick={() => setMore((m) => !m)} aria-expanded={more} className={cn("inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface/70 hover:bg-surface-3 text-[13px] font-medium whitespace-nowrap", compact ? "h-8 px-3" : "h-9 px-3.5")}>
            More <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", more && "rotate-180")} />
          </button>
        )}
      </div>
      {more && <div className="flex flex-wrap items-center gap-1.5 mt-1.5 fade-in">{extra.map(btn)}</div>}
    </div>
  );
}
