import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Circle, Container, Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { errorText, useAgentContainers, useContainersJob, useContainersSetup, useContainersTeardown } from "../../data/engine/queries.ts";
import type { ContainersJob, ContainersParams, ContainersStatus } from "../../data/engine/host.ts";
import { useEngine } from "../../data/store.tsx";
import { Button, Card, EmptyState, Input, PageFrame, PageHeader, Status, Select } from "../../ui/primitives.tsx";

export const TEARDOWN_PHRASE = "remove agent containers";

const SIZES: { id: string; label: string; size: ContainersParams["size"] }[] = [
  { id: "small", label: "Small: 1 core, 2 GB memory, 16 GB disk", size: { cores: 1, memoryMb: 2048, diskGb: 16 } },
  { id: "standard", label: "Standard: 2 cores, 4 GB memory, 16 GB disk", size: { cores: 2, memoryMb: 4096, diskGb: 16 } },
  { id: "large", label: "Large: 4 cores, 8 GB memory, 32 GB disk", size: { cores: 4, memoryMb: 8192, diskGb: 32 } },
];
const sizeId = (s: ContainersParams["size"] | undefined) => SIZES.find((x) => x.size.cores === s?.cores && x.size.memoryMb === s?.memoryMb && x.size.diskGb === s?.diskGb)?.id ?? "standard";
const field = "h-10 w-full rounded-lg bg-surface-2 border border-line px-3 text-sm outline-none focus:border-line-strong";

const STATE_TEXT: Record<ContainersStatus["state"], { kind: "good" | "warning" | "critical" | "off"; label: string }> = {
  ready: { kind: "good", label: "Ready" },
  partial: { kind: "warning", label: "Partly set up" },
  error: { kind: "critical", label: "Needs attention" },
  not_set_up: { kind: "off", label: "Not set up" },
};

function StepIcon({ state }: { state: "done" | "running" | "failed" | "pending" }) {
  if (state === "done") return <CheckCircle2 className="h-4 w-4 text-good shrink-0" aria-label="Done" />;
  if (state === "running") return <Loader2 className="h-4 w-4 animate-spin text-accent shrink-0" aria-label="Working" />;
  if (state === "failed") return <AlertTriangle className="h-4 w-4 text-critical shrink-0" aria-label="Failed" />;
  return <Circle className="h-4 w-4 text-ink-3 shrink-0" aria-label="Not done" />;
}

function Log({ job }: { job: ContainersJob }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [job.log.length]);
  return (
    <pre ref={ref} aria-label="Setup log" className="mt-3 max-h-64 overflow-auto rounded-lg border border-line bg-surface-2 p-3 text-xs leading-5 font-mono whitespace-pre-wrap break-words">
      {job.log.map((l, i) => (
        <div key={i} className={l.level === "error" ? "text-critical" : l.level === "warn" ? "text-warning" : "text-ink-2"}>{l.text}</div>
      ))}
    </pre>
  );
}

/** The Settings section: live devices only (the demo has no Proxmox to put containers on). */
export function AgentContainersSettings() {
  if (useEngine().live) return <AgentContainers />;
  return (
    <PageFrame width="4xl">
      <PageHeader title="Agent containers" subtitle="Agents run inside unprivileged Proxmox containers, never on the host." />
      <Card><EmptyState icon={<Container className="h-5 w-5" />} title="Available on a live device" body="On a real Proxmox host, a Proxmox administrator sets this up here in a few clicks." /></Card>
    </PageFrame>
  );
}

