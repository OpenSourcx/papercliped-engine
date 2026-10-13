import { useId } from "react";
import { cn } from "../lib/storage.ts";

/**
 * Meters show one ratio against a limit. One hue for the fill, the same hue faint for the track; the number is in
 * text ink, never in the series color. The exact values are always in the visible caption and in the tooltip.
 */

const clamp = (n: number) => Math.max(0, Math.min(100, n));

export function ArcMeter({ label, pct, caption }: { label: string; pct: number; caption: string }) {
  const id = useId();
  const v = clamp(pct);
  // Drawn in a fixed 168-unit box and scaled to the column, so three fit side by side on a phone.
  const size = 168;
  const stroke = 10;
  const r = (size - stroke) / 2;
  const c = size / 2;
  // 240 degree arc, open at the bottom.
  const start = (150 * Math.PI) / 180;
  const sweep = (240 * Math.PI) / 180;
  const pt = (a: number) => `${c + r * Math.cos(a)} ${c + r * Math.sin(a)}`;
  const arc = (frac: number) => `M ${pt(start)} A ${r} ${r} 0 ${sweep * frac > Math.PI ? 1 : 0} 1 ${pt(start + sweep * frac)}`;
  return (
    <figure className="flex flex-col items-center w-full max-w-[168px] m-0" title={`${label}: ${v.toFixed(0)}% (${caption})`}>
      <div className="relative w-full" style={{ aspectRatio: "1 / 0.82" }}>
        <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-labelledby={id} className="absolute inset-x-0 top-0 w-full h-auto">
          <title id={id}>{`${label} ${v.toFixed(0)} percent, ${caption}`}</title>
          <path d={arc(1)} fill="none" stroke="var(--accent)" strokeOpacity={0.16} strokeWidth={stroke} strokeLinecap="round" />
          {v > 0.5 && <path d={arc(v / 100)} fill="none" stroke="var(--accent)" strokeWidth={stroke} strokeLinecap="round" />}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center pt-[6%]">
          <div className="text-meter font-semibold tracking-tight tabular-nums leading-none">{v.toFixed(0)}<span className="text-unit text-ink-2">%</span></div>
          <div className="text-meter-caption font-medium text-ink-2 mt-1">{label}</div>
        </div>
      </div>
      <figcaption className="text-meter-caption text-ink-3 tabular-nums text-center leading-snug">{caption}</figcaption>
    </figure>
  );
}

export function BarMeter({ label, pct, value, className }: { label: string; pct: number; value: string; className?: string }) {
  const v = clamp(pct);
  return (
    <div className={cn("min-w-0", className)} title={`${label}: ${value}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs mb-1.5">
        <span className="text-ink-3">{label}</span>
        <span className="text-ink-2 tabular-nums">{value}</span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "color-mix(in oklab, var(--accent) 16%, transparent)" }} role="meter" aria-label={label} aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-accent transition-[width] duration-(--duration-deliberate)" style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}
