import { useState } from "react";
import { Cpu, Loader2, Pencil, Plus, Settings2, Trash2 } from "lucide-react";
import { HUGEPAGES, HOTPLUG, KEYBOARDS, SCSI_HW, SCSI_HW_LABEL, RNG_SOURCES, WATCHDOG_ACTIONS, CT_ARCHES, CT_CMODES, CT_OSTYPES, VIDEO_STREAMING, CPU_FLAG_HINTS } from "@papercliped-engine/proxmox-client/machine-schema";
import type { Choices } from "../../data/engine/machineApi.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, Input, SectionTitle, Select } from "../../ui/primitives.tsx";
import { useLoad } from "../disks/common.tsx";
import { Dd, Dl, Dt, Heading, Off, PendingMark, SwitchRow, toNum, useRun, Warnings, type SCtx } from "./MachineSettingsKit.tsx";

/* ── Processor details (VM) ─────────────────────────────────────────────────────────── */

export function ProcessorCard({ ctx }: { ctx: SCtx }) {
  const vm = ctx.s.vm!;
  const c = vm.cpu;
  const [edit, setEdit] = useState(false);
  const [numa, setNuma] = useState<{ key: string | null } | null>(null);
  return (
    <Card className="p-5">
      <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => setEdit(true)}><Pencil className="h-3.5 w-3.5" />Edit</Button>}>Processor details</SectionTitle>
      <Dl>
        <Dt>Type</Dt><Dd>{c.type ? <span className="font-mono text-compact">{c.type}</span> : <Off>Default (kvm64)</Off>} <PendingMark s={ctx.s} keys={["cpu"]} /></Dd>
        <Dt>Flags</Dt><Dd>{c.flags.length ? <span className="flex flex-wrap gap-1">{c.flags.map((f) => <Chip key={f.name} tone={f.mode === "+" ? "good" : "warning"}>{f.mode}{f.name}</Chip>)}</span> : <Off>None</Off>}</Dd>
        <Dt>Hypervisor hidden</Dt><Dd>{c.hidden ? "Yes" : "No"}</Dd>
        <Dt>Active CPUs</Dt><Dd>{c.vcpus !== null ? `${c.vcpus} of ${c.sockets * c.cores}` : <Off>All {c.sockets * c.cores}</Off>} <PendingMark s={ctx.s} keys={["vcpus"]} /></Dd>
        <Dt>CPU affinity</Dt><Dd>{c.affinity ? <span className="font-mono text-compact">{c.affinity}</span> : <Off>Any host CPU</Off>}</Dd>
        <Dt>NUMA</Dt><Dd>{c.numa ? "On" : "Off"}</Dd>
      </Dl>
      {c.numa && (
        <div className="mt-4">
          <div className="flex items-center justify-between mb-1"><Heading>NUMA nodes</Heading><Button size="sm" variant="ghost" onClick={() => setNuma({ key: null })}><Plus className="h-3.5 w-3.5" />Add</Button></div>
          {vm.numaNodes.length === 0 ? <p className="text-xs text-ink-3">No virtual NUMA nodes are defined. Proxmox spreads the memory itself.</p> : (
            <div className="divide-y divide-line">{vm.numaNodes.map((n) => (
              <div key={n.key} className="flex items-center gap-3 py-2 text-compact"><span className="font-mono">{n.key}</span><span className="flex-1 min-w-0 truncate text-ink-2">CPUs {n.cpus}{n.hostnodes ? ` · host ${n.hostnodes}` : ""}{n.memory ? ` · ${n.memory} MiB` : ""}{n.policy ? ` · ${n.policy}` : ""}</span><Button size="sm" variant="ghost" aria-label={`Edit ${n.key}`} onClick={() => setNuma({ key: n.key })}><Pencil className="h-3.5 w-3.5" /></Button></div>
            ))}</div>
          )}
        </div>
      )}
      {edit && <CpuModal ctx={ctx} onClose={() => setEdit(false)} />}
      {numa && <NumaModal ctx={ctx} nodeKey={numa.key} onClose={() => setNuma(null)} />}
    </Card>
  );
}

function useChoices(ctx: SCtx) {
  return useLoad<Choices>(() => ctx.api.choices(ctx.vmid), [ctx.api, ctx.vmid]);
}

