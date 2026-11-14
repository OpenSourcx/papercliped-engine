import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Ban, KeyRound, Pause, Play, RefreshCw, ShieldOff, Trash2 } from "lucide-react";
import { useEngine } from "../../data/store.tsx";
import { fabricApi, fabricErrorText, FabricError, type Lease, type Worker, useFabricAction, useWorker } from "../../data/engine/fabric.ts";
import { useModals } from "../../modals/useModals.ts";
import { ConfirmModal } from "../../ui/Confirm.tsx";
import { Button, Card, Chip, EmptyState, Field, Input, Notice, PageFrame, PageHeader, SectionTitle, Select, Status, Tabs } from "../../ui/primitives.tsx";
import { CapabilityFacts, Fact } from "./Hardware.tsx";
import { FabricGate } from "./Gate.tsx";
import { MachineRuns } from "../placements/PlacementViews.tsx";
import { ago, clock, healthOf, providerLabel } from "./util.ts";

type Tab = "overview" | "leases" | "activity";

export function WorkerDetailPage() {
  const { id = "" } = useParams();
  return <FabricGate title="Worker">{() => <Detail id={id} />}</FabricGate>;
}

function Detail({ id }: { id: string }) {
  const { setup } = useEngine();
  const back = `/${setup?.deviceName ?? "pve"}/datacenter/workers`;
  const q = useWorker(id);
  const [tab, setTab] = useState<Tab>("overview");
  const backLink = <Link to={back} className="inline-flex items-center gap-1.5 min-h-11 -my-2 text-compact text-ink-2 hover:text-ink rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)"><ArrowLeft className="h-4 w-4" aria-hidden />All workers</Link>;
  if (q.isPending) return <PageFrame><PageHeader title="Worker" eyebrow={backLink} /><p className="text-ink-3" role="status" aria-busy="true">Loading worker</p></PageFrame>;
  if (q.error) {
    const gone = q.error instanceof FabricError && q.error.status === 404;
    return <PageFrame><PageHeader title={gone ? "This worker doesn't exist" : "Worker"} eyebrow={backLink} /><Card><EmptyState icon={<Ban className="h-5 w-5" />} title={gone ? "No worker with this address" : "Couldn't load this worker"} body={gone ? "It may have been removed. Go back to the list to see the workers this device knows." : fabricErrorText(q.error)} action={gone ? undefined : <Button onClick={() => void q.refetch()}>Try again</Button>} /></Card></PageFrame>;
  }
  const { worker: w, leases, audit } = q.data;
  const h = healthOf(w);
  return (
    <PageFrame>
      <PageHeader title={w.name} eyebrow={backLink} subtitle={<span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1"><Status kind={h.kind} label={h.label} /><span className="text-compact text-ink-3">{h.detail}</span></span>} actions={<Actions w={w} backTo={back} />} />
      <Tabs value={tab} onChange={setTab} className="mb-5" tabs={[{ id: "overview", label: "Overview" }, { id: "leases", label: "Leases", count: leases.filter((l) => l.state === "active").length }, { id: "activity", label: "Activity", count: audit.length }]} />
      {tab === "overview" && <Overview w={w} />}
      {tab === "leases" && <Leases leases={leases} />}
      {tab === "activity" && <Activity audit={audit} />}
    </PageFrame>
  );
}

function Actions({ w, backTo }: { w: Worker; backTo: string }) {
  const nav = useNavigate();
  const { openModal } = useModals();
  const patch = useFabricAction((p: Parameters<typeof fabricApi.patch>[1]) => fabricApi.patch(w.id, p));
  const refresh = useFabricAction(() => fabricApi.refresh(w.id));
  const revoke = useFabricAction(() => fabricApi.revoke(w.id));
  const remove = useFabricAction(() => fabricApi.remove(w.id));
  const [confirm, setConfirm] = useState<"revoke" | "remove" | null>(null);
  const adopted = w.state === "adopted";
  const err = patch.error ?? refresh.error ?? revoke.error ?? remove.error;
  return (
    <>
      {adopted && (
        <>
          <Button onClick={() => patch.mutate({ drain: !w.draining })} loading={patch.isPending}>{w.draining ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}{w.draining ? "Stop draining" : "Drain"}</Button>
          <Button onClick={() => patch.mutate({ disabled: !w.disabled })} loading={patch.isPending}>{w.disabled ? <Play className="h-4 w-4" /> : <Ban className="h-4 w-4" />}{w.disabled ? "Enable" : "Disable"}</Button>
          <Button onClick={() => refresh.mutate(undefined)} loading={refresh.isPending} disabled={!w.online}><RefreshCw className="h-4 w-4" />Refresh capabilities</Button>
          {!w.online && <Button onClick={() => openModal("adopt-worker")}><KeyRound className="h-4 w-4" />Re-pair</Button>}
          <Button variant="danger" onClick={() => setConfirm("revoke")}><ShieldOff className="h-4 w-4" />Revoke</Button>
        </>
      )}
      {w.state === "revoked" && <Button variant="danger" onClick={() => setConfirm("remove")}><Trash2 className="h-4 w-4" />Remove record</Button>}
      {err && <p role="alert" className="basis-full text-compact text-critical">{fabricErrorText(err)}</p>}
      {confirm === "revoke" && (
        <ConfirmModal
          title={`Revoke ${w.name}?`}
          label="Revoke permanently"
          danger
          busy={revoke.isPending}
          onClose={() => setConfirm(null)}
          onConfirm={() => revoke.mutate(undefined, { onSuccess: () => setConfirm(null) })}
          body={<><p>Revoking is permanent for this identity. The worker's connection closes now, its leases are destroyed, and its key is put on a deny list: it can never connect to this device again.</p><p className="mt-2">The computer itself is not touched or powered off. To use it again you install a fresh worker identity and approve it as a new worker.</p></>}
        />
      )}
      {confirm === "remove" && (
        <ConfirmModal
          title={`Remove the record of ${w.name}?`}
          label="Remove record"
          danger
          busy={remove.isPending}
          onClose={() => setConfirm(null)}
          onConfirm={() => remove.mutate(undefined, { onSuccess: () => { setConfirm(null); nav(backTo); } })}
          body="The entry disappears from this list. The revoked key stays on the deny list, so this identity still can't connect."
        />
      )}
    </>
  );
}

function Overview({ w }: { w: Worker }) {
  const [name, setName] = useState(w.name);
  const rename = useFabricAction((n: string) => fabricApi.patch(w.id, { name: n }));
  const c = w.capabilities;
  return (
    <div className="grid gap-5">
      <AiSetup w={w} />
      <MachineRuns target={{ kind: "worker", workerId: w.id }} />
      <Card className="p-4 sm:p-5">
        <SectionTitle>Capabilities</SectionTitle>
        <CapabilityFacts c={c} />
      </Card>
      <Card className="p-4 sm:p-5">
        <SectionTitle>Connection</SectionTitle>
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
          <Fact label="Provider">{providerLabel(w.transport.provider)}</Fact>
          <Fact label="Address" mono>{w.transport.address}</Fact>
          <Fact label="Status">{w.online ? "Connected" : "Offline"}</Fact>
          <Fact label="Connected since">{w.connectedSince ? clock(w.connectedSince) : "Not connected"}</Fact>
          <Fact label="Last seen">{w.online ? "Now" : ago(w.lastSeen)}</Fact>
          <Fact label="Worker version" mono>{w.version}</Fact>
          <Fact label="Key fingerprint" mono>{w.fingerprint}</Fact>
          <Fact label="Organizations">{w.companies === null ? "All organizations" : w.companies.length === 0 ? "None" : `${w.companies.length} selected`}</Fact>
          <Fact label="Slots">{w.shellSlots} shell, {w.inferenceSlots} inference</Fact>
        </dl>
        <p className="mt-3 text-xs text-ink-3">The worker dials out to this device, so it needs no open port. The channel is encrypted and the worker proves its own identity on every connection.</p>
      </Card>
      {w.state === "adopted" && (
        <Card className="p-4 sm:p-5">
          <SectionTitle>Name</SectionTitle>
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (name.trim() && name.trim() !== w.name) rename.mutate(name.trim()); }}>
            <Field label="Worker name" htmlFor="worker-name" className="flex-1 min-w-48" error={rename.error ? fabricErrorText(rename.error) : undefined}>
              <Input id="worker-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
            </Field>
            <Button type="submit" loading={rename.isPending} disabled={!name.trim() || name.trim() === w.name}>Save name</Button>
          </form>
        </Card>
      )}
    </div>
  );
}

