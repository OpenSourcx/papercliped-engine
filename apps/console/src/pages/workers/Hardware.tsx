import type { ReactNode } from "react";
import { Chip } from "../../ui/primitives.tsx";
import type { Capabilities } from "../../data/engine/fabric.ts";
import { gb, gpuText, modelNames } from "./util.ts";

/** A label over a value; machine values are mono. */
export function Fact({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-micro uppercase tracking-label text-ink-3">{label}</dt>
      <dd className={`mt-0.5 text-compact text-ink break-words ${mono ? "font-mono tabular-nums" : ""}`}>{children}</dd>
    </div>
  );
}

/** What a machine reports about itself. Used by the adopt flow (so approval is informed) and the detail page. */
export function CapabilityFacts({ c }: { c: Capabilities | null }) {
  if (!c) return <p className="text-compact text-ink-3">This worker has not reported its hardware yet. It appears here after its first connection.</p>;
  const models = modelNames(c);
  const tools = Object.entries(c.tools);
  return (
    <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
      <Fact label="Host name" mono>{c.hostname}</Fact>
      <Fact label="System">{c.os.name} {c.os.version}</Fact>
      <Fact label="Architecture" mono>{c.arch}</Fact>
      <Fact label="CPU">{c.cpu.model}, {c.cpu.cores} cores</Fact>
      <Fact label="Memory" mono>{gb(c.memMb)}</Fact>
      <Fact label="GPU">{gpuText(c)}</Fact>
      <Fact label="Storage">{c.storage.length === 0 ? "Not reported" : c.storage.map((s) => `${s.path}: ${Math.round(s.freeGb)} of ${Math.round(s.totalGb)} GB free`).join("; ")}</Fact>
      <Fact label="Local models">{c.inference ? (models.length ? models.join(", ") : `${c.inference.runtime}, no models`) : "No model runtime"}</Fact>
      <Fact label="Workspace root" mono>{c.workspaceRoot}</Fact>
      <div className="col-span-2 sm:col-span-3 min-w-0">
        <dt className="text-micro uppercase tracking-label text-ink-3">Tools</dt>
        <dd className="mt-1 flex flex-wrap gap-1.5">
          {tools.length === 0 ? <span className="text-compact text-ink-3">None found</span> : tools.map(([k, v]) => <Chip key={k}><span className="font-mono">{k} {v}</span></Chip>)}
        </dd>
      </div>
      <div className="col-span-2 sm:col-span-3 min-w-0">
        <dt className="text-micro uppercase tracking-label text-ink-3">Networks</dt>
        <dd className="mt-1 flex flex-wrap gap-1.5">
          {c.networks.length === 0 ? <span className="text-compact text-ink-3">Not reported</span> : c.networks.map((n) => <Chip key={n.provider + n.address}><span className="font-mono">{n.provider} {n.address}</span></Chip>)}
        </dd>
      </div>
    </dl>
  );
}
