import { useState } from "react";
import { Cpu, Loader2, Plug, Plus, RotateCcw, Trash2, Usb } from "lucide-react";
import type { PassthroughItem } from "@papercliped-engine/proxmox-client/machine-extra";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, Input, Notice, SectionTitle, Segmented, Select } from "../../ui/primitives.tsx";
import { useLoad } from "../disks/common.tsx";
import { PendingMark, SwitchRow, useRun, Warnings, type SCtx } from "./MachineSettingsKit.tsx";

/** Host devices handed to a machine: PCI and USB for a VM, device nodes for a container. Add, change, remove. */
export function HostDevicesCard({ ctx }: { ctx: SCtx }) {
  const items = ctx.s.passthrough;
  const vm = ctx.s.type === "qemu";
  const [add, setAdd] = useState(false);
  const [remove, setRemove] = useState<PassthroughItem | null>(null);
  const host = useLoad(() => ctx.api.hostDevices(ctx.vmid), [ctx.api, ctx.vmid, ctx.s.digest]);
  const KIND = { pci: "PCI device", usb: "USB device", dev: "Device node" } as const;
  const name = (p: PassthroughItem) => {
    const h = host.data;
    if (!h) return "";
    if (p.kind === "pci" && !p.mapped) return p.target.split(";").map((id) => { const d = h.pci.find((x) => x.id === id || x.id.endsWith(id)); return d ? [d.vendor, d.device].filter(Boolean).join(" ") : ""; }).filter(Boolean).join(", ");
    if (p.kind === "usb" && !p.mapped) return h.usb.find((u) => u.id.toLowerCase() === p.target.toLowerCase() || u.port === p.target)?.name ?? (p.target === "spice" ? "SPICE USB redirection" : "");
    const m = (p.kind === "pci" ? h.mappings.pci : h.mappings.usb).find((x) => x.id === p.target);
    return m?.description ?? "";
  };
  return (
    <Card className="p-5">
      <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => setAdd(true)}><Plus className="h-3.5 w-3.5" />Add device</Button>}>{vm ? "PCI and USB passthrough" : "Device passthrough"}</SectionTitle>
      {items.length === 0 ? (
        <p className="text-sm text-ink-3">{vm ? "No PCI or USB devices from the host are handed to this VM." : "No host devices are handed to this container."}</p>
      ) : (
        <div className="divide-y divide-line">
          {items.map((p) => (
            <div key={p.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
              <span className="text-ink-3 shrink-0">{p.kind === "usb" ? <Usb className="h-4 w-4" /> : <Cpu className="h-4 w-4" />}</span>
              <div className="flex-1 min-w-0 basis-44">
                <div className="text-sm flex flex-wrap items-center gap-x-2 gap-y-1"><span className="font-mono">{p.key}</span><span className="text-ink-3">{KIND[p.kind]}</span>{p.mapped && <Chip>Mapped</Chip>}<PendingMark s={ctx.s} keys={[p.key]} /></div>
                <div className="text-xs text-ink-3 truncate"><span className="font-mono">{p.target}</span>{name(p) ? ` · ${name(p)}` : ""}{p.options.length ? ` · ${p.options.join(", ")}` : ""}</div>
              </div>
              <Button size="sm" variant="ghost" aria-label={`Remove ${p.key}`} onClick={() => setRemove(p)}><Trash2 className="h-3.5 w-3.5" />Remove</Button>
            </div>
          ))}
        </div>
      )}
      {host.data?.explainer && <p className="text-xs text-ink-3 mt-3">{host.data.explainer}</p>}
      <p className="text-xs text-ink-3 mt-2">A machine with a host device can't be live-migrated. Changes take effect the next time it starts.</p>
      {add && <AddDeviceModal ctx={ctx} onClose={() => setAdd(false)} />}
      {remove && <RemoveModal ctx={ctx} item={remove} onClose={() => setRemove(null)} />}
    </Card>
  );
}

