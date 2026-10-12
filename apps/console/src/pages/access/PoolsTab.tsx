import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Plus, Trash2, X } from "lucide-react";
import { access, type Pool, type PoolOverview } from "../../data/engine/access.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Chip, EmptyState, Input, Notice, SectionTitle, Select } from "../../ui/primitives.tsx";
import { QueryState, ReadOnlyNote, Table, Td, Th, plural, AField as Field } from "./shared.tsx";

const KEY = ["access", "pools"] as const;

function PoolModal({ pool, data, onClose }: { pool: Pool | null; data: PoolOverview; onClose: () => void }) {
  const qc = useQueryClient();
  const creating = !pool;
  const [poolid, setPoolid] = useState("");
  const [comment, setComment] = useState(pool?.comment ?? "");
  const [addVm, setAddVm] = useState("");
  const [addStore, setAddStore] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const done = () => {
    qc.invalidateQueries({ queryKey: KEY });
    onClose();
  };
  const fail = (e: unknown) => setError(errorText(e));
  const save = useMutation({ mutationFn: () => (creating ? access.pools.create(poolid.trim(), comment.trim() || undefined) : access.pools.update(pool.poolid, { comment: comment.trim() })), onSuccess: done, onError: fail });
  const change = useMutation({
    mutationFn: (p: Parameters<typeof access.pools.update>[1]) => access.pools.update(pool!.poolid, p),
    onSuccess: () => {
      setAddVm("");
      setAddStore("");
      qc.invalidateQueries({ queryKey: KEY });
    },
    onError: fail,
  });
  const remove = useMutation({ mutationFn: () => access.pools.remove(pool!.poolid), onSuccess: done, onError: fail });
  // The modal shows the pool as it is now, not as it was when opened.
  const live = data.pools.find((p) => p.poolid === pool?.poolid) ?? pool;
  const inPool = new Set((live?.members ?? []).filter((m) => m.kind === "machine").map((m) => m.id));
  const storeIn = new Set((live?.members ?? []).filter((m) => m.kind === "storage").map((m) => m.id));
  const mapped = live?.organization;
  return (
    <Modal
      size="lg"
      icon={<Boxes className="h-5 w-5" />}
      title={creating ? "New resource group" : live!.poolid}
      subtitle="A resource group collects machines and storage so one permission covers them all."
      onClose={onClose}
      footer={
        <>
          {!creating && data.canManage && !confirm && <Button variant="ghost" className="mr-auto text-critical" onClick={() => setConfirm(true)}><Trash2 className="h-4 w-4" />Delete</Button>}
          <Button variant="ghost" onClick={onClose}>{data.canManage ? "Cancel" : "Close"}</Button>
          {data.canManage && <Button variant="primary" loading={save.isPending} disabled={creating && !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(poolid.trim())} onClick={() => save.mutate()}>{creating ? "Create group" : "Save comment"}</Button>}
        </>
      }
    >
      <div className="space-y-5">
        {mapped && <Notice tone="info" title={`Resource group of ${mapped.name}`}>This resource group is managed through the organization. Its machines are the organization's machines, and it can't be deleted while the organization uses it.</Notice>}
        {live?.orgPool && !mapped && <Notice tone="warning" title="Left over from an organization">Resource groups named epc- are made for organizations. No organization uses this one now.</Notice>}
        {creating && <Field label="Name" hint="Starts with a letter. Names starting with epc- are for organizations."><Input value={poolid} onChange={(e) => setPoolid(e.target.value)} className="font-mono" autoFocus spellCheck={false} /></Field>}
        <Field label="Comment"><Input value={comment} onChange={(e) => setComment(e.target.value)} disabled={!data.canManage} /></Field>
        {!creating && live && (
          <>
            <div>
              <div className="text-compact font-medium text-ink-2 mb-1.5">Members ({live.members.length})</div>
              {live.members.length === 0 ? <p className="text-compact text-ink-3">Nothing in this group yet.</p> : (
                <ul className="rounded-lg border border-line divide-y divide-line">
                  {live.members.map((m) => (
                    <li key={`${m.kind}${m.id}`} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <Chip>{m.kind === "storage" ? "Storage" : m.type === "lxc" ? "Container" : "Virtual machine"}</Chip>
                      <span className="flex-1 min-w-0 truncate">{m.kind === "storage" ? <span className="font-mono">{m.id}</span> : <>{m.name ?? "Machine"} <span className="font-mono text-ink-3">{m.id}</span></>}</span>
                      {data.canManage && <Button size="sm" variant="ghost" aria-label={`Remove ${m.name ?? m.id} from the group`} onClick={() => change.mutate(m.kind === "storage" ? { removeStorage: [m.id] } : { removeVms: [m.id] })}><X className="h-4 w-4" /></Button>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {data.canManage && (
              <div className="grid sm:grid-cols-2 gap-4">
                <Field label="Add a machine">
                  <div className="flex gap-2">
                    <Select aria-label="Add a machine" value={addVm} onChange={(e) => setAddVm(e.target.value)}><option value="">Choose…</option>{data.candidates.machines.filter((m) => !inPool.has(String(m.vmid))).map((m) => <option key={m.vmid} value={m.vmid}>{m.name ?? "Machine"} ({m.vmid})</option>)}</Select>
                    <Button disabled={!addVm} loading={change.isPending} onClick={() => change.mutate({ addVms: [addVm] })}><Plus className="h-4 w-4" />Add</Button>
                  </div>
                </Field>
                <Field label="Add a storage">
                  <div className="flex gap-2">
                    <Select aria-label="Add a storage" value={addStore} onChange={(e) => setAddStore(e.target.value)}><option value="">Choose…</option>{data.candidates.storage.filter((s) => !storeIn.has(s)).map((s) => <option key={s} value={s}>{s}</option>)}</Select>
                    <Button disabled={!addStore} loading={change.isPending} onClick={() => change.mutate({ addStorage: [addStore] })}><Plus className="h-4 w-4" />Add</Button>
                  </div>
                </Field>
              </div>
            )}
          </>
        )}
        {confirm && live && (
          mapped ? <Notice tone="critical" title="This group can't be deleted">It is the resource group of {mapped.name}. Remove the organization's resources first.</Notice>
            : <Notice tone="critical" title={`Delete ${live.poolid}?`} action={<Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>Delete group</Button>}>{live.members.length ? "Proxmox only deletes empty groups. Remove its members first." : "Permissions given on it go with it."}</Notice>
        )}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

export function PoolsTab() {
  const q = useQuery({ queryKey: KEY, queryFn: access.pools.list, retry: 1 });
  const [editing, setEditing] = useState<string | "new" | null>(null);
  return (
    <QueryState query={q}>
      {q.data && (
        <>
          <SectionTitle action={q.data.canManage ? <Button variant="primary" onClick={() => setEditing("new")}><Plus className="h-4 w-4" />New resource group</Button> : undefined}>Resource groups</SectionTitle>
          {!q.data.canManage && <ReadOnlyNote what="manage resource groups" />}
          {q.data.pools.length === 0 ? (
            <EmptyState icon={<Boxes className="h-5 w-5" />} title="No resource groups" body="Create one, add machines and storage, then give a group or user a role on it." />
          ) : (
            <Table>
              <thead><tr className="border-b border-line"><Th>Group</Th><Th>Members</Th><Th>Comment</Th></tr></thead>
              <tbody>
                {q.data.pools.map((p) => (
                  <tr key={p.poolid} className="border-b border-line last:border-0 hover:bg-surface-2/50">
                    <Td>
                      <button className="font-medium text-left hover:underline font-mono text-compact" onClick={() => setEditing(p.poolid)}>{p.poolid}</button>{" "}
                      {p.organization ? <Chip tone="live">Organization: {p.organization.name}</Chip> : p.orgPool ? <Chip tone="warning">Organization pool, unused</Chip> : null}
                    </Td>
                    <Td className="text-ink-2">{plural(p.members.filter((m) => m.kind === "machine").length, "machine")}, {p.members.filter((m) => m.kind === "storage").length} storage</Td>
                    <Td className="text-ink-2">{p.comment ?? ""}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {editing && <PoolModal pool={editing === "new" ? null : (q.data.pools.find((p) => p.poolid === editing) ?? null)} data={q.data} onClose={() => setEditing(null)} />}
        </>
      )}
    </QueryState>
  );
}
