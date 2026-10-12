import { useState } from "react";
import { ArrowLeftRight, Check, KeyRound, ShieldCheck, ShieldX, UserPlus } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import { Modal } from "../ui/Modal.tsx";
import type { Role, User } from "../data/types.ts";
import { cn } from "../lib/storage.ts";
import { Avatar, Button, Card, Chip, PageHeader, Segmented, Status, PageFrame } from "../ui/primitives.tsx";

const TOOLS: [string, string][] = [
  ["tasks", "Create and work on tasks"],
  ["agents.read", "See agents and runs"],
  ["agents.manage", "Hire, pause and configure agents"],
  ["guests.console", "Open container consoles"],
  ["guests.power", "Start and stop guests"],
  ["automations", "Create automations"],
  ["pin", "Talk to Pin"],
];
const ROLES: Role[] = ["owner", "admin", "member", "viewer"];

function Check2({ on, onClick, label, disabled }: { on: boolean; onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} role="checkbox" aria-checked={on} aria-label={label} className={cn("h-5 w-5 rounded-md border flex items-center justify-center shrink-0 transition disabled:opacity-40", on ? "bg-accent border-accent text-primary-ink" : "border-line-strong hover:border-ink-3")}>
      {on && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
    </button>
  );
}

function UserPanel({ user, onClose }: { user: User; onClose: () => void }) {
  const { data, updateUser } = useEngine();
  const all = user.tools.includes("*");
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const owner = user.role === "owner";
  return (
    <Modal title={user.name} subtitle={user.email} icon={<Avatar name={user.name} hue={210} size={40} />} onClose={onClose}>
      <div className="space-y-6">
          <div className="rounded-xl border border-line bg-surface-2/50 p-3.5 flex items-center gap-3">
            <ArrowLeftRight className="h-4 w-4 text-ink-3" />
            <div className="flex-1 text-compact">
              <div>Proxmox user <span className="font-mono">{user.pveUser}</span></div>
              <div className="text-ink-3">{user.synced ? "In sync. Changes here apply to the Proxmox console too." : "Not synced yet. It will be created on the next sync."}</div>
            </div>
            {user.synced ? <Status kind="good" label="Synced" /> : <Status kind="warning" label="Pending" />}
          </div>

          <div>
            <div className="text-compact font-medium mb-2">Role</div>
            <Segmented value={user.role} onChange={(r) => updateUser(user.id, { role: r })} options={ROLES.map((r) => ({ value: r, label: r[0].toUpperCase() + r.slice(1) }))} />
          </div>

          <div>
            <div className="text-compact font-medium mb-2">Organizations</div>
            <div className="space-y-2">
              {data.orgs.map((o) => {
                const m = user.orgs.find((x) => x.slug === o.slug);
                return (
                  <div key={o.slug} className="flex items-center gap-3">
                    <Check2 label={`Access to ${o.name}`} on={!!m} disabled={owner} onClick={() => updateUser(user.id, { orgs: m ? user.orgs.filter((x) => x.slug !== o.slug) : [...user.orgs, { slug: o.slug, role: "member" }] })} />
                    <Avatar name={o.name} hue={o.hue} size={22} />
                    <span className="flex-1 text-sm truncate">{o.name}</span>
                    {m && (
                      <select value={m.role} disabled={owner} onChange={(e) => updateUser(user.id, { orgs: user.orgs.map((x) => (x.slug === o.slug ? { ...x, role: e.target.value as Role } : x)) })} className="bg-surface-2 border border-line rounded-md h-7 text-xs px-1.5" aria-label={`Role in ${o.name}`}>
                        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <div className="text-compact font-medium mb-2">Tools</div>
            {all ? <p className="text-compact text-ink-3">Owners can use every tool.</p> : (
              <div className="space-y-2">
                {TOOLS.map(([id, label]) => (
                  <label key={id} className="flex items-center gap-3 text-sm">
                    <Check2 label={label} on={user.tools.includes(id)} onClick={() => updateUser(user.id, { tools: toggle(user.tools, id) })} />
                    <span className="flex-1">{label}</span>
                    <span className="font-mono text-micro text-ink-3">{id}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="text-compact font-medium mb-2">Connectors</div>
            <div className="flex flex-wrap gap-2">
              {data.connectors.map((c) => {
                const on = user.connectors.includes("*") || user.connectors.includes(c.id);
                return (
                  <button key={c.id} disabled={owner} onClick={() => updateUser(user.id, { connectors: toggle(user.connectors, c.id) })} aria-pressed={on} className={cn("h-8 px-3 rounded-full border text-compact transition disabled:opacity-60", on ? "bg-accent-soft border-accent/40 text-ink" : "border-line text-ink-3 hover:text-ink-2")}>
                    {on && <Check className="inline h-3.5 w-3.5 mr-1" />}{c.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="text-compact font-medium mb-2">Policies</div>
            <div className="space-y-2">
              {data.policies.map((p) => (
                <label key={p.id} className="flex items-start gap-3">
                  <Check2 label={p.name} on={user.policies.includes(p.id)} onClick={() => updateUser(user.id, { policies: toggle(user.policies, p.id) })} />
                  <span className="text-sm -mt-0.5">{p.name} <span className="block text-xs text-ink-3">{p.description}</span></span>
                </label>
              ))}
            </div>
          </div>
      </div>
    </Modal>
  );
}

export function Access() {
  const { data } = useEngine();
  const [tab, setTab] = useState<"users" | "policies">("users");
  const [open, setOpen] = useState<string | null>(null);
  const user = data.users.find((u) => u.id === open);
  const pending = data.users.filter((u) => !u.synced).length;

  return (
    <PageFrame width="6xl">
      <PageHeader
        title="Access control"
        subtitle="Integrated Access Control keeps ePaperclip and Proxmox in step: every user here is also a real Proxmox user, and the policies you set apply in both."
        actions={<Button variant="primary" disabled title="Invites arrive with the access-control backend"><UserPlus className="h-4 w-4" />Invite user</Button>}
      />
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <Segmented value={tab} onChange={setTab} options={[{ value: "users", label: `Users (${data.users.length})` }, { value: "policies", label: `Policies (${data.policies.length})` }]} />
        <div className="text-compact text-ink-3 flex items-center gap-2">
          <ArrowLeftRight className="h-3.5 w-3.5" />{pending ? `${pending} user waiting to sync to Proxmox` : "All users synced with Proxmox"}
        </div>
      </div>

      {tab === "users" ? (
        <Card className="overflow-hidden">
          <div className="hidden md:grid grid-cols-[1.6fr_1.2fr_0.8fr_1.4fr_0.6fr] gap-4 px-5 h-10 items-center text-xs text-ink-3 border-b border-line">
            <span>User</span><span>Proxmox user</span><span>Role</span><span>Organizations</span><span>2FA</span>
          </div>
          {data.users.map((u) => (
            <button key={u.id} onClick={() => setOpen(u.id)} className="w-full text-left grid grid-cols-1 md:grid-cols-[1.6fr_1.2fr_0.8fr_1.4fr_0.6fr] gap-2 md:gap-4 px-5 py-3.5 items-center border-b border-line last:border-0 hover:bg-surface-2/60 transition">
              <span className="flex items-center gap-3 min-w-0">
                <Avatar name={u.name} hue={210} size={32} />
                <span className="min-w-0"><span className="block text-sm font-medium truncate">{u.name}</span><span className="block text-xs text-ink-3 truncate">{u.email}</span></span>
              </span>
              <span className="flex items-center gap-2 text-compact"><span className="font-mono text-ink-2">{u.pveUser}</span>{u.synced ? <Status kind="good" label="Synced" /> : <Status kind="warning" label="Pending" />}</span>
              <span className="text-compact capitalize text-ink-2">{u.role}</span>
              <span className="flex flex-wrap gap-1">{u.orgs.length ? u.orgs.map((o) => <Chip key={o.slug}>{data.orgs.find((x) => x.slug === o.slug)?.name ?? o.slug}</Chip>) : <span className="text-compact text-ink-3">None</span>}</span>
              <span>{u.twoFactor ? <Status kind="good" label="On" /> : <Status kind="warning" label="Off" />}</span>
            </button>
          ))}
        </Card>
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {data.policies.map((p) => (
            <Card key={p.id} className="p-5">
              <div className="flex items-center gap-2">
                {p.effect === "allow" ? <ShieldCheck className="h-4 w-4 text-good" /> : <ShieldX className="h-4 w-4 text-critical" />}
                <span className="font-medium">{p.name}</span>
                <Chip>{p.effect === "allow" ? "Allow" : "Deny"}</Chip>
              </div>
              <p className="text-compact text-ink-2 mt-1.5">{p.description}</p>
              <div className="mt-3 grid gap-1 text-xs font-mono text-ink-3">
                <span>actions: {p.actions.join(", ")}</span>
                <span>resources: {p.resources.join(", ")}</span>
              </div>
              <div className="mt-3 text-xs text-ink-3 flex items-center gap-1.5"><KeyRound className="h-3.5 w-3.5" />Applied to {data.users.filter((u) => u.policies.includes(p.id)).length} users · mirrored as a Proxmox role</div>
            </Card>
          ))}
        </div>
      )}
      {user && <UserPanel user={user} onClose={() => setOpen(null)} />}
    </PageFrame>
  );
}
