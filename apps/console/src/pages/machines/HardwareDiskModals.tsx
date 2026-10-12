import { useEffect, useState, type ReactNode } from "react";
import { Disc3, FolderInput, HardDrive, Move, Plus, Unlink } from "lucide-react";
import { errorText, useDisksApi, type GuestDisk, type GuestDisks } from "../../data/engine/disks.ts";
import { useEngine } from "../../data/store.tsx";
import type { MachineOptions } from "../../data/api.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Field, Input, Notice, Segmented, Select } from "../../ui/primitives.tsx";
import { Check } from "../disks/common.tsx";

/** The dialogs behind a machine's Disks card. Each one sends the page's digest, so a machine changed elsewhere is refused. */

type Kind = "qemu" | "lxc";
export interface DiskCtx {
  vmid: number;
  kind: Kind;
  name: string;
  running: boolean;
  disks: GuestDisks;
  /** Reload the card; called after every change and when Proxmox says the page is stale. */
  reload: () => void;
}

/** Runs one change, watches its task and closes. Shows Proxmox's own words when it refuses. */
function useAct(ctx: DiskCtx, onClose: () => void) {
  const api = useDisksApi();
  const engine = useEngine();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (tail: string, body: Record<string, unknown>, label?: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.guestAct(ctx.vmid, tail, { ...body, digest: ctx.disks.digest });
      if (label) engine.watchTask(r.task ?? null, label);
      ctx.reload();
      onClose();
      return r;
    } catch (e) {
      setError(errorText(e, "Couldn't change the disk"));
      if (e instanceof Error && (e as { status?: number }).status === 409) ctx.reload();
      setBusy(false);
      return null;
    }
  };
  return { act, busy, error };
}

function useStorages() {
  const engine = useEngine();
  const [opts, setOpts] = useState<MachineOptions | null>(null);
  useEffect(() => {
    let alive = true;
    engine.backend.machineOptions().then((o) => alive && setOpts(o), () => alive && setOpts(null));
    return () => {
      alive = false;
    };
  }, [engine.backend]);
  return opts;
}

const BUS_LABEL: Record<string, string> = { scsi: "SCSI (recommended)", virtio: "VirtIO Block", sata: "SATA", ide: "IDE (oldest, for legacy systems)" };

interface Opts {
  cache: string;
  aio: string;
  discard: boolean;
  ssd: boolean;
  iothread: boolean;
  backup: boolean;
  ro: boolean;
  replicate: boolean;
  mbpsRd: string;
  mbpsWr: string;
  iopsRd: string;
  iopsWr: string;
  // containers
  acl: boolean;
  quota: boolean;
  mp: string;
  noatime: boolean;
}

const optsFrom = (d?: GuestDisk): Opts => ({
  cache: d?.cache ?? "", aio: d?.aio ?? "", discard: d?.discard ?? false, ssd: d?.ssd ?? false, iothread: d?.iothread ?? d?.bus === "scsi", backup: d?.backup ?? true, ro: d?.ro ?? false, replicate: d?.replicate ?? true,
  mbpsRd: d?.mbpsRd ? String(d.mbpsRd) : "", mbpsWr: d?.mbpsWr ? String(d.mbpsWr) : "", iopsRd: d?.iopsRd ? String(d.iopsRd) : "", iopsWr: d?.iopsWr ? String(d.iopsWr) : "",
  acl: d?.acl ?? false, quota: d?.quota ?? false, mp: d?.mp ?? "", noatime: d?.mountoptions?.includes("noatime") ?? false,
});

const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));

function vmBody(o: Opts, bus: string): Record<string, unknown> {
  return { cache: o.cache || null, aio: o.aio || null, discard: o.discard, ssd: bus === "virtio" ? false : o.ssd, iothread: bus === "virtio" || bus === "scsi" ? o.iothread : false, backup: o.backup, ro: o.ro, replicate: o.replicate, mbps_rd: num(o.mbpsRd), mbps_wr: num(o.mbpsWr), iops_rd: num(o.iopsRd), iops_wr: num(o.iopsWr) };
}

