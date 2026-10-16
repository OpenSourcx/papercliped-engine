import { useState } from "react";
import { Cpu, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { errorText } from "../../data/engine/guestApi.ts";
import { useMachineApi, type CpuModelRow } from "../../data/engine/machineApi.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, EmptyState, Input, Notice, PageFrame, PageHeader, Select, Tabs } from "../../ui/primitives.tsx";
import { ConfirmTypeModal, useLoad } from "../disks/common.tsx";
import { SwitchRow } from "./MachineSettingsKit.tsx";

/** Custom CPU models (a named CPU type with its own flags) and what this device's virtualization supports. */
export function CpuModelsPage() {
  const [tab, setTab] = useState<"models" | "support">("models");
  return (
    <PageFrame width="4xl">
      <PageHeader title="CPU models" subtitle="A custom CPU model is a named CPU type you pick for a VM. Give every VM in a cluster the same model and they can move between different hosts." />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: "models", label: "Custom models" }, { id: "support", label: "What this device supports" }]} className="mb-5" />
      {tab === "models" ? <Models /> : <Support />}
    </PageFrame>
  );
}

function Models() {
  const api = useMachineApi();
  const [tick, setTick] = useState(0);
  const l = useLoad(() => api.cpuModels(), [api, tick]);
  const caps = useLoad(() => api.capabilities(), [api]);
  const [edit, setEdit] = useState<CpuModelRow | "new" | null>(null);
  const [del, setDel] = useState<CpuModelRow | null>(null);
  if (l.error) return <Notice tone="critical" title="Couldn't read this from the device">{l.error}</Notice>;
  if (!l.data) return <p className="text-sm text-ink-3"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Reading…</p>;
  const d = l.data;
  const reload = () => setTick((n) => n + 1);
  return (
    <div className="space-y-4">
      {!d.canModify && <Notice tone="info">Your Proxmox account can read these but not change them (it needs Mapping.Modify on /mapping/cpu).</Notice>}
      <Card>
        {d.models.length === 0 ? (
          <EmptyState icon={<Cpu className="h-5 w-5" />} title="No custom CPU models" body="Pick a base model, add or remove flags, and use the result as a VM's CPU type." action={d.canModify ? <Button variant="primary" onClick={() => setEdit("new")}><Plus className="h-4 w-4" />Add a model</Button> : undefined} />
        ) : (
          <div className="divide-y divide-line">
            {d.models.map((m) => (
              <div key={m.cputype} className="p-4 flex flex-wrap items-center gap-3">
                <div className="flex-1 min-w-0 basis-52"><div className="font-mono text-sm">custom-{m.cputype}</div><div className="text-xs text-ink-3 truncate">Based on {m.reportedModel}{m.flags ? ` · ${m.flags}` : ""}{m.hidden ? " · hypervisor hidden" : ""}</div></div>
                {d.canModify && <><Button size="sm" variant="ghost" aria-label={`Edit ${m.cputype}`} onClick={() => setEdit(m)}><Pencil className="h-3.5 w-3.5" /></Button><Button size="sm" variant="ghost" aria-label={`Delete ${m.cputype}`} onClick={() => setDel(m)}><Trash2 className="h-3.5 w-3.5" /></Button></>}
              </div>
            ))}
          </div>
        )}
      </Card>
      {d.models.length > 0 && d.canModify && <Button onClick={() => setEdit("new")}><Plus className="h-4 w-4" />Add a model</Button>}
      {edit && <ModelModal row={edit === "new" ? null : edit} base={(caps.data?.cpu ?? []).filter((c) => !c.custom).map((c) => c.name)} flags={(caps.data?.flags ?? []).map((f) => f.name)} onClose={() => setEdit(null)} onDone={reload} />}
      {del && <ConfirmTypeModal title={`Delete ${del.cputype}?`} subtitle="VMs that use it can't start until you pick another CPU type." expected={del.cputype} actionLabel="Delete" onConfirm={(t) => api.deleteCpuModel(del.cputype, t)} onClose={() => setDel(null)} onDone={reload} />}
    </div>
  );
}

