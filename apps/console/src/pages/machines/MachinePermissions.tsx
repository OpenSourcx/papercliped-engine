import { useState } from "react";
import { Key, Plus, Trash2, User, Users } from "lucide-react";
import { errorText, useGuestApi, type AclEntry, type GuestPermissions } from "../../data/engine/guestApi.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, Field, Input, Notice, SectionTitle, Segmented, Select } from "../../ui/primitives.tsx";
import { ConfirmTypeModal, Loading, useLoad } from "../disks/common.tsx";
import { Row } from "./MachineKit.tsx";

/** Who may use one machine: Proxmox access entries on /vms/<id>, plus what reaches it from above. Proxmox checks every change. */

const ICON = { user: <User className="h-4 w-4" />, group: <Users className="h-4 w-4" />, token: <Key className="h-4 w-4" /> };
const KIND = { user: "User", group: "Group", token: "API token" };

export function MachinePermissions({ vmid, name }: { vmid: number; name: string }) {
  const api = useGuestApi();
  const q = useLoad(() => api.permissions(vmid), [api, vmid]);
  const [add, setAdd] = useState(false);
  const [revoke, setRevoke] = useState<AclEntry | null>(null);
  const p = q.data;
  return (
    <div className="space-y-4 fade-in">
      <p className="text-compact text-ink-3">Who may see and use {name}. These are Proxmox access entries on <span className="font-mono">/vms/{vmid}</span>; they stack with what people get on the whole device or from a resource group.</p>
      {q.error && <p role="alert" className="text-compact text-critical">{q.error}</p>}
      {!p && !q.error && <Card><Loading label="Reading access" /></Card>}
      {p && (
        <>
          {!p.visible && <Notice>Your account can't list access entries. Ask an administrator, or sign in with an account that can.</Notice>}
          <Card className="p-5">
            <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => setAdd(true)} disabled={!p.canModify} title={p.canModify ? undefined : "Your account can't change who may use this machine (it needs Permissions.Modify)"}><Plus className="h-3.5 w-3.5" />Grant access</Button>}>On this machine</SectionTitle>
            {p.entries.length === 0 ? <p className="text-sm text-ink-3">Nothing is set on this machine itself. People get access from the device or its resource group.</p> : (
              <div className="divide-y divide-line">
                {p.entries.map((e) => (
                  <Row key={`${e.type}-${e.id}-${e.role}`}>
                    <span className="text-ink-3 shrink-0">{ICON[e.type]}</span>
                    <div className="flex-1 min-w-0 basis-44"><div className="text-sm font-mono truncate">{e.id}</div><div className="text-xs text-ink-3">{KIND[e.type]}</div></div>
                    <Chip>{e.role}</Chip>
                    <button onClick={() => setRevoke(e)} disabled={!p.canModify} aria-label={`Revoke ${e.role} from ${e.id}`} className="h-8 w-8 rounded-md inline-flex items-center justify-center text-ink-3 hover:text-critical hover:bg-critical/10 disabled:opacity-40"><Trash2 className="h-4 w-4" /></button>
                  </Row>
                ))}
              </div>
            )}
          </Card>
          {p.inherited.length > 0 && (
            <Card className="p-5">
              <SectionTitle>Reaches it from above</SectionTitle>
              <div className="divide-y divide-line">
                {p.inherited.map((e) => (
                  <Row key={`${e.path}-${e.type}-${e.id}-${e.role}`}>
                    <span className="text-ink-3 shrink-0">{ICON[e.type]}</span>
                    <div className="flex-1 min-w-0 basis-44"><div className="text-sm font-mono truncate">{e.id}</div><div className="text-xs text-ink-3">{KIND[e.type]} · set on <span className="font-mono">{e.path}</span></div></div>
                    <Chip>{e.role}</Chip>
                  </Row>
                ))}
              </div>
              <p className="text-xs text-ink-3 mt-3">Change these where they are set: Settings, Access.</p>
            </Card>
          )}
        </>
      )}
      {add && p && <GrantModal vmid={vmid} p={p} onClose={() => setAdd(false)} onDone={q.reload} />}
      {revoke && (
        <ConfirmTypeModal
          title={`Revoke ${revoke.role}?`}
          subtitle={<><span className="font-mono">{revoke.id}</span> loses the {revoke.role} role on {name}.</>}
          expected={revoke.id}
          actionLabel="Revoke access"
          onConfirm={(typed) => api.revoke(vmid, { type: revoke.type, id: revoke.id, role: revoke.role, confirm: typed })}
          onClose={() => setRevoke(null)}
          onDone={q.reload}
        />
      )}
    </div>
  );
}

function GrantModal({ vmid, p, onClose, onDone }: { vmid: number; p: GuestPermissions; onClose: () => void; onDone: () => void }) {
  const api = useGuestApi();
  const [type, setType] = useState<"user" | "group">("user");
  const [id, setId] = useState("");
  const [role, setRole] = useState(p.roles.includes("PVEVMUser") ? "PVEVMUser" : p.roles[0] ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const known = type === "user" ? p.users : p.groups;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.grant(vmid, { type, id: id.trim(), role, propagate: true });
      onDone();
      onClose();
    } catch (e) {
      setError(errorText(e, "Couldn't grant access"));
      setBusy(false);
    }
  };
  return (
    <Modal size="sm" icon={<Users className="h-5 w-5" />} title="Grant access" subtitle="Give a person or a group a role on this machine." onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} loading={busy} disabled={!id.trim() || !role}>Grant access</Button></>}>
      <div className="space-y-4">
        <Segmented size="sm" label="Who" value={type} onChange={(t) => { setType(t); setId(""); }} options={[{ value: "user", label: "A user" }, { value: "group", label: "A group" }]} />
        <Field label={type === "user" ? "User" : "Group"} htmlFor="acl-id" hint={type === "user" ? "Like name@pve or name@pam." : undefined}>
          {known.length > 0 ? (
            <Select id="acl-id" value={id} onChange={(e) => setId(e.target.value)}><option value="">Choose…</option>{known.map((k) => <option key={k} value={k}>{k}</option>)}</Select>
          ) : (
            <Input id="acl-id" value={id} onChange={(e) => setId(e.target.value)} placeholder={type === "user" ? "name@pve" : "group name"} className="font-mono" />
          )}
        </Field>
        <Field label="Role" htmlFor="acl-role" hint="PVEVMUser can use the machine; PVEVMAdmin can also change it; PVEAuditor can only look.">
          {p.roles.length > 0 ? <Select id="acl-role" value={role} onChange={(e) => setRole(e.target.value)}>{p.roles.map((r) => <option key={r}>{r}</option>)}</Select> : <Input id="acl-role" value={role} onChange={(e) => setRole(e.target.value)} placeholder="PVEVMUser" className="font-mono" />}
        </Field>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}