function VmOptionFields({ o, set, bus }: { o: Opts; set: (p: Partial<Opts>) => void; bus: string }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Cache" hint="None is safest and fast on modern storage. Write back is fastest but loses data on a power cut." htmlFor="do-cache">
          <Select id="do-cache" value={o.cache} onChange={(e) => set({ cache: e.target.value })}>
            <option value="">Default (no cache)</option><option value="none">No cache</option><option value="writethrough">Write through</option><option value="writeback">Write back</option><option value="directsync">Direct sync</option><option value="unsafe">Write back (unsafe)</option>
          </Select>
        </Field>
        <Field label="Async IO" hint="How the disk talks to the storage. Leave on default unless you know why." htmlFor="do-aio">
          <Select id="do-aio" value={o.aio} onChange={(e) => set({ aio: e.target.value })}><option value="">Default</option><option value="io_uring">io_uring</option><option value="native">native</option><option value="threads">threads</option></Select>
        </Field>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
        <Check checked={o.discard} onChange={(v) => set({ discard: v })} label="Discard (TRIM)" hint="Frees space on thin storage when the guest deletes files." />
        <Check checked={o.ssd} onChange={(v) => set({ ssd: v })} label="SSD emulation" hint={bus === "virtio" ? "Not available for VirtIO Block." : "Tells the guest this is a solid-state disk."} disabled={bus === "virtio"} />
        <Check checked={o.iothread} onChange={(v) => set({ iothread: v })} label="IO thread" hint={bus === "virtio" || bus === "scsi" ? "A separate thread for this disk. Helps busy disks." : "Only for VirtIO and SCSI disks."} disabled={bus !== "virtio" && bus !== "scsi"} />
        <Check checked={o.backup} onChange={(v) => set({ backup: v })} label="Include in backups" hint="Turn off for scratch disks." />
        <Check checked={o.replicate} onChange={(v) => set({ replicate: v })} label="Include in replication" />
        <Check checked={o.ro} onChange={(v) => set({ ro: v })} label="Read only" />
      </div>
      <details className="rounded-lg border border-line px-4 py-3">
        <summary className="text-compact text-ink-2 cursor-pointer">Speed limits</summary>
        <p className="text-xs text-ink-3 mt-2">Stops one disk from using all of the storage. Empty means no limit.</p>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <Field label="Read (MB/s)" htmlFor="do-mrd"><Input id="do-mrd" type="number" min={0} value={o.mbpsRd} onChange={(e) => set({ mbpsRd: e.target.value })} placeholder="Unlimited" /></Field>
          <Field label="Write (MB/s)" htmlFor="do-mwr"><Input id="do-mwr" type="number" min={0} value={o.mbpsWr} onChange={(e) => set({ mbpsWr: e.target.value })} placeholder="Unlimited" /></Field>
          <Field label="Read (IOPS)" htmlFor="do-ird"><Input id="do-ird" type="number" min={0} value={o.iopsRd} onChange={(e) => set({ iopsRd: e.target.value })} placeholder="Unlimited" /></Field>
          <Field label="Write (IOPS)" htmlFor="do-iwr"><Input id="do-iwr" type="number" min={0} value={o.iopsWr} onChange={(e) => set({ iopsWr: e.target.value })} placeholder="Unlimited" /></Field>
        </div>
      </details>
    </div>
  );
}

