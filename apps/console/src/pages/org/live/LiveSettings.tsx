import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Archive, Users } from "lucide-react";
import { useEngine } from "../../../data/store.tsx";
import { dollars } from "../../../data/engine/map.ts";
import { useMembers, useOrg, useResourceGroup } from "../../../data/engine/queries.ts";
import { useOrgSettingsWrites } from "../../../data/engine/more.ts";
import { formatBytes } from "../../../lib/storage.ts";
import { Modal } from "../../../ui/Modal.tsx";
import { Avatar, Button, Card, Chip, Field, Input, Notice, PageFrame, PageHeader, SectionTitle, Textarea, Toggle } from "../../../ui/primitives.tsx";
import { ActionError, LoadError, Loading, useLiveOrg } from "./common.tsx";
import { memberName } from "./names.ts";

const ROLE: Record<string, string> = { owner: "Owner", admin: "Admin", operator: "Operator", viewer: "Viewer", member: "Member" };

export function LiveOrgSettings() {
  const { companyId, org } = useLiveOrg();
  const { setup } = useEngine();
  const navigate = useNavigate();
  const d = setup?.deviceName ?? "pve";
  const detail = useOrg(companyId);
  const members = useMembers(companyId);
  const rg = useResourceGroup(companyId);
  const w = useOrgSettingsWrites(companyId);
  const [name, setName] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [typed, setTyped] = useState("");
  const c = detail.data;
  const g = rg.group;
  const canManage = members.data?.access.canManageMembers ?? false;
  const nameValue = name ?? c?.name ?? org.name;
  const descValue = description ?? c?.description ?? "";
  const dirty = (name !== null && name.trim() !== (c?.name ?? "")) || (description !== null && description.trim() !== (c?.description ?? ""));
  const active = (members.data?.members ?? []).filter((m) => m.status === "active");
  const save = () => w.update.mutate({ ...(name !== null ? { name: name.trim() } : {}), ...(description !== null ? { description: description.trim() || null } : {}) }, { onSuccess: () => { setName(null); setDescription(null); } });
  const archive = () => w.archive.mutate(undefined, { onSuccess: () => navigate(`/${d}/home`, { replace: true }) });
  const toggleApproval = (v: boolean) => w.update.mutate({ requireBoardApprovalForNewAgents: v });
  return (
    <PageFrame width="3xl">
      <PageHeader title="Organization settings" subtitle={`How ${org.name} is named, funded and who can work in it.`} />
      {detail.isPending && <Card><Loading /></Card>}
      {detail.error && <Card><LoadError error={detail.error} retry={() => void detail.refetch()} /></Card>}
      {c && (
        <>
          <Card className="p-5 mb-6 space-y-4">
            <div className="flex items-center gap-3"><Avatar name={org.name} hue={org.hue} size={44} /><div className="min-w-0"><div className="font-medium truncate">{c.name}</div><div className="text-xs text-ink-3 font-mono">/{org.slug} · tasks are {c.issuePrefix}-1, {c.issuePrefix}-2…</div></div></div>
            <Field label="Name" htmlFor="os-name"><Input id="os-name" value={nameValue} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Description" htmlFor="os-desc" hint="What this organization is for. Agents read it as context."><Textarea id="os-desc" rows={3} value={descValue} onChange={(e) => setDescription(e.target.value)} /></Field>
            <p className="text-xs text-ink-3">The task prefix ({c.issuePrefix}) is fixed when an organization is created, and the engine has no logo or colour setting we can change from here.</p>
            <div className="flex justify-end gap-2"><Button variant="ghost" disabled={!dirty} onClick={() => { setName(null); setDescription(null); }}>Discard</Button><Button variant="primary" disabled={!dirty || !nameValue.trim()} loading={w.update.isPending && !w.update.variables?.requireBoardApprovalForNewAgents} onClick={save}>Save settings</Button></div>
            <ActionError error={w.update.error} />
          </Card>

          <SectionTitle>Spending and approvals</SectionTitle>
          <Card className="p-5 mb-6 space-y-3">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <div className="flex-1 min-w-48"><div className="font-medium">Monthly budget</div><div className="text-xs text-ink-3">{c.budgetMonthlyCents ? `${dollars(c.budgetMonthlyCents)} a month, ${dollars(c.spentMonthlyCents)} spent so far` : "No limit set"}</div></div>
              <Link to={`/${d}/${org.slug}/costs`} className="text-compact text-accent hover:underline">Change it in Costs</Link>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm border-t border-line pt-3">
              <div className="flex-1 min-w-48"><div className="font-medium">Approve new agents</div><div className="text-xs text-ink-3">When on, a hire waits for a person in Decisions before the agent can run.</div></div>
              <Toggle label="Require approval for new agents" checked={!!(c as { requireBoardApprovalForNewAgents?: boolean }).requireBoardApprovalForNewAgents} onChange={toggleApproval} />
            </div>
          </Card>

          <SectionTitle>Resources</SectionTitle>
          <Card className="p-5 mb-6">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-ink-3">Resource group</dt>
              <dd>{rg.isPending ? "…" : rg.error ? <span className="text-ink-3">Unknown</span> : g ? `${g.cores} cores · ${formatBytes(g.memoryMb * 1024 ** 2)} memory · ${g.diskGb} GB disk · up to ${g.maxGuests} containers (${g.pool})` : <span className="text-ink-3">No resource group yet</span>}</dd>
              <dt className="text-ink-3">Status</dt><dd className="capitalize">{c.status}</dd>
            </dl>
          </Card>

          <SectionTitle action={<Link to={`/${d}/${org.slug}/members`} className="text-compact text-accent hover:underline">All members</Link>}>Members</SectionTitle>
          <Card className="divide-y divide-line mb-3">
            {members.isPending && <Loading />}
            {members.error && <LoadError error={members.error} retry={() => void members.refetch()} />}
            {active.slice(0, 6).map((m) => {
              const n = memberName(m.user);
              return <div key={m.id} className="flex items-center gap-3 px-5 py-2.5"><Avatar name={n} hue={210} size={26} /><span className="flex-1 text-sm truncate">{n}</span><Chip>{(m.membershipRole && ROLE[m.membershipRole]) ?? "Member"}</Chip></div>;
            })}
            {members.data && active.length === 0 && <p className="px-5 py-4 text-sm text-ink-3">Nobody else has access yet.</p>}
          </Card>
          <Notice tone="info" className="mb-6" action={<Link to={`/${d}/home?settings=access`} className="text-compact text-accent hover:underline whitespace-nowrap"><Users className="h-3.5 w-3.5 inline mr-1" />Open Access</Link>}>
            Who can work in this organization is decided by Proxmox permissions on its resource group. Change it in Access, not here.
          </Notice>

          <SectionTitle>Danger zone</SectionTitle>
          <Card className="p-5 border-critical/30">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-48"><div className="text-sm font-medium">Archive this organization</div><div className="text-xs text-ink-3">Agents stop and it leaves the sidebar. Nothing is deleted.</div></div>
              <Button variant="danger" disabled={!canManage} title={canManage ? undefined : "Only an owner or administrator can archive an organization"} onClick={() => { setTyped(""); setArchiving(true); }}><Archive className="h-4 w-4" />Archive organization</Button>
            </div>
          </Card>
        </>
      )}
      {archiving && (
        <Modal title="Archive this organization" subtitle={org.name} size="sm" onClose={() => setArchiving(false)} footer={<><Button variant="ghost" onClick={() => setArchiving(false)}>Cancel</Button><Button variant="danger" disabled={typed.trim() !== org.name} loading={w.archive.isPending} onClick={archive}>Archive organization</Button></>}>
          <div className="space-y-3">
            <p className="text-sm text-ink-2">Its agents stop working and the organization disappears from the sidebar. Its data stays in the engine.</p>
            <Field label={`Type ${org.name} to confirm`} htmlFor="os-confirm"><Input id="os-confirm" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} /></Field>
            <ActionError error={w.archive.error} />
          </div>
        </Modal>
      )}
    </PageFrame>
  );
}
