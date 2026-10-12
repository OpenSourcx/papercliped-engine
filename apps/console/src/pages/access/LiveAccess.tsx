import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, Lock, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { errorText } from "../../data/engine/queries.ts";
import { iac, type DeviceRole, type IacOverview, type IacUser, type IacUserSpec, type OrgRole } from "../../data/engine/host.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, EmptyState, Input, PageFrame, PageHeader, Toggle } from "../../ui/primitives.tsx";

const select = "h-10 w-full rounded-lg bg-surface-2 border border-line px-3 text-[14px] outline-none focus:border-line-strong";

const DEVICE_LABEL: Record<DeviceRole | "custom", string> = { admin: "Administrator", operator: "Operator", viewer: "Viewer", none: "No device access", custom: "Custom (set in Proxmox)" };
const DEVICE_HELP: Record<DeviceRole, string> = {
  admin: "Full control of this device, in Proxmox and here. Can create organizations and manage people.",
  operator: "Sees everything, runs machines, uses storage. Can't change the device itself.",
  viewer: "Sees everything. Changes nothing.",
  none: "Sees only the organizations they're given below.",
};
const ORG_ROLES: { value: OrgRole | ""; label: string }[] = [
  { value: "", label: "No access" },
  { value: "viewer", label: "Viewer" },
  { value: "operator", label: "Operator" },
  { value: "admin", label: "Admin" },
  { value: "owner", label: "Owner" },
];

const KEY = ["iac"] as const;

function useIac() {
  return useQuery({ queryKey: KEY, queryFn: iac.get, retry: 1, refetchInterval: 60_000 });
}

function Warnings({ items }: { items: string[] }) {
  if (!items.length) return null;
  return <ul className="text-[13px] text-warning space-y-1 list-disc pl-5">{items.map((w, i) => <li key={i}>{w}</li>)}</ul>;
}

const roleOf = (u: IacUser | undefined, companyId: string): OrgRole | "" => (u?.orgs.find((o) => o.companyId === companyId)?.role as OrgRole | undefined) ?? "";

