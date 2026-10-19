import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import { errorText } from "../data/engine/queries.ts";
import { ago } from "../data/engine/map.ts";
import { vaultApi, type Ceo, type VaultInput, type VaultItem } from "../data/engine/vaultApi.ts";
import { Modal } from "../ui/Modal.tsx";
import { PinOrb } from "../pin/PinIsland.tsx";
import { Button, Card, Chip, EmptyState, Field, Input, Notice, PageFrame, PageHeader, Spinner } from "../ui/primitives.tsx";

const KEY = ["vault"] as const;

/** Settings → Vault: variables kept once for the whole host, Pin only or shared with the CEOs an administrator picks. */
export function Vault() {
  return useEngine().live ? <LiveVault /> : (
    <PageFrame width="4xl">
      <PageHeader title="Vault" subtitle="Host-wide variables and secrets." />
      <Notice>The vault lives on the device, so it isn't part of the demo.</Notice>
    </PageFrame>
  );
}

function LiveVault() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: vaultApi.list, retry: 1 });
  const [editing, setEditing] = useState<VaultItem | "new" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const can = q.data?.canManage === true;
  const sync = useMutation({
    mutationFn: vaultApi.sync,
    onSuccess: (r) => { const n = Object.keys(r.problems).length; setNote(n ? `Couldn't update ${Object.keys(r.problems).join(", ")}.` : "Every share is up to date."); refresh(); },
    onError: (e) => setNote(errorText(e)),
  });
  return (
    <PageFrame width="4xl">
      <PageHeader
        title="Vault"
        subtitle="Variables and secrets for the whole host. Set one once, then choose who can use it: Pin only, or the CEOs you pick in any organization. Values are sealed and never shown again."
        actions={can ? <div className="flex gap-2"><Button onClick={() => sync.mutate()} loading={sync.isPending}><RefreshCw className="h-4 w-4" />Sync</Button><Button variant="primary" onClick={() => setEditing("new")}><Plus className="h-4 w-4" />Add a variable</Button></div> : undefined}
      />
      {q.isPending && <div className="py-10 flex justify-center"><Spinner /></div>}
      {q.error && <p role="alert" className="text-compact text-critical mb-3">{errorText(q.error)}</p>}
      {note && <p role="status" className="text-compact text-ink-2 mb-3">{note}</p>}
      {q.data && !can && <Notice>Only Proxmox administrators can use the vault.</Notice>}
      {q.data && can && (
        <Card className="divide-y divide-line">
          {q.data.items.length === 0 && <EmptyState icon={<KeyRound className="h-5 w-5" />} title="Nothing in the vault yet" body="Add a token or key once and decide who can use it." action={<Button variant="primary" onClick={() => setEditing("new")}><Plus className="h-4 w-4" />Add a variable</Button>} />}
          {q.data.items.map((i) => <Row key={i.id} item={i} onEdit={() => setEditing(i)} onChanged={refresh} />)}
        </Card>
      )}
      {editing && <EditModal item={editing === "new" ? null : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); refresh(); }} />}
    </PageFrame>
  );
}

