import { useState } from "react";
import { Activity, Eraser, HardDrive, Layers, Plus, Trash2 } from "lucide-react";
import { useDisksApi, type DiskStorageKind, type PhysDisk, type ZfsDetail, type ZfsNode } from "../../data/engine/disks.ts";
import { useEngine } from "../../data/store.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { BarMeter } from "../../ui/meters.tsx";
import { formatBytes } from "../../lib/storage.ts";
import { Button, Card, Chip, EmptyState, Notice, PageFrame, PageHeader, Status, Tabs, type StatusKind } from "../../ui/primitives.tsx";
import { CreateOnDisk } from "./CreateOnDisk.tsx";
import { ConfirmTypeModal, Loading, diskSize, useLoad } from "./common.tsx";

type Tab = "disks" | "lvm" | "lvmthin" | "zfs" | "directory";

/** The device's physical disks and the storage built on them, in place of Proxmox's Disks panel. */
export function DisksPage() {
  const api = useDisksApi();
  const engine = useEngine();
  const [tab, setTab] = useState<Tab>("disks");
  const [create, setCreate] = useState<DiskStorageKind | null>(null);
  const disks = useLoad(() => api.disks(), [api, engine.contentVersion]);

  return (
    <PageFrame width="6xl">
      <PageHeader
        title="Disks"
        subtitle="The physical disks in this device and the storage built on them. Create storage from an unused disk, check a disk's health, or wipe one to reuse it."
        actions={<Button variant="primary" onClick={() => setCreate(tab === "disks" ? "directory" : tab)}><Plus className="h-4 w-4" />Create storage</Button>}
      />
      <Tabs<Tab> className="mb-5" value={tab} onChange={setTab} tabs={[{ id: "disks", label: "Disks" }, { id: "lvm", label: "LVM" }, { id: "lvmthin", label: "LVM-Thin" }, { id: "zfs", label: "ZFS" }, { id: "directory", label: "Directory" }]} />
      {tab === "disks" ? <DiskList disks={disks.data} error={disks.error} reload={disks.reload} /> : <OnDiskList kind={tab} onCreate={() => setCreate(tab)} disks={disks.data} />}
      {create && disks.data && <CreateOnDisk disks={disks.data} kind={create} onClose={() => setCreate(null)} onDone={disks.reload} />}
    </PageFrame>
  );
}

const typeLabel = (t: string) => ({ hdd: "HDD", ssd: "SSD", nvme: "NVMe", usb: "USB", unknown: "Disk" })[t] ?? t.toUpperCase();

function healthStatus(h: string | null): { kind: StatusKind; label: string } {
  if (!h || h === "UNKNOWN") return { kind: "idle", label: "Not reported" };
  if (h === "PASSED" || h === "OK") return { kind: "good", label: "Healthy" };
  if (h === "FAILED") return { kind: "critical", label: "Failing" };
  return { kind: "warning", label: h };
}

