import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/storage.ts";

/**
 * The one popover the composer opens for "/" and "@": a list anchored to the field and opened upward, so it never needs
 * a tall column. It fits Pin's island panel (480 wide) and widens where there is room (PinView's column); it is never
 * wider than the window. It follows the WAI-ARIA listbox pattern: the field keeps focus and passes keys here, arrow keys
 * move, Enter or Tab chooses, Escape closes. Every row is at least 36 tall, 44 on a touch screen.
 */

export interface PopoverItem {
  /** Stable key for React. */
  key: string;
  label: string;
  /** A second line: what a command does, or an agent's role and organization. */
  detail?: string;
  icon?: ReactNode;
  /** Right-aligned hint, e.g. the command name without its slash. */
  hint?: string;
  disabled?: boolean;
}

export interface PopoverGroup {
  /** A heading over a run of rows, e.g. "Agents". */
  label?: string;
  items: PopoverItem[];
}

const GAP = 8;

/** The list itself. `anchor` is the composer's field: the list sits above it, at least as wide, and inside the window. */
export function ComposerPopover({ id, anchor, groups, active, label, onChoose, onHover }: {
  /** The id the field's `aria-controls` points at. */
  id: string;
  anchor: HTMLElement | null;
  groups: PopoverGroup[];
  /** The index of the highlighted row, counting rows in order across groups. */
  active: number;
  label: string;
  onChoose: (item: PopoverItem) => void;
  onHover: (index: number) => void;
}) {
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const uid = id;
  const rows = groups.flatMap((g) => g.items);

  useLayoutEffect(() => {
    const r = anchor?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(Math.max(r.width, 288), Math.min(560, window.innerWidth - 16));
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    setPos({ left, bottom: window.innerHeight - r.top + GAP, width });
  }, [anchor, groups]);

  // Keep the highlighted row in view inside the list as the arrow keys move. This scrolls the list only: scrolling the
  // row into view with `scrollIntoView` would move the page (and the field) whenever the pointer crossed a row.
  useEffect(() => {
    const box = list.current;
    const el = box?.querySelector<HTMLElement>('[data-active="true"]');
    if (!box || !el) return;
    const top = el.offsetTop - box.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
  }, [active]);

  if (!pos) return null;
  let i = -1;
  return createPortal(
    <div
      ref={list}
      id={uid}
      role="listbox"
      aria-label={label}
      aria-activedescendant={rows[active] ? `${uid}-${active}` : undefined}
      style={{ position: "fixed", left: pos.left, bottom: pos.bottom, width: pos.width, maxHeight: Math.min(320, window.innerHeight - 120) }}
      className="glass solid menu-in z-(--z-popover) overflow-y-auto overflow-x-hidden rounded-2xl p-1.5 shadow-overlay"
    >
      {groups.map((g, gi) => (
        <div key={g.label ?? `g${gi}`} role="group" aria-label={g.label}>
          {g.label && <div className="px-2.5 pt-2 pb-1 text-xs font-medium text-ink-3">{g.label}</div>}
          {g.items.map((it) => {
            i += 1;
            const index = i;
            const on = index === active && !it.disabled;
            return (
              <div
                key={it.key}
                id={`${uid}-${index}`}
                role="option"
                aria-selected={on}
                aria-disabled={it.disabled || undefined}
                data-active={on}
                onMouseMove={() => !it.disabled && onHover(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => !it.disabled && onChoose(it)}
                className={cn("flex items-center gap-2.5 rounded-lg px-2.5 min-h-9 py-1.5 text-sm select-none", it.disabled ? "text-ink-3 opacity-60" : "cursor-pointer text-ink", on && "bg-surface-3")}
              >
                {it.icon && <span aria-hidden className="shrink-0 text-ink-3">{it.icon}</span>}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{it.label}</span>
                  {it.detail && <span className="block truncate text-xs text-ink-3">{it.detail}</span>}
                </span>
                {it.hint && <span className="shrink-0 font-mono text-xs text-ink-3">{it.hint}</span>}
              </div>
            );
          })}
        </div>
      ))}
      {!rows.length && <div className="px-2.5 py-2 text-sm text-ink-3">Nothing matches yet.</div>}
    </div>,
    document.body,
  );
}

/** Which of these keys the field should give to the popover instead of handling itself. */
export function popoverKey(e: KeyboardEvent, rows: number): "up" | "down" | "first" | "last" | "choose" | "complete" | "close" | null {
  if (e.nativeEvent.isComposing) return null;
  if (e.key === "ArrowUp") return "up";
  if (e.key === "ArrowDown") return "down";
  // Home and End stay the field's own (start and end of the line) unless there is a list to move through.
  if (e.key === "Home" && rows > 0 && e.ctrlKey === false && e.metaKey === false) return "first";
  if (e.key === "End" && rows > 0 && e.ctrlKey === false && e.metaKey === false) return "last";
  if (e.key === "Escape") return "close";
  // Nothing to choose from: Enter sends the message as it always did, and Escape still closes the popover.
  if (e.key === "Enter" && rows > 0) return "choose";
  if (e.key === "Tab" && !e.shiftKey && rows > 0) return "complete";
  return null;
}
