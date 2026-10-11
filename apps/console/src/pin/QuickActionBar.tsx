import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../lib/storage.ts";
import { usePin } from "./PinContext.tsx";
import type { QuickAction } from "./quickActions.ts";
import { splitSuggestions } from "./suggestions.ts";

const GROUPS = [
  { id: "do", label: "On this page" },
  { id: "ask", label: "Ask Pin" },
  { id: "go", label: "Go to" },
] as const;

/**
 * Pin's quick actions for the current page. The row holds at most three, preferring things to do; everything else is
 * one tap away in the More panel, grouped so it reads at a glance. Risky actions are confirmed first.
 */
export function QuickActionBar({ compact, onDone }: { compact?: boolean; onDone?: () => void }) {
  const pin = usePin();
  const [more, setMore] = useState(false);
  const actions = pin.actions;
  if (!actions || actions.items.length === 0) return null;
  const { main, rest } = splitSuggestions(actions.items, 3);
  const extra = rest.map((i) => actions.items[i]);

  const run = (a: QuickAction) => {
    // Always run the newest version of the action, never a stale copy.
    const current = pin.findLatest(a.id) ?? a;
    if (current.disabled) return;
    setMore(false);
    if (current.confirm) {
      pin.setConfirm(current);
      onDone?.();
      return;
    }
    current.run();
    onDone?.();
  };

  const chip = (a: QuickAction) => (
    <button
      key={a.id}
      onClick={() => run(a)}
      disabled={a.disabled}
      title={a.title ?? a.label}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border text-[13px] font-medium whitespace-nowrap transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0",
        compact ? "h-8 px-3" : "h-9 px-3.5",
        a.danger ? "border-critical/35 text-critical hover:bg-critical/10" : "border-line-strong bg-surface/70 hover:bg-surface-3 text-ink",
      )}
    >
      <span className={cn("shrink-0", !a.danger && "text-ink-2")}>{a.icon}</span>
      <span>{a.label}</span>
    </button>
  );

  const row = (a: QuickAction) => (
    <button
      key={a.id}
      onClick={() => run(a)}
      disabled={a.disabled}
      title={a.title}
      className={cn("flex items-center gap-2.5 h-9 px-2.5 rounded-lg text-left text-[13px] transition disabled:opacity-40 disabled:cursor-not-allowed min-w-0", a.danger ? "text-critical hover:bg-critical/10" : "text-ink hover:bg-surface-3")}
    >
      <span className={cn("shrink-0", !a.danger && "text-ink-3")}>{a.icon}</span>
      <span className="truncate">{a.label}</span>
    </button>
  );

  return (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-1.5 min-w-0">
        {main.map((i) => chip(actions.items[i]))}
        {extra.length > 0 && (
          <button onClick={() => setMore((m) => !m)} aria-expanded={more} className={cn("ml-auto inline-flex items-center gap-1 rounded-full text-[13px] font-medium whitespace-nowrap text-ink-2 hover:text-ink hover:bg-surface-3 shrink-0", compact ? "h-8 px-2.5" : "h-9 px-3")}>
            More <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", more && "rotate-180")} />
          </button>
        )}
      </div>
      {more && (
        <div className="mt-2 pt-2 border-t border-line space-y-2 fade-in">
          {GROUPS.map((g) => {
            const list = extra.filter((a) => (a.group ?? "do") === g.id);
            if (!list.length) return null;
            return (
              <div key={g.id} className="min-w-0">
                <div className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{g.label}</div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-1">{list.map(row)}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
