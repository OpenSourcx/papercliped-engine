import type { ReactNode } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import { cn } from "../../../lib/storage.ts";
import { IconButton, ResizeHandle } from "../../../ui/primitives.tsx";
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
            <section aria-label={t.label} className="fade-in flex flex-col min-h-0 h-full bg-bg">
              <header className="h-12 shrink-0 flex items-center gap-0.5 pl-4 pr-2 border-b border-line">
                <div className="min-w-0 flex-1 truncate text-compact font-semibold">{t.title}</div>
                {t.actions}
                <IconButton variant="bare" size="xs" label={expanded === t.kind ? `Restore ${t.label}` : `Expand ${t.label}`} onClick={() => onExpand(expanded === t.kind ? null : t.kind)}>{expanded === t.kind ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</IconButton>
                <IconButton variant="bare" size="xs" label={`Close ${t.label}`} onClick={() => { if (expanded === t.kind) onExpand(null); onClose(t.kind); }}><X className="h-4 w-4" /></IconButton>
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