function AiSetup({ w }: { w: Worker }) {
  const setup = useQuery({ queryKey: ["fabric", "worker", w.id, "setup"], queryFn: () => fabricApi.setup(w.id), enabled: w.state === "adopted" });
  const run = useFabricAction((body: { action: "ollama" | "pull"; model?: string }) => fabricApi.inference(w.id, body));
  const [model, setModel] = useState("");
  if (w.state !== "adopted") return null;
  const s = setup.data?.setup;
  const fits = (s?.recommendations ?? []).filter((r) => r.fit !== "too_big");
  const selected = model || fits[0]?.spec.id || "";
  const result = run.data?.result;
  return (
    <Card className="p-4 sm:p-5">
      <SectionTitle>AI setup</SectionTitle>
      {setup.isPending && <p className="text-sm text-ink-3" role="status">Reading this worker's hardware…</p>}
      {setup.error && <p role="alert" className="text-sm text-critical">{fabricErrorText(setup.error)}</p>}
      {s && (
        <div className="space-y-3">
          <p className="text-compact text-ink-2">
            {s.setupMode === "pin" ? "Pin-managed: Pin installs with your approval." : s.setupMode === "self" ? "Guided: you run the steps; Pin verifies." : "No setup authority chosen yet on the worker."}
            {!s.online && " The worker is offline; connect it before installing anything."}
          </p>
          {fits.length === 0 ? <p className="text-sm text-ink-3">No catalogue model fits this machine.</p> : (
            <>
              <Field label="Model that fits this worker" htmlFor="worker-model" hint="Only models that fit the detected RAM/VRAM/disk are listed.">
                <Select id="worker-model" value={selected} onChange={(e) => setModel(e.target.value)}>
                  {fits.map((r) => <option key={r.spec.id} value={r.spec.id}>{r.spec.label} · {r.fit === "gpu" ? "GPU" : "CPU"} · ~{r.spec.sizeGb} GB</option>)}
                </Select>
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button loading={run.isPending && run.variables?.action === "ollama"} disabled={!s.online} onClick={() => run.mutate({ action: "ollama" })}>Install Ollama</Button>
                <Button loading={run.isPending && run.variables?.action === "pull"} disabled={!s.online || !selected} onClick={() => run.mutate({ action: "pull", model: selected })}>Pull model</Button>
              </div>
            </>
          )}
          {result?.code === "guided_only" && <Notice tone="info" title="Guided mode">Run this on the worker, then refresh capabilities:<pre className="mt-2 overflow-x-auto text-xs">{result.command}</pre></Notice>}
          {result?.code === "helper_missing" && <Notice tone="warning" title="Pin can't install yet">The privileged helper isn't installed. Run this on the worker:<pre className="mt-2 overflow-x-auto text-xs">{result.command}</pre></Notice>}
          {result?.ok && <Notice tone="good" title="Done">{result.output || "The worker reports the step succeeded."}</Notice>}
          {run.error && <p role="alert" className="text-sm text-critical">{fabricErrorText(run.error)}</p>}
        </div>
      )}
    </Card>
  );
}

const LEASE_TEXT = { active: "Active", released: "Released", stopped: "Stopped", destroyed: "Destroyed" } as const;

function Leases({ leases }: { leases: Lease[] }) {
  if (leases.length === 0) return <Card><EmptyState icon={<KeyRound className="h-5 w-5" />} title="No leases yet" body="A lease is one agent run's claim on this worker and its private workspace. They appear here when an agent runs." /></Card>;
  const tone = { active: "good", released: "idle", stopped: "paused", destroyed: "off" } as const;
  return (
    <>
      <Notice tone="info" className="mb-3">Releasing or destroying a lease frees capacity and clears that run's workspace. It never turns the computer off.</Notice>
      <Card className="divide-y divide-line">
        {leases.map((l) => (
          <div key={l.id} className="px-4 py-3 grid gap-1">
            <div className="flex flex-wrap items-center gap-2"><Status kind={tone[l.state]} label={LEASE_TEXT[l.state]} /><span className="text-xs text-ink-3">Started {ago(l.createdAt)}{l.releasedAt ? `, ended ${ago(l.releasedAt)}` : ""}</span></div>
            <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs">
              <Fact label="Agent" mono={!l.agentName}>{l.agentName ?? l.agentId}</Fact>
              <Fact label="Run" mono>{l.runId}</Fact>
              <Fact label="Workspace" mono>{l.workspace}</Fact>
            </dl>
          </div>
        ))}
      </Card>
    </>
  );
}

function Activity({ audit }: { audit: import("../../data/engine/fabric.ts").AuditEvent[] }) {
  if (audit.length === 0) return <Card><EmptyState icon={<RefreshCw className="h-5 w-5" />} title="No activity yet" body="Adoption, changes, connections and revocations of this worker are recorded here." /></Card>;
  return (
    <Card className="divide-y divide-line">
      <ol aria-label="Activity log">
        {audit.map((a) => (
          <li key={a.n} className="px-4 py-3 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="text-xs text-ink-3 tabular-nums">{clock(a.at)}</span>
            <span className="text-sm font-medium font-mono">{a.action}</span>
            <span className="text-xs text-ink-3">by {a.actor}</span>
            {a.detail && <span className="basis-full text-xs text-ink-2 break-words">{a.detail}</span>}
          </li>
        ))}
      </ol>
    </Card>
  );
}
