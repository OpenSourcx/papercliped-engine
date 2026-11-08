import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Cpu, Plus, Server, Sparkles, X } from "lucide-react";
import { useEngine } from "../../data/store.tsx";
import { fabricApi, fabricErrorText, type EnvView, type Pending, type Worker, useFabricAction } from "../../data/engine/fabric.ts";
import { useModals } from "../../modals/useModals.ts";
import { BarMeter } from "../../ui/meters.tsx";
import { Button, Card, Chip, EmptyState, Notice, SectionTitle, Status } from "../../ui/primitives.tsx";
import { PageFrame, PageHeader } from "../../ui/primitives.tsx";
import { CapabilityFacts, Fact } from "./Hardware.tsx";
import { FabricGate } from "./Gate.tsx";
import { ServiceDots } from "./Health.tsx";
import { ago, countdown, degrees, gb, pct, gpuText, hardwareSummary, healthOf, leaseCount, modelNames, providerLabel } from "./util.ts";

const SUBTITLE = "Computers you own that run agents for your organizations. A worker keeps its own connection to this device, so it keeps working if the internet goes down.";

export function WorkersPage() {
  return <FabricGate title="Workers" subtitle={SUBTITLE}>{(f) => <WorkersBody f={f} />}</FabricGate>;
}

function WorkersBody({ f }: { f: import("../../data/engine/fabric.ts").FabricOverview }) {
  const { openModal } = useModals();
  const visible = f.workers.filter((w) => w.state !== "revoked");
  const revoked = f.workers.filter((w) => w.state === "revoked");
  return (
    <PageFrame>
      <PageHeader
        title="Workers"
        subtitle={SUBTITLE}
        actions={
          <>
            {f.workers.some((w) => w.state === "adopted") && <Button onClick={() => openModal("use-worker")}><Cpu className="h-4 w-4" />Run agents on a worker</Button>}
            <Button variant="primary" onClick={() => openModal("adopt-worker")}><Plus className="h-4 w-4" />Add a worker</Button>
          </>
        }
      />
      {f.pending.length > 0 && (
        <section aria-labelledby="pending-h" className="mb-8">
          <SectionTitle><span id="pending-h">Waiting for your approval</span></SectionTitle>
          <div className="grid gap-3">{f.pending.map((p) => <PendingCard key={p.id} p={p} />)}</div>
        </section>
      )}
      {visible.length === 0 && f.pending.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Server className="h-5 w-5" />}
            title="No workers yet"
            body="Adopt a computer you own, such as a Linux server or a Jetson, and agents can run their commands and local models there. You install the worker software on it, give it a one-use pairing code, and approve what it reports. No passwords are copied to it."
            action={<Button variant="primary" onClick={() => openModal("adopt-worker")}><Plus className="h-4 w-4" />Add a worker</Button>}
          />
        </Card>
      ) : (
        <section aria-label="Workers" className="grid gap-3">{visible.map((w) => <WorkerCard key={w.id} w={w} />)}</section>
      )}
      {revoked.length > 0 && (
        <section aria-labelledby="revoked-h" className="mt-8">
          <SectionTitle><span id="revoked-h">Revoked</span></SectionTitle>
          <div className="grid gap-3">{revoked.map((w) => <WorkerCard key={w.id} w={w} />)}</div>
        </section>
      )}
      <Environments envs={f.environments} workers={f.workers} />
    </PageFrame>
  );
}

export function WorkerCard({ w }: { w: Worker }) {
  const { setup } = useEngine();
  const h = healthOf(w);
  const c = w.capabilities;
  const models = c ? modelNames(c) : [];
  const hl = w.health;
  const fresh = hl?.state === "online";
  const memPct = fresh && hl.memPct !== null ? hl.memPct : c && w.usage.freeMemMb !== null && c.memMb ? 100 - (w.usage.freeMemMb / c.memMb) * 100 : null;
  const cpuPct = fresh && hl.cpuPct !== null ? hl.cpuPct : c && w.usage.loadAvg !== null && c.cpu.cores ? (w.usage.loadAvg / c.cpu.cores) * 100 : null;
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <Link to={`/${setup?.deviceName ?? "pve"}/datacenter/workers/${encodeURIComponent(w.id)}`} className="inline-flex items-center min-h-11 -my-2 text-lead font-semibold hover:underline rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)">{w.name}</Link>
          <p className="text-compact text-ink-3 mt-0.5">{hardwareSummary(c)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2"><Status kind={h.kind} label={h.label} /></div>
      </div>
      {!c ? <p className="mt-4 text-compact text-ink-3">Waiting for the worker's first hardware report. <span className="font-mono">{w.transport.address}</span></p> : <dl className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
        <Fact label="System">{c.os.name} <span className="font-mono">{c.arch}</span></Fact>
        <Fact label="Connection">{providerLabel(w.transport.provider)} <span className="font-mono text-ink-3">{w.transport.address}</span></Fact>
        <Fact label="GPU">{gpuText(c)}</Fact>
        <Fact label="Local models">{models.length ? models.join(", ") : c.inference ? "None pulled" : "No runtime"}</Fact>
        <Fact label="Active leases"><span className="tabular-nums">{leaseCount(w)} of {w.shellSlots}</span><span className="text-ink-3"> shell, </span><span className="tabular-nums">{w.usage.inferenceRunning + w.usage.inferenceQueued}</span><span className="text-ink-3"> inference</span></Fact>
        <Fact label="Last seen">{w.online ? "Connected now" : ago(w.lastSeen)}</Fact>
        <div className="col-span-2">{cpuPct !== null ? <BarMeter label="CPU load" pct={cpuPct} value={fresh && hl.cpuPct !== null ? `${hl.cpuPct.toFixed(0)}% of ${c.cpu.cores} cores, load ${hl.load1?.toFixed(2) ?? "n/a"}` : `${w.usage.loadAvg!.toFixed(2)} on ${c.cpu.cores} cores`} /> : <Fact label="CPU">Not reported</Fact>}</div>
        {hl && hl.state !== "offline" && <>
          <Fact label="Temperature">{degrees(hl.tempC)}</Fact>
          <Fact label="GPU load">{hl.gpuPct === null ? "n/a" : pct(hl.gpuPct)}</Fact>
          <Fact label="Disk free">{hl.diskFreeGb === null ? "n/a" : `${hl.diskFreeGb.toFixed(0)} GB`}</Fact>
          <Fact label="Services">{hl.services ? <ServiceDots s={hl.services} /> : "n/a"}</Fact>
        </>}
        <div className="col-span-2">{memPct !== null ? <BarMeter label="Memory in use" pct={memPct} value={`${gb(c.memMb - w.usage.freeMemMb!)} of ${gb(c.memMb)}`} /> : <Fact label="Memory">{gb(c.memMb)}, use not reported</Fact>}</div>
      </dl>}
    </Card>
  );
}