/** The live Agent containers screen (Settings). Everything here happens on the host, as the signed-in Proxmox administrator. */
export function AgentContainers() {
  const q = useAgentContainers();
  const setup = useContainersSetup();
  const teardown = useContainersTeardown();
  const [jobId, setJobId] = useState<string | null>(null);
  const [choices, setChoices] = useState<ContainersParams | null>(null);
  const [typed, setTyped] = useState("");
  const status = q.data;
  const runningId = status?.job?.status === "running" ? status.job.id : null;
  // A job already running on the host (this page was closed and reopened) is picked up again.
  useEffect(() => {
    if (runningId && !jobId) setJobId(runningId);
  }, [runningId, jobId]);
  const job = useContainersJob(jobId);
  const j = job.data;
  const running = j?.status === "running" || setup.isPending || teardown.isPending;
  const opts = status?.options ?? null;
  // Start from what is saved, else from what this host offers (a default of local-lvm means nothing on a host without it).
  const form = useMemo<ContainersParams>(
    () => choices ?? status?.params ?? { storage: opts?.suggested.storage ?? "local-lvm", templateStorage: opts?.suggested.templateStorage ?? "local", bridge: opts?.suggested.bridge ?? "vmbr0", pool: "epc-agents", size: SIZES[1].size },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [choices, status?.params, JSON.stringify(opts?.suggested)],
  );
  const set = (patch: Partial<ContainersParams>) => setChoices({ ...form, ...patch });

  const start = () =>
    setup.mutate({ storage: form.storage.trim(), templateStorage: form.templateStorage.trim(), bridge: form.bridge.trim(), pool: form.pool.trim(), size: form.size }, { onSuccess: (r) => setJobId(r.jobId) });
  const remove = () => teardown.mutate(typed, { onSuccess: (r) => { setJobId(r.jobId); setTyped(""); } });

  const stepState = (id: string, done: boolean): "done" | "running" | "failed" | "pending" => {
    const js = j?.status === "running" || j?.status === "failed" ? j.steps.find((s) => s.id === id) : undefined;
    if (js?.state === "running") return "running";
    if (js?.state === "failed") return "failed";
    return done ? "done" : "pending";
  };

  const label = !status ? "Set up agent containers" : status.state === "ready" ? "Check and repair" : status.state === "not_set_up" ? "Set up agent containers" : "Resume setup";
  const canManage = status?.canManage === true;

  return (
    <PageFrame width="4xl">
      <PageHeader
        title="Agent containers"
        subtitle="Agents run inside unprivileged Proxmox containers, never on this host. A Proxmox administrator sets this up once; every step is made in Proxmox as you, and Proxmox decides what's allowed."
        actions={status ? <Status kind={STATE_TEXT[status.state].kind} label={STATE_TEXT[status.state].label} /> : undefined}
      />
      {q.isPending && <div className="py-12 grid place-items-center text-ink-3" aria-busy="true"><Loader2 className="h-5 w-5 animate-spin" /></div>}
      {q.error && <p role="alert" className="text-sm text-critical">{errorText(q.error)}</p>}
      {status && (
        <>
          {status.state !== "ready" && (
            <div role="status" className="mb-4 flex items-start gap-3 rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm">
              <ShieldAlert className="h-4 w-4 mt-0.5 text-warning shrink-0" />
              <span>Agents can't run until agent containers are set up. {canManage ? "Nothing runs on the host in the meantime." : "Ask a Proxmox administrator to set them up."}</span>
            </div>
          )}
          {status.error && <p role="alert" className="mb-3 text-compact text-critical">{status.error}</p>}
          <Card className="divide-y divide-line">
            {status.steps.length === 0 && <p className="px-5 py-4 text-sm text-ink-2">Only Proxmox administrators can see the steps.</p>}
            {status.steps.map((s) => {
              const st = stepState(s.id, s.done);
              const live = j?.steps.find((x) => x.id === s.id);
              const note = (st === "running" || st === "failed" ? live?.detail : undefined) ?? s.detail ?? (st === "done" ? live?.detail : undefined);
              return (
                <div key={s.id} className="flex items-start gap-3 px-5 py-3.5">
                  <span className="mt-0.5"><StepIcon state={st} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm">{s.label}</div>
                    {note && <div className={`text-xs mt-0.5 ${st === "failed" ? "text-critical" : "text-ink-3"}`}>{note}</div>}
                  </div>
                </div>
              );
            })}
          </Card>

          {canManage ? (
            <>
              <div className="mt-5 grid sm:grid-cols-2 gap-4">
                <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Container storage</span>{opts && opts.storages.length > 0 ? <Select value={form.storage} onChange={(e) => set({ storage: e.target.value })} disabled={running} aria-label="Container storage" className="font-mono">{(opts.storages.includes(form.storage) ? opts.storages : [form.storage, ...opts.storages]).map((x) => <option key={x} value={x}>{x}</option>)}</Select> : <Input value={form.storage} onChange={(e) => set({ storage: e.target.value })} spellCheck={false} className="font-mono" disabled={running} aria-label="Container storage" />}<span className="block text-xs text-ink-3 mt-1">Where each agent container's disk lives. Only storages on this host that can hold container disks are listed.</span></label>
                <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Template storage</span>{opts && opts.templateStorages.length > 0 ? <Select value={form.templateStorage} onChange={(e) => set({ templateStorage: e.target.value })} disabled={running} aria-label="Template storage" className="font-mono">{(opts.templateStorages.includes(form.templateStorage) ? opts.templateStorages : [form.templateStorage, ...opts.templateStorages]).map((x) => <option key={x} value={x}>{x}</option>)}</Select> : <Input value={form.templateStorage} onChange={(e) => set({ templateStorage: e.target.value })} spellCheck={false} className="font-mono" disabled={running} aria-label="Template storage" />}<span className="block text-xs text-ink-3 mt-1">Where Proxmox keeps container templates.</span></label>
                <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Network bridge</span>{opts && opts.bridges.length > 0 ? <Select value={form.bridge} onChange={(e) => set({ bridge: e.target.value })} disabled={running} aria-label="Network bridge" className="font-mono">{(opts.bridges.includes(form.bridge) ? opts.bridges : [form.bridge, ...opts.bridges]).map((x) => <option key={x} value={x}>{x}</option>)}</Select> : <Input value={form.bridge} onChange={(e) => set({ bridge: e.target.value })} spellCheck={false} className="font-mono" disabled={running} aria-label="Network bridge" />}<span className="block text-xs text-ink-3 mt-1">Containers get an address by DHCP on this bridge.</span></label>
                <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Container size</span>
                  <Select value={sizeId(form.size)} onChange={(e) => set({ size: SIZES.find((x) => x.id === e.target.value)!.size })} disabled={running} aria-label="Container size">
                    {SIZES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                  </Select>
                  <span className="block text-xs text-ink-3 mt-1">The most a container gets; an organization's resource group can make it smaller.</span>
                </label>
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <Button variant="primary" onClick={start} disabled={running || !form.storage.trim() || !form.templateStorage.trim() || !form.bridge.trim()}>
                  {running ? <Loader2 className="h-4 w-4 animate-spin" /> : status.state === "ready" ? <RefreshCw className="h-4 w-4" /> : <Container className="h-4 w-4" />}
                  {running ? "Working…" : label}
                </Button>
                <span className="text-xs text-ink-3">It's safe to run again; steps already done are skipped. It carries on if you close this page. Building the template takes several minutes.</span>
              </div>
              {setup.isError && <p role="alert" className="text-compact text-critical mt-3">{errorText(setup.error)}</p>}
            </>
          ) : (
            <p className="mt-4 text-compact text-ink-3">Only Proxmox administrators can set up or change agent containers.</p>
          )}

          {j && (
            <div className="mt-5">
              <div className="flex items-center gap-2 text-sm">
                <StepIcon state={j.status === "running" ? "running" : j.status === "done" ? "done" : "failed"} />
                <span>{j.kind === "teardown" ? "Removal" : "Setup"} {j.status === "running" ? "in progress" : j.status === "done" ? "finished" : "stopped"}</span>
              </div>
              {j.status === "failed" && j.error && <p role="alert" className="text-compact text-critical mt-2">{j.error}</p>}
              {j.status === "failed" && <p className="text-xs text-ink-3 mt-1">Press the button again to resume: what's done is kept, and a half-made container has been removed.</p>}
              <Log job={j} />
            </div>
          )}
          {job.error && <p role="alert" className="text-compact text-critical mt-3">{errorText(job.error)}</p>}

          {canManage && (
            <details className="mt-8 group">
              <summary className="cursor-pointer text-compact text-ink-2">Advanced</summary>
              <div className="mt-3 rounded-lg border border-critical/40 bg-critical/10 p-4 space-y-3">
                <p className="text-compact">Remove what agent containers created: the sandbox user, role and API token in Proxmox, the template container, the engine's container environments and the provider. Your machines, organizations, agents and data are not touched. Agents stay blocked from running on the host.</p>
                <div className="flex flex-wrap gap-2">
                  <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={`Type "${TEARDOWN_PHRASE}" to confirm`} spellCheck={false} className="font-mono flex-1 min-w-[240px]" aria-label="Confirmation" disabled={running} />
                  <Button variant="danger" onClick={remove} disabled={typed !== TEARDOWN_PHRASE || running}>Remove agent containers</Button>
                </div>
                {teardown.isError && <p role="alert" className="text-compact text-critical">{errorText(teardown.error)}</p>}
              </div>
            </details>
          )}
        </>
      )}
    </PageFrame>
  );
}
