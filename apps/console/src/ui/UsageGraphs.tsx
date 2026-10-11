import { useEffect, useMemo, useState } from "react";
import type { RrdCf, RrdPoint, RrdTimeframe } from "@papercliped-engine/proxmox-client";
import { api, ApiError } from "../data/api.ts";
import { normalizeRrd } from "../data/live.ts";
import { demoRrd, TIMEFRAMES, type RrdBase } from "../data/rrd.ts";
import { useEngine } from "../data/store.tsx";
import { formatBytes } from "../lib/storage.ts";
import { Segmented } from "./primitives.tsx";
import { TimeSeriesChart } from "./TimeSeriesChart.tsx";

const rate = (v: number) => `${formatBytes(v)}/s`;
const pct = (v: number) => `${v < 10 && v > 0 ? v.toFixed(1) : Math.round(v)}%`;

/**
 * The Summary graphs for a machine or the node: CPU, memory, network and disk, over Proxmox's timeframes. Live, they
 * read Proxmox's own statistics as the signed-in user; in the demo they draw generated history.
 */
export function UsageGraphs({ seed, base, kind, vmid }: { seed: number; base: RrdBase; kind: "guest" | "node"; vmid?: number }) {
  const { live } = useEngine();
  const [timeframe, setTimeframe] = useState<RrdTimeframe>("hour");
  const [cf, setCf] = useState<RrdCf>("AVERAGE");
  const [livePoints, setLivePoints] = useState<RrdPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!live) return;
    let alive = true;
    const target = kind === "node" ? ({ kind: "node" } as const) : ({ kind: "guest", vmid: vmid ?? seed } as const);
    const load = () =>
      api.stats(target, timeframe, cf).then(
        (p) => alive && (setLivePoints(normalizeRrd(p)), setError(null)),
        (e) => alive && setError(e instanceof ApiError ? e.message : "Couldn't load usage history"),
      );
    load();
    // Proxmox samples every minute at the hour view; longer views change slowly.
    const t = setInterval(load, timeframe === "hour" ? 60_000 : 10 * 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [live, kind, vmid, seed, timeframe, cf]);
  const demo = useMemo(() => (live ? [] : demoRrd(seed, timeframe, cf, base)), [live, seed, timeframe, cf, base]);
  const points = live ? (livePoints ?? []) : demo;
  const times = points.map((p) => p.time);
  const col = (k: keyof (typeof points)[number], f = (v: number) => v) => points.map((p) => (typeof p[k] === "number" ? f(p[k] as number) : null));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <Segmented size="sm" value={timeframe} onChange={setTimeframe} options={TIMEFRAMES.map((t) => ({ value: t.id, label: t.label }))} />
        <Segmented size="sm" value={cf} onChange={setCf} options={[{ value: "AVERAGE", label: "Average" }, { value: "MAX", label: "Maximum" }]} />
      </div>
      {error && <p role="alert" className="text-[13px] text-critical mb-3">{error}</p>}
      <div className="grid lg:grid-cols-2 gap-4">
        {kind === "node" ? (
          <TimeSeriesChart title="CPU and IO delay" series={[{ key: "cpu", label: "CPU", values: col("cpu", (v) => v * 100), area: true }, { key: "io", label: "IO delay", values: col("iowait", (v) => v * 100) }]} times={times} format={pct} />
        ) : (
          <TimeSeriesChart title={`CPU usage (of ${base.maxcpu} core${base.maxcpu === 1 ? "" : "s"})`} series={[{ key: "cpu", label: "CPU", values: col("cpu", (v) => v * 100), area: true }]} times={times} format={pct} yMax={undefined} />
        )}
        <TimeSeriesChart title="Memory" series={[{ key: "used", label: "Used", values: col("mem"), area: true }, { key: "total", label: "Total", values: col("maxmem") }]} times={times} format={formatBytes} binary />
        <TimeSeriesChart title="Network traffic" series={[{ key: "in", label: "In", values: col("netin"), area: true }, { key: "out", label: "Out", values: col("netout") }]} times={times} format={rate} binary />
        {kind === "node" ? (
          <TimeSeriesChart title="Server load" series={[{ key: "load", label: "Load average", values: col("loadavg"), area: true }]} times={times} format={(v) => v.toFixed(2)} />
        ) : (
          <TimeSeriesChart title="Disk IO" series={[{ key: "read", label: "Read", values: col("diskread"), area: true }, { key: "write", label: "Write", values: col("diskwrite") }]} times={times} format={rate} binary />
        )}
      </div>
    </div>
  );
}
