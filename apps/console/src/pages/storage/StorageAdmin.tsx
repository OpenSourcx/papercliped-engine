import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Pencil, Trash2 } from "lucide-react";
import { errorText, useDisksApi, type StorageDef } from "../../data/engine/disks.ts";
import { useEngine } from "../../data/store.tsx";
import { Button, Notice } from "../../ui/primitives.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { RemoveStorageModal } from "../disks/StorageDefinitions.tsx";
import { StorageFormModal } from "../disks/StorageForm.tsx";

/** Edit and Remove for one storage, next to its title. Loads the definition (with its digest) when asked. */
export function StorageAdmin({ id }: { id: string }) {
  const api = useDisksApi();
  const engine = useEngine();
  const nav = useNavigate();
  const [def, setDef] = useState<StorageDef | null>(null);
  const [mode, setMode] = useState<"edit" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"edit" | "remove" | null>(null);
  const open = async (m: "edit" | "remove") => {
    setBusy(m);
    setError(null);
    try {
      setDef(await api.storageDef(id));
      setMode(m);
    } catch (e) {
      setError(errorText(e, "Couldn't read this storage's settings"));
    }
    setBusy(null);
  };
  const device = engine.setup?.deviceName ?? "pve";
  return (
    <>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" loading={busy === "edit"} onClick={() => open("edit")}><Pencil className="h-3.5 w-3.5" />Edit</Button>
        <Button size="sm" variant="ghost" loading={busy === "remove"} onClick={() => open("remove")}><Trash2 className="h-3.5 w-3.5" />Remove</Button>
      </div>
      {error && <Modal size="sm" title="Can't open the settings" onClose={() => setError(null)} footer={<Button onClick={() => setError(null)}>Close</Button>}><Notice tone="critical">{error}</Notice></Modal>}
      {def && mode === "edit" && <StorageFormModal existing={def} onClose={() => setMode(null)} onDone={() => setDef(null)} />}
      {def && mode === "remove" && <RemoveStorageModal storage={def} onClose={() => setMode(null)} onDone={() => nav(`/${device}/storage`)} />}
    </>
  );
}
