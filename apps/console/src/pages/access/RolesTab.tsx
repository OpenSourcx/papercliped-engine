import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { access, type Acl, type Privilege, type Role } from "../../data/engine/access.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Chip, EmptyState, Input, Notice, SectionTitle, Segmented, Select, Toggle } from "../../ui/primitives.tsx";
import { QueryState, ReadOnlyNote, Table, Td, Th, plural, useIac, AField as Field } from "./shared.tsx";

const ROLES_KEY = ["access", "roles"] as const;
const ACL_KEY = ["access", "acl"] as const;

const groupPrivileges = (privs: Privilege[]) => {
  const out = new Map<string, Privilege[]>();
  for (const p of privs) out.set(p.group, [...(out.get(p.group) ?? []), p]);
  return [...out];
};

function PrivilegePicker({ privileges, value, onChange, readOnly }: { privileges: Privilege[]; value: string[]; onChange?: (v: string[]) => void; readOnly?: boolean }) {
  return (
    <div className="space-y-4 max-h-96 overflow-y-auto overflow-x-hidden pr-1">
      {groupPrivileges(privileges).map(([group, list]) => (
        <fieldset key={group}>
          <legend className="text-xs font-semibold uppercase tracking-label text-ink-3 mb-1.5">{group}</legend>
          <div className="rounded-lg border border-line divide-y divide-line">
            {list.map((p) => (
              <label key={p.name} className="flex items-start gap-3 px-3 py-2 text-sm">
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-(--accent)" disabled={readOnly} checked={value.includes(p.name)} onChange={(e) => onChange?.(e.target.checked ? [...value, p.name] : value.filter((x) => x !== p.name))} />
                <span className="min-w-0"><span className="font-mono text-compact">{p.name}</span><span className="block text-xs text-ink-3">{p.description}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

function RoleModal({ role, privileges, canManage, onClose }: { role: Role | null; privileges: Privilege[]; canManage: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const creating = !role;
  const readOnly = !canManage || (role?.builtin ?? false);
  const [roleid, setRoleid] = useState("");
  const [privs, setPrivs] = useState<string[]>(role?.privileges ?? []);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [inUse, setInUse] = useState<string | null>(null);
  const done = () => {
    qc.invalidateQueries({ queryKey: ROLES_KEY });
    qc.invalidateQueries({ queryKey: ACL_KEY });
    onClose();
  };
  const save = useMutation({ mutationFn: () => (creating ? access.roles.create(roleid.trim(), privs) : access.roles.update(role.roleid, privs)), onSuccess: done, onError: (e) => setError(errorText(e)) });
  const remove = useMutation({
    mutationFn: (removeAcls: boolean) => access.roles.remove(role!.roleid, removeAcls),
    onSuccess: done,
    onError: (e: unknown) => ((e as { code?: string }).code === "role_in_use" ? setInUse(errorText(e)) : setError(errorText(e))),
  });
  return (
    <Modal
      size="lg"
      icon={<ShieldCheck className="h-5 w-5" />}
      title={creating ? "New role" : role.roleid}
      subtitle={role?.builtin ? "Built-in roles are part of Proxmox and can't be changed. Create a custom role to adjust one." : "A role is a set of privileges. Give it to a user, group or API token on a path."}
      onClose={onClose}
      footer={
        <>
          {!creating && !role.builtin && canManage && !confirm && <Button variant="ghost" className="mr-auto text-critical" onClick={() => setConfirm(true)}><Trash2 className="h-4 w-4" />Delete role</Button>}
          <Button variant="ghost" onClick={onClose}>{readOnly ? "Close" : "Cancel"}</Button>
          {!readOnly && <Button variant="primary" loading={save.isPending} disabled={creating && !/^[A-Za-z][A-Za-z0-9._-]{1,63}$/.test(roleid.trim())} onClick={() => save.mutate()}>{creating ? "Create role" : "Save role"}</Button>}
        </>
      }
    >
      <div className="space-y-4">
        {creating && <Field label="Role name" hint="Starts with a letter. Letters, digits, . _ and -"><Input value={roleid} onChange={(e) => setRoleid(e.target.value)} className="font-mono" autoFocus spellCheck={false} /></Field>}
        <PrivilegePicker privileges={privileges} value={privs} onChange={setPrivs} readOnly={readOnly} />
        {confirm && (
          <Notice tone="critical" title={`Delete ${role?.roleid}?`} action={<Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate(false)}>Delete role</Button>}>
            {inUse ?? "Anyone holding this role through a permission loses it."}
            {inUse && <span className="block mt-2"><Button variant="danger" size="sm" loading={remove.isPending} onClick={() => remove.mutate(true)}>Remove those permissions and delete</Button></span>}
          </Notice>
        )}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function PathInput({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
  const q = useQuery({ queryKey: ["access", "paths"], queryFn: access.acl.paths, staleTime: 60_000, retry: 0 });
  return (
    <>
      <Input id={id} list={`${id}-list`} value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder="/vms/100" className="font-mono" spellCheck={false} autoComplete="off" />
      <datalist id={`${id}-list`}>{(q.data?.paths ?? []).map((p) => <option key={p.path} value={p.path}>{p.label}</option>)}</datalist>
    </>
  );
}

const PATH_OK = /^\/([A-Za-z0-9._:-]+(\/[A-Za-z0-9._:-]+){0,5})?$/;
const TOKEN_OK = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*![A-Za-z][A-Za-z0-9._-]+$/;

function AddAclModal({ roles, onClose, initial }: { roles: Role[]; onClose: () => void; initial?: { type?: "user" | "group" | "token"; ugid?: string; path?: string } }) {
  const qc = useQueryClient();
  const iacQ = useIac();
  const groupsQ = useQuery({ queryKey: ["access", "groups"], queryFn: access.groups.list, retry: 0 });
  const [path, setPath] = useState(initial?.path ?? "/");
  const [type, setType] = useState<"user" | "group" | "token">(initial?.type ?? "user");
  const [ugid, setUgid] = useState(initial?.ugid ?? "");
  const [role, setRole] = useState("PVEAuditor");
  const [propagate, setPropagate] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const subjects = type === "user" ? (iacQ.data?.users ?? []).map((u) => u.userid) : type === "group" ? (groupsQ.data?.groups ?? []).map((g) => g.groupid) : [];
  const valid = PATH_OK.test(path) && role && (type === "token" ? TOKEN_OK.test(ugid) : ugid !== "");
  const add = useMutation({
    mutationFn: () => access.acl.set({ path, roles: [role], propagate, [type === "user" ? "users" : type === "group" ? "groups" : "tokens"]: [ugid] }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ACL_KEY });
      qc.invalidateQueries({ queryKey: IAC_QUERY });
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal size="md" title="Add permission" subtitle="Gives a user, group or API token a role on a path." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={add.isPending} disabled={!valid} onClick={() => add.mutate()}>Add permission</Button></>}>
      <div className="space-y-4">
        <Field label="Path" hint="/ is everything. /vms/100 is one machine, /storage/local one storage, /pool/team one resource group."><PathInput id="acl-path" value={path} onChange={setPath} /></Field>
        <div className="grid sm:grid-cols-[10rem_1fr] gap-4">
          <Field label="Applies to"><Select value={type} onChange={(e) => { setType(e.target.value as typeof type); setUgid(""); }}><option value="user">User</option><option value="group">Group</option><option value="token">API token</option></Select></Field>
          <Field label={type === "token" ? "API token" : type === "group" ? "Group" : "User"} hint={type === "token" ? "Written as user@realm!tokenname" : undefined}>
            {type === "token" ? <Input value={ugid} onChange={(e) => setUgid(e.target.value.trim())} className="font-mono" placeholder="sam@pve!ci" spellCheck={false} /> : (
              <Select value={ugid} onChange={(e) => setUgid(e.target.value)}><option value="">Choose…</option>{subjects.map((s) => <option key={s} value={s}>{s}</option>)}</Select>
            )}
          </Field>
        </div>
        <Field label="Role"><Select value={role} onChange={(e) => setRole(e.target.value)}>{roles.map((r) => <option key={r.roleid} value={r.roleid}>{r.roleid}{r.builtin ? "" : " (custom)"}</option>)}</Select></Field>
        <div className="flex items-center gap-3"><Toggle checked={propagate} onChange={setPropagate} label="Applies below this path" /><span className="text-compact text-ink-2">{propagate ? "Applies to everything below this path too" : "Applies to this path only"}</span></div>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}
const IAC_QUERY = ["iac"] as const;

function AclTable({ roles }: { roles: Role[] }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ACL_KEY, queryFn: access.acl.list, retry: 1 });
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState({ text: "", type: "", role: "", custom: false });
  const [removing, setRemoving] = useState<Acl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (a: Acl) => access.acl.set({ path: a.path, roles: [a.roleid], [a.type === "user" ? "users" : a.type === "group" ? "groups" : "tokens"]: [a.ugid], remove: true }),
    onSuccess: () => {
      setRemoving(null);
      qc.invalidateQueries({ queryKey: ACL_KEY });
      qc.invalidateQueries({ queryKey: IAC_QUERY });
    },
    onError: (e) => setError(errorText(e)),
  });
  const rows = useMemo(() => {
    const t = filter.text.trim().toLowerCase();
    return (q.data?.acls ?? []).filter((a) => (!t || `${a.path} ${a.ugid}`.toLowerCase().includes(t)) && (!filter.type || a.type === filter.type) && (!filter.role || a.roleid === filter.role) && (!filter.custom || !a.preset));
  }, [q.data, filter]);
  return (
    <QueryState query={q}>
      {q.data && (
        <>
          <SectionTitle action={q.data.canModify ? <Button variant="primary" onClick={() => setAdding(true)}><Plus className="h-4 w-4" />Add permission</Button> : undefined}>Permissions</SectionTitle>
          {!q.data.canModify && <ReadOnlyNote what="change permissions" />}
          <div className="grid sm:grid-cols-[1fr_9rem_12rem_auto] gap-3 mb-3 items-end">
            <Field label="Search"><Input value={filter.text} onChange={(e) => setFilter({ ...filter, text: e.target.value })} placeholder="Path, user or group" /></Field>
            <Field label="Type"><Select value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value })}><option value="">All</option><option value="user">Users</option><option value="group">Groups</option><option value="token">API tokens</option></Select></Field>
            <Field label="Role"><Select value={filter.role} onChange={(e) => setFilter({ ...filter, role: e.target.value })}><option value="">All roles</option>{roles.map((r) => <option key={r.roleid} value={r.roleid}>{r.roleid}</option>)}</Select></Field>
            <label className="flex items-center gap-2 text-compact text-ink-2 h-10"><input type="checkbox" className="h-4 w-4 accent-(--accent)" checked={filter.custom} onChange={(e) => setFilter({ ...filter, custom: e.target.checked })} />Only ones set by hand</label>
          </div>
          {error && <p role="alert" className="text-compact text-critical mb-2">{error}</p>}
          {rows.length === 0 ? (
            <EmptyState icon={<Lock className="h-5 w-5" />} title="No permissions match" body="Add a permission to give a user, group or API token a role on a path." />
          ) : (
            <Table min="min-w-[760px]">
              <thead><tr className="border-b border-line"><Th>Path</Th><Th>Who</Th><Th>Role</Th><Th>Applies below</Th><Th>Set by</Th><Th /></tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={`${a.path}|${a.type}|${a.ugid}|${a.roleid}`} className="border-b border-line last:border-0 hover:bg-surface-2/50">
                    <Td className="font-mono text-compact">{a.path}</Td>
                    <Td><span className="font-mono text-compact">{a.ugid}</span> <Chip>{a.type === "token" ? "API token" : a.type}</Chip></Td>
                    <Td><Chip tone="accent">{a.roleid}</Chip></Td>
                    <Td className="text-ink-2">{a.propagate ? "Yes" : "No"}</Td>
                    <Td className="text-compact text-ink-3">{a.preset ?? "Set by hand"}</Td>
                    <Td className="text-right">
                      {q.data.canModify && (removing === a ? <Button size="sm" variant="danger" loading={remove.isPending} onClick={() => remove.mutate(a)}>Remove</Button> : <Button size="sm" variant="ghost" aria-label={`Remove ${a.roleid} for ${a.ugid} on ${a.path}`} onClick={() => setRemoving(a)}><Trash2 className="h-4 w-4" /></Button>)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <p className="text-xs text-ink-3 mt-3">Device and organization roles are presets made of these permissions. They show up here too, marked, and anything you add by hand is left alone by them.</p>
        </>
      )}
      {adding && <AddAclModal roles={roles} onClose={() => setAdding(false)} />}
    </QueryState>
  );
}

function Inspector({ privileges }: { privileges: Privilege[] }) {
  const iacQ = useIac();
  const [who, setWho] = useState("");
  const [path, setPath] = useState("/");
  const [asked, setAsked] = useState<{ who: string; path: string } | null>(null);
  const q = useQuery({ queryKey: ["access", "permissions", asked?.who, asked?.path], queryFn: () => access.acl.permissions(asked!.who, asked!.path), enabled: !!asked, retry: 0 });
  const granted = new Set(Object.entries(q.data?.permissions?.[asked?.path ?? ""] ?? {}).filter(([, v]) => v === 1).map(([k]) => k));
  const valid = (who !== "") && PATH_OK.test(path);
  return (
    <div>
      <SectionTitle>Check access</SectionTitle>
      <p className="text-compact text-ink-2 mb-3 max-w-2xl">See exactly what a user or API token can do on a path, after groups, roles and inheritance. This is what Proxmox itself computes.</p>
      <div className="grid sm:grid-cols-[1fr_1fr_auto] gap-3 items-end mb-4">
        <Field label="User or API token">
          <Input list="inspect-who" value={who} onChange={(e) => setWho(e.target.value.trim())} placeholder="sam@pve or sam@pve!ci" className="font-mono" spellCheck={false} />
          <datalist id="inspect-who">{(iacQ.data?.users ?? []).map((u) => <option key={u.userid} value={u.userid} />)}</datalist>
        </Field>
        <Field label="Path"><PathInput id="inspect-path" value={path} onChange={setPath} /></Field>
        <Button variant="primary" disabled={!valid} onClick={() => setAsked({ who, path })}>Check access</Button>
      </div>
      {asked && q.isPending && <p className="text-compact text-ink-3">Asking Proxmox…</p>}
      {q.error && <p role="alert" className="text-compact text-critical">{errorText(q.error)}</p>}
      {q.data && (
        granted.size === 0 ? (
          <Notice tone="warning" title={`${asked!.who} has no access on ${asked!.path}`}>Give them a role on this path, or on a path above it that applies below.</Notice>
        ) : (
          <div className="space-y-4">
            <p className="text-compact text-ink-2"><span className="font-mono">{asked!.who}</span> holds {plural(granted.size, "privilege")} on <span className="font-mono">{asked!.path}</span>.</p>
            {groupPrivileges(privileges).map(([group, list]) => {
              const have = list.filter((p) => granted.has(p.name));
              if (!have.length) return null;
              return (
                <div key={group}>
                  <div className="text-xs font-semibold uppercase tracking-label text-ink-3 mb-1.5">{group}</div>
                  <ul className="rounded-lg border border-line divide-y divide-line">{have.map((p) => <li key={p.name} className="px-3 py-2 text-sm"><span className="font-mono text-compact">{p.name}</span><span className="block text-xs text-ink-3">{p.description}</span></li>)}</ul>
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}

type View = "roles" | "permissions" | "check";

export function RolesTab() {
  const q = useQuery({ queryKey: ROLES_KEY, queryFn: access.roles.list, retry: 1 });
  const [view, setView] = useState<View>("permissions");
  const [editing, setEditing] = useState<Role | "new" | null>(null);
  return (
    <QueryState query={q}>
      {q.data && (
        <div className="space-y-5">
          <Segmented<View> label="Roles and permissions" value={view} onChange={setView} options={[{ value: "permissions", label: "Permissions" }, { value: "roles", label: "Roles" }, { value: "check", label: "Check access" }]} />
          {view === "permissions" && <AclTable roles={q.data.roles} />}
          {view === "check" && <Inspector privileges={q.data.privileges} />}
          {view === "roles" && (
            <>
              <SectionTitle action={q.data.canManage ? <Button variant="primary" onClick={() => setEditing("new")}><Plus className="h-4 w-4" />New role</Button> : undefined}>Roles</SectionTitle>
              {!q.data.canManage && <ReadOnlyNote what="create or change roles" />}
              <Table>
                <thead><tr className="border-b border-line"><Th>Role</Th><Th>Kind</Th><Th>Privileges</Th></tr></thead>
                <tbody>
                  {q.data.roles.map((r) => (
                    <tr key={r.roleid} className="border-b border-line last:border-0 hover:bg-surface-2/50">
                      <Td><button className="font-medium text-left hover:underline" onClick={() => setEditing(r)}>{r.roleid}</button></Td>
                      <Td><Chip tone={r.builtin ? "neutral" : "accent"}>{r.builtin ? "Built in" : "Custom"}</Chip></Td>
                      <Td className="text-ink-2">{plural(r.privileges.length, "privilege")}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
          )}
          {editing && <RoleModal role={editing === "new" ? null : editing} privileges={q.data.privileges} canManage={q.data.canManage} onClose={() => setEditing(null)} />}
        </div>
      )}
    </QueryState>
  );
}

export { AddAclModal };
