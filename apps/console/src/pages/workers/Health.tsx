import { Status } from "../../ui/primitives.tsx";
import { BarMeter } from "../../ui/meters.tsx";
import { TimeSeriesChart } from "../../ui/TimeSeriesChart.tsx";
import { Card, EmptyState, SectionTitle } from "../../ui/primitives.tsx";
import { Activity } from "lucide-react";
import { Fact } from "./Hardware.tsx";
import { degrees, gb, pct, span } from "./util.ts";
import type { HistoryPoint, Stats, SvcState, WorkerStats } from "../../data/engine/fabric.ts";

const SVC: Record<SvcState, { kind: "good" | "off" | "critical" | "idle"; word: string }> = { active: { kind: "good", word: "running" }, inactive: { kind: "off", word: "stopped" }, failed: { kind: "critical", word: "failed" }, unknown: { kind: "idle", word: "unknown" } };
const NAMES = { worker: "Worker", ollama: "Ollama", tailscale: "Tailscale" } as const;

/** Three service states; state is a word and an icon, never colour alone (StatusDot). */
export function ServiceDots({ s }: { s: Record<"worker" | "ollama" | "tailscale", SvcState> }) {
  return <span className="inline-flex flex-wrap gap-x-3 gap-y-1">{(Object.keys(NAMES) as (keyof typeof NAMES)[]).map((k) => <Status key={k} kind={SVC[s[k]].kind} label={`${NAMES[k]} ${SVC[s[k]].word}`} />)}</span>;
}

function Charts({ pts, title }: { pts: HistoryPoint[]; title: string }) {
  const times = pts.map((p) => Math.floor(p.at / 1000));
  const col = (f: (p: HistoryPoint) => number | null) => pts.map(f);
  const hasGpu = pts.some((p) => p.gpu !== null);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <TimeSeriesChart title={`CPU, ${title}`} times={times} yMax={100} format={(v) => `${Math.round(v)}%`} series={[{ key: "cpu", label: "CPU", values: col((p) => p.cpu), area: true }]} />
      <TimeSeriesChart title={`Memory in use, ${title}`} times={times} yMax={100} format={(v) => `${Math.round(v)}%`} series={[{ key: "mem", label: "Memory", values: col((p) => p.memPct), area: true }]} />
      <TimeSeriesChart title={`Temperature, ${title}`} times={times} format={(v) => `${Math.round(v)} C`} series={[{ key: "t", label: "Temperature", values: col((p) => p.temp), area: true }]} />
      {hasGpu && <TimeSeriesChart title={`GPU load, ${title}`} times={times} yMax={100} format={(v) => `${Math.round(v)}%`} series={[{ key: "g", label: "GPU", values: col((p) => p.gpu), area: true }]} />}
    </div>
  );
}

export function HealthPanel({ data, cores }: { data: WorkerStats | undefined; cores: number | undefined }) {
  const s: Stats | null = data?.latest ?? null;
  if (!data || !s) return <Card><EmptyState icon={<Activity className="h-5 w-5" />} title="No health samples yet" body={data?.online ? "The worker sends a sample every 15 seconds. The first one arrives shortly." : "The worker is offline. Samples resume when it reconnects. Older workers that do not report health need updating."} /></Card>;
  const stale = Date.now() - s.at > 60_000;
  const disk = s.disk[0];
  return (
    <div className="grid gap-5">
      <Card className="p-4 sm:p-5">
        <SectionTitle>Right now{stale ? " (last sample is old)" : ""}</SectionTitle>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
          <div className="col-span-2">{s.cpu.pct !== null ? <BarMeter label="CPU" pct={s.cpu.pct} value={`${Math.round(s.cpu.pct)}% of ${cores ?? s.cpu.cores} cores`} /> : <Fact label="CPU">Measuring</Fact>}</div>
          <div className="col-span-2"><BarMeter label="Memory" pct={s.mem.totalMb ? (s.mem.usedMb / s.mem.totalMb) * 100 : 0} value={`${gb(s.mem.usedMb)} of ${gb(s.mem.totalMb)}`} /></div>
          {s.gpu && <div className="col-span-2">{s.gpu.utilPct !== null ? <BarMeter label={`GPU ${s.gpu.name}`} pct={s.gpu.utilPct} value={`${pct(s.gpu.utilPct)} (${s.gpu.source})`} /> : <Fact label={`GPU ${s.gpu.name}`}>Load not readable</Fact>}</div>}
          {disk && <div className="col-span-2"><BarMeter label={`Disk ${disk.path}`} pct={disk.totalGb ? ((disk.totalGb - disk.freeGb) / disk.totalGb) * 100 : 0} value={`${disk.freeGb.toFixed(0)} GB free of ${disk.totalGb.toFixed(0)} GB`} /></div>}
          <Fact label="Load (1, 5, 15 min)">{s.load ? s.load.map((n) => n.toFixed(2)).join(", ") : "n/a"}</Fact>
          <Fact label="Temperature">{degrees(s.gpu?.tempC ?? s.cpu.tempC)}</Fact>
          <Fact label="Swap">{s.mem.swapTotalMb ? `${gb(s.mem.swapUsedMb)} of ${gb(s.mem.swapTotalMb)}` : "None"}</Fact>
          <Fact label="Uptime">{span(s.uptimeS)}</Fact>
          <div className="col-span-2 sm:col-span-4"><dt className="text-micro uppercase tracking-label text-ink-3">Services</dt><dd className="mt-1 text-compact"><ServiceDots s={s.services} /></dd></div>
        </dl>
      </Card>
      <Card className="p-4 sm:p-5">
        <SectionTitle>Models and queue</SectionTitle>
        {!s.ollama ? <p className="text-compact text-ink-3">No Ollama answered on this machine.</p> : (
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
            <Fact label="Ollama" mono>{s.ollama.version ?? "running"}</Fact>
            <Fact label="Running / queued"><span className="tabular-nums">{s.ollama.running} / {s.ollama.queued}</span></Fact>
            <Fact label="In memory">{s.ollama.loaded.length ? s.ollama.loaded.map((m) => `${m.name} (${gb(m.sizeMb)})`).join(", ") : "Nothing loaded"}</Fact>
            <Fact label="Installed">{s.ollama.available.length ? s.ollama.available.map((m) => m.name).join(", ") : "None"}</Fact>
          </dl>
        )}
      </Card>
      <Card className="p-4 sm:p-5"><SectionTitle>Last hour</SectionTitle>{data.recent.length > 1 ? <Charts pts={data.recent} title="last hour" /> : <p className="text-compact text-ink-3">Collecting samples.</p>}</Card>
      <Card className="p-4 sm:p-5"><SectionTitle>Last 24 hours</SectionTitle>{data.history.length > 1 ? <Charts pts={data.history} title="last 24 hours" /> : <p className="text-compact text-ink-3">One point is kept every five minutes; charts appear after the second.</p>}</Card>
    </div>
  );
}
