import { Link } from "react-router-dom";
import { formatBytes } from "../../../lib/storage.ts";
import { Field, Input, Notice, selectClass, Select } from "../../../ui/primitives.tsx";
import { AddButton, Grid, ListItem, Num, Pick, SwitchRow } from "./fields.tsx";
import { nextKey, type CtForm, type DeviceForm, type MountForm } from "./state.ts";
import type { StepProps } from "./types.ts";

type P = StepProps<CtForm>;

export function TemplateStep({ f, set, o, err, device, onClose }: P & { device: string; onClose: () => void }) {
  return (
    <div className="space-y-4">
      {o.templates.length === 0 ? (
        <Notice tone="warning" title="No container templates yet">There are none on {device}. <Link onClick={onClose} to={`/${device}/storage`} className="text-accent hover:underline">Get one from the template catalog</Link> in Storage, then come back.</Notice>
      ) : (
        <Field label="Template" htmlFor="wz-tpl" error={err("template")} hint="The system the container starts with.">
          <Select id="wz-tpl" value={f.template} onChange={(e) => set({ template: e.target.value })}>
            {o.templates.map((t) => <option key={t.volid} value={t.volid}>{t.name}{t.size ? ` · ${formatBytes(t.size)}` : ""}</option>)}
          </Select>
        </Field>
      )}
    </div>
  );
}

export function CtDiskStep({ f, set, o, err }: P) {
  return (
    <div className="space-y-4">
      <Grid>
        <Field label="Storage" htmlFor="wz-ctstore" error={err("disk.storage")}>
          <Pick id="wz-ctstore" value={f.storage} onChange={(storage) => set({ storage })} options={o.ctStorages.map((s) => ({ value: s.storage, label: `${s.storage}${s.avail !== null ? ` · ${formatBytes(s.avail)} free` : ""}` }))} />
        </Field>
        <Field label="Disk size" htmlFor="wz-ctsize" error={err("disk.sizeGb")} hint="The root disk. You can grow it later."><Num id="wz-ctsize" value={f.sizeGb} onChange={(sizeGb) => set({ sizeGb })} suffix="GiB" /></Field>
      </Grid>
      {o.ctStorages.length === 0 && <Notice tone="warning" title="No storage for container disks">This device has no storage that can hold container disks that you may use. Add one in Storage settings.</Notice>}
    </div>
  );
}

export function CtCpuStep({ f, set, err }: P) {
  return (
    <Grid cols={3}>
      <Field label="Cores" htmlFor="wz-ctcores" error={err("cpu.cores")}><Num id="wz-ctcores" value={f.cores} onChange={(cores) => set({ cores })} /></Field>
      <Field label="CPU limit" htmlFor="wz-ctlimit" error={err("cpu.limit")} hint="Optional. Cores' worth of time, like 1.5. Empty is unlimited."><Num id="wz-ctlimit" value={f.cpuLimit} onChange={(cpuLimit) => set({ cpuLimit })} placeholder="Unlimited" /></Field>
      <Field label="CPU weight" htmlFor="wz-ctunits" error={err("cpu.units")} hint="Optional. The usual weight is 100."><Num id="wz-ctunits" value={f.cpuUnits} onChange={(cpuUnits) => set({ cpuUnits })} placeholder="Default" /></Field>
    </Grid>
  );
}

const MEM_PRESETS = [512, 1024, 2048, 4096, 8192];

export function CtMemoryStep({ f, set, err }: P) {
  const mb = Number(f.memoryMb);
  return (
    <div className="space-y-5">
      <Grid>
        <Field label="Memory" htmlFor="wz-ctmem" error={err("memory.mb")} hint={mb >= 16 ? `${formatBytes(mb * 1024 ** 2)}.` : "In MiB."}>
          <Num id="wz-ctmem" value={f.memoryMb} onChange={(memoryMb) => set({ memoryMb })} suffix="MiB" />
        </Field>
        <Field label="Swap" htmlFor="wz-ctswap" error={err("memory.swapMb")} hint="Extra room on disk when memory runs out. 0 turns it off."><Num id="wz-ctswap" value={f.swapMb} onChange={(swapMb) => set({ swapMb })} suffix="MiB" /></Field>
      </Grid>
      <div className="flex flex-wrap gap-1.5">
        {MEM_PRESETS.map((p) => (
          <button key={p} type="button" onClick={() => set({ memoryMb: String(p) })} aria-pressed={mb === p} className={`transition-control rounded-full border px-2.5 h-7 text-xs tabular-nums ${mb === p ? "border-accent/60 bg-accent-soft text-ink" : "border-line text-ink-2 hover:border-line-strong"}`}>{p >= 1024 ? `${p / 1024} GiB` : `${p} MiB`}</button>
        ))}
      </div>
    </div>
  );
}

const without = <T extends { id: number }>(l: T[], id: number) => l.filter((x) => x.id !== id);