function CtOptionFields({ o, set, withPath }: { o: Opts; set: (p: Partial<Opts>) => void; withPath: boolean }) {
  return (
    <div className="space-y-4">
      {withPath && <Field label="Path inside the container" hint="Where the volume appears, for example /data." htmlFor="co-mp" error={o.mp && !/^\/[\w./+@ -]+$/.test(o.mp) ? "Use an absolute path such as /data." : undefined}><Input id="co-mp" value={o.mp} onChange={(e) => set({ mp: e.target.value })} className="font-mono" placeholder="/data" /></Field>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
        <Check checked={o.backup} onChange={(v) => set({ backup: v })} label="Include in backups" />
        <Check checked={o.replicate} onChange={(v) => set({ replicate: v })} label="Include in replication" />
        <Check checked={o.acl} onChange={(v) => set({ acl: v })} label="POSIX ACLs" hint="Fine-grained file permissions." />
        <Check checked={o.quota} onChange={(v) => set({ quota: v })} label="User quotas" hint="Not available on ZFS subvolumes." />
        <Check checked={o.ro} onChange={(v) => set({ ro: v })} label="Read only" />
        <Check checked={o.noatime} onChange={(v) => set({ noatime: v })} label="Don't record access times" hint="Less writing on busy volumes." />
      </div>
    </div>
  );
}

const ctBody = (o: Opts, withPath: boolean): Record<string, unknown> => ({ ...(withPath ? { mp: o.mp } : {}), backup: o.backup, replicate: o.replicate, acl: o.acl, quota: o.quota, ro: o.ro, mountoptions: o.noatime ? ["noatime"] : [] });

function Foot({ onClose, busy, label, disabled, onGo }: { onClose: () => void; busy: boolean; label: string; disabled?: boolean; onGo: () => void }) {
  return <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={onGo} loading={busy} disabled={disabled}>{label}</Button></>;
}

function Failure({ message }: { message: string | null }) {
  return message ? <Notice tone="critical" title="Proxmox didn't accept that">{message}</Notice> : null;
}

function StagedNote({ ctx }: { ctx: DiskCtx }) {
  if (ctx.kind !== "qemu" || !ctx.running) return null;
  return <Notice tone="info">{ctx.disks.hotplug ? "This VM is running. Proxmox applies disk changes live when the guest supports it, and otherwise at the next start." : "This VM is running and hot-plugging disks is off, so the change applies at the next start."}</Notice>;
}

export function AddDiskModal({ ctx, onClose }: { ctx: DiskCtx; onClose: () => void }) {
  const opts = useStorages();
  const { act, busy, error } = useAct(ctx, onClose);
  const vm = ctx.kind === "qemu";
  const [bus, setBus] = useState("scsi");
  const [storage, setStorage] = useState("");
  const [size, setSize] = useState(32);
  const [format, setFormat] = useState("raw");
  const [o, setO] = useState<Opts>(optsFrom({ bus: "scsi" } as GuestDisk));
  const set = (p: Partial<Opts>) => setO((s) => ({ ...s, ...p }));
  const list = (vm ? opts?.vmStorages : opts?.storages) ?? [];
  const chosen = storage || list[0]?.storage || "";
  const withPath = !vm;
  const valid = !!chosen && size >= 1 && (vm || /^\/[\w./+@ -]+$/.test(o.mp));
  const go = () =>
    act(vm ? "add" : "mount", vm ? { bus, storage: chosen, sizeGb: size, format: format === "raw" && !isFileStorage(list, chosen) ? undefined : format, ...vmBody(o, bus) } : { storage: chosen, sizeGb: size, ...ctBody(o, withPath) }, vm ? "Add disk" : "Add mount point");
  return (
    <Modal size="lg" icon={<Plus className="h-5 w-5" />} title={vm ? "Add a disk" : "Add a mount point"} subtitle={`${ctx.name} #${ctx.vmid}. Creates a new, empty volume.`} onClose={onClose} footer={<Foot onClose={onClose} busy={busy} label={vm ? "Add disk" : "Add mount point"} disabled={!valid} onGo={go} />}>
      <div className="space-y-5">
        <StagedNote ctx={ctx} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {vm && <Field label="Bus" hint="SCSI with VirtIO drivers is the best default." htmlFor="ad-bus"><Select id="ad-bus" value={bus} onChange={(e) => { setBus(e.target.value); set({ iothread: e.target.value === "scsi" || e.target.value === "virtio", ssd: e.target.value === "virtio" ? false : o.ssd }); }}>{Object.entries(BUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>}
          <Field label="Storage" htmlFor="ad-storage" hint={list.length === 0 ? "No storage on this device can hold this kind of disk." : undefined}>
            <Select id="ad-storage" value={chosen} onChange={(e) => setStorage(e.target.value)}>{list.map((s) => <option key={s.storage} value={s.storage}>{s.storage} · {s.type}{s.avail ? ` · ${Math.round(s.avail / 1e9)} GB free` : ""}</option>)}</Select>
          </Field>
          <Field label="Size (GB)" htmlFor="ad-size"><Input id="ad-size" type="number" min={1} value={size} onChange={(e) => setSize(Math.max(0, Math.floor(Number(e.target.value) || 0)))} /></Field>
          {vm && isFileStorage(list, chosen) && <Field label="Format" hint="QCOW2 supports snapshots on file storage; raw is faster." htmlFor="ad-format"><Select id="ad-format" value={format} onChange={(e) => setFormat(e.target.value)}><option value="raw">Raw</option><option value="qcow2">QCOW2</option><option value="vmdk">VMDK</option></Select></Field>}
        </div>
        {vm ? <VmOptionFields o={o} set={set} bus={bus} /> : <CtOptionFields o={o} set={set} withPath />}
        <Failure message={error} />
      </div>
    </Modal>
  );
}

const isFileStorage = (list: { storage: string; type: string }[], id: string) => ["dir", "nfs", "cifs", "cephfs", "glusterfs", "btrfs"].includes(list.find((s) => s.storage === id)?.type ?? "");

export function EditDiskModal({ ctx, disk, onClose }: { ctx: DiskCtx; disk: GuestDisk; onClose: () => void }) {
  const { act, busy, error } = useAct(ctx, onClose);
  const vm = ctx.kind === "qemu";
  const [o, setO] = useState(() => optsFrom(disk));
  const set = (p: Partial<Opts>) => setO((s) => ({ ...s, ...p }));
  const bind = disk.kind === "bind";
  return (
    <Modal size="lg" icon={<HardDrive className="h-5 w-5" />} title={`Edit ${disk.key}`} subtitle={<span className="font-mono">{disk.volume}</span>} onClose={onClose} footer={<Foot onClose={onClose} busy={busy} label="Save changes" onGo={() => act(`${disk.key}/edit`, vm ? vmBody(o, disk.bus ?? "scsi") : ctBody(o, disk.key !== "rootfs"))} />}>
      <div className="space-y-5">
        <StagedNote ctx={ctx} />
        {bind && <Notice tone="warning">This mount hands a folder of the host to the container. Only Proxmox administrators may change it.</Notice>}
        {vm ? <VmOptionFields o={o} set={set} bus={disk.bus ?? "scsi"} /> : <CtOptionFields o={o} set={set} withPath={disk.key !== "rootfs"} />}
        <Failure message={error} />
      </div>
    </Modal>
  );
}

export function MountModal({ ctx, onClose }: { ctx: DiskCtx; onClose: () => void }) {
  const opts = useStorages();
  const { act, busy, error } = useAct(ctx, onClose);
  const [mode, setMode] = useState<"volume" | "bind">("volume");
  const [storage, setStorage] = useState("");
  const [size, setSize] = useState(8);
  const [bind, setBind] = useState("");
  const [o, setO] = useState(() => optsFrom());
  const set = (p: Partial<Opts>) => setO((s) => ({ ...s, ...p }));
  const list = opts?.storages ?? [];
  const chosen = storage || list[0]?.storage || "";
  const pathOk = /^\/[\w./+@ -]+$/.test(o.mp) && o.mp !== "/";
  const valid = pathOk && (mode === "volume" ? !!chosen && size >= 1 : /^\/[\w./+@-]+$/.test(bind) && !bind.includes(".."));
  return (
    <Modal size="lg" icon={<FolderInput className="h-5 w-5" />} title="Add a mount point" subtitle={`${ctx.name} #${ctx.vmid}`} onClose={onClose} footer={<Foot onClose={onClose} busy={busy} label="Add mount point" disabled={!valid} onGo={() => act("mount", mode === "volume" ? { storage: chosen, sizeGb: size, ...ctBody(o, true) } : { bind, ...ctBody(o, true) }, "Add mount point")} />}>
      <div className="space-y-5">
        <Segmented<"volume" | "bind"> label="Kind" value={mode} onChange={setMode} options={[{ value: "volume", label: "New volume" }, ...(ctx.disks.isAdmin ? [{ value: "bind" as const, label: "Host folder (bind mount)" }] : [])]} />
        {mode === "volume" ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Storage" htmlFor="mt-storage"><Select id="mt-storage" value={chosen} onChange={(e) => setStorage(e.target.value)}>{list.map((s) => <option key={s.storage} value={s.storage}>{s.storage} · {s.type}</option>)}</Select></Field>
            <Field label="Size (GB)" htmlFor="mt-size"><Input id="mt-size" type="number" min={1} value={size} onChange={(e) => setSize(Math.max(0, Math.floor(Number(e.target.value) || 0)))} /></Field>
          </div>
        ) : (
          <div className="space-y-3">
            <Notice tone="warning" title="Bind mounts share the host's files">A bind mount gives this container direct access to a folder on the host. Anything the container does there happens on the host, and an unprivileged container can write files as the host's users. Proxmox only allows this for administrators. Use it for shared data folders, never for system folders.</Notice>
            <Field label="Folder on the host" hint="An absolute path that already exists, for example /srv/shared." htmlFor="mt-bind"><Input id="mt-bind" value={bind} onChange={(e) => setBind(e.target.value)} className="font-mono" placeholder="/srv/shared" /></Field>
          </div>
        )}
        <CtOptionFields o={o} set={set} withPath />
        <Failure message={error} />
      </div>
    </Modal>
  );
}

export function DetachModal({ ctx, disk, onClose }: { ctx: DiskCtx; disk: GuestDisk; onClose: () => void }) {
  const { act, busy, error } = useAct(ctx, onClose);
  const cd = disk.kind === "cdrom";
  return (
    <Modal size="sm" icon={<Unlink className="h-5 w-5" />} title={cd ? `Remove the CD drive ${disk.key}?` : `Detach ${disk.key}?`} subtitle={cd ? "The drive disappears from the machine. No data is lost." : "The disk stays on its storage as a detached disk. You can attach it again or destroy it later; nothing is deleted now."} onClose={onClose} footer={<Foot onClose={onClose} busy={busy} label={cd ? "Remove drive" : "Detach disk"} onGo={() => act(`${disk.key}/detach`, {})} />}>
      <div className="space-y-3"><StagedNote ctx={ctx} /><p className="font-mono text-xs text-ink-3 break-all">{disk.volume}</p><Failure message={error} /></div>
    </Modal>
  );
}

export function AttachModal({ ctx, unused, onClose }: { ctx: DiskCtx; unused: GuestDisks["unused"][number]; onClose: () => void }) {
  const { act, busy, error } = useAct(ctx, onClose);
  const vm = ctx.kind === "qemu";
  const [bus, setBus] = useState("scsi");
  const [o, setO] = useState(() => optsFrom());
  const set = (p: Partial<Opts>) => setO((s) => ({ ...s, ...p }));
  return (
    <Modal size="md" icon={<HardDrive className="h-5 w-5" />} title={`Attach ${unused.name}`} subtitle="Connects the detached disk to the machine again, with its data intact." onClose={onClose} footer={<Foot onClose={onClose} busy={busy} label="Attach disk" disabled={!vm && !/^\/[\w./+@ -]+$/.test(o.mp)} onGo={() => act(`${unused.key}/reattach`, vm ? { bus } : ctBody(o, true))} />}>
      <div className="space-y-4">
        <StagedNote ctx={ctx} />
        {vm ? <Field label="Attach as" htmlFor="at-bus"><Select id="at-bus" value={bus} onChange={(e) => setBus(e.target.value)}>{Object.entries(BUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field> : <CtOptionFields o={o} set={set} withPath />}
        <Failure message={error} />
      </div>
    </Modal>
  );
}

export function MoveModal({ ctx, disk, others, onClose }: { ctx: DiskCtx; disk: { key: string; volume: string; storage: string | null; bus?: string }; others: { vmid: number; name: string; kind: Kind }[]; onClose: () => void }) {
  const opts = useStorages();
  const { act, busy, error } = useAct(ctx, onClose);
  const vm = ctx.kind === "qemu";
  const [mode, setMode] = useState<"storage" | "machine">("storage");
  const [storage, setStorage] = useState("");
  const [format, setFormat] = useState("");
  const [del, setDel] = useState(true);
  const [limit, setLimit] = useState("");
  const [target, setTarget] = useState("");
  const list = ((vm ? opts?.vmStorages : opts?.storages) ?? []).filter((s) => s.storage !== disk.storage);
  const chosen = storage || list[0]?.storage || "";
  const peers = others.filter((m) => m.kind === ctx.kind && m.vmid !== ctx.vmid);
  const peer = target || String(peers[0]?.vmid ?? "");
  return (
    <Modal
      size="md"
      icon={<Move className="h-5 w-5" />}
      title={`Move ${disk.key}`}
      subtitle={<span className="font-mono">{disk.volume}</span>}
      onClose={onClose}
      footer={mode === "storage"
        ? <Foot onClose={onClose} busy={busy} label="Move disk" disabled={!chosen} onGo={() => act(`${disk.key}/move`, { storage: chosen, format: format || undefined, deleteSource: del, bwlimit: limit ? Number(limit) * 1024 : undefined }, `Move ${disk.key} of ${ctx.name} to ${chosen}`)} />
        : <Foot onClose={onClose} busy={busy} label="Move to machine" disabled={!peer} onGo={() => act(`${disk.key}/reassign`, { targetVmid: Number(peer) }, `Move ${disk.key} to #${peer}`)} />}
    >
      <div className="space-y-4">
        <Segmented<"storage" | "machine"> label="Move to" value={mode} onChange={setMode} options={[{ value: "storage", label: "Another storage" }, { value: "machine", label: "Another machine" }]} />
        {mode === "storage" ? (
          <>
            <Field label="Target storage" htmlFor="mv-storage"><Select id="mv-storage" value={chosen} onChange={(e) => setStorage(e.target.value)}>{list.map((s) => <option key={s.storage} value={s.storage}>{s.storage} · {s.type}</option>)}</Select></Field>
            {vm && <Field label="Format" hint="Leave on same as source unless the target needs another." htmlFor="mv-format"><Select id="mv-format" value={format} onChange={(e) => setFormat(e.target.value)}><option value="">Keep as is</option><option value="raw">Raw</option><option value="qcow2">QCOW2</option><option value="vmdk">VMDK</option></Select></Field>}
            <Check checked={del} onChange={setDel} label="Delete the original after copying" hint="Off keeps the old copy as a detached disk, which uses space until you destroy it." />
            <Field label="Speed limit (MB/s)" hint="Empty uses the storage's own limit." htmlFor="mv-limit"><Input id="mv-limit" type="number" min={0} value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="No limit" /></Field>
            <p className="text-xs text-ink-3">The copy runs as a task and can take a while. The machine keeps running during the move.</p>
          </>
        ) : (
          <>
            <Notice tone="warning">The disk leaves {ctx.name} and becomes part of the other machine. Both machines should be stopped; the other machine must be on this device.</Notice>
            <Field label="Machine" htmlFor="mv-peer">{peers.length ? <Select id="mv-peer" value={peer} onChange={(e) => setTarget(e.target.value)}>{peers.map((m) => <option key={m.vmid} value={m.vmid}>{m.name} #{m.vmid}</option>)}</Select> : <p className="text-compact text-ink-3">There is no other {vm ? "virtual machine" : "container"} to move it to.</p>}</Field>
          </>
        )}
        <StagedNote ctx={ctx} />
        <Failure message={error} />
      </div>
    </Modal>
  );
}

export function CdModal({ ctx, drive, onClose }: { ctx: DiskCtx; drive: GuestDisk | null; onClose: () => void }) {
  const engine = useEngine();
  const { act, busy, error } = useAct(ctx, onClose);
  const [isos, setIsos] = useState<{ volid: string; name: string }[] | null>(null);
  const [choice, setChoice] = useState<string>("");
  useEffect(() => {
    let alive = true;
    const stores = engine.data.host.storage.filter((s) => s.content.includes("iso"));
    Promise.all(stores.map((s) => engine.backend.content(s.id, "iso").catch(() => []))).then((lists) => {
      if (!alive) return;
      const all = lists.flat().filter((i) => i.content === "iso").map((i) => ({ volid: i.volid, name: i.volid.split("/").pop() ?? i.volid }));
      setIsos(all);
      setChoice((c) => c || all[0]?.volid || "");
    });
    return () => {
      alive = false;
    };
  }, [engine.backend, engine.data.host.storage]);
  const send = (iso: string) => act("cdrom", { ...(drive ? { key: drive.key } : {}), iso });
  const current = drive && drive.volume !== "none" ? drive.volume : null;
  return (
    <Modal
      size="md"
      icon={<Disc3 className="h-5 w-5" />}
      title={drive ? `CD/DVD drive ${drive.key}` : "Add a CD/DVD drive"}
      subtitle={current ? <>Holds <span className="font-mono">{current}</span></> : "Empty"}
      onClose={onClose}
      footer={<>{drive && current && <Button variant="secondary" onClick={() => send("none")} disabled={busy} className="mr-auto">Eject</Button>}<Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => send(choice)} loading={busy} disabled={!choice || choice === "physical"}>{drive ? "Insert image" : "Add drive"}</Button></>}
    >
      <div className="space-y-4">
        {isos === null ? <p className="text-compact text-ink-3">Looking for ISO images…</p> : isos.length === 0 ? <Notice tone="info">No ISO images on this device yet. Upload one under Storage, then come back.</Notice> : (
          <Field label="ISO image" htmlFor="cd-iso"><Select id="cd-iso" value={choice} onChange={(e) => setChoice(e.target.value)}>{isos.map((i) => <option key={i.volid} value={i.volid}>{i.volid}</option>)}</Select></Field>
        )}
        <div><Button size="sm" variant="secondary" onClick={() => send("physical")} disabled={busy}>Use the host's physical drive</Button><p className="text-xs text-ink-3 mt-1.5">Passes the device's own optical drive through to the machine.</p></div>
        <StagedNote ctx={ctx} />
        <Failure message={error} />
      </div>
    </Modal>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">{children}</div>;
}