function PendingCard({ p }: { p: Pending }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const approve = useFabricAction(() => fabricApi.approve(p.id, {}));
  const deny = useFabricAction(() => fabricApi.deny(p.id));
  const left = countdown(p.expiresAt, now);
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lead font-semibold">{p.name}</h3>
          <p className="text-compact text-ink-3 mt-0.5">Asked to join from <span className="font-mono">{p.remote}</span>. {left ? <>Expires in <span className="tabular-nums">{left}</span>.</> : "This request expired."}</p>
        </div>
        <Chip tone="warning">Needs approval</Chip>
      </div>
      <VerifyBox verification={p.verification} fingerprint={p.fingerprint} />
      <div className="mt-4"><CapabilityFacts c={p.capabilities} /></div>
      {(approve.error || deny.error) && <p role="alert" className="mt-3 text-compact text-critical">{fabricErrorText(approve.error ?? deny.error)}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="primary" loading={approve.isPending} disabled={!left || deny.isPending} onClick={() => approve.mutate(undefined)}><Check className="h-4 w-4" />Approve {p.name}</Button>
        <Button variant="secondary" loading={deny.isPending} disabled={approve.isPending} onClick={() => deny.mutate(undefined)}><X className="h-4 w-4" />Deny</Button>
      </div>
    </Card>
  );
}

/** The short string both screens show, so the person can check the request is from the machine in front of them. */
export function VerifyBox({ verification, fingerprint }: { verification: string; fingerprint: string }) {
  return (
    <div className="mt-4 rounded-lg border border-line bg-surface-2 px-4 py-3">
      <div className="text-micro uppercase tracking-label text-ink-3">Check this matches the worker's screen</div>
      <div className="mt-1 font-mono text-title tracking-code" aria-label={`Verification string ${verification.split("").join(" ")}`}>{verification}</div>
      <div className="mt-1 text-xs text-ink-3">Key fingerprint <span className="font-mono break-all">{fingerprint}</span></div>
    </div>
  );
}

function Environments({ envs, workers }: { envs: EnvView[]; workers: Worker[] }) {
  const { openModal } = useModals();
  if (envs.length === 0) return null;
  const name = (id: string | null) => (id ? workers.find((w) => w.id === id)?.name ?? "Unknown worker" : "Any matching worker");
  return (
    <section aria-labelledby="env-h" className="mt-8">
      <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => openModal("use-worker")}>Add environment</Button>}><span id="env-h">Environments on workers</span></SectionTitle>
      <Notice tone="info" className="mb-3">An environment says where an agent's commands run. Which AI model an agent thinks with is a separate choice on the agent.</Notice>
      <Card className="divide-y divide-line">
        {envs.map((e) => (
          <div key={e.id} className="px-4 py-3 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-medium">{e.name}</div>
              <div className="text-xs text-ink-3">{name(e.workerId)} · {e.agents.length} {e.agents.length === 1 ? "agent" : "agents"}</div>
            </div>
            <div className="flex flex-wrap gap-1.5">{reqChips(e)}</div>
          </div>
        ))}
      </Card>
    </section>
  );
}

function reqChips(e: EnvView) {
  const r = e.requirements;
  const out: string[] = [];
  if (r.gpu) out.push("GPU");
  if (r.arch) out.push(r.arch);
  if (r.localModel) out.push(`model ${r.localModel}`);
  if (r.minFreeMemMb) out.push(`${gb(r.minFreeMemMb)} free`);
  for (const t of r.tools ?? []) out.push(t);
  return out.length ? out.map((x) => <Chip key={x}><span className="font-mono">{x}</span></Chip>) : <Chip><Sparkles className="h-3 w-3" aria-hidden />No special needs</Chip>;
}
