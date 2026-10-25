import type { ReactNode } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import { cn } from "../../../lib/storage.ts";
import { ResizeHandle } from "../../../ui/primitives.tsx";
import type { TileKind } from "./layout.ts";

/**
 * The tile column: panes stacked top to bottom (a plan, files, a terminal...), each with its title, its own actions,
 * expand (fills the column) and close. The line between two panes drags to share the height; the last pane takes the rest.
 */

export interface TileSpec { kind: TileKind; title: ReactNode; label: string; actions?: ReactNode; body: ReactNode }

export function TileStack({ tiles, heights, onHeight, expanded, onExpand, onClose }: {
  tiles: TileSpec[];
  heights: Partial<Record<TileKind, number>>;
  onHeight: (k: TileKind, h: number) => void;
  expanded: TileKind | null;
  onExpand: (k: TileKind | null) => void;
  onClose: (k: TileKind) => void;
}) {
  const shown = expanded ? tiles.filter((t) => t.kind === expanded) : tiles;
  return (
    <div className="flex flex-col min-h-0 h-full">
      {shown.map((t, i) => {
        const last = i === shown.length - 1;
        const h = heights[t.kind] ?? 320;
        return (
          <div key={t.kind} className={cn("flex flex-col min-h-0", last ? "flex-1" : "shrink-0")} style={last ? undefined : { height: h }}>
            <section aria-label={t.label} className="flex flex-col min-h-0 h-full bg-bg">
              <header className="h-11 shrink-0 flex items-center gap-1 pl-4 pr-2 border-b border-line">
                <div className="min-w-0 flex-1 truncate text-compact font-medium">{t.title}</div>
                {t.actions}
                <button type="button" aria-label={expanded === t.kind ? `Restore ${t.label}` : `Expand ${t.label}`} title={expanded === t.kind ? "Restore" : "Expand"} onClick={() => onExpand(expanded === t.kind ? null : t.kind)} className="transition-control h-7 w-7 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2">{expanded === t.kind ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}</button>
                <button type="button" aria-label={`Close ${t.label}`} title="Close" onClick={() => { if (expanded === t.kind) onExpand(null); onClose(t.kind); }} className="transition-control h-7 w-7 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2"><X className="h-3.5 w-3.5" /></button>
              </header>
              <div className="flex-1 min-h-0 overflow-hidden">{t.body}</div>
            </section>
            {!last && <ResizeHandle label={`${t.label} height`} orientation="horizontal" value={h} min={120} max={900} onChange={(v) => onHeight(t.kind, v)} className="border-b border-line" />}
          </div>
        );
      })}
    </div>
  );
}
