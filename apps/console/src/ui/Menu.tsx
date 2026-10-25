import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../lib/storage.ts";

/**
 * The one menu: a small button that opens a list of actions, the way a desktop app's "⋯" menu does. Entries are actions
 * (with an optional shortcut hint, red when they destroy something), checkboxes that stay open while you tick them,
 * headings and separators. It follows the WAI-ARIA menu pattern: arrow keys move, Enter or Space runs, Escape closes and
 * gives focus back to the button. Use it instead of hand-made popovers (DESIGN.md, "One definition per control").
 */

export type MenuEntry =
  | { kind?: "item"; label: string; shortcut?: string; danger?: boolean; disabled?: boolean; icon?: ReactNode; onSelect: () => void }
  | { kind: "check"; label: string; checked: boolean; onToggle: (next: boolean) => void }
  | { kind: "heading"; label: string }
  | { kind: "separator" };

const GAP = 6;
const WIDTH = 224;

export function Menu({ label, icon, text, items, align = "end", className, size = "md" }: { label: string; icon?: ReactNode; /** Words instead of an icon (a status line's "Agent mode"); the button then shows a small caret. */ text?: ReactNode; items: MenuEntry[]; align?: "start" | "end"; className?: string; size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const uid = useId();
  const actionable = (i: number) => {
    const e = items[i];
    return !!e && (e.kind === undefined || e.kind === "item" || e.kind === "check") && !("disabled" in e && e.disabled);
  };
  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < items.length; i += dir) if (actionable(i)) return i;
    return from;
  };

  const close = useCallback((focus = true) => {
    setOpen(false);
    setActive(-1);
    if (focus) button.current?.focus({ preventScroll: true });
  }, []);

  const place = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(align === "end" ? r.right - WIDTH : r.left, window.innerWidth - WIDTH - 8));
    const room = window.innerHeight - r.bottom;
    setPos(room < items.length * 34 + 16 && r.top > room ? { left, bottom: window.innerHeight - r.top + GAP } : { left, top: r.bottom + GAP });
  };

  const show = (first = false) => {
    place();
    setOpen(true);
    setActive(first ? step(-1, 1) : -1);
  };

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !list.current?.contains(t)) close(false);
    };
    const moved = () => close(false);
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", moved);
    window.addEventListener("scroll", moved, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", moved);
      window.removeEventListener("scroll", moved, true);
    };
  }, [open, close]);

  useEffect(() => {
    if (open) list.current?.focus({ preventScroll: true });
  }, [open]);

  const run = (i: number) => {
    const e = items[i];
    if (!e || !actionable(i)) return;
    if (e.kind === "check") return e.onToggle(!e.checked);
    if (e.kind === undefined || e.kind === "item") {
      close();
      e.onSelect();
    }
  };

  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      close(e.key === "Escape");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => step(a, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => step(a < 0 ? items.length : a, -1));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? step(-1, 1) : step(items.length, -1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      run(active);
    }
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? uid : undefined}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            show(true);
          }
        }}
        className={cn("transition-control inline-flex items-center justify-center shrink-0 rounded-md text-ink-3 hover:text-ink hover:bg-surface-2 aria-expanded:bg-surface-3 aria-expanded:text-ink", text ? "gap-1 px-2 text-xs max-w-full min-w-0 " : "", size === "sm" ? "h-7 pointer-coarse:h-11" : "h-8 pointer-coarse:h-11", !text && (size === "sm" ? "w-7 pointer-coarse:w-11" : "w-8 pointer-coarse:w-11"), className)}
      >
        {text ? <><span className="truncate">{text}</span><ChevronDown className="h-3 w-3 shrink-0" aria-hidden /></> : icon}
      </button>
      {open && pos && createPortal(
        <div
          ref={list}
          id={uid}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={keys}
          style={{ position: "fixed", left: pos.left, top: pos.top, bottom: pos.bottom, width: WIDTH }}
          className="glass solid menu-in z-(--z-popover) rounded-2xl p-1.5 shadow-overlay outline-none"
        >
          {items.map((it, i) => {
            if (it.kind === "separator") return <div key={`s${i}`} role="separator" className="my-1 h-px bg-line" />;
            if (it.kind === "heading") return <div key={`h${i}`} className="px-2.5 pt-2 pb-1 text-xs font-medium text-ink-3">{it.label}</div>;
            const check = it.kind === "check";
            const disabled = !check && !!it.disabled;
            return (
              <div
                key={`i${i}`}
                role={check ? "menuitemcheckbox" : "menuitem"}
                aria-checked={check ? it.checked : undefined}
                aria-disabled={disabled || undefined}
                onMouseMove={() => !disabled && setActive(i)}
                onClick={() => run(i)}
                className={cn("flex items-center gap-2.5 rounded-lg px-2.5 h-9 text-sm select-none", disabled ? "text-ink-3 opacity-60" : "cursor-pointer", !check && it.danger ? "text-critical" : "text-ink", active === i && !disabled && "bg-surface-3")}
              >
                {check ? (
                  <span aria-hidden className={cn("h-4 w-4 shrink-0 rounded border flex items-center justify-center", it.checked ? "bg-accent border-accent text-on-status" : "border-line-strong")}>{it.checked && <Check className="h-3 w-3" />}</span>
                ) : it.icon ? <span aria-hidden className="shrink-0 text-ink-3">{it.icon}</span> : null}
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {!check && it.shortcut && <span className="text-xs text-ink-3 shrink-0">{it.shortcut}</span>}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