function DiskList({ disks, error, reload }: { disks: PhysDisk[] | null; error: string | null; reload: () => void }) {
  const [smart, setSmart] = useState<PhysDisk | null>(null);
  const [action, setAction] = useState<{ disk: PhysDisk; what: "wipe" | "init" } | null>(null);
  const api = useDisksApi();
  const engine = useEngine();
  if (error) return <Notice tone="critical" title="Couldn't read the disks">{error}</Notice>;
  if (!disks) return <Card><Loading /></Card>;
  if (disks.length === 0) return <Card><EmptyState icon={<HardDrive className="h-5 w-5" />} title="No disks reported" body="Proxmox didn't list any physical disks, or your account can't see them (it needs Sys.Audit on the device)." /></Card>;
  return (
    <>
      <Card className="overflow-x-auto">
        <table className="w-full text-compact min-w-[860px]">
          <thead>
            <tr className="border-b border-line text-ink-3 text-left">
              <th className="font-normal px-4 h-10">Disk</th>
              <th className="font-normal px-3">Type</th>
              <th className="font-normal px-3 text-right">Size</th>
              <th className="font-normal px-3">Model and serial</th>
              <th className="font-normal px-3">Used by</th>
              <th className="font-normal px-3">Wear</th>
              <th className="font-normal px-3">Health</th>
              <th className="px-3 w-[1%]"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {disks.map((d) => {
              const h = healthStatus(d.health);
              return (
                <tr key={d.devpath} className="border-b border-line last:border-0 hover:bg-surface-2/50">
                  <td className="px-4 py-3 font-mono">{d.name}</td>
                  <td className="px-3"><Chip>{typeLabel(d.type)}</Chip></td>
                  <td className="px-3 text-right tabular-nums whitespace-nowrap">{diskSize(d.sizeBytes)}</td>
                  <td className="px-3 min-w-0"><div className="truncate">{[d.vendor, d.model].filter(Boolean).join(" ") || "—"}</div><div className="text-xs text-ink-3 font-mono truncate">{d.serial ?? ""}</div></td>
                  <td className="px-3">{d.usedBy ? <Chip tone={d.inUseReason ? "accent" : "neutral"}>{d.usedBy}</Chip> : <span className="text-ink-3">Unused</span>}</td>
                  <td className="px-3 whitespace-nowrap tabular-nums" title="How much of the disk's rated life is left, as the disk reports it">{d.wearoutPct === null ? <span className="text-ink-3">—</span> : d.wearoutPct <= 10 ? <Status kind="warning" label={`${d.wearoutPct}% life left`} /> : `${d.wearoutPct}% life left`}</td>
                  <td className="px-3"><Status kind={h.kind} label={h.label} /></td>
                  <td className="px-3 whitespace-nowrap text-right">
                    <span className="inline-flex items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setSmart(d)}><Activity className="h-3.5 w-3.5" />SMART</Button>
                      {!d.gpt && !d.inUseReason && <Button size="sm" variant="ghost" onClick={() => setAction({ disk: d, what: "init" })}><Layers className="h-3.5 w-3.5" />Initialize</Button>}
                      <Button size="sm" variant="ghost" onClick={() => setAction({ disk: d, what: "wipe" })} aria-label={`Wipe ${d.name}`}><Eraser className="h-3.5 w-3.5" />Wipe</Button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <p className="text-xs text-ink-3 mt-3">Disks that are mounted or hold LVM, ZFS or the boot loader can't be wiped or initialized. Remove what uses them first.</p>
      {smart && <SmartModal disk={smart} onClose={() => setSmart(null)} />}
      {action && (
        <ConfirmTypeModal
          title={action.what === "wipe" ? `Wipe ${action.disk.name}?` : `Initialize ${action.disk.name} with GPT?`}
          subtitle={action.what === "wipe" ? "Erases the partition table and file system signatures so the disk can be reused. The data on it can't be recovered." : "Writes a new, empty GPT partition table. Anything on the disk becomes unreachable."}
          expected={action.disk.name}
          accepts={[action.disk.devpath]}
          actionLabel={action.what === "wipe" ? "Wipe disk" : "Initialize disk"}
          warning={action.disk.inUseReason ? <>Proxmox will refuse this: {action.disk.inUseReason}.</> : <>This is permanent. {diskSize(action.disk.sizeBytes)} {action.disk.model ?? ""} · serial {action.disk.serial ?? "unknown"}.</>}
          onConfirm={async (typed) => {
            const r = action.what === "wipe" ? await api.wipe(action.disk.devpath, typed) : await api.initGpt(action.disk.devpath, typed);
            engine.watchTask(r.task, `${action.what === "wipe" ? "Wipe" : "Initialize"} ${action.disk.name}`);
          }}
          onClose={() => setAction(null)}
          onDone={reload}
        />
      )}
    </>
  );
}

function SmartModal({ disk, onClose }: { disk: PhysDisk; onClose: () => void }) {
  const api = useDisksApi();
  const smart = useLoad(() => api.smart(disk.devpath), [api, disk.devpath]);
  const h = healthStatus(smart.data?.health ?? disk.health);
  return (
    <Modal size="lg" icon={<Activity className="h-5 w-5" />} title={`SMART health of ${disk.name}`} subtitle={[disk.model, disk.serial].filter(Boolean).join(" · ")} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {smart.error ? <Notice tone="critical" title="Couldn't read SMART data">{smart.error}</Notice> : !smart.data ? <Loading label="Reading SMART data" /> : (
        <div className="space-y-4">
          <div className="flex items-center gap-3"><span className="text-compact text-ink-3">Overall</span><Status kind={h.kind} label={h.label} /></div>
          {smart.data.attributes.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-compact min-w-[520px]">
                <thead><tr className="text-ink-3 text-left border-b border-line"><th className="font-normal px-3 h-9">Attribute</th><th className="font-normal px-3 text-right">Value</th><th className="font-normal px-3 text-right">Worst</th><th className="font-normal px-3 text-right">Threshold</th><th className="font-normal px-3 text-right">Raw</th></tr></thead>
                <tbody>
                  {smart.data.attributes.map((a, i) => (
                    <tr key={`${a.id ?? i}-${a.name}`} className="border-b border-line last:border-0">
                      <td className="px-3 py-2 font-mono text-xs">{a.name}</td>
                      <td className="px-3 text-right tabular-nums">{a.value ?? "—"}</td>
                      <td className="px-3 text-right tabular-nums">{a.worst ?? "—"}</td>
                      <td className="px-3 text-right tabular-nums">{a.threshold ?? "—"}</td>
                      <td className="px-3 text-right tabular-nums font-mono text-xs">{a.raw ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : smart.data.text ? <pre className="rounded-lg bg-code p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap">{smart.data.text}</pre> : <p className="text-compact text-ink-3">This disk reports no detailed attributes.</p>}
        </div>
      )}
    </Modal>
  );
}

const COLUMNS: Record<Exclude<Tab, "disks">, { title: string; empty: string; remove: string }> = {
  lvm: { title: "LVM volume groups", empty: "No volume groups yet. Create one from an unused disk.", remove: "volume group" },
  lvmthin: { title: "LVM-Thin pools", empty: "No thin pools yet. Create one from an unused disk.", remove: "thin pool" },
  zfs: { title: "ZFS pools", empty: "No ZFS pools yet. Create one from one or more unused disks.", remove: "pool" },
  directory: { title: "Directories on disks", empty: "No directories on their own disks yet. Format an unused disk to create one.", remove: "directory" },
};

function OnDiskList({ kind, onCreate, disks }: { kind: Exclude<Tab, "disks">; onCreate: () => void; disks: PhysDisk[] | null }) {
  const api = useDisksApi();
  const engine = useEngine();
  const list = useLoad(() => api.listOnDisks(kind), [api, kind, engine.contentVersion]);
  const [removing, setRemoving] = useState<Record<string, unknown> | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const meta = COLUMNS[kind];
  const nameOf = (r: Record<string, unknown>) => String(kind === "lvmthin" ? r.lv : kind === "directory" ? String(r.path).split("/").pop() : r.name);
  if (list.error) return <Notice tone="critical" title={`Couldn't read ${meta.title.toLowerCase()}`}>{list.error}</Notice>;
  if (!list.data) return <Card><Loading /></Card>;
  const n = (v: unknown) => Number(v) || 0;
  return (
    <>
      {list.data.length === 0 ? (
        <Card><EmptyState icon={<HardDrive className="h-5 w-5" />} title={meta.title} body={meta.empty} action={<Button variant="primary" onClick={onCreate}><Plus className="h-4 w-4" />Create storage</Button>} /></Card>
      ) : (
        <div className="space-y-3">
          {list.data.map((r) => {
            const name = nameOf(r);
            const size = kind === "lvmthin" ? n(r.lv_size) : n(r.size);
            const used = kind === "lvm" ? size - n(r.free) : kind === "lvmthin" ? n(r.used) : n(r.alloc);
            return (
              <Card key={`${kind}-${name}`} className="p-5">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium font-mono">{name}</div>
                    <div className="text-xs text-ink-3">{kind === "lvmthin" ? `in volume group ${String(r.vg)}` : kind === "directory" ? `${String(r.type)} on ${String(r.device)} · ${String(r.path)}` : kind === "zfs" ? `Health ${String(r.health)} · fragmentation ${n(r.frag)}%` : "Volume group"}</div>
                  </div>
                  {kind === "zfs" && <Button size="sm" variant="secondary" onClick={() => setDetail(name)}>Status</Button>}
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(r)} aria-label={`Remove ${name}`}><Trash2 className="h-3.5 w-3.5" />Remove</Button>
                </div>
                {size > 0 && <BarMeter className="mt-4" label="Used" pct={(used / size) * 100} value={`${formatBytes(used)} of ${formatBytes(size)}`} />}
              </Card>
            );
          })}
        </div>
      )}
      {detail && <ZfsStatus name={detail} onClose={() => setDetail(null)} />}
      {removing && (
        <RemoveOnDisk kind={kind} name={nameOf(removing)} volumeGroup={kind === "lvmthin" ? String(removing.vg) : undefined} label={meta.remove} disks={disks} onClose={() => setRemoving(null)} onDone={list.reload} />
      )}
    </>
  );
}

function RemoveOnDisk({ kind, name, volumeGroup, label, disks, onClose, onDone }: { kind: DiskStorageKind; name: string; volumeGroup?: string; label: string; disks: PhysDisk[] | null; onClose: () => void; onDone: () => void }) {
  const api = useDisksApi();
  const engine = useEngine();
  const [cleanupConfig, setCleanupConfig] = useState(true);
  const [cleanupDisks, setCleanupDisks] = useState(false);
  const using = (disks ?? []).filter((d) => d.usedBy?.includes(name));
  return (
    <ConfirmTypeModal
      title={`Remove ${label} ${name}?`}
      subtitle="Destroys the data stored on it. Machines that have disks there lose them."
      expected={name}
      actionLabel={`Remove ${label}`}
      warning={using.length ? <>Frees {using.map((d) => d.name).join(", ")}. Everything on {using.length === 1 ? "it" : "them"} is destroyed.</> : "Everything on it is destroyed."}
      onConfirm={async (typed) => {
        const r = await api.deleteOnDisk(kind, name, { confirm: typed, cleanupConfig, cleanupDisks, volumeGroup });
        engine.watchTask(r.task, `Remove ${label} ${name}`);
      }}
      onClose={onClose}
      onDone={onDone}
    >
      <div className="space-y-2.5">
        <label className="flex items-start gap-3 cursor-pointer"><input type="checkbox" className="mt-1 h-4 w-4 accent-(--accent)" checked={cleanupConfig} onChange={(e) => setCleanupConfig(e.target.checked)} /><span className="text-sm">Also remove it from Proxmox's storage list<span className="block text-xs text-ink-3">Leave this on unless the storage is shared with other devices.</span></span></label>
        <label className="flex items-start gap-3 cursor-pointer"><input type="checkbox" className="mt-1 h-4 w-4 accent-(--accent)" checked={cleanupDisks} onChange={(e) => setCleanupDisks(e.target.checked)} /><span className="text-sm">Wipe the disks afterwards<span className="block text-xs text-ink-3">So they are ready to be used for something else.</span></span></label>
      </div>
    </ConfirmTypeModal>
  );
}

function ZfsTree({ nodes, depth = 0 }: { nodes: ZfsNode[]; depth?: number }) {
  return (
    <ul className={depth ? "ml-5 border-l border-line pl-3" : ""}>
      {nodes.map((n) => (
        <li key={`${depth}-${n.name}`} className="py-1">
          <div className="flex flex-wrap items-center gap-x-3 text-compact">
            <span className="font-mono">{n.name}</span>
            {n.state && <Status kind={n.state === "ONLINE" ? "good" : n.state === "DEGRADED" ? "warning" : "critical"} label={n.state} />}
            {(n.read || n.write || n.cksum) ? <span className="text-xs text-critical tabular-nums">errors r{n.read ?? 0} w{n.write ?? 0} c{n.cksum ?? 0}</span> : null}
            {n.msg && <span className="text-xs text-ink-3">{n.msg}</span>}
          </div>
          {n.children?.length ? <ZfsTree nodes={n.children} depth={depth + 1} /> : null}
        </li>
      ))}
    </ul>
  );
}

function ZfsStatus({ name, onClose }: { name: string; onClose: () => void }) {
  const api = useDisksApi();
  const d = useLoad<ZfsDetail>(() => api.zfsDetail(name), [api, name]);
  return (
    <Modal size="lg" title={`ZFS pool ${name}`} subtitle="The pool's layout and health, as ZFS reports it." onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {d.error ? <Notice tone="critical">{d.error}</Notice> : !d.data ? <Loading /> : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-compact">
            <span><span className="text-ink-3">State </span>{d.data.state ?? "unknown"}</span>
            {d.data.scan && <span><span className="text-ink-3">Scan </span>{d.data.scan}</span>}
            {d.data.errors && <span><span className="text-ink-3">Errors </span>{d.data.errors}</span>}
          </div>
          {d.data.action && <Notice tone="warning">{d.data.action}</Notice>}
          {d.data.children?.length ? <ZfsTree nodes={d.data.children} /> : null}
        </div>
      )}
    </Modal>
  );
}
