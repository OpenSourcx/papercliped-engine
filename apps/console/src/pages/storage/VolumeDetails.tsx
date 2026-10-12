import { useState } from "react";
import { Copy, Trash2 } from "lucide-react";
import { errorText, useDisksApi } from "../../data/engine/disks.ts";
import type { StorageItem } from "../../data/api.ts";
import { formatBytes } from "../../lib/storage.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Field, Notice, Textarea, Toggle } from "../../ui/primitives.tsx";

/**
 * One file or volume on a storage: where it is, how big, notes, and protection for backups. Deleting stays one click
 * away. Restoring backups lives on the Backups page, and Proxmox has no way to export a disk image, so there is none here.
 */
export function VolumeDetails({ storage, item, onClose, onDelete, onSaved }: { storage: string; item: StorageItem; onClose: () => void; onDelete: () => void; onSaved: () => void }) {
  const api = useDisksApi();
  const [notes, setNotes] = useState(item.notes ?? "");
  const [prot, setProt] = useState(item.protected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const dirty = notes !== (item.notes ?? "") || prot !== item.protected;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.volumeAttributes(storage, item.volid, { ...(notes !== (item.notes ?? "") ? { notes } : {}), ...(prot !== item.protected ? { protected: prot } : {}) });
      onSaved();
      onClose();
    } catch (e) {
      setError(errorText(e, "Couldn't save it"));
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.volid);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Modal
      size="md"
      title={item.volid.split("/").pop() ?? item.volid}
      subtitle={<span className="font-mono break-all">{item.volid}</span>}
      onClose={onClose}
      footer={<><Button variant="danger" onClick={onDelete} disabled={item.protected} className="mr-auto"><Trash2 className="h-4 w-4" />Delete</Button><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" onClick={save} loading={busy} disabled={!dirty}>Save</Button></>}
    >
      <div className="space-y-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-compact">
          <dt className="text-ink-3">Kind</dt><dd>{item.content}</dd>
          <dt className="text-ink-3">Format</dt><dd>{item.format ?? "—"}</dd>
          <dt className="text-ink-3">Size</dt><dd className="tabular-nums">{item.size !== null ? formatBytes(item.size) : "—"}</dd>
          {item.vmid && <><dt className="text-ink-3">Machine</dt><dd className="tabular-nums">#{item.vmid}</dd></>}
          {item.ctime && <><dt className="text-ink-3">Created</dt><dd>{new Date(item.ctime * 1000).toLocaleString()}</dd></>}
        </dl>
        <Button size="sm" variant="secondary" onClick={copy}><Copy className="h-3.5 w-3.5" />{copied ? "Copied" : "Copy volume ID"}</Button>
        {item.content === "backup" && (
          <div className="flex items-center justify-between gap-4"><div><div className="text-sm">Protected</div><div className="text-xs text-ink-3">A protected backup is never removed by retention settings and can't be deleted until you turn this off.</div></div><Toggle checked={prot} onChange={setProt} label="Protected" /></div>
        )}
        {item.content === "backup" && <Field label="Notes" htmlFor="vol-notes"><Textarea id="vol-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={2048} /></Field>}
        {error && <Notice tone="critical">{error}</Notice>}
      </div>
    </Modal>
  );
}
