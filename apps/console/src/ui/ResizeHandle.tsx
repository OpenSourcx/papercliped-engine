import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "../lib/storage.ts";

/**
 * The one handle for resizing panes: drag it, or focus it and use the arrow keys (Shift for bigger steps). It is a
 * WAI-ARIA window splitter, so screen readers hear the size. `edge` says which side of the pane it sits on, so dragging
 * outward always makes the pane bigger.
 */
export function ResizeHandle({ label, value, min, max, onChange, orientation = "vertical", edge = "end", className }: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  /** vertical: a line between side-by-side panes (changes a width); horizontal: between stacked panes (a height). */
  orientation?: "vertical" | "horizontal";
  /** Where the handle is on the pane it resizes: end (right/bottom) grows with the pointer, start (left/top) the other way. */
  edge?: "start" | "end";
  className?: string;
}) {
  const start = useRef<{ at: number; value: number } | null>(null);
  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)));
  const sign = edge === "end" ? 1 : -1;
  const pos = (e: PointerEvent) => (orientation === "vertical" ? e.clientX : e.clientY);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { at: pos(e), value };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current) onChange(clamp(start.current.value + sign * (pos(e) - start.current.at)));
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    start.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 12;
    const grow: Record<string, number> = orientation === "vertical" ? { ArrowRight: 1, ArrowLeft: -1 } : { ArrowDown: 1, ArrowUp: -1 };
    const d = grow[e.key];
    if (d) { e.preventDefault(); onChange(clamp(value + sign * d * step)); }
    else if (e.key === "Home") { e.preventDefault(); onChange(min); }
    else if (e.key === "End") { e.preventDefault(); onChange(max); }
  };

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={keys}
      className={cn(
        "group relative shrink-0 touch-none outline-none",
        orientation === "vertical" ? "w-1 -mx-0.5 cursor-col-resize" : "h-1 -my-0.5 cursor-row-resize",
        className,
      )}
    >
      <span aria-hidden className={cn("transition-control absolute bg-transparent group-hover:bg-accent/70 group-focus-visible:bg-accent group-active:bg-accent shadow-none group-hover:shadow-raised", orientation === "vertical" ? "inset-y-0 left-1/2 w-0.5 -translate-x-1/2 group-hover:w-1 group-active:w-1" : "inset-x-0 top-1/2 h-0.5 -translate-y-1/2 group-hover:h-1 group-active:h-1")} />
    </div>
  );
}
