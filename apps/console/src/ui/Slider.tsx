import { useId, type CSSProperties } from "react";
import { cn } from "../lib/storage.ts";

/**
 * The one slider. A real `<input type="range">` underneath (keyboard, touch, forms and assistive technology for free),
 * drawn by `.slider` in index.css from tokens: a filled track in the accent, a round thumb, a focus ring. `variant`
 * swaps the track for a colour ramp (used by the colour picker); the ramp's inputs come from `--h`, `--s` and `--l`
 * set on a parent.
 */
export function Slider({ label, value, min, max, step = 1, onChange, format, variant, className, disabled }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  /** How the value reads next to the label ("10px", "62%"). Also the value announced by screen readers. */
  format?: (v: number) => string;
  variant?: "hue" | "saturation" | "lightness";
  className?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <div className={className}>
      <div className="mb-1 flex items-baseline justify-between gap-3 text-compact">
        <label htmlFor={id} className="text-ink-2">{label}</label>
        {format && <output htmlFor={id} className="tabular-nums text-ink-3">{format(value)}</output>}
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={format?.(value)}
        onChange={(e) => onChange(Number(e.target.value))}
        className={cn("slider", variant && `slider-${variant}`)}
        style={{ "--p": `${fill}%` } as CSSProperties}
      />
    </div>
  );
}