function Row({ item, onEdit, onChanged }: { item: VaultItem; onEdit: () => void; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const del = useMutation({ mutationFn: () => vaultApi.remove(item.id), onSuccess: onChanged, onError: (e) => { setError(errorText(e)); setConfirm(false); } });
  return (
    <div className="px-5 py-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="h-8 w-8 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2 shrink-0"><KeyRound className="h-4 w-4" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm truncate">{item.name}</div>
          <div className="text-xs text-ink-3 truncate">{item.description || "No description"}{item.last4 && <> · ends in {item.last4}</>} · changed {ago(new Date(item.updatedAt))} by {item.updatedBy}</div>
        </div>
        {item.share === "pin" ? <Chip><span className="inline-flex items-center gap-1.5"><PinOrb size={12} />Pin only</span></Chip> : <Chip tone="accent">Pin and {item.targets.length} CEO{item.targets.length === 1 ? "" : "s"}</Chip>}
        <Button size="sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${item.name}`}><Pencil className="h-4 w-4" /></Button>
        {confirm ? <Button size="sm" variant="danger" loading={del.isPending} onClick={() => del.mutate()}>Remove {item.name}</Button> : <Button size="sm" variant="ghost" onClick={() => setConfirm(true)} aria-label={`Remove ${item.name}`}><Trash2 className="h-4 w-4" /></Button>}
      </div>
      {error && <p role="alert" className="text-xs text-critical mt-2">{error}</p>}
    </div>
  );
}

function EditModal({ item, onClose, onDone }: { item: VaultItem | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(item?.name ?? "");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState(item?.description ?? "");
  const [share, setShare] = useState<"pin" | "ceos">(item?.share ?? "pin");
  const [picked, setPicked] = useState<Set<string>>(new Set(item?.targets.map((t) => t.agentId)));
  const [error, setError] = useState<string | null>(null);
  // Only CEOs the engine actually has are offered; with none, nothing is listed.
  const ceos = useQuery({ queryKey: ["vault", "ceos"], queryFn: vaultApi.ceos, retry: 0 });
  const list: Ceo[] = ceos.data?.ceos ?? [];
  const targets = list.filter((c) => picked.has(c.agentId)).map((c) => ({ companyId: c.companyId, agentId: c.agentId }));
  const save = useMutation({
    mutationFn: async () => {
      const body: VaultInput = { description, share, targets: share === "ceos" ? targets : [], ...(value ? { value } : {}) };
      return item ? vaultApi.update(item.id, body) : vaultApi.create({ ...body, name, value });
    },
    onSuccess: (r) => { if (r.problems.length) setError(`Saved, but not every organization was updated: ${r.problems.join("; ")}`); else onDone(); },
    onError: (e) => setError(errorText(e)),
    onSettled: () => setValue(""),
  });
  const byCompany = new Map<string, Ceo[]>();
  for (const c of list) byCompany.set(c.companyName, [...(byCompany.get(c.companyName) ?? []), c]);
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <Modal size="md" icon={<KeyRound className="h-5 w-5" />} title={item ? `Edit ${item.name}` : "Add a variable"} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>{error?.startsWith("Saved") ? "Close" : "Cancel"}</Button><Button variant="primary" loading={save.isPending} disabled={!item && (!name.trim() || !value)} onClick={() => save.mutate()}>{item ? "Save" : "Add to the vault"}</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }} autoComplete="off">
        <Field label="Name" htmlFor="v-name" hint="What a program sees, such as GITHUB_TOKEN.">
          <Input id="v-name" value={name} disabled={!!item} onChange={(e) => setName(e.target.value)} placeholder="GITHUB_TOKEN" spellCheck={false} className="font-mono" />
        </Field>
        <Field label={item ? "New value" : "Value"} htmlFor="v-value" hint={item ? "Leave empty to keep the current value." : "Sealed on this device. It won't be shown again."}>
          <Input id="v-value" type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" spellCheck={false} />
        </Field>
        <Field label="What it's for" htmlFor="v-desc">
          <Input id="v-desc" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <fieldset>
          <legend className="text-compact font-medium text-ink-2 mb-1.5">Who can use it</legend>
          <div className="grid grid-cols-2 gap-2">
            {([["pin", "Pin only", "Pin knows it exists. No organization sees it."], ["ceos", "Selected CEOs", "Pin, and the CEOs you pick."]] as const).map(([v, label, body]) => (
              <label key={v} className={`cursor-pointer rounded-lg border px-3 py-2.5 transition-control ${share === v ? "border-accent bg-accent/5" : "border-line hover:border-line-strong"}`}>
                <input type="radio" name="share" className="sr-only" checked={share === v} onChange={() => setShare(v)} />
                <div className="text-sm font-medium">{label}</div>
                <div className="text-xs text-ink-3">{body}</div>
              </label>
            ))}
          </div>
        </fieldset>
        {share === "ceos" && list.length > 0 && (
          <div className="space-y-3" role="group" aria-label="CEOs">
            {[...byCompany].map(([company, members]) => (
              <div key={company}>
                <div className="text-xs text-ink-3 mb-1">{company}</div>
                {members.map((c) => (
                  <label key={c.agentId} className="flex items-center gap-2.5 py-1.5 text-sm cursor-pointer">
                    <input type="checkbox" checked={picked.has(c.agentId)} onChange={() => toggle(c.agentId)} />
                    <span className="truncate">{c.name}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        )}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
        <button type="submit" className="sr-only" tabIndex={-1}>Save</button>
      </form>
    </Modal>
  );
}
