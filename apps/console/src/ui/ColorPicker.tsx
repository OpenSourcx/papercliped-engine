import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/storage.ts";
import { Input } from "./primitives.tsx";
import { Slider } from "./Slider.tsx";

/**
 * The one colour picker, in place of the browser's. A round swatch opens a small popover with three sliders (hue,
 * saturation, lightness) and a hex field. Values are `#rrggbb`. It never shows the operating system's picker.
 */

const HEX = /^#[0-9a-f]{6}$/i;
const GAP = 6;
const WIDTH = 256;

interface Hsl { h: number; s: number; l: number }

export function hexToHsl(hex: string): Hsl {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0, l: Math.round(l * 100) };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: Math.round(h * 60) % 360, s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const sat = s / 100, lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => Math.round(255 * (lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function ColorPicker({ value, onChange, label, className }: { value: string; onChange: (hex: string) => void; label: string; className?: string }) {
  const uid = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const safe = HEX.test(value) ? value.toLowerCase() : hslToHex({ h: 0, s: 0, l: 50 });
  const cur = hexToHsl(safe);
  // Hue is kept apart: a grey has no hue of its own, and dragging saturation up from zero must not snap it to red.
  const [hue, setHue] = useState(cur.h);
  const [text, setText] = useState(safe);
  useEffect(() => {
    setText(safe);
    if (cur.s > 0 && cur.l > 0 && cur.l < 100) setHue(cur.h);
  }, [safe]); // eslint-disable-line react-hooks/exhaustive-deps

  const place = () => {
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - WIDTH - 8));
    const below = window.innerHeight - r.bottom;
    setPos(below >= 260 || below >= r.top ? { left, top: r.bottom + GAP } : { left, bottom: window.innerHeight - r.top + GAP });
  };
  useLayoutEffect(() => {
    if (!open) return;
    place();
    const again = () => place();
    window.addEventListener("resize", again);
    window.addEventListener("scroll", again, true);
    return () => {
      window.removeEventListener("resize", again);
      window.removeEventListener("scroll", again, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);

  const set = (next: Partial<Hsl>) => onChange(hslToHex({ h: hue, s: cur.s, l: cur.l, ...next }));
  const ramp = { "--h": hue, "--s": `${cur.s}%`, "--l": `${cur.l}%` } as CSSProperties;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={`${label}: ${safe}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? uid : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cn("transition-control h-9 w-9 shrink-0 rounded-full border border-line-strong outline-none hover:border-ink-3 focus-visible:ring-2 focus-visible:ring-accent/40", className)}
        style={{ backgroundColor: safe }}
      />
      {open && pos && createPortal(
        <div
          ref={panel}
          id={uid}
          role="dialog"
          aria-label={label}
          style={{ position: "fixed", left: pos.left, top: pos.top, bottom: pos.bottom, width: WIDTH }}
          className="glass solid menu-in z-(--z-popover) space-y-3 rounded-2xl p-3 shadow-overlay"
        >
          <div className="flex items-center gap-3">
            <span className="h-9 w-9 shrink-0 rounded-full border border-line-strong" style={{ backgroundColor: safe }} />
            <Input
              aria-label={`${label} (hex)`}
              value={text}
              maxLength={7}
              spellCheck={false}
              className="font-mono uppercase"
              onChange={(e) => {
                const v = e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`;
                setText(v);
                if (HEX.test(v)) onChange(v.toLowerCase());
              }}
              onBlur={() => setText(safe)}
            />
          </div>
          <div style={ramp} className="space-y-2">
            <Slider variant="hue" label="Hue" min={0} max={359} value={hue} onChange={(h) => { setHue(h); set({ h }); }} format={(v) => `${v}°`} />
            <Slider variant="saturation" label="Saturation" min={0} max={100} value={cur.s} onChange={(s) => set({ s })} format={(v) => `${v}%`} />
            <Slider variant="lightness" label="Lightness" min={0} max={100} value={cur.l} onChange={(l) => set({ l })} format={(v) => `${v}%`} />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
