import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ToolConnection } from "@papercliped-engine/engine-client";
import { connectApi } from "../../../data/engine/connectApi.ts";
import { engine } from "../../../data/engine/queries.ts";
import { Modal } from "../../../ui/Modal.tsx";
import { Button, Card, Field, Notice, Select } from "../../../ui/primitives.tsx";
import { ActionError, LoadError, Loading } from "./common.tsx";

type Mode = "off" | "ask" | "allow";

/** Pin's own access to this organization's apps. Pin runs on the host and takes no worker or container; the engine decides every call. */
export function PinAppAccess({ companyId, connections, canManage }: { companyId: string; connections: ToolConnection[]; canManage: boolean }) {
  const qc = useQueryClient();
  const key = ["pin-apps", companyId];
  const access = useQuery({ queryKey: key, queryFn: () => connectApi.pinApps.get(companyId) });
  const done = () => void qc.invalidateQueries({ queryKey: key });
  const enable = useMutation({ mutationFn: () => connectApi.pinApps.enable(companyId), onSuccess: done });
  const revoke = useMutation({ mutationFn: () => connectApi.pinApps.revoke(companyId), onSuccess: () => { setRevoking(false); done(); } });
  const [editing, setEditing] = useState<ToolConnection | null>(null);
  const [revoking, setRevoking] = useState(false);
  const data = access.data;
  return <Card className="mt-6 p-5">
    <h3 className="font-medium">Pin</h3>
    <p className="mt-1 text-compact text-ink-3">Let Pin use this organization’s apps. Pin stays on the host and uses none of the organization’s machines. Everything starts Off; the engine’s policy and approvals decide each call, and Pin cannot approve anything.</p>
    {access.isPending && <Loading />}
    {access.error && <LoadError error={access.error} retry={() => void access.refetch()} />}
    {data && !data.enabled && <div className="mt-3"><Button variant="primary" disabled={!canManage} loading={enable.isPending} onClick={() => enable.mutate()}>Let Pin use apps here</Button></div>}
    {data?.enabled && <div className="mt-3 space-y-2">
      {connections.length === 0 && <p className="text-compact text-ink-3">Connect an app first.</p>}
      {connections.map((c) => { const mine = data.entries.filter((e) => e.connectionId === c.id); return <div key={c.id} className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1 basis-40 truncate">{c.name}</div><span className="text-xs text-ink-3">{mine.length ? `${mine.filter((e) => e.mode === "allow").length} allowed, ${mine.filter((e) => e.mode === "ask").length} ask first` : "Off"}</span><Button disabled={!canManage} onClick={() => setEditing(c)}>Set Pin access</Button></div>; })}
      <Button variant="ghost" disabled={!canManage} onClick={() => setRevoking(true)}>Revoke Pin’s access</Button>
    </div>}
    <ActionError error={enable.error} />
    {editing && data && <PinReview companyId={companyId} connection={editing} entries={data.entries.filter((e) => e.connectionId === editing.id)} onClose={() => { setEditing(null); done(); }} />}
    {revoking && <Modal title="Revoke Pin’s access?" onClose={() => setRevoking(false)} footer={<><Button onClick={() => setRevoking(false)}>Cancel</Button><Button variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate()}>Revoke</Button></>}><p className="text-sm text-ink-2">Pin loses every app action at once. You can allow actions again later.</p><ActionError error={revoke.error} /></Modal>}
  </Card>;
}

function PinReview({ companyId, connection, entries, onClose }: { companyId: string; connection: ToolConnection; entries: { catalogEntryId: string; mode: "ask" | "allow" }[]; onClose: () => void }) {
  const catalog = useQuery({ queryKey: ["engine", "connection", connection.id, "pin-catalog"], queryFn: () => engine.apps.catalog(connection.id) });
  const [edits, setEdits] = useState<Record<string, Mode>>({});
  const current = (id: string): Mode => edits[id] ?? entries.find((e) => e.catalogEntryId === id)?.mode ?? "off";
  const save = useMutation({ mutationFn: () => connectApi.pinApps.set(companyId, connection.id, (catalog.data?.catalog ?? []).map((e) => ({ catalogEntryId: e.id, mode: current(e.id) }))), onSuccess: onClose });
  return <Modal title={`Pin access to ${connection.name}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!catalog.data} onClick={() => save.mutate()}>Save</Button></>}>
    <div className="space-y-4"><Notice tone="info">Choose what Pin may do. “Ask for approval” holds each call until a person approves it in the engine.</Notice>
      {catalog.isPending && <Loading />}{catalog.error && <LoadError error={catalog.error} retry={() => void catalog.refetch()} />}
      {catalog.data?.catalog.map((e) => <Field key={e.id} label={e.title ?? e.toolName} htmlFor={`pin-${e.id}`} hint={e.status === "disabled" ? "Unavailable at the provider" : e.isDestructive ? "Destructive action" : e.isReadOnly ? "Read only" : "Can change provider data"}>
        <Select id={`pin-${e.id}`} value={current(e.id)} disabled={e.status === "disabled"} onChange={(ev) => setEdits({ ...edits, [e.id]: ev.target.value as Mode })}><option value="off">Off</option><option value="ask">Ask for approval</option><option value="allow">Allow</option></Select></Field>)}
      <ActionError error={save.error} /></div>
  </Modal>;
}
