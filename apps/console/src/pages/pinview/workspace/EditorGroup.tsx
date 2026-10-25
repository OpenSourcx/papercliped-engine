import type { KeyboardEvent, ReactNode } from "react";
import { MoreHorizontal, X } from "lucide-react";
import { cn } from "../../../lib/storage.ts";
import { Menu } from "../../../ui/primitives.tsx";

/**
 * The editor group: tabs over one content area, as in an editor. A preview tab (italic) is replaced by the next preview
 * until you keep it (double-click its tab, or start editing); a dot means unsaved changes. Middle-click or the × closes a
 * tab; the menu closes others or all.
 */

export interface TabHead { id: string; title: string; icon: ReactNode; preview?: boolean; dirty?: boolean; hint?: string }

export function EditorGroup({ tabs, active, onActivate, onClose, onKeep, onCloseMany, children }: {
  tabs: TabHead[];
  active: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onKeep: (id: string) => void;
  onCloseMany: (ids: string[]) => void;
  children: ReactNode;
}) {
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === active);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
      if (next) { onActivate(next.id); (e.currentTarget.querySelector(`[data-tab="${next.id}"]`) as HTMLElement | null)?.focus(); }
    } else if (e.key === "Delete" && active) { e.preventDefault(); onClose(active); }
  };
  return (
    <div className="flex flex-col min-h-0 h-full min-w-0">
      <div className="h-9 shrink-0 flex items-stretch border-b border-line">
        <div role="tablist" aria-label="Open editors" onKeyDown={keys} className="flex-1 min-w-0 flex items-stretch overflow-x-auto [scrollbar-width:thin]">
          {tabs.map((t) => {
            const on = t.id === active;
            return (
              <div key={t.id} className={cn("group relative flex items-center gap-1.5 pl-3 pr-1 border-r border-line shrink-0 max-w-56", on ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink-2 hover:bg-surface-2/50")}>
                {on && <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-accent" />}
                <button type="button" role="tab" data-tab={t.id} aria-selected={on} tabIndex={on ? 0 : -1} title={t.hint ?? t.title}
                  onClick={() => onActivate(t.id)} onDoubleClick={() => onKeep(t.id)} onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(t.id); } }}
                  className="min-w-0 flex items-center gap-1.5 h-full outline-none text-compact">
                  <span aria-hidden className="shrink-0">{t.icon}</span>
                  <span className={cn("truncate", t.preview && "italic")}>{t.title}</span>
                  {t.preview && <span className="sr-only"> (preview)</span>}
                </button>
                <button type="button" aria-label={`Close ${t.title}`} title="Close" onClick={() => onClose(t.id)}
                  className={cn("transition-control h-6 w-6 shrink-0 rounded-sm flex items-center justify-center hover:bg-surface-3", t.dirty ? "text-ink" : on ? "text-ink-3" : "text-transparent group-hover:text-ink-3 focus-visible:text-ink-3")}>
                  {t.dirty ? <span className="h-2 w-2 rounded-full bg-ink group-hover:hidden" aria-label="Unsaved changes" /> : null}
                  <X className={cn("h-3.5 w-3.5", t.dirty && "hidden group-hover:block")} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center px-1 border-l border-line">
          <Menu size="sm" label="Editor options" icon={<MoreHorizontal className="h-4 w-4" />} items={[
            { label: "Keep this tab open", onSelect: () => active && onKeep(active), disabled: !tabs.find((t) => t.id === active)?.preview },
            { kind: "separator" },
            { label: "Close others", onSelect: () => onCloseMany(tabs.filter((t) => t.id !== active).map((t) => t.id)), disabled: tabs.length < 2 },
            { label: "Close all", onSelect: () => onCloseMany(tabs.map((t) => t.id)), shortcut: "" },
          ]} />
        </div>
      </div>
      <div role="tabpanel" aria-label={tabs.find((t) => t.id === active)?.title ?? "Editor"} className="flex-1 min-h-0 overflow-hidden bg-bg">{children}</div>
    </div>
  );
}
