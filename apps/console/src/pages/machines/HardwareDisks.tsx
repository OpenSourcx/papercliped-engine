import { useState } from "react";
import { Disc3, FolderInput, HardDrive, Link2, Move, Pencil, Plus, Trash2, Unlink } from "lucide-react";
import { useDisksApi, type GuestDisk, type GuestDisks } from "../../data/engine/disks.ts";
import { useEngine } from "../../data/store.tsx";
import type { Guest } from "../../data/types.ts";
import { volName } from "../storage/content.ts";
import { Button, Card, Chip, Notice, SectionTitle } from "../../ui/primitives.tsx";
import { ConfirmTypeModal, useLoad } from "../disks/common.tsx";
import { AddDiskModal, AttachModal, CdModal, DetachModal, EditDiskModal, MountModal, MoveModal, Row, type DiskCtx } from "./HardwareDiskModals.tsx";

type Dialog =
  | { kind: "add" }
  | { kind: "mount" }
  | { kind: "edit"; disk: GuestDisk }
  | { kind: "detach"; disk: GuestDisk }
  | { kind: "move"; disk: GuestDisk }
  | { kind: "cd"; disk: GuestDisk | null }
  | { kind: "attach"; unused: GuestDisks["unused"][number] }
  | { kind: "destroy"; unused: GuestDisks["unused"][number] };

const KIND_LABEL: Record<GuestDisk["kind"], string> = { disk: "Disk", cdrom: "CD/DVD drive", cloudinit: "Cloud-init drive", efidisk: "EFI disk", tpm: "TPM state", rootfs: "Root disk", mount: "Mount point", bind: "Host folder" };

function chips(d: GuestDisk) {
  const out: string[] = [];
  if (d.cache) out.push(`cache ${d.cache}`);
  if (d.discard) out.push("discard");
  if (d.ssd) out.push("SSD");
  if (d.iothread) out.push("IO thread");
  if (d.aio) out.push(d.aio);
  if (d.ro) out.push("read only");
  if (d.acl) out.push("ACL");
  if (d.quota) out.push("quota");
  if (d.mbpsRd || d.mbpsWr || d.iopsRd || d.iopsWr) out.push("speed limited");
  return out;
}

