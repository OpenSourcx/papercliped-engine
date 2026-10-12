import { useState } from "react";
import { Database, Pencil, Plus, Trash2 } from "lucide-react";
import { CONTENT_LABELS, storageDef, type ContentType } from "@papercliped-engine/proxmox-client/storage-schema";
import { useDisksApi, type StorageDef, type StorageUsage } from "../../data/engine/disks.ts";
import { useEngine } from "../../data/store.tsx";
import { Button, Card, Chip, EmptyState, Notice, PageFrame, PageHeader, Status } from "../../ui/primitives.tsx";
import { ConfirmTypeModal, Loading, useLoad } from "./common.tsx";
import { StorageFormModal } from "./StorageForm.tsx";

/** Datacenter -> Storage: every storage definition, with add, edit and remove. */
export function StorageDefinitions() {
  const api = useDisksApi();
  const engine = useEngine();
  const list = useLoad(() => api.storageDefs(), [api, engine.contentVersion]);
  const [editing, setEditing] = useState<StorageDef | "new" | null>(null);
  const [removing, setRemoving] = useState<StorageDef | null>(null);

  return (
    <PageFrame width="6xl">
      <PageHeader
        title="Storage settings"
        subtitle="Where this device and its cluster keep machine disks, templates, ISO images and backups. Add a storage, change what it holds, or remove it. Open a storage under Storage to browse its files."
        actions={<Button variant="primary" onClick={() => setEditing("new")}><Plus className="h-4 w-4" />Add storage</Button>}
      />
      {list.error ? <Notice tone="critical" title="Couldn't read the storage settings">{list.error}</Notice> : !list.data ? <Card><Loading /></Card> : list.data.length === 0 ? (
        <Card><EmptyState icon={<Database className="h-5 w-5" />} title="No storage defined" body="Add a directory, a network share or a disk-backed pool so machines have somewhere to live." action={<Button variant="primary" onClick={() => setEditing("new")}><Plus className="h-4 w-4" />Add storage</Button>} /></Card>
      ) : (
        <div className="space-y-3">
          {list.data.map((s) => <StorageRow key={s.id} s={s} onEdit={() => setEditing(s)} onRemove={() => setRemoving(s)} />)}
        </div>
      )}
      {editing && <StorageFormModal existing={editing === "new" ? null : editing} onClose={() => setEditing(null)} onDone={list.reload} />}
      {removing && <RemoveStorageModal storage={removing} onClose={() => setRemoving(null)} onDone={list.reload} />}
    </PageFrame>
  );
}

function StorageRow({ s, onEdit, onRemove }: { s: StorageDef; onEdit: () => void; onRemove: () => void }) {
  const def = storageDef(s.type);
  const where = String(s.config.path ?? s.config.server ?? s.config.vgname ?? s.config.pool ?? s.config.portal ?? "");
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="h-9 w-9 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2 shrink-0"><Database className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1 basis-48">
          <div className="font-medium">{s.id}</div>
          <div className="text-xs text-ink-3 font-mono truncate">{def?.label ?? s.type}{where ? ` · ${where}` : ""}</div>
        </div>
        {s.enabled ? <Status kind="good" label="Enabled" /> : <Status kind="off" label="Disabled" />}
        <Button size="sm" variant="secondary" onClick={onEdit} aria-label={`Edit ${s.id}`}><Pencil className="h-3.5 w-3.5" />Edit</Button>
        <Button size="sm" variant="ghost" onClick={onRemove} aria-label={`Remove ${s.id}`}><Trash2 className="h-3.5 w-3.5" />Remove</Button>
      </div>
      <div className="flex flex-wrap gap-1.5 mt-3">
        {s.content.map((c) => <Chip key={c}>{CONTENT_LABELS[c as ContentType]?.label ?? c}</Chip>)}
        {s.shared && <Chip tone="accent">Shared</Chip>}
        {s.nodes.length > 0 && <Chip>Only on {s.nodes.join(", ")}</Chip>}
        {s.prune && (s.prune.keepAll ? <Chip>Keeps every backup</Chip> : s.prune.keepLast || s.prune.keepDaily || s.prune.keepWeekly || s.prune.keepMonthly || s.prune.keepYearly || s.prune.keepHourly ? <Chip>Keeps {[s.prune.keepLast && `${s.prune.keepLast} last`, s.prune.keepHourly && `${s.prune.keepHourly} hourly`, s.prune.keepDaily && `${s.prune.keepDaily} daily`, s.prune.keepWeekly && `${s.prune.keepWeekly} weekly`, s.prune.keepMonthly && `${s.prune.keepMonthly} monthly`, s.prune.keepYearly && `${s.prune.keepYearly} yearly`].filter(Boolean).join(", ")}</Chip> : null)}
        {s.secretsSet.length > 0 && <Chip>Credentials stored</Chip>}
      </div>
    </Card>
  );
}

/** What would be left without a home if the storage went: its files, the machines using it and backup jobs writing to it. */
export function UsageWarning({ usage }: { usage: StorageUsage | null }) {
  if (!usage) return <p className="text-compact text-ink-3">Checking what uses it…</p>;
  const files = Object.entries(usage.counts).filter(([, n]) => n > 0);
  if (!usage.readable) return <Notice tone="warning">Couldn't read this storage to see what uses it. It may be offline.</Notice>;
  if (!files.length && !usage.guests.length && !usage.backupJobs.length) return <p className="text-compact text-ink-2">Nothing on it is used by a machine or a backup job.</p>;
  return (
    <Notice tone="warning" title="Still in use">
      <ul className="list-disc pl-4 space-y-0.5">
        {usage.guests.map((g) => <li key={g.vmid}>{g.name ?? "Machine"} #{g.vmid} has {g.volumes} disk{g.volumes === 1 ? "" : "s"} here</li>)}
        {usage.backupJobs.map((j) => <li key={j}>Backup job {j} writes here</li>)}
        {files.map(([k, n]) => <li key={k}>{n} {(CONTENT_LABELS[k as ContentType]?.label ?? k).toLowerCase()}</li>)}
      </ul>
      <p className="mt-2">Removing the storage only forgets it in Proxmox. The data isn't deleted, but machines that use it can't start until you move their disks.</p>
    </Notice>
  );
}

export function RemoveStorageModal({ storage, onClose, onDone }: { storage: StorageDef; onClose: () => void; onDone: () => void }) {
  const api = useDisksApi();
  const usage = useLoad(() => api.storageUsage(storage.id), [api, storage.id]);
  const inUse = !!usage.data && (usage.data.guests.length > 0 || usage.data.backupJobs.length > 0);
  return (
    <ConfirmTypeModal
      title={`Remove ${storage.id}?`}
      subtitle="Takes the storage out of Proxmox's settings."
      expected={storage.id}
      actionLabel="Remove storage"
      onConfirm={(typed) => api.removeStorage(storage.id, { confirm: typed, acknowledgeInUse: inUse })}
      onClose={onClose}
      onDone={onDone}
    >
      {usage.error ? <Notice tone="warning">{usage.error}</Notice> : <UsageWarning usage={usage.data} />}
    </ConfirmTypeModal>
  );
}
