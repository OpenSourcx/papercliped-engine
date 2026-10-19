import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type SelectHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "../lib/storage.ts";

/**
 * The one dropdown. It is a real `<select>` underneath (so forms, labels, tests, autofill and assistive technology keep
 * working exactly as before), laid invisibly over a field that looks like ours; opening it shows our own list instead of
 * the browser's, which can't be styled. Same props as a `<select>`: `value`, `onChange`, `<option>`, `<optgroup>`.
 */

type Item = { kind: "group"; label: string } | { kind: "option"; value: string; label: string; disabled: boolean };

/** The sizes the console's controls come in (DESIGN.md): xs for dense table rows, sm for toolbars, md the default, lg and xl for roomy forms. */
const SIZES = {
  xs: "h-7 pl-2 pr-7 text-xs rounded-md",
  sm: "h-9 pl-3 pr-8 text-compact rounded-lg",
  md: "h-10 pl-3 pr-9 text-sm rounded-lg",
  lg: "h-11 pl-3 pr-9 text-body rounded-lg",
  xl: "h-12 pl-4 pr-10 text-body rounded-xl",
} as const;

const GAP = 4;
const MAX_H = 288;

const itemsOf = (el: HTMLSelectElement): Item[] => {
  const out: Item[] = [];
  for (const c of Array.from(el.children)) {
    if (c instanceof HTMLOptGroupElement) {
      out.push({ kind: "group", label: c.label });
      for (const o of Array.from(c.children) as HTMLOptionElement[]) out.push({ kind: "option", value: o.value, label: o.text, disabled: o.disabled || c.disabled });
    } else if (c instanceof HTMLOptionElement) out.push({ kind: "option", value: c.value, label: c.text, disabled: c.disabled });
  }
  return out;
};

export function Select({ className, children, size = "md", onMouseDown, onKeyDown, onBlur, ...rest }: Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & { size?: keyof typeof SIZES }) {
  const native = useRef<HTMLSelectElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; max: number } | null>(null);
  const typed = useRef({ text: "", at: 0 });

  // What the field shows is whichever option the select has chosen, read after every render so it can't drift.
  useLayoutEffect(() => {
    const t = native.current?.selectedOptions[0]?.text ?? "";
    if (t !== label) setLabel(t);
  });

  const close = useCallback(() => setOpen(false), []);

  /** Where the list goes: under the field, or above it when there is more room there. */
  const place = (count: number) => {
    const box = wrap.current;
    if (!box) return;
    const r = box.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - GAP - 8;
    const above = r.top - GAP - 8;
    const flip = below < Math.min(MAX_H, count * 36 + 8) && above > below;
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - r.width - 8)), width: r.width, ...(flip ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }), max: Math.min(MAX_H, flip ? above : below) });
  };

  const show = () => {
    const el = native.current;
    if (!el || !wrap.current || el.disabled) return;
    const all = itemsOf(el);
    place(all.length);
    setItems(all);
    setActive(all.findIndex((i) => i.kind === "option" && i.value === el.value));
    setOpen(true);
  };

  const choose = (value: string) => {
    const el = native.current;
    if (el && el.value !== value) {
      // Set the value the way a user's choice would, so React's onChange runs with a real change event.
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    close();
    el?.focus({ preventScroll: true });
  };

  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < items.length; i += dir) if (items[i].kind === "option" && !(items[i] as { disabled: boolean }).disabled) return i;
    return from;
  };

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      const t = e.target as Node;
      if (!wrap.current?.contains(t) && !list.current?.contains(t)) close();
    };
    // The page scrolled or resized under the open list: follow the field instead of closing.
    const moved = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) place(items.length);
    };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, close, items.length]);

  useEffect(() => {
    // Keep the active row in view by moving the list itself (never the page behind it).
    const box = list.current;
    const row = box?.querySelector<HTMLElement>(`[data-i="${active}"]`);
    if (open && box && row) {
      if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop - 4;
      else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight + 4;
    }
  }, [open, active]);

  const keys = (e: KeyboardEvent<HTMLSelectElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (!open) {
      if (e.key === " " || e.key === "Enter" || ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.altKey)) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => step(a, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => step(a, -1));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? step(-1, 1) : step(items.length, -1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const it = items[active];
      if (it?.kind === "option" && !it.disabled) choose(it.value);
      else close();
    } else if (e.key === "Tab") close();
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      const t = typed.current;
      t.text = now - t.at > 600 ? e.key.toLowerCase() : t.text + e.key.toLowerCase();
      t.at = now;
      const hit = items.findIndex((i) => i.kind === "option" && !i.disabled && i.label.toLowerCase().startsWith(t.text));
      if (hit >= 0) setActive(hit);
    }
  };

  return (
    <div
      ref={wrap}
      data-open={open || undefined}
      className={cn("transition-control relative flex items-center w-full bg-surface-2 border border-line text-ink hover:border-line-strong focus-within:border-line-strong focus-within:ring-2 focus-within:ring-accent/30 has-[:disabled]:opacity-50 has-[:disabled]:hover:border-line", SIZES[size], className)}
    >
      <span data-label={label} className="select-display block min-w-0 flex-1 truncate" aria-hidden />
      <ChevronsUpDown className="absolute right-3 h-4 w-4 text-ink-3 pointer-events-none" aria-hidden />
      <select
        {...rest}
        ref={native}
        aria-expanded={open}
        aria-activedescendant={open && active >= 0 ? `${uid}-${active}` : undefined}
        onMouseDown={(e) => {
          onMouseDown?.(e);
          if (e.defaultPrevented || e.button !== 0 || e.currentTarget.disabled) return;
          // Our list opens instead of the browser's.
          e.preventDefault();
          e.currentTarget.focus({ preventScroll: true });
          if (open) close();
          else show();
        }}
        onKeyDown={keys}
        onBlur={(e) => {
          onBlur?.(e);
          if (open && !list.current?.contains(e.relatedTarget as Node)) close();
        }}
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0 outline-none disabled:cursor-not-allowed"
      >
        {children}
      </select>
      {open && pos && createPortal(
        <div
          ref={list}
          role="listbox"
          aria-label={rest["aria-label"]}
          style={{ position: "fixed", left: pos.left, minWidth: pos.width, maxHeight: pos.max, top: pos.top, bottom: pos.bottom }}
          className="glass solid menu-in z-(--z-popover) overflow-y-auto overflow-x-hidden rounded-2xl p-1.5 shadow-overlay"
          onMouseDown={(e) => e.preventDefault()}
        >
          {items.map((it, i) =>
            it.kind === "group" ? (
              <div key={`g${i}`} className="px-2.5 pt-2 pb-1 text-micro font-semibold uppercase tracking-label text-ink-3">{it.label}</div>
            ) : (
              <div
                key={`o${i}`}
                id={`${uid}-${i}`}
                data-i={i}
                role="option"
                aria-selected={it.value === native.current?.value}
                aria-disabled={it.disabled || undefined}
                onMouseMove={() => !it.disabled && setActive(i)}
                onClick={() => !it.disabled && choose(it.value)}
                className={cn("flex items-center gap-2 rounded-lg px-2.5 h-9 text-sm", it.disabled ? "text-ink-3 opacity-60" : "cursor-pointer text-ink", active === i && !it.disabled && "bg-surface-3")}
              >
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {it.value === native.current?.value && <Check className="h-4 w-4 shrink-0 text-accent" aria-hidden />}
              </div>
            ),
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