function CpuModal({ ctx, onClose }: { ctx: SCtx; onClose: () => void }) {
  const c = ctx.s.vm!.cpu;
  const ch = useChoices(ctx);
  const { run, busy, error, warnings } = useRun(ctx.reload);
  const [type, setType] = useState(c.type ?? "");
  const [flags, setFlags] = useState<Record<string, "+" | "-">>(Object.fromEntries(c.flags.map((f) => [f.name, f.mode])));
  const [hidden, setHidden] = useState(c.hidden);
  const [vcpus, setVcpus] = useState(c.vcpus === null ? "" : String(c.vcpus));
  const [affinity, setAffinity] = useState(c.affinity ?? "");
  const [numa, setNuma] = useState(c.numa);
  const models = ch.data?.cpuModels ?? [];
  const known = ch.data?.cpuFlags ?? [];
  const flagNames = [...new Set([...Object.keys(CPU_FLAG_HINTS).filter((n) => !known.length || known.some((k) => k.name === n)), ...known.map((k) => k.name), ...Object.keys(flags)])].sort();
  const max = c.sockets * c.cores;
  const save = async () => {
    const r = await run(() => ctx.api.save(ctx.vmid, "cpu", { digest: ctx.s.digest, type: type || null, flags: Object.entries(flags).map(([name, mode]) => ({ name, mode })), hidden, vcpus: vcpus.trim() === "" ? null : toNum(vcpus), affinity: affinity.trim() || null, numa }));
    if (r && !r.warnings.length) onClose();
  };
  const cycle = (n: string) => setFlags((f) => { const x = { ...f }; if (!x[n]) x[n] = "+"; else if (x[n] === "+") x[n] = "-"; else delete x[n]; return x; });
  return (
    <Modal size="lg" icon={<Cpu className="h-5 w-5" />} title="Processor details" subtitle={`${ctx.s.name} #${ctx.vmid}. Cores and sockets are in Processor and memory.`} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{warnings.length ? "Close" : "Cancel"}</Button><Button variant="primary" onClick={save} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Save</Button></>}>
      <div className="space-y-4">
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">CPU type</span>
          <Input list="cpu-models" value={type} onChange={(e) => setType(e.target.value)} placeholder="Default (kvm64)" className="font-mono" />
          <datalist id="cpu-models">{models.map((m) => <option key={m.name} value={m.name}>{m.vendor ?? ""}</option>)}</datalist>
          <span className="block text-xs text-ink-3 mt-1.5">“host” gives the VM every feature of the real CPU but can't move between different hosts. x86-64-v2-AES is a safe middle.</span>
        </label>
        <div>
          <Heading>Flags (click to turn on, off or back to default)</Heading>
          <div className="flex flex-wrap gap-2 mt-2">{flagNames.map((n) => (
            <button key={n} onClick={() => cycle(n)} title={known.find((k) => k.name === n)?.description || CPU_FLAG_HINTS[n]} className={`h-8 px-2.5 rounded-lg border text-compact font-mono ${flags[n] === "+" ? "border-accent text-accent bg-accent-soft" : flags[n] === "-" ? "border-warning text-warning" : "border-line text-ink-3 hover:text-ink-2"}`}>{flags[n] ?? "·"}{n}</button>
          ))}</div>
          <p className="text-xs text-ink-3 mt-2">Spectre and Meltdown protections for a VM are CPU flags: <span className="font-mono">+spec-ctrl</span>, <span className="font-mono">+ssbd</span>, <span className="font-mono">+pcid</span>, <span className="font-mono">+md-clear</span>. Turn them on when the host CPU supports them.</p>
        </div>
        <SwitchRow label="Hide the hypervisor" hint="Helps some GPU drivers start in a VM." checked={hidden} onChange={setHidden} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Active CPUs (of {max})</span><Input type="number" min={1} max={max} value={vcpus} onChange={(e) => setVcpus(e.target.value)} placeholder="All" /><span className="block text-xs text-ink-3 mt-1.5">Fewer than the total lets you add CPUs later without a restart.</span></label>
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">CPU affinity</span><Input value={affinity} onChange={(e) => setAffinity(e.target.value)} placeholder="Any, or 0-3,8" className="font-mono" /><span className="block text-xs text-ink-3 mt-1.5">Pins the VM to these host CPUs.</span></label>
        </div>
        <SwitchRow label="NUMA" hint="Needed for memory and CPU hotplug and for large VMs." checked={numa} onChange={setNuma} />
        <Warnings list={warnings} />
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function NumaModal({ ctx, nodeKey, onClose }: { ctx: SCtx; nodeKey: string | null; onClose: () => void }) {
  const n = ctx.s.vm!.numaNodes.find((x) => x.key === nodeKey);
  const { run, busy, error } = useRun(ctx.reload, onClose);
  const [cpus, setCpus] = useState(n?.cpus ?? "0-1");
  const [host, setHost] = useState(n?.hostnodes ?? "");
  const [mem, setMem] = useState(n?.memory ? String(n.memory) : "");
  const [policy, setPolicy] = useState(n?.policy ?? "");
  const save = () => run(() => ctx.api.save(ctx.vmid, "numa", { digest: ctx.s.digest, action: nodeKey ? "set" : "add", ...(nodeKey ? { key: nodeKey } : {}), cpus, hostnodes: host || undefined, memory: toNum(mem) ?? undefined, policy: policy || undefined }));
  return (
    <Modal size="sm" title={nodeKey ? `Edit ${nodeKey}` : "Add a NUMA node"} onClose={onClose} footer={<>{nodeKey && <Button variant="danger" onClick={() => run(() => ctx.api.save(ctx.vmid, "numa", { digest: ctx.s.digest, action: "remove", key: nodeKey }))} disabled={busy}><Trash2 className="h-4 w-4" />Remove</Button>}<Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>Save</Button></>}>
      <div className="space-y-3">
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Virtual CPUs</span><Input value={cpus} onChange={(e) => setCpus(e.target.value)} className="font-mono" placeholder="0-3" /></label>
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Host NUMA nodes</span><Input value={host} onChange={(e) => setHost(e.target.value)} className="font-mono" placeholder="Any, or 0-1" /></label>
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Memory (MiB)</span><Input type="number" value={mem} onChange={(e) => setMem(e.target.value)} placeholder="Share evenly" /></label>
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Policy</span><Select value={policy} onChange={(e) => setPolicy(e.target.value)}><option value="">Default</option><option value="preferred">Preferred</option><option value="bind">Bind</option><option value="interleave">Interleave</option></Select></label>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

/* ── Memory details, machine type and SCSI controller (VM) ──────────────────────────── */

export function SystemCard({ ctx }: { ctx: SCtx }) {
  const vm = ctx.s.vm!;
  const [edit, setEdit] = useState<"memory" | "machine" | null>(null);
  return (
    <Card className="p-5">
      <SectionTitle action={<span className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => setEdit("memory")}><Pencil className="h-3.5 w-3.5" />Memory</Button><Button size="sm" variant="ghost" onClick={() => setEdit("machine")}><Pencil className="h-3.5 w-3.5" />Machine</Button></span>}>Machine type and memory details</SectionTitle>
      <Dl>
        <Dt>Machine type</Dt><Dd>{vm.machine.type ? <span className="font-mono text-compact">{vm.machine.type}</span> : <Off>Default (i440fx)</Off>} <PendingMark s={ctx.s} keys={["machine"]} /></Dd>
        <Dt>Virtual IOMMU</Dt><Dd>{vm.machine.viommu ? vm.machine.viommu === "intel" ? "Intel" : "VirtIO" : <Off>Off</Off>}</Dd>
        <Dt>SCSI controller</Dt><Dd>{SCSI_HW_LABEL[vm.scsihw] ?? vm.scsihw} <PendingMark s={ctx.s} keys={["scsihw"]} /></Dd>
        <Dt>Memory shares</Dt><Dd>{vm.memory.shares !== null ? vm.memory.shares : <Off>Default (1000)</Off>}</Dd>
        <Dt>Huge pages</Dt><Dd>{vm.memory.hugepages ? vm.memory.hugepages === "any" ? "Any size" : vm.memory.hugepages === "2" ? "2 MiB" : "1 GiB" : <Off>Off</Off>}{vm.memory.keephugepages ? " · kept after shutdown" : ""}</Dd>
      </Dl>
      {edit === "memory" && <MemoryModal ctx={ctx} onClose={() => setEdit(null)} />}
      {edit === "machine" && <MachineModal ctx={ctx} onClose={() => setEdit(null)} />}
    </Card>
  );
}

function MemoryModal({ ctx, onClose }: { ctx: SCtx; onClose: () => void }) {
  const m = ctx.s.vm!.memory;
  const { run, busy, error, warnings } = useRun(ctx.reload);
  const [shares, setShares] = useState(m.shares === null ? "" : String(m.shares));
  const [huge, setHuge] = useState(m.hugepages ?? "");
  const [keep, setKeep] = useState(m.keephugepages);
  const save = async () => {
    const r = await run(() => ctx.api.save(ctx.vmid, "memory", { digest: ctx.s.digest, shares: shares.trim() === "" ? null : toNum(shares), hugepages: huge || null, keephugepages: huge ? keep : false }));
    if (r && !r.warnings.length) onClose();
  };
  return (
    <Modal size="sm" title="Memory details" subtitle="Minimum memory is in Processor and memory." onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{warnings.length ? "Close" : "Cancel"}</Button><Button variant="primary" onClick={save} disabled={busy}>Save</Button></>}>
      <div className="space-y-4">
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Memory shares (0 to 50000)</span><Input type="number" min={0} max={50000} value={shares} onChange={(e) => setShares(e.target.value)} placeholder="1000" /><span className="block text-xs text-ink-3 mt-1.5">When ballooning, VMs with more shares keep more memory when the host runs short.</span></label>
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Huge pages</span><Select value={huge} onChange={(e) => setHuge(e.target.value)}><option value="">Off</option>{HUGEPAGES.map((h) => <option key={h} value={h}>{h === "any" ? "Any size" : h === "2" ? "2 MiB" : "1 GiB"}</option>)}</Select></label>
        {huge && <SwitchRow label="Keep huge pages after shutdown" hint="Holds the memory for the next start." checked={keep} onChange={setKeep} />}
        <Warnings list={warnings} />
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function MachineModal({ ctx, onClose }: { ctx: SCtx; onClose: () => void }) {
  const m = ctx.s.vm!.machine;
  const ch = useChoices(ctx);
  const { run, busy, error, warnings } = useRun(ctx.reload);
  const [type, setType] = useState(m.type ?? "");
  const [viommu, setViommu] = useState(m.viommu ?? "");
  const [aw, setAw] = useState(m.awBits === null ? "" : String(m.awBits));
  const [s3, setS3] = useState(m.enableS3);
  const [s4, setS4] = useState(m.enableS4);
  const [scsi, setScsi] = useState(ctx.s.vm!.scsihw);
  const versions = (ch.data?.machines ?? []).map((x) => x.id);
  const save = async () => {
    const r = await run(() => ctx.api.save(ctx.vmid, "machine", { digest: ctx.s.digest, type: type || null, viommu: viommu || null, awBits: viommu === "intel" ? toNum(aw) : null, enableS3: s3, enableS4: s4, scsihw: scsi }));
    if (r && !r.warnings.length) onClose();
  };
  return (
    <Modal size="lg" title="Machine type and controller" subtitle={`${ctx.s.name} #${ctx.vmid}`} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{warnings.length ? "Close" : "Cancel"}</Button><Button variant="primary" onClick={save} disabled={busy}>Save</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Machine type</span>
            <Select value={type} onChange={(e) => setType(e.target.value)}><option value="">Default (i440fx, latest)</option><option value="q35">q35 (modern PCI Express layout)</option><option value="pc">i440fx</option>{versions.filter((v) => v !== "q35" && v !== "pc").map((v) => <option key={v} value={v}>{v}</option>)}{type && !["", "q35", "pc", ...versions].includes(type) && <option value={type}>{type}</option>}</Select>
            <span className="block text-xs text-ink-3 mt-1.5">q35 is needed for PCI Express passthrough. A version pins the layout so updates don't change it.</span></label>
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">SCSI controller</span>
            <Select value={scsi} onChange={(e) => setScsi(e.target.value)}>{SCSI_HW.map((h) => <option key={h} value={h}>{SCSI_HW_LABEL[h]}</option>)}</Select></label>
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Virtual IOMMU</span>
            <Select value={viommu} onChange={(e) => setViommu(e.target.value)} disabled={!type.startsWith("q35") && !type.startsWith("pc-q35")}><option value="">Off</option><option value="intel">Intel</option><option value="virtio">VirtIO</option></Select><span className="block text-xs text-ink-3 mt-1.5">Needs q35. Lets nested virtualization pass devices through.</span></label>
          {viommu === "intel" && <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Address width (bits)</span><Input type="number" min={32} max={64} value={aw} onChange={(e) => setAw(e.target.value)} placeholder="Default" /></label>}
        </div>
        <SwitchRow label="Allow sleep to RAM" hint="Lets the guest suspend itself." checked={s3} onChange={setS3} />
        <SwitchRow label="Allow hibernate" hint="Lets the guest hibernate itself." checked={s4} onChange={setS4} />
        <Warnings list={warnings} />
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

/* ── Small devices (VM): random numbers, watchdog, shared folders, parallel ports ───── */

type Dev = { kind: "rng" | "watchdog" | "virtiofs" | "parallel"; key?: string } | null;

export function SmallDevicesCard({ ctx }: { ctx: SCtx }) {
  const vm = ctx.s.vm!;
  const [dev, setDev] = useState<Dev>(null);
  const rows: { kind: NonNullable<Dev>["kind"]; key?: string; title: string; detail: string }[] = [];
  if (vm.rng) rows.push({ kind: "rng", title: "Random number generator", detail: `${vm.rng.source}${vm.rng.maxBytes !== null ? ` · ${vm.rng.maxBytes} bytes per ${vm.rng.period ?? 1000} ms` : ""}` });
  if (vm.watchdog) rows.push({ kind: "watchdog", title: "Watchdog", detail: `${vm.watchdog.model}${vm.watchdog.action ? ` · ${vm.watchdog.action}` : ""}` });
  for (const f of vm.virtiofs) rows.push({ kind: "virtiofs", key: f.key, title: `Shared folder ${f.key}`, detail: `${f.dirid} · cache ${f.cache}` });
  for (const p of vm.parallel) rows.push({ kind: "parallel", key: p.key, title: `Parallel port ${p.key}`, detail: p.path });
  const missing: { kind: NonNullable<Dev>["kind"]; label: string }[] = [];
  if (!vm.rng) missing.push({ kind: "rng", label: "Random number generator" });
  if (!vm.watchdog) missing.push({ kind: "watchdog", label: "Watchdog" });
  missing.push({ kind: "virtiofs", label: "Shared folder" }, { kind: "parallel", label: "Parallel port" });
  return (
    <Card className="p-5">
      <SectionTitle>Other devices</SectionTitle>
      {rows.length === 0 ? <p className="text-sm text-ink-3">No random number generator, watchdog, shared folders or parallel ports.</p> : (
        <div className="divide-y divide-line">{rows.map((r) => (
          <div key={r.title} className="flex flex-wrap items-center gap-3 py-2.5"><div className="flex-1 min-w-0 basis-44"><div className="text-sm">{r.title} <PendingMark s={ctx.s} keys={[r.key ?? (r.kind === "rng" ? "rng0" : r.kind)]} /></div><div className="text-xs text-ink-3 truncate font-mono">{r.detail}</div></div><Button size="sm" variant="ghost" aria-label={`Edit ${r.title}`} onClick={() => setDev({ kind: r.kind, key: r.key })}><Pencil className="h-3.5 w-3.5" /></Button></div>
        ))}</div>
      )}
      <div className="flex flex-wrap gap-2 mt-3">{missing.map((m) => <Button key={m.kind} size="sm" variant="secondary" onClick={() => setDev({ kind: m.kind })}><Plus className="h-3.5 w-3.5" />{m.label}</Button>)}</div>
      <p className="text-xs text-ink-3 mt-3">The random number generator feeds the guest's entropy pool. A shared folder uses a directory mapping set up under Datacenter, Resource mappings.</p>
      {dev && <DeviceModal ctx={ctx} dev={dev} onClose={() => setDev(null)} />}
    </Card>
  );
}

function DeviceModal({ ctx, dev, onClose }: { ctx: SCtx; dev: NonNullable<Dev>; onClose: () => void }) {
  const vm = ctx.s.vm!;
  const ch = useChoices(ctx);
  const { run, busy, error, warnings } = useRun(ctx.reload);
  const existing = dev.kind === "virtiofs" ? vm.virtiofs.find((f) => f.key === dev.key) : null;
  const [source, setSource] = useState(vm.rng?.source ?? "/dev/urandom");
  const [maxBytes, setMaxBytes] = useState(vm.rng?.maxBytes === null || vm.rng === null ? "1024" : String(vm.rng.maxBytes));
  const [period, setPeriod] = useState(vm.rng?.period === null || vm.rng === null ? "1000" : String(vm.rng.period));
  const [model, setModel] = useState(vm.watchdog?.model ?? "i6300esb");
  const [wdAction, setWdAction] = useState(vm.watchdog?.action ?? "reset");
  const [dirid, setDirid] = useState(existing?.dirid ?? "");
  const [cache, setCache] = useState(existing?.cache ?? "auto");
  const [dio, setDio] = useState(existing?.directIo ?? false);
  const [acl, setAcl] = useState(existing?.exposeAcl ?? false);
  const [xattr, setXattr] = useState(existing?.exposeXattr ?? false);
  const [path, setPath] = useState(vm.parallel.find((p) => p.key === dev.key)?.path ?? "/dev/parport0");
  const editing = dev.kind === "rng" ? !!vm.rng : dev.kind === "watchdog" ? !!vm.watchdog : !!dev.key;
  const body = (): Record<string, unknown> => {
    const base = { digest: ctx.s.digest, action: editing ? "set" : "add", ...(dev.key ? { key: dev.key } : {}) };
    if (dev.kind === "rng") return { ...base, source, maxBytes: toNum(maxBytes) ?? undefined, period: toNum(period) ?? undefined };
    if (dev.kind === "watchdog") return { ...base, model, watchdogAction: wdAction };
    if (dev.kind === "virtiofs") return { ...base, dirid, cache, directIo: dio, exposeAcl: acl, exposeXattr: xattr };
    return { ...base, path };
  };
  const save = async () => {
    const r = await run(() => ctx.api.save(ctx.vmid, dev.kind, body()));
    if (r && !r.warnings.length) onClose();
  };
  const title = { rng: "Random number generator", watchdog: "Watchdog", virtiofs: "Shared folder", parallel: "Parallel port" }[dev.kind];
  return (
    <Modal size="sm" title={`${editing ? "Edit" : "Add"} ${title.toLowerCase()}`} onClose={onClose} footer={<>{editing && <Button variant="danger" disabled={busy} onClick={() => run(() => ctx.api.save(ctx.vmid, dev.kind, { digest: ctx.s.digest, action: "remove", ...(dev.key ? { key: dev.key } : {}) }))}><Trash2 className="h-4 w-4" />Remove</Button>}<Button variant="ghost" onClick={onClose}>{warnings.length ? "Close" : "Cancel"}</Button><Button variant="primary" onClick={save} disabled={busy || (dev.kind === "virtiofs" && !dirid)}>Save</Button></>}>
      <div className="space-y-3">
        {dev.kind === "rng" && <>
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Source</span><Select value={source} onChange={(e) => setSource(e.target.value)}>{RNG_SOURCES.map((s) => <option key={s} value={s} disabled={s !== "/dev/urandom" && !ctx.s.isAdmin}>{s}{s !== "/dev/urandom" ? " (administrators)" : ""}</option>)}</Select></label>
          <div className="grid grid-cols-2 gap-3"><label className="block"><span className="block text-compact text-ink-2 mb-1.5">Bytes per period</span><Input type="number" value={maxBytes} onChange={(e) => setMaxBytes(e.target.value)} /></label><label className="block"><span className="block text-compact text-ink-2 mb-1.5">Period (ms)</span><Input type="number" value={period} onChange={(e) => setPeriod(e.target.value)} /></label></div>
          <p className="text-xs text-ink-3">1024 bytes every 1000 ms is Proxmox's recommended limit; 0 bytes means unlimited.</p>
        </>}
        {dev.kind === "watchdog" && <>
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Model</span><Select value={model} onChange={(e) => setModel(e.target.value)}><option value="i6300esb">Intel 6300ESB</option><option value="ib700">iBASE 700</option></Select></label>
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">When it isn't fed</span><Select value={wdAction} onChange={(e) => setWdAction(e.target.value)}>{WATCHDOG_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}</Select></label>
        </>}
        {dev.kind === "virtiofs" && <>
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Directory mapping</span><Select value={dirid} onChange={(e) => setDirid(e.target.value)}><option value="">Pick one…</option>{(ch.data?.dirMappings ?? []).map((d) => <option key={d.id} value={d.id}>{d.id}{d.description ? ` · ${d.description}` : ""}</option>)}</Select>{ch.data && ch.data.dirMappings.length === 0 && <span className="block text-xs text-ink-3 mt-1.5">There are no directory mappings yet. An administrator adds them under Datacenter, Resource mappings.</span>}</label>
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Cache</span><Select value={cache} onChange={(e) => setCache(e.target.value)}><option value="auto">Auto</option><option value="always">Always</option><option value="metadata">Metadata</option><option value="never">Never</option></Select></label>
          <SwitchRow label="Direct I/O" checked={dio} onChange={setDio} />
          <SwitchRow label="Expose ACLs" checked={acl} onChange={setAcl} />
          <SwitchRow label="Expose extended attributes" checked={xattr} onChange={setXattr} />
        </>}
        {dev.kind === "parallel" && <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Host port</span><Input value={path} onChange={(e) => setPath(e.target.value)} className="font-mono" /><span className="block text-xs text-ink-3 mt-1.5">Only administrators may hand a host port to a VM.</span></label>}
        <Warnings list={warnings} />
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

/* ── VM options beyond the basics ───────────────────────────────────────────────────── */

export function VmOptionsCard({ ctx }: { ctx: SCtx }) {
  const o = ctx.s.vm!.options;
  const [edit, setEdit] = useState(false);
  const yn = (v: boolean) => (v ? "On" : "Off");
  return (
    <Card className="p-5">
      <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => setEdit(true)}><Settings2 className="h-3.5 w-3.5" />Edit</Button>}>More options</SectionTitle>
      <Dl>
        <Dt>USB tablet</Dt><Dd>{yn(o.tablet)}</Dd>
        <Dt>ACPI</Dt><Dd>{yn(o.acpi)}</Dd>
        <Dt>KVM hardware virtualization</Dt><Dd>{yn(o.kvm)}</Dd>
        <Dt>Freeze CPU at start</Dt><Dd>{yn(o.freeze)}</Dd>
        <Dt>Local time</Dt><Dd>{o.localtime === null ? <Off>Automatic</Off> : o.localtime ? "Host's local time" : "UTC"}</Dd>
        <Dt>Hotplug</Dt><Dd>{o.hotplug === null ? <Off>Disks, network, USB</Off> : o.hotplug.length ? o.hotplug.join(", ") : "None"}</Dd>
        <Dt>Keyboard layout</Dt><Dd>{o.keyboard ?? <Off>Default</Off>}</Dd>
        <Dt>Guest agent</Dt><Dd>{o.agent.enabled ? `On · ${o.agent.type === "isa" ? "ISA serial" : "VirtIO"}${o.agent.freezeFs ? " · freezes for backups" : ""}${o.agent.fstrimClonedDisks ? " · trims clones" : ""}` : "Off"}</Dd>
        <Dt>SMBIOS</Dt><Dd>{o.smbios.manufacturer || o.smbios.product ? [o.smbios.manufacturer, o.smbios.product].filter(Boolean).join(" ") : <Off>Proxmox's</Off>}</Dd>
        {o.args && <><Dt>Extra arguments</Dt><Dd><span className="font-mono text-compact">{o.args}</span></Dd></>}
      </Dl>
      {edit && <VmOptionsModal ctx={ctx} onClose={() => setEdit(false)} />}
    </Card>
  );
}

function VmOptionsModal({ ctx, onClose }: { ctx: SCtx; onClose: () => void }) {
  const o = ctx.s.vm!.options;
  const { run, busy, error, warnings } = useRun(ctx.reload);
  const [f, setF] = useState({ tablet: o.tablet, acpi: o.acpi, kvm: o.kvm, freeze: o.freeze, tdf: o.tdf, allowKsm: o.allowKsm, localtime: o.localtime === null ? "auto" : o.localtime ? "local" : "utc", startdate: o.startdate ?? "", keyboard: o.keyboard ?? "", vmstatestorage: o.vmstatestorage ?? "", hotplugDefault: o.hotplug === null, hotplug: o.hotplug ?? ["disk", "network", "usb"], agentFreeze: o.agent.freezeFs, agentTrim: o.agent.fstrimClonedDisks, agentType: o.agent.type, folder: o.spice.folderSharing, video: o.spice.videoStreaming, mf: o.smbios.manufacturer, product: o.smbios.product, version: o.smbios.version, serial: o.smbios.serial, sku: o.smbios.sku, family: o.smbios.family, uuid: o.smbios.uuid, args: o.args ?? "" });
  const ch = useChoices(ctx);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    const body: Record<string, unknown> = { digest: ctx.s.digest, tablet: f.tablet, acpi: f.acpi, kvm: f.kvm, freeze: f.freeze, tdf: f.tdf, allowKsm: f.allowKsm,
      startdate: f.startdate.trim() || null, keyboard: f.keyboard || null, vmstatestorage: f.vmstatestorage || null, hotplug: f.hotplugDefault ? null : f.hotplug,
      agent: { freezeFs: f.agentFreeze, fstrimClonedDisks: f.agentTrim, type: f.agentType }, spice: { folderSharing: f.folder, videoStreaming: f.video },
      smbios: { manufacturer: f.mf, product: f.product, version: f.version, serial: f.serial, sku: f.sku, family: f.family, uuid: f.uuid } };
    if (f.localtime !== (o.localtime === null ? "auto" : o.localtime ? "local" : "utc")) body.localtime = f.localtime === "auto" ? null : f.localtime === "local";
    if ((f.args || null) !== o.args) body.args = f.args.trim() || null;
    const r = await run(() => ctx.api.save(ctx.vmid, "vmoptions", body));
    if (r && !r.warnings.length) onClose();
  };
  return (
    <Modal size="lg" icon={<Settings2 className="h-5 w-5" />} title="More options" subtitle={`${ctx.s.name} #${ctx.vmid}`} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{warnings.length ? "Close" : "Cancel"}</Button><Button variant="primary" onClick={save} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Save</Button></>}>
      <div className="space-y-4">
        <Heading>Hardware behaviour</Heading>
        <SwitchRow label="USB tablet" hint="A pointer that lines up with the screen. Turn off for a plain mouse." checked={f.tablet} onChange={(v) => set("tablet", v)} />
        <SwitchRow label="ACPI" hint="Power buttons and clean shutdown. Almost always on." checked={f.acpi} onChange={(v) => set("acpi", v)} />
        <SwitchRow label="KVM hardware virtualization" hint="Off makes the VM very slow; only for testing." checked={f.kvm} onChange={(v) => set("kvm", v)} />
        <SwitchRow label="Freeze CPU at start" hint="Starts paused so you can attach a debugger." checked={f.freeze} onChange={(v) => set("freeze", v)} />
        <SwitchRow label="Time drift fix" checked={f.tdf} onChange={(v) => set("tdf", v)} />
        <SwitchRow label="Kernel same-page merging" hint="Lets the host share identical memory between VMs." checked={f.allowKsm} onChange={(v) => set("allowKsm", v)} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Clock</span><Select value={f.localtime} onChange={(e) => set("localtime", e.target.value)}><option value="auto">Automatic by OS type</option><option value="local">Host's local time</option><option value="utc">UTC</option></Select></label>
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Start date</span><Input value={f.startdate} onChange={(e) => set("startdate", e.target.value)} placeholder="now, or 2026-01-31T12:00:00" className="font-mono" /></label>
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Keyboard layout</span><Select value={f.keyboard} onChange={(e) => set("keyboard", e.target.value)}><option value="">Default</option>{KEYBOARDS.map((k) => <option key={k} value={k}>{k}</option>)}</Select></label>
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Where suspend state is kept</span><Select value={f.vmstatestorage} onChange={(e) => set("vmstatestorage", e.target.value)}><option value="">Same as the disks</option>{(ch.data?.storages ?? []).map((s) => <option key={s} value={s}>{s}</option>)}</Select></label>
        </div>
        <Heading>Hotplug</Heading>
        <SwitchRow label="Use Proxmox's default" hint="Disks, network and USB." checked={f.hotplugDefault} onChange={(v) => set("hotplugDefault", v)} />
        {!f.hotplugDefault && <div className="flex flex-wrap gap-2">{HOTPLUG.map((h) => <button key={h} onClick={() => set("hotplug", f.hotplug.includes(h) ? f.hotplug.filter((x) => x !== h) : [...f.hotplug, h])} className={`h-8 px-3 rounded-lg border text-compact ${f.hotplug.includes(h) ? "border-accent text-accent bg-accent-soft" : "border-line text-ink-3"}`}>{h}</button>)}</div>}
        <Heading>Guest agent details</Heading>
        <SwitchRow label="Freeze file systems for backups" hint="Gives consistent backups. Needs the agent inside." checked={f.agentFreeze} onChange={(v) => set("agentFreeze", v)} />
        <SwitchRow label="Trim disks after cloning" checked={f.agentTrim} onChange={(v) => set("agentTrim", v)} />
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Agent channel</span><Select value={f.agentType} onChange={(e) => set("agentType", e.target.value)}><option value="virtio">VirtIO</option><option value="isa">ISA serial</option></Select></label>
        <Heading>SPICE</Heading>
        <SwitchRow label="Folder sharing" checked={f.folder} onChange={(v) => set("folder", v)} />
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Video streaming</span><Select value={f.video} onChange={(e) => set("video", e.target.value)}>{VIDEO_STREAMING.map((v) => <option key={v} value={v}>{v}</option>)}</Select></label>
        <Heading>SMBIOS (what the guest sees as its hardware maker)</Heading>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {([["mf", "Manufacturer"], ["product", "Product"], ["version", "Version"], ["serial", "Serial number"], ["sku", "SKU"], ["family", "Family"]] as const).map(([k, label]) => <label key={k} className="block"><span className="block text-compact text-ink-2 mb-1.5">{label}</span><Input value={f[k]} onChange={(e) => set(k, e.target.value)} /></label>)}
          <label className="block sm:col-span-2"><span className="block text-compact text-ink-2 mb-1.5">UUID</span><Input value={f.uuid} onChange={(e) => set("uuid", e.target.value)} className="font-mono" placeholder="Proxmox's" /></label>
        </div>
        <Heading>Extra QEMU arguments</Heading>
        <label className="block"><Input value={f.args} onChange={(e) => set("args", e.target.value)} placeholder="Only administrators can set these" className="font-mono" disabled={!ctx.s.isAdmin} /><span className="block text-xs text-ink-3 mt-1.5">Passed to QEMU as typed. A wrong one stops the VM from starting.</span></label>
        <Warnings list={warnings} />
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

/* ── Container options ──────────────────────────────────────────────────────────────── */

export function CtOptionsCard({ ctx }: { ctx: SCtx }) {
  const c = ctx.s.ct!;
  const [edit, setEdit] = useState(false);
  return (
    <Card className="p-5">
      <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => setEdit(true)}><Settings2 className="h-3.5 w-3.5" />Edit</Button>}>Container options</SectionTitle>
      <Dl>
        <Dt>Privileges</Dt><Dd>{c.unprivileged ? "Unprivileged (safer)" : "Privileged"}</Dd>
        <Dt>Console mode</Dt><Dd>{c.cmode}</Dd>
        <Dt>Terminals</Dt><Dd>{c.tty}</Dd>
        <Dt>Console device</Dt><Dd>{c.console ? "Connected" : "Not connected"}</Dd>
        <Dt>Time zone</Dt><Dd>{c.timezone ?? <Off>Same as the host</Off>}</Dd>
        <Dt>Architecture</Dt><Dd>{c.arch}</Dd>
        <Dt>OS type</Dt><Dd>{c.ostype ?? <Off>Detected</Off>}</Dd>
        <Dt>Hook script</Dt><Dd>{c.hookscript ? <span className="font-mono text-compact">{c.hookscript}</span> : <Off>None</Off>}</Dd>
      </Dl>
      <p className="text-xs text-ink-3 mt-3">{c.unprivileged ? "Unprivileged containers map root inside to an ordinary user on the host. That is chosen when the container is created and can't be changed; restore a backup as a new container to switch." : "A privileged container's root is the host's root. That is chosen when the container is created and can't be changed; restore a backup as an unprivileged container to switch."}</p>
      {edit && <CtOptionsModal ctx={ctx} onClose={() => setEdit(false)} />}
    </Card>
  );
}

function CtOptionsModal({ ctx, onClose }: { ctx: SCtx; onClose: () => void }) {
  const c = ctx.s.ct!;
  const { run, busy, error, warnings } = useRun(ctx.reload);
  const [cmode, setCmode] = useState(c.cmode);
  const [tty, setTty] = useState(String(c.tty));
  const [cons, setCons] = useState(c.console);
  const [tz, setTz] = useState(c.timezone ?? "");
  const [arch, setArch] = useState(c.arch);
  const [ostype, setOstype] = useState(c.ostype ?? "");
  const [hook, setHook] = useState(c.hookscript ?? "");
  const [debug, setDebug] = useState(c.debug);
  const save = async () => {
    const body: Record<string, unknown> = { digest: ctx.s.digest, cmode, tty: toNum(tty) ?? 2, console: cons, timezone: tz.trim() || null, ostype: ostype || null, hookscript: hook.trim() || null, debug };
    if (arch !== c.arch) body.arch = arch;
    const r = await run(() => ctx.api.save(ctx.vmid, "ctoptions", body));
    if (r && !r.warnings.length) onClose();
  };
  return (
    <Modal size="lg" icon={<Settings2 className="h-5 w-5" />} title="Container options" subtitle={`${ctx.s.name} #${ctx.vmid}`} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{warnings.length ? "Close" : "Cancel"}</Button><Button variant="primary" onClick={save} disabled={busy}>Save</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Console mode</span><Select value={cmode} onChange={(e) => setCmode(e.target.value)}>{CT_CMODES.map((m) => <option key={m} value={m}>{m === "tty" ? "tty (attach to a terminal)" : m === "console" ? "console (attach to /dev/console)" : "shell (a root shell, no login)"}</option>)}</Select></label>
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Terminals (0 to 6)</span><Input type="number" min={0} max={6} value={tty} onChange={(e) => setTty(e.target.value)} /></label>
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Time zone</span><Input value={tz} onChange={(e) => setTz(e.target.value)} placeholder="Same as the host, or Europe/Berlin" /></label>
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">OS type</span><Select value={ostype} onChange={(e) => setOstype(e.target.value)}><option value="">Detected</option>{CT_OSTYPES.map((o) => <option key={o} value={o}>{o}</option>)}</Select></label>
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Architecture</span><Select value={arch} onChange={(e) => setArch(e.target.value)}>{CT_ARCHES.map((o) => <option key={o} value={o}>{o}</option>)}</Select></label>
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Hook script</span><Input value={hook} onChange={(e) => setHook(e.target.value)} placeholder="local:snippets/hook.pl" className="font-mono" disabled={!ctx.s.isAdmin} /></label>
        </div>
        <SwitchRow label="Connect the console device" hint="Off if something else uses /dev/console." checked={cons} onChange={setCons} />
        <SwitchRow label="Debug logging at start" hint="Writes a detailed log of the next start." checked={debug} onChange={setDebug} />
        <Warnings list={warnings} />
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