/** Extra mount points (a new volume, or a host directory) and host device nodes passed through to the container. */
export function CtExtrasStep({ f, set, o, err }: P) {
  const setMount = (id: number, p: Partial<MountForm>) => set({ mounts: f.mounts.map((m) => (m.id === id ? { ...m, ...p } : m)) });
  const setDev = (id: number, p: Partial<DeviceForm>) => set({ devices: f.devices.map((d) => (d.id === id ? { ...d, ...p } : d)) });
  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <h3 className="text-micro font-semibold uppercase tracking-label text-ink-3">Extra mount points</h3>
        {f.mounts.length === 0 && <p className="text-sm text-ink-3">The container has only its root disk. Add a separate volume for data, or share a folder from the host.</p>}
        {f.mounts.map((m, i) => (
          <ListItem key={m.id} title={<>Mount point {i + 1}</>} removeLabel={`Remove mount point ${i + 1}`} onRemove={() => set({ mounts: without(f.mounts, m.id) })}>
            <Grid cols={3}>
              <Field label="Kind" htmlFor={`wz-mk-${m.id}`}><Pick id={`wz-mk-${m.id}`} value={m.kind} onChange={(kind) => setMount(m.id, { kind })} options={[{ value: "volume", label: "New volume" }, { value: "host", label: "Host folder (root@pam)", disabled: !o.rawPassthrough }]} /></Field>
              <Field label="Path inside the container" htmlFor={`wz-mp-${m.id}`} error={err(`mounts.${i}.path`)}><Input id={`wz-mp-${m.id}`} value={m.path} onChange={(e) => setMount(m.id, { path: e.target.value })} placeholder="/data" className="font-mono" /></Field>
              {m.kind === "volume" ? (
                <Field label="Size" htmlFor={`wz-ms-${m.id}`} error={err(`mounts.${i}.sizeGb`)}><Num id={`wz-ms-${m.id}`} value={m.sizeGb} onChange={(sizeGb) => setMount(m.id, { sizeGb })} suffix="GiB" /></Field>
              ) : (
                <Field label="Folder on the host" htmlFor={`wz-mh-${m.id}`} error={err(`mounts.${i}.hostPath`)}><Input id={`wz-mh-${m.id}`} value={m.hostPath} onChange={(e) => setMount(m.id, { hostPath: e.target.value })} placeholder="/srv/media" className="font-mono" /></Field>
              )}
              {m.kind === "volume" && <Field label="Storage" htmlFor={`wz-mst-${m.id}`} error={err(`mounts.${i}.storage`)}><Pick id={`wz-mst-${m.id}`} value={m.storage} onChange={(storage) => setMount(m.id, { storage })} options={o.ctStorages.map((s) => ({ value: s.storage, label: s.storage }))} /></Field>}
            </Grid>
            <Grid cols={2} className="gap-y-2">
              <SwitchRow label="Read only" checked={m.readOnly} onChange={(readOnly) => setMount(m.id, { readOnly })} />
              {m.kind === "volume" && <SwitchRow label="Include in backups" checked={m.backup} onChange={(backup) => setMount(m.id, { backup })} />}
            </Grid>
          </ListItem>
        ))}
        <AddButton onClick={() => set({ mounts: [...f.mounts, { id: nextKey(), path: `/data${f.mounts.length || ""}`, kind: "volume", storage: f.storage || o.ctStorages[0]?.storage || "", sizeGb: "8", hostPath: "", readOnly: false, backup: true }] })} disabled={f.mounts.length >= 10}>Add mount point</AddButton>
      </section>
      <section className="space-y-3">
        <h3 className="text-micro font-semibold uppercase tracking-label text-ink-3">Device passthrough</h3>
        {!o.rawPassthrough && <Notice tone="info">Proxmox lets only root@pam pass a host device through to a container. Ask an administrator to add it after creation.</Notice>}
        {f.devices.map((d, i) => (
          <ListItem key={d.id} title={<>Device {i + 1}</>} removeLabel={`Remove device ${i + 1}`} onRemove={() => set({ devices: without(f.devices, d.id) })}>
            <Grid cols={3}>
              <Field label="Device path" htmlFor={`wz-dp-${d.id}`} error={err(`devices.${i}.path`)}><Input id={`wz-dp-${d.id}`} value={d.path} onChange={(e) => setDev(d.id, { path: e.target.value })} placeholder="/dev/dri/renderD128" className="font-mono" /></Field>
              <Field label="Mode" htmlFor={`wz-dm-${d.id}`} error={err(`devices.${i}.mode`)}><Input id={`wz-dm-${d.id}`} value={d.mode} onChange={(e) => setDev(d.id, { mode: e.target.value })} placeholder="0660" className="font-mono" /></Field>
              <Field label="Group ID" htmlFor={`wz-dg-${d.id}`} error={err(`devices.${i}.gid`)}><Num id={`wz-dg-${d.id}`} value={d.gid} onChange={(gid) => setDev(d.id, { gid })} placeholder="e.g. 44" /></Field>
            </Grid>
          </ListItem>
        ))}
        <AddButton onClick={() => set({ devices: [...f.devices, { id: nextKey(), path: "/dev/dri/renderD128", mode: "", gid: "", denyWrite: false }] })} disabled={!o.rawPassthrough || f.devices.length >= 16}>Add device</AddButton>
      </section>
    </div>
  );
}