function RemoveModal({ ctx, item, onClose }: { ctx: SCtx; item: PassthroughItem; onClose: () => void }) {
  const { run, busy, error } = useRun(ctx.reload, onClose);
  return (
    <Modal size="sm" title={`Remove ${item.key}?`} subtitle={`${item.target} is no longer handed to ${ctx.s.name}.`} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={busy} onClick={() => run(() => ctx.api.saveHostDevice(ctx.vmid, { digest: ctx.s.digest, kind: item.kind, action: "remove", key: item.key }))}><Trash2 className="h-4 w-4" />Remove</Button></>}>
      <div className="space-y-2">
        <p className="text-compact text-ink-2">The device goes back to the host when the machine next stops and starts.</p>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function AddDeviceModal({ ctx, onClose }: { ctx: SCtx; onClose: () => void }) {
  const vm = ctx.s.type === "qemu";
  const host = useLoad(() => ctx.api.hostDevices(ctx.vmid), [ctx.api, ctx.vmid]);
  const h = host.data;
  const { run, busy, error, warnings } = useRun(ctx.reload);
  const [kind, setKind] = useState<"pci" | "usb" | "dev">(vm ? "pci" : "dev");
  const [source, setSource] = useState<"mapping" | "raw" | "host" | "port" | "spice">("mapping");
  const [mapping, setMapping] = useState("");
  const [pciIds, setPciIds] = useState<string[]>([]);
  const [usbId, setUsbId] = useState("");
  const [pcie, setPcie] = useState(false);
  const [xvga, setXvga] = useState(false);
  const [rombar, setRombar] = useState(true);
  const [mdev, setMdev] = useState("");
  const [usb3, setUsb3] = useState(false);
  const [path, setPath] = useState("/dev/dri/renderD128");
  const [mode, setMode] = useState("");
  const [gid, setGid] = useState("");
  const [ro, setRo] = useState(false);
  const root = h?.root ?? false;
  const mappingsFor = kind === "pci" ? h?.mappings.pci ?? [] : h?.mappings.usb ?? [];
  const mdevFor = useLoad(() => (kind === "pci" && source === "raw" && pciIds[0] ? ctx.api.mdevTypes(pciIds[0]) : Promise.resolve(null)), [ctx.api, kind, source, pciIds[0]]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) => setPciIds((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));
  // Devices in one IOMMU group move together: picking one suggests the rest.
  const sameGroup = (id: string) => { const d = h?.pci.find((x) => x.id === id); return d && d.iommuGroup >= 0 ? h!.pci.filter((x) => x.iommuGroup === d.iommuGroup && x.id !== id).map((x) => x.id) : []; };
  const body = (): Record<string, unknown> => {
    const d = { digest: ctx.s.digest, action: "add", kind };
    if (kind === "dev") return { ...d, path, mode: mode || undefined, gid: gid.trim() ? Number(gid) : undefined, denyWrite: ro || undefined };
    if (kind === "usb") return source === "spice" ? { ...d, source } : source === "mapping" ? { ...d, source, mapping, usb3 } : { ...d, source, host: usbId, usb3 };
    return source === "mapping" ? { ...d, source, mapping, pcie, xVga: xvga, rombar, mdev: mdev || undefined } : { ...d, source, host: pciIds, pcie, xVga: xvga, rombar, mdev: mdev || undefined };
  };
  const save = async () => {
    const r = await run(() => ctx.api.saveHostDevice(ctx.vmid, body()));
    if (r && !r.warnings.length) onClose();
  };
  const ready = kind === "dev" ? /^\/dev\//.test(path) : kind === "usb" ? source === "spice" || (source === "mapping" ? !!mapping : !!usbId) : source === "mapping" ? !!mapping : pciIds.length > 0;
  const rawBlocked = !root && (source === "raw" || source === "host" || source === "port");
  return (
    <Modal size="lg" icon={<Plug className="h-5 w-5" />} title="Add a host device" subtitle={`${ctx.s.name} #${ctx.vmid}`} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{warnings.length ? "Close" : "Cancel"}</Button><Button variant="primary" onClick={save} disabled={busy || !ready || (kind !== "dev" && rawBlocked)}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Add</Button></>}>
      <div className="space-y-4">
        {host.error && <p role="alert" className="text-compact text-critical">{host.error}</p>}
        {vm && <Segmented size="sm" value={kind} onChange={(v) => { setKind(v); setSource("mapping"); }} options={[{ value: "pci", label: "PCI device" }, { value: "usb", label: "USB device" }]} />}
        {kind !== "dev" && (
          <>
            <Segmented size="sm" value={source} onChange={setSource} options={kind === "pci" ? [{ value: "mapping", label: "Saved mapping" }, { value: "raw", label: "Device on the host" }] : [{ value: "mapping", label: "Saved mapping" }, { value: "host", label: "Device" }, { value: "port", label: "Port" }, { value: "spice", label: "SPICE" }]} />
            {rawBlocked && <Notice tone="warning" title="Only root@pam can do this">{h?.explainer}</Notice>}
          </>
        )}
        {kind !== "dev" && source === "mapping" && (
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Mapping</span>
            <Select value={mapping} onChange={(e) => setMapping(e.target.value)}><option value="">Pick one…</option>{mappingsFor.map((m) => <option key={m.id} value={m.id}>{m.id}{m.description ? ` · ${m.description}` : ""}</option>)}</Select>
            {h && mappingsFor.length === 0 && <span className="block text-xs text-ink-3 mt-1.5">No mappings yet. An administrator adds them under Datacenter, Resource mappings.</span>}
          </label>
        )}
        {kind === "pci" && source === "raw" && (
          <div>
            <span className="block text-compact text-ink-2 mb-1.5">Devices on this host</span>
            {h?.notes.pci && <p className="text-xs text-ink-3">{h.notes.pci}</p>}
            <div className="rounded-lg border border-line divide-y divide-line max-h-64 overflow-y-auto">{(h?.pci ?? []).map((d) => (
              <label key={d.id} className="flex items-center gap-3 px-3 py-2 text-compact cursor-pointer"><input type="checkbox" checked={pciIds.includes(d.id)} onChange={() => toggle(d.id)} /><span className="font-mono">{d.id}</span><span className="flex-1 min-w-0 truncate text-ink-2">{[d.vendor, d.device].filter(Boolean).join(" ")}</span>{d.iommuGroup >= 0 ? <Chip>Group {d.iommuGroup}</Chip> : <Chip tone="warning">No IOMMU group</Chip>}</label>
            ))}</div>
            {pciIds.length === 1 && sameGroup(pciIds[0]).length > 0 && <p className="text-xs text-warning mt-2">This device shares an IOMMU group with {sameGroup(pciIds[0]).join(", ")}. Proxmox usually needs the whole group passed together.</p>}
          </div>
        )}
        {kind === "pci" && (
          <>
            <SwitchRow label="PCI Express" hint="Needs the q35 machine type." checked={pcie} onChange={setPcie} />
            <SwitchRow label="Primary GPU" hint="Makes the device the VM's main display (x-vga)." checked={xvga} onChange={setXvga} />
            <SwitchRow label="ROM-BAR" hint="Turn off if the device misbehaves at boot." checked={rombar} onChange={setRombar} />
            {(source === "raw" ? mdevFor.data?.types.length : true) ? (
              <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Mediated device type (vGPU)</span>
                {mdevFor.data?.types.length ? <Select value={mdev} onChange={(e) => setMdev(e.target.value)}><option value="">Whole device</option>{mdevFor.data.types.map((t) => <option key={t.type} value={t.type}>{t.type} · {t.name ?? t.description} · {t.available} available</option>)}</Select> : <Input value={mdev} onChange={(e) => setMdev(e.target.value)} placeholder="Whole device, or a type like nvidia-63" className="font-mono" />}</label>
            ) : null}
          </>
        )}
        {kind === "usb" && (source === "host" || source === "port") && (
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">{source === "host" ? "USB device" : "USB port"}</span>
            <Select value={usbId} onChange={(e) => setUsbId(e.target.value)}><option value="">Pick one…</option>{(h?.usb ?? []).map((u) => <option key={u.port} value={source === "host" ? u.id : u.port}>{u.name} · {source === "host" ? u.id : u.port}</option>)}</Select>
            {h?.notes.usb && <span className="block text-xs text-ink-3 mt-1.5">{h.notes.usb}</span>}
            <span className="block text-xs text-ink-3 mt-1.5">{source === "host" ? "Follows the device if it is moved to another port." : "Whatever is plugged into this port, now or later."}</span></label>
        )}
        {kind === "usb" && source !== "spice" && <SwitchRow label="USB 3" hint="Faster, if the guest supports it." checked={usb3} onChange={setUsb3} />}
        {kind === "usb" && source === "spice" && <p className="text-xs text-ink-3">Lets you hand a USB device from your own computer to the VM through a SPICE viewer.</p>}
        {kind === "dev" && (
          <>
            {!root && <Notice tone="warning" title="Only root@pam can do this">Proxmox lets only root@pam pass a host device node through to a container. Ask an administrator to add it.</Notice>}
            <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Device path</span><Input value={path} onChange={(e) => setPath(e.target.value)} className="font-mono" placeholder="/dev/dri/renderD128" /><span className="block text-xs text-ink-3 mt-1.5">Common ones: /dev/dri/renderD128 (GPU), /dev/ttyUSB0 (serial adapter), /dev/net/tun (VPN), /dev/kvm.</span></label>
            <div className="grid grid-cols-2 gap-3"><label className="block"><span className="block text-compact text-ink-2 mb-1.5">Mode</span><Input value={mode} onChange={(e) => setMode(e.target.value)} placeholder="0660" className="font-mono" /></label><label className="block"><span className="block text-compact text-ink-2 mb-1.5">Group ID</span><Input type="number" value={gid} onChange={(e) => setGid(e.target.value)} placeholder="e.g. 44" /></label></div>
            <SwitchRow label="Read only" checked={ro} onChange={setRo} />
          </>
        )}
        <Warnings list={warnings} />
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

/** Changes that wait for a restart, with a way to take them back. */
export function PendingBanner({ ctx }: { ctx: SCtx }) {
  const [open, setOpen] = useState(false);
  if (!ctx.s.pendingKeys.length) return null;
  return (
    <div className="lg:col-span-2">
      <Notice tone="warning" title={`${ctx.s.pendingKeys.length} change${ctx.s.pendingKeys.length === 1 ? "" : "s"} wait for a restart`} action={<Button size="sm" onClick={() => setOpen(true)}><RotateCcw className="h-3.5 w-3.5" />Review</Button>}>
        <p>{ctx.s.pendingKeys.join(", ")}. Shut the machine down and start it again to apply them, or take them back.</p>
      </Notice>
      {open && <PendingModal ctx={ctx} onClose={() => setOpen(false)} />}
    </div>
  );
}

function PendingModal({ ctx, onClose }: { ctx: SCtx; onClose: () => void }) {
  const p = useLoad(() => ctx.api.pending(ctx.vmid), [ctx.api, ctx.vmid, ctx.s.digest]);
  const { run, busy, error } = useRun(ctx.reload);
  return (
    <Modal size="md" title="Pending changes" subtitle="Saved in Proxmox, applied when the machine restarts." onClose={onClose}>
      {!p.data && !p.error && <p className="text-sm text-ink-3">Reading…</p>}
      {p.error && <p role="alert" className="text-compact text-critical">{p.error}</p>}
      {p.data && p.data.items.length === 0 && <p className="text-sm text-ink-3">Nothing is waiting.</p>}
      <div className="divide-y divide-line">{p.data?.items.map((i) => (
        <div key={i.key} className="flex flex-wrap items-center gap-3 py-2.5">
          <div className="flex-1 min-w-0 basis-44"><div className="text-sm font-mono">{i.key}</div><div className="text-xs text-ink-3 truncate">{i.remove ? "Will be removed" : i.pending ?? "Changed"}</div></div>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => ctx.api.revert(ctx.vmid, ctx.s.digest!, [i.key]))}><RotateCcw className="h-3.5 w-3.5" />Take back</Button>
        </div>
      ))}</div>
      {p.data && p.data.items.length > 1 && <div className="mt-3"><Button size="sm" disabled={busy} onClick={() => run(() => ctx.api.revert(ctx.vmid, ctx.s.digest!, p.data!.items.map((i) => i.key)))}>Take back all</Button></div>}
      {error && <p role="alert" className="text-compact text-critical mt-2">{error}</p>}
    </Modal>
  );
}