function ModelModal({ row, base, flags, onClose, onDone }: { row: CpuModelRow | null; base: string[]; flags: string[]; onClose: () => void; onDone: () => void }) {
  const api = useMachineApi();
  const [name, setName] = useState(row?.cputype ?? "");
  const [reported, setReported] = useState(row?.reportedModel ?? "");
  const [fl, setFl] = useState(row?.flags ?? "");
  const [hidden, setHidden] = useState(row?.hidden ?? false);
  const [vendor, setVendor] = useState(row?.hvVendorId ?? "");
  const [phys, setPhys] = useState(row?.physBits ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveCpuModel(row ? row.cputype : null, { ...(row ? {} : { cputype: name }), reportedModel: reported, flags: fl.trim() || null, hidden, hvVendorId: vendor.trim() || null, physBits: phys.trim() || null, ...(row?.digest ? {} : {}) });
      onDone();
      onClose();
    } catch (e) {
      setError(errorText(e, "Proxmox refused that"));
      setBusy(false);
    }
  };
  return (
    <Modal size="md" icon={<Cpu className="h-5 w-5" />} title={row ? `Edit ${row.cputype}` : "Add a CPU model"} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy || !name || !reported}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Save</Button></>}>
      <div className="space-y-4">
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Name</span><Input value={name} onChange={(e) => setName(e.target.value)} disabled={!!row} className="font-mono" placeholder="fast" /><span className="block text-xs text-ink-3 mt-1.5">VMs refer to it as custom-{name || "name"}.</span></label>
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Based on</span><Select value={reported} onChange={(e) => setReported(e.target.value)}><option value="">Pick a CPU model…</option>{base.map((b) => <option key={b} value={b}>{b}</option>)}{reported && !base.includes(reported) && <option value={reported}>{reported}</option>}</Select></label>
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Flags</span><Input value={fl} onChange={(e) => setFl(e.target.value)} className="font-mono" placeholder="+aes;-pcid" list="cpu-flag-list" /><datalist id="cpu-flag-list">{flags.map((f) => <option key={f} value={`+${f}`} />)}</datalist><span className="block text-xs text-ink-3 mt-1.5">+name turns a feature on, -name turns it off; separate with semicolons.</span></label>
        <SwitchRow label="Hide the hypervisor" checked={hidden} onChange={setHidden} />
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Hyper-V vendor ID</span><Input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Optional" /></label>
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Physical address bits</span><Input value={phys} onChange={(e) => setPhys(e.target.value)} placeholder="host, or 8 to 64" /></label>
        </div>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function Support() {
  const api = useMachineApi();
  const c = useLoad(() => api.capabilities(), [api]);
  if (c.error) return <Notice tone="critical" title="Couldn't read this from the device">{c.error}</Notice>;
  if (!c.data) return <p className="text-sm text-ink-3"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Reading…</p>;
  const d = c.data;
  return (
    <div className="space-y-4">
      {d.migration && <Card className="p-5"><div className="text-compact text-ink-3">Live migration</div><p className="text-sm mt-1">{d.migration.cpu ? <>Safe CPU type for moving VMs between hosts: <span className="font-mono">{d.migration.cpu}</span>.</> : "This node reports no common CPU type."}</p></Card>}
      <Card className="p-5">
        <h2 className="text-compact font-semibold uppercase tracking-label text-ink-3 mb-3">CPU types ({d.cpu.length})</h2>
        <div className="flex flex-wrap gap-1.5">{d.cpu.map((x) => <Chip key={x.name} tone={x.custom ? "accent" : "neutral"}>{x.name}</Chip>)}</div>
      </Card>
      <Card className="p-5">
        <h2 className="text-compact font-semibold uppercase tracking-label text-ink-3 mb-3">CPU flags ({d.flags.length})</h2>
        <div className="divide-y divide-line">{d.flags.map((f) => <div key={f.name} className="py-2 flex flex-wrap gap-x-3 text-compact"><span className="font-mono w-32 shrink-0">{f.name}</span><span className="text-ink-2 flex-1 min-w-0">{f.description}</span>{f.supported === false && <Chip tone="warning">Not supported here</Chip>}</div>)}</div>
      </Card>
      <Card className="p-5">
        <h2 className="text-compact font-semibold uppercase tracking-label text-ink-3 mb-3">Machine types ({d.machines.length})</h2>
        <div className="flex flex-wrap gap-1.5">{d.machines.map((x) => <Chip key={x.id}>{x.id}</Chip>)}</div>
      </Card>
    </div>
  );
}
