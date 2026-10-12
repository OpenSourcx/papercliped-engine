import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Table2 } from "lucide-react";
import { cn } from "../lib/storage.ts";

/**
 * A usage-over-time chart, like Proxmox's Summary graphs. One y-axis, thin 2px lines, a light area under the first
 * series, a crosshair and tooltip on hover, a legend when there are two series, and a table view. Single-series
 * charts use the accent; two-series charts use the validated --series-1 / --series-2 slots.
 */

export interface Series {
  key: string;
  label: string;
  values: (number | null)[];
  area?: boolean;
}

const COLORS = ["var(--series-1)", "var(--series-2)"];

/** A round axis top. Byte axes round in binary units (GiB, MiB) so ticks read 10 GiB, 20 GiB, not 11.6 GiB. */
export function niceMax(v: number, binary = false): number {
  if (v <= 0) return 1;
  if (binary && v >= 1024) {
    const unit = 1024 ** Math.floor(Math.log(v) / Math.log(1024));
    return niceMax(v / unit) * unit;
  }
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function timeLabel(sec: number, spanSec: number): string {
  const d = new Date(sec * 1000);
  if (spanSec <= 2 * 86400) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function TimeSeriesChart({ title, series, times, format, yMax, binary, height = 180, className }: { title: string; series: Series[]; times: number[]; format: (v: number) => string; yMax?: number; binary?: boolean; height?: number; className?: string }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  useLayoutEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const single = series.length === 1;
  const color = (i: number) => (single ? "var(--accent)" : COLORS[i % COLORS.length]);
  const m = { l: 52, r: 12, t: 10, b: 24 };
  const w = width - m.l - m.r;
  const h = height - m.t - m.b;
  const max = useMemo(() => yMax ?? niceMax(Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null))) * 1.1, binary), [series, yMax, binary]);
  const n = times.length;
  const x = (i: number) => m.l + (n <= 1 ? 0 : (i / (n - 1)) * w);
  const y = (v: number) => m.t + h - (Math.min(v, max) / max) * h;
  const path = (vals: (number | null)[]) => vals.map((v, i) => (v === null ? "" : `${i === 0 || vals[i - 1] === null ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join("");
  const area = (vals: (number | null)[]) => {
    const line = path(vals);
    return line ? `${line}L${x(n - 1).toFixed(1)},${m.t + h}L${x(0).toFixed(1)},${m.t + h}Z` : "";
  };
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const span = n > 1 ? times[n - 1] - times[0] : 3600;
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (n - 1)));
  const latest = series.map((s) => s.values[n - 1] ?? 0);
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / r.width) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  return (
    <figure className={cn("rounded-xl border border-line bg-surface m-0", className)} aria-labelledby={`${id}-t`}>
      <div className="flex items-center gap-3 px-4 pt-3">
        <figcaption id={`${id}-t`} className="text-sm font-medium flex-1">{title}</figcaption>
        {!single && (
          <div className="flex items-center gap-3 text-xs text-ink-2" aria-label="Legend">
            {series.map((s, i) => (
              <span key={s.key} className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: color(i) }} aria-hidden />{s.label}</span>
            ))}
          </div>
        )}
        <button onClick={() => setTable((t) => !t)} aria-pressed={table} className="h-7 px-2 rounded-md text-xs text-ink-3 hover:text-ink hover:bg-surface-2 inline-flex items-center gap-1" title="Show as table"><Table2 className="h-3.5 w-3.5" />Table</button>
      </div>
      {table ? (
        <div className="max-h-[220px] overflow-y-auto px-4 py-3">
          <table className="w-full text-xs tabular-nums">
            <thead><tr className="text-ink-3 text-left"><th className="font-normal py-1">Time</th>{series.map((s) => <th key={s.key} className="font-normal py-1 text-right">{s.label}</th>)}</tr></thead>
            <tbody>
              {times.map((t, i) => (
                <tr key={t} className="border-t border-line"><td className="py-1 text-ink-2">{new Date(t * 1000).toLocaleString()}</td>{series.map((s) => <td key={s.key} className="py-1 text-right">{s.values[i] === null ? "—" : format(s.values[i]!)}</td>)}</tr>
              )).reverse()}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={box} className="relative px-1 pb-2">
          <svg width={width} height={height} role="img" aria-label={`${title}. Latest ${series.map((s, i) => `${s.label} ${format(latest[i])}`).join(", ")}.`} className="block">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={m.l} x2={m.l + w} y1={y(t)} y2={y(t)} stroke="var(--line)" />
                <text x={m.l - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" fontSize="11" fill="var(--ink-3)">{format(t)}</text>
              </g>
            ))}
            {xTicks.map((i, k) => (
              <text key={k} x={x(i)} y={height - 6} textAnchor={k === 0 ? "start" : k === xTicks.length - 1 ? "end" : "middle"} fontSize="11" fill="var(--ink-3)">{n ? timeLabel(times[i], span) : ""}</text>
            ))}
            {series.map((s, i) => s.area && <path key={`a-${s.key}`} d={area(s.values)} fill={color(i)} opacity={0.18} />)}
            {series.map((s, i) => <path key={s.key} d={path(s.values)} fill="none" stroke={color(i)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
            {hover !== null && (
              <g pointerEvents="none">
                <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={m.t + h} stroke="var(--ink-3)" strokeDasharray="3 3" />
                {series.map((s, i) => s.values[hover] !== null && <circle key={s.key} cx={x(hover)} cy={y(s.values[hover]!)} r={4.5} fill={color(i)} stroke="var(--surface)" strokeWidth={2} />)}
              </g>
            )}
            <rect x={m.l} y={m.t} width={w} height={h} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
          </svg>
          {hover !== null && (
            <div className="pointer-events-none absolute top-2 z-(--z-raised) rounded-lg border border-line-strong bg-surface-3 px-3 py-2 text-xs shadow-overlay" style={{ left: Math.min(Math.max(x(hover) + 12, 8), width - 180) }}>
              <div className="text-ink-3 mb-1">{new Date(times[hover] * 1000).toLocaleString()}</div>
              {series.map((s, i) => (
                <div key={s.key} className="flex items-center gap-2 tabular-nums">
                  <span className="h-2 w-2 rounded-sm" style={{ background: color(i) }} aria-hidden />
                  <span className="text-ink-2">{s.label}</span>
                  <span className="ml-auto pl-3 text-ink">{s.values[hover] === null ? "—" : format(s.values[hover]!)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