/** A machine's disks: add, edit, detach, move, reassign, CD drive and mount points. Replaces the read-only list. */
export function DisksCard({ g, kind, running, onGrow, version, onChanged }: { g: Guest; kind: "qemu" | "lxc"; running: boolean; onGrow: (key: string, sizeGb: number | null) => void; version: number; onChanged: () => void }) {
  const api = useDisksApi();
  const engine = useEngine();
  const disks = useLoad(() => api.guestDisks(g.vmid, kind), [api, g.vmid, kind, version, engine.contentVersion]);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const d = disks.data;
  const reload = () => {
    disks.reload();
    onChanged();
  };
  const ctx: DiskCtx | null = d ? { vmid: g.vmid, kind, name: g.name, running, disks: d, reload } : null;
  const others = engine.data.guests.filter((x) => !x.template).map((x) => ({ vmid: x.vmid, name: x.name, kind: x.type === "lxc" ? ("lxc" as const) : ("qemu" as const) }));
  const vm = kind === "qemu";
  const hasCd = !!d?.disks.some((x) => x.kind === "cdrom");

  return (
    <Card className="p-5">
      <SectionTitle
        action={d && (
          <div className="flex flex-wrap gap-1">
            {vm && !hasCd && <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "cd", disk: null })}><Disc3 className="h-3.5 w-3.5" />CD drive</Button>}
            <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: vm ? "add" : "mount" })}><Plus className="h-3.5 w-3.5" />{vm ? "Add disk" : "Add mount point"}</Button>
          </div>
        )}
      >
        Disks
      </SectionTitle>
      {disks.error && <p role="alert" className="text-compact text-critical">{disks.error}</p>}
      {!d && !disks.error && <p className="text-sm text-ink-3">Reading disks…</p>}
      {d && (
        <>
          {d.locked && <Notice tone="warning" className="mb-3">This machine is busy ({d.locked}). Disk changes wait until it's done.</Notice>}
          {d.pendingKeys.length > 0 && <Notice tone="warning" className="mb-3" title="Waiting for a restart">Proxmox will apply {d.pendingKeys.join(", ")} when the machine starts again. Shown below as pending.</Notice>}
          <div className="divide-y divide-line">
            {d.disks.map((x) => (
              <Row key={x.key}>
                {x.kind === "cdrom" ? <Disc3 className="h-4 w-4 text-ink-3 shrink-0" /> : x.kind === "bind" ? <FolderInput className="h-4 w-4 text-ink-3 shrink-0" /> : <HardDrive className="h-4 w-4 text-ink-3 shrink-0" />}
                <div className="flex-1 min-w-0 basis-48">
                  <div className="text-sm"><span className="font-mono">{x.key}</span>{x.mp && <span className="text-ink-3"> · mounted at <span className="font-mono">{x.mp}</span></span>}<span className="text-ink-3"> · {KIND_LABEL[x.kind]}</span></div>
                  <div className="text-xs text-ink-3 truncate font-mono" title={x.volume}>{x.kind === "cdrom" ? (x.volume === "none" ? "Empty" : x.volume === "cdrom" ? "Host drive" : volName(x.volume)) : x.kind === "bind" ? `Host folder ${x.volume}` : `${x.storage ?? ""} · ${volName(x.volume)}`}</div>
                  {(chips(x).length > 0 || x.staged || x.backup === false) && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {x.staged && <Chip tone="warning">Pending restart</Chip>}
                      {x.backup === false && x.kind !== "cdrom" && <Chip tone="warning">Not backed up</Chip>}
                      {chips(x).map((c) => <Chip key={c}>{c}</Chip>)}
                    </div>
                  )}
                </div>
                {x.sizeGb !== null && x.kind !== "cdrom" && <span className="text-sm tabular-nums">{x.sizeGb} GB</span>}
                <div className="flex flex-wrap items-center gap-1">
                  {x.kind === "cdrom" && <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "cd", disk: x })}><Disc3 className="h-3.5 w-3.5" />{x.volume === "none" ? "Insert" : "Change"}</Button>}
                  {(x.kind === "disk" || x.kind === "rootfs" || x.kind === "mount" || x.kind === "bind") && <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "edit", disk: x })} aria-label={`Edit ${x.key}`}><Pencil className="h-3.5 w-3.5" />Edit</Button>}
                  {(x.kind === "disk" || x.kind === "rootfs" || x.kind === "mount") && <Button size="sm" variant="ghost" onClick={() => onGrow(x.key, x.sizeGb)}>Grow</Button>}
                  {(x.kind === "disk" || x.kind === "rootfs" || x.kind === "mount") && <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "move", disk: x })} aria-label={`Move ${x.key}`}><Move className="h-3.5 w-3.5" />Move</Button>}
                  {x.kind !== "rootfs" && x.kind !== "efidisk" && x.kind !== "tpm" && x.kind !== "cloudinit" && <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "detach", disk: x })} aria-label={`${x.kind === "cdrom" ? "Remove" : "Detach"} ${x.key}`}><Unlink className="h-3.5 w-3.5" />{x.kind === "cdrom" ? "Remove" : "Detach"}</Button>}
                </div>
              </Row>
            ))}
          </div>
          {d.unused.length > 0 && (
            <div className="mt-4">
              <h3 className="text-micro font-semibold uppercase tracking-label text-ink-3 mb-1">Detached disks</h3>
              <p className="text-xs text-ink-3">These still exist on their storage and use space. Attach one again, or destroy it for good.</p>
              <div className="divide-y divide-line">
                {d.unused.map((u) => (
                  <Row key={u.key}>
                    <Link2 className="h-4 w-4 text-ink-3 shrink-0" />
                    <div className="flex-1 min-w-0 basis-48"><div className="text-sm"><span className="font-mono">{u.key}</span></div><div className="text-xs text-ink-3 truncate font-mono" title={u.volume}>{u.storage ?? ""} · {u.name}</div></div>
                    <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "attach", unused: u })}>Attach</Button>
                    <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "destroy", unused: u })} aria-label={`Destroy ${u.name}`}><Trash2 className="h-3.5 w-3.5" />Destroy</Button>
                  </Row>
                ))}
              </div>
            </div>
          )}
          <p className="text-xs text-ink-3 mt-3">Disks can grow but not shrink. The filesystem inside {vm ? "may need extending from inside the VM" : "grows with it"}.</p>
        </>
      )}

      {ctx && dialog?.kind === "add" && <AddDiskModal ctx={ctx} onClose={() => setDialog(null)} />}
      {ctx && dialog?.kind === "mount" && <MountModal ctx={ctx} onClose={() => setDialog(null)} />}
      {ctx && dialog?.kind === "edit" && <EditDiskModal ctx={ctx} disk={dialog.disk} onClose={() => setDialog(null)} />}
      {ctx && dialog?.kind === "detach" && <DetachModal ctx={ctx} disk={dialog.disk} onClose={() => setDialog(null)} />}
      {ctx && dialog?.kind === "move" && <MoveModal ctx={ctx} disk={dialog.disk} others={others} onClose={() => setDialog(null)} />}
      {ctx && dialog?.kind === "cd" && <CdModal ctx={ctx} drive={dialog.disk} onClose={() => setDialog(null)} />}
      {ctx && dialog?.kind === "attach" && <AttachModal ctx={ctx} unused={dialog.unused} onClose={() => setDialog(null)} />}
      {ctx && dialog?.kind === "destroy" && (
        <ConfirmTypeModal
          title={`Destroy ${dialog.unused.name}?`}
          subtitle="Deletes the disk and its data from the storage. This can't be undone."
          expected={dialog.unused.name}
          actionLabel="Destroy disk"
          warning={<>The data on <span className="font-mono">{dialog.unused.volume}</span> is lost for good. Back it up first if you might need it.</>}
          onConfirm={(typed) => api.guestAct(g.vmid, `${dialog.unused.key}/destroy`, { confirm: typed, digest: ctx.disks.digest })}
          onClose={() => setDialog(null)}
          onDone={reload}
        />
      )}
    </Card>
  );
}