/** Create or edit a person. Changes go to Proxmox first, as you; the engine follows. */
function UserModal({ overview, user, onClose, onDone }: { overview: IacOverview; user: IacUser | null; onClose: () => void; onDone: (warnings: string[]) => void }) {
  const qc = useQueryClient();
  const creating = !user;
  const [userid, setUserid] = useState("");
  const [password, setPassword] = useState("");
  const [firstname, setFirstname] = useState(user?.name.split(" ")[0] ?? "");
  const [lastname, setLastname] = useState(user?.name.split(" ").slice(1).join(" ") ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [enabled, setEnabled] = useState(user?.enabled ?? true);
  const [deviceRole, setDeviceRole] = useState<DeviceRole | "custom">(user?.deviceRole ?? "none");
  const [orgRoles, setOrgRoles] = useState<Record<string, OrgRole | "">>(() => Object.fromEntries(overview.orgs.map((o) => [o.companyId, roleOf(user ?? undefined, o.companyId)])));
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typed, setTyped] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const orgs = overview.orgs.flatMap((o) => (orgRoles[o.companyId] ? [{ companyId: o.companyId, role: orgRoles[o.companyId] as OrgRole }] : []));
      const spec: IacUserSpec = { email: email.trim(), firstname: firstname.trim(), lastname: lastname.trim(), enable: enabled, orgs };
      if (deviceRole !== "custom") spec.deviceRole = deviceRole;
      if (creating) return iac.createUser({ ...spec, userid: userid.trim(), password });
      return iac.updateUser(user.userid, spec);
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: KEY });
      onDone(r.warnings);
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: () => iac.deleteUser(user!.userid),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: KEY });
      onDone(r.warnings);
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });

  const canSave = !save.isPending && (creating ? /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(userid.trim()) && password.length >= 8 : true);

  return (
    <Modal
      size="lg"
      icon={<ShieldCheck className="h-5 w-5" />}
      title={creating ? "New user" : user.name}
      subtitle={creating ? "Creates a Proxmox user. Their sign-in is their Proxmox account." : `${user.userid}${user.realmType ? ` · ${user.realmType} realm` : ""}`}
      onClose={onClose}
      footer={
        <>
          {!creating && !confirmDelete && <Button variant="ghost" className="mr-auto text-critical" onClick={() => setConfirmDelete(true)}><Trash2 className="h-4 w-4" />Delete user</Button>}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => save.mutate()} disabled={!canSave}>{save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}{creating ? "Create user" : "Save changes"}</Button>
        </>
      }
    >
      <div className="space-y-5">
        {creating && (
          <div className="grid sm:grid-cols-2 gap-4">
            <label className="block"><span className="block text-[13px] text-ink-2 mb-2">User name</span><Input value={userid} onChange={(e) => setUserid(e.target.value.toLowerCase())} placeholder="sam@pve" autoFocus spellCheck={false} className="font-mono" /><span className="block text-[12px] text-ink-3 mt-1.5">name@realm. {overview.realms.length ? `Realms here: ${overview.realms.map((r) => r.realm).join(", ")}.` : ""}</span></label>
            <label className="block"><span className="block text-[13px] text-ink-2 mb-2">Password</span><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /><span className="block text-[12px] text-ink-3 mt-1.5">At least 8 characters. Only used for the pve realm; other realms keep theirs.</span></label>
          </div>
        )}
        <div className="grid sm:grid-cols-3 gap-4">
          <label className="block"><span className="block text-[13px] text-ink-2 mb-2">First name</span><Input value={firstname} onChange={(e) => setFirstname(e.target.value)} /></label>
          <label className="block"><span className="block text-[13px] text-ink-2 mb-2">Last name</span><Input value={lastname} onChange={(e) => setLastname(e.target.value)} /></label>
          <label className="block"><span className="block text-[13px] text-ink-2 mb-2">Email</span><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        </div>
        <div className="flex items-center gap-3"><Toggle checked={enabled} onChange={setEnabled} label="Account enabled" /><span className="text-[13px] text-ink-2">{enabled ? "Account enabled" : "Account disabled: they're signed out and can't sign in"}</span></div>

        <label className="block">
          <span className="block text-[13px] text-ink-2 mb-2">Device access</span>
          <select className={select} value={deviceRole} onChange={(e) => setDeviceRole(e.target.value as DeviceRole)}>
            {deviceRole === "custom" && <option value="custom">{DEVICE_LABEL.custom}</option>}
            {(["admin", "operator", "viewer", "none"] as const).map((r) => <option key={r} value={r}>{DEVICE_LABEL[r]}</option>)}
          </select>
          <span className="block text-[12px] text-ink-3 mt-1.5">{deviceRole === "custom" ? "Their Proxmox permissions don't match a standard role, so they're left as they are. Choosing a role here replaces them." : DEVICE_HELP[deviceRole]}</span>
        </label>

        <div>
          <div className="text-[13px] text-ink-2 mb-2">Organizations</div>
          {overview.orgs.length === 0 ? (
            <p className="text-[13px] text-ink-3">There are no organizations yet.</p>
          ) : (
            <div className="rounded-lg border border-line divide-y divide-line">
              {overview.orgs.map((o) => (
                <div key={o.companyId} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1"><div className="text-[14px] truncate">{o.name}</div><div className="text-[12px] text-ink-3 font-mono truncate">{o.pool ? `pool ${o.pool}` : "no resource group yet"}</div></div>
                  <select className={`${select} !w-48`} value={orgRoles[o.companyId] ?? ""} onChange={(e) => setOrgRoles((r) => ({ ...r, [o.companyId]: e.target.value as OrgRole | "" }))} aria-label={`Role in ${o.name}`}>
                    {ORG_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                </div>
              ))}
            </div>
          )}
          <p className="text-[12px] text-ink-3 mt-2">An organization role also gives matching access to its machines in Proxmox, through the organization's resource group.</p>
        </div>

        {confirmDelete && user && (
          <div className="rounded-lg border border-critical/40 bg-critical/10 p-3 space-y-2">
            <p className="text-[13px]">This deletes <span className="font-mono">{user.userid}</span> from Proxmox, removes them from every organization and signs them out. It can't be undone.</p>
            <div className="flex gap-2">
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={`Type ${user.userid} to confirm`} className="font-mono" spellCheck={false} />
              <Button variant="danger" disabled={typed !== user.userid || remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}Delete</Button>
            </div>
          </div>
        )}
        {error && <p role="alert" className="text-[13px] text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function PasswordModal({ user, onClose }: { user: IacUser; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [mine, setMine] = useState("");
  const [error, setError] = useState<string | null>(null);
  const set = useMutation({ mutationFn: () => iac.setPassword(user.userid, password, mine), onSuccess: onClose, onError: (e) => setError(errorText(e)) });
  return (
    <Modal size="sm" icon={<KeyRound className="h-5 w-5" />} title={`New password for ${user.name}`} subtitle="Proxmox asks for your own password to confirm." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={password.length < 8 || !mine || set.isPending} onClick={() => set.mutate()}>{set.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Set password</Button></>}>
      <div className="space-y-4">
        <label className="block"><span className="block text-[13px] text-ink-2 mb-2">New password</span><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="new-password" /></label>
        <label className="block"><span className="block text-[13px] text-ink-2 mb-2">Your password</span><Input type="password" value={mine} onChange={(e) => setMine(e.target.value)} autoComplete="current-password" /></label>
        {error && <p role="alert" className="text-[13px] text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

const orgName = (o: IacOverview, id: string) => o.orgs.find((x) => x.companyId === id)?.name ?? "Unknown organization";

/** Access control on a live device: every row is a real Proxmox user. */
export function LiveAccess() {
  const q = useIac();
  const [editing, setEditing] = useState<IacUser | "new" | null>(null);
  const [password, setPassword] = useState<IacUser | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const data = q.data;

  return (
    <PageFrame width="6xl">
      <PageHeader
        title="Access control"
        subtitle="Integrated Access Control: people here are real Proxmox users, and what they can do is Proxmox permissions. A change made here is made in Proxmox first, as you, and Proxmox decides whether it's allowed."
        actions={data?.canManageUsers ? <Button variant="primary" onClick={() => setEditing("new")}><UserPlus className="h-4 w-4" />New user</Button> : undefined}
      />
      {q.isPending && <div className="py-16 grid place-items-center text-ink-3"><Loader2 className="h-5 w-5 animate-spin" /></div>}
      {q.error && <p role="alert" className="text-[14px] text-critical">{errorText(q.error)}</p>}
      {data && (
        <>
          {!data.canManageUsers && <p className="text-[13px] text-ink-3 mb-4 flex items-center gap-2"><Lock className="h-4 w-4" />Your Proxmox account can't manage users, so this list is read-only.</p>}
          <Warnings items={[...data.warnings, ...notes]} />
          {data.users.length === 0 ? (
            <EmptyState icon={<ShieldCheck className="h-5 w-5" />} title="No users" body="Proxmox didn't list any users for your account." />
          ) : (
            <Card className="overflow-x-auto mt-3">
              <table className="w-full text-[14px] min-w-[760px]">
                <thead>
                  <tr className="text-[12px] text-ink-3 border-b border-line text-left">
                    <th className="font-normal px-5 h-11">User</th>
                    <th className="font-normal px-3">Device access</th>
                    <th className="font-normal px-3">Organizations</th>
                    <th className="font-normal px-3">Status</th>
                    <th className="px-3 w-10" />
                  </tr>
                </thead>
                <tbody>
                  {data.users.map((u) => (
                    <tr key={u.userid} className="border-b border-line last:border-0 hover:bg-surface-2/50">
                      <td className="px-5 py-3"><button className="text-left" onClick={() => data.canManageUsers && setEditing(u)} disabled={!data.canManageUsers}><div className="font-medium">{u.name}</div><div className="text-[12px] text-ink-3 font-mono">{u.userid}</div></button></td>
                      <td className="px-3"><Chip tone={u.deviceRole === "admin" ? "accent" : u.deviceRole === "custom" ? "warning" : "neutral"}>{DEVICE_LABEL[u.deviceRole]}</Chip></td>
                      <td className="px-3"><div className="flex flex-wrap gap-1.5">{u.orgs.length ? u.orgs.map((o) => <Chip key={o.companyId}>{orgName(data, o.companyId)} · {o.role}</Chip>) : <span className="text-[13px] text-ink-3">None</span>}</div></td>
                      <td className="px-3 text-[13px] text-ink-2">{u.enabled ? "Active" : "Disabled"}{u.expire ? ` · expires ${new Date(u.expire * 1000).toLocaleDateString()}` : ""}</td>
                      <td className="px-3">{data.canManageUsers && u.realmType === "pve" && <Button variant="ghost" size="sm" onClick={() => setPassword(u)} title="Set password"><KeyRound className="h-4 w-4" /></Button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          <p className="text-[12px] text-ink-3 mt-4">Device access uses Proxmox's built-in roles (Administrator, or Auditor with VM and storage rights). Anything else set in Proxmox is shown as Custom and left alone.</p>
        </>
      )}
      {editing && data && <UserModal overview={data} user={editing === "new" ? null : editing} onClose={() => setEditing(null)} onDone={setNotes} />}
      {password && <PasswordModal user={password} onClose={() => setPassword(null)} />}
    </PageFrame>
  );
}
