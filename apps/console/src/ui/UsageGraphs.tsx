import { useMemo, useState } from "react";
import type { RrdCf, RrdTimeframe } from "@papercliped-engine/proxmox-client";
import { demoRrd, TIMEFRAMES, type RrdBase } from "../data/rrd.ts";
import { formatBytes } from "../lib/storage.ts";
import { Segmented } from "./primitives.tsx";
import { TimeSeriesChart } from "./TimeSeriesChart.tsx";

const rate = (v: number) => `${formatBytes(v)}/s`;
const pct = (v: number) => `${v < 10 && v > 0 ? v.toFixed(1) : Math.round(v)}%`;

/** The Summary graphs for a machine or the node: CPU, memory, network and disk, over Proxmox's timeframes. */
export function UsageGraphs({ seed, base, kind }: { seed: number; base: RrdBase; kind: "guest" | "node" }) {
  const [timeframe, setTimeframe] = useState<RrdTimeframe>("hour");
  const [cf, setCf] = useState<RrdCf>("AVERAGE");
  const points = useMemo(() => demoRrd(seed, timeframe, cf, base), [seed, timeframe, cf, base]);
  const times = points.map((p) => p.time);
  const col = (k: keyof (typeof points)[number], f = (v: number) => v) => points.map((p) => (typeof p[k] === "number" ? f(p[k] as number) : null));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <Segmented size="sm" value={timeframe} onChange={setTimeframe} options={TIMEFRAMES.map((t) => ({ value: t.id, label: t.label }))} />
        <Segmented size="sm" value={cf} onChange={setCf} options={[{ value: "AVERAGE", label: "Average" }, { value: "MAX", label: "Maximum" }]} />
      </div>
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
