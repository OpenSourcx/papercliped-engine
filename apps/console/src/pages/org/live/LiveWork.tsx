import { useState } from "react";
import { Check, CircleDollarSign, FolderOpen, History, Plus, Target, Users, X } from "lucide-react";
import type { GoalLevel } from "@papercliped-engine/engine-client";
import { ago, dollars } from "../../../data/engine/map.ts";
import { APPROVAL_TYPE_LABEL } from "../../../data/engine/labels.tsx";
import { useActivity, useAgents, useApprovals, useCosts, useCreateGoal, useCreateProject, useDecide, useGoals, useIssues, useMembers, useProjects, useResourceGroup } from "../../../data/engine/queries.ts";
import { formatBytes } from "../../../lib/storage.ts";
import { BarMeter } from "../../../ui/meters.tsx";
import { Modal } from "../../../ui/Modal.tsx";
import { Avatar, Button, Card, Chip, EmptyState, Input, PageFrame, PageHeader, Segmented, Status, Select } from "../../../ui/primitives.tsx";
import { ActionError, Field, LoadError, Loading, selectClass, textareaClass, useLiveOrg } from "./common.tsx";
import { describeActivity, memberName, realEmail, useNames } from "./names.ts";

const GOAL_STATUS: Record<string, string> = { planned: "Planned", active: "Active", achieved: "Achieved", cancelled: "Cancelled" };
const GOAL_LEVEL: Record<GoalLevel, string> = { company: "Organization", team: "Team", agent: "Agent", task: "Task" };
const PROJECT_STATUS: Record<string, string> = { backlog: "Backlog", planned: "Planned", in_progress: "In progress", completed: "Completed", cancelled: "Cancelled" };

export function LiveGoals() {
  const { companyId, org } = useLiveOrg();
  const goals = useGoals(companyId);
  const agents = useAgents(companyId);
  const names = useNames(companyId);
  const create = useCreateGoal(companyId);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [level, setLevel] = useState<GoalLevel>("company");
  const [owner, setOwner] = useState("");
  const save = () => {
    if (!title.trim() || create.isPending) return;
    create.mutate({ title: title.trim(), description: description.trim() || null, level, status: "active", ownerAgentId: owner || null }, { onSuccess: () => { setOpen(false); setTitle(""); setDescription(""); setOwner(""); } });
  };
  return (
    <PageFrame width="4xl">
      <PageHeader title="Goals" subtitle="What the organization is working toward. Agents plan their tasks against these." actions={<Button variant="primary" onClick={() => setOpen(true)}><Plus className="h-4 w-4" />New goal</Button>} />
      <div className="space-y-3">
        {goals.isPending && <Card><Loading label="Loading goals" /></Card>}
        {goals.error && <Card><LoadError error={goals.error} retry={() => void goals.refetch()} /></Card>}
        {goals.data?.length === 0 && <Card><EmptyState icon={<Target className="h-5 w-5" />} title="No goals yet" body="Set a goal and your agents plan toward it." /></Card>}
        {(goals.data ?? []).map((g) => (
          <Card key={g.id} className="p-5">
            <div className="flex flex-wrap items-center gap-2"><Target className="h-4 w-4 text-ink-3" /><span className="font-medium flex-1">{g.title}</span><Chip>{GOAL_LEVEL[g.level] ?? g.level}</Chip><span className="text-xs text-ink-3">{GOAL_STATUS[g.status] ?? g.status}</span></div>
            {g.description && <p className="text-compact text-ink-2 mt-2 whitespace-pre-wrap">{g.description}</p>}
            {g.ownerAgentId && <p className="text-xs text-ink-3 mt-2">Owner: {names.agent(g.ownerAgentId)}</p>}
          </Card>
        ))}
      </div>
      {open && (
        <Modal title="New goal" subtitle={`In ${org.name}`} onClose={() => setOpen(false)} footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={save} disabled={!title.trim() || create.isPending}>Set goal</Button></>}>
          <div className="space-y-3">
            <Field label="Goal"><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} placeholder="e.g. Ship the beta to 50 users" /></Field>
            <Field label="Description" hint="(optional)"><textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} className={textareaClass} /></Field>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Level"><Select value={level} onChange={(e) => setLevel(e.target.value as GoalLevel)}>{(Object.keys(GOAL_LEVEL) as GoalLevel[]).map((l) => <option key={l} value={l}>{GOAL_LEVEL[l]}</option>)}</Select></Field>
              <Field label="Owner"><Select value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">Nobody yet</option>{(agents.data ?? []).filter((a) => a.status !== "terminated").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
            </div>
            <ActionError error={create.error} />
          </div>
        </Modal>
      )}
    </PageFrame>
  );
}

export function LiveProjects() {
  const { companyId, org } = useLiveOrg();
  const projects = useProjects(companyId);
  const issues = useIssues(companyId);
  const agents = useAgents(companyId);
  const names = useNames(companyId);
  const create = useCreateProject(companyId);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [lead, setLead] = useState("");
  const save = () => {
    if (!name.trim() || create.isPending) return;
    create.mutate({ name: name.trim(), description: description.trim() || null, status: "planned", leadAgentId: lead || null }, { onSuccess: () => { setOpen(false); setName(""); setDescription(""); setLead(""); } });
  };
  return (
    <PageFrame width="6xl">
      <PageHeader title="Projects" subtitle="Related tasks, grouped." actions={<Button variant="primary" onClick={() => setOpen(true)}><Plus className="h-4 w-4" />New project</Button>} />
      {projects.isPending && <Card><Loading label="Loading projects" /></Card>}
      {projects.error && <Card><LoadError error={projects.error} retry={() => void projects.refetch()} /></Card>}
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
        {projects.data?.length === 0 && <Card className="md:col-span-3"><EmptyState icon={<FolderOpen className="h-5 w-5" />} title="No projects yet" body="Group related tasks into a project." /></Card>}
        {(projects.data ?? []).map((p) => {
          const mine = (issues.data ?? []).filter((t) => t.projectId === p.id);
          const done = mine.filter((t) => t.status === "done").length;
          return (
            <Card key={p.id} className="p-5">
              <div className="flex items-center gap-2 font-medium"><FolderOpen className="h-4 w-4 text-ink-3" /><span className="flex-1 truncate">{p.name}</span><span className="text-xs text-ink-3 font-normal">{PROJECT_STATUS[p.status] ?? p.status}</span></div>
              {p.description && <p className="text-compact text-ink-2 mt-2 line-clamp-2">{p.description}</p>}
              <BarMeter className="mt-4" label="Progress" pct={mine.length ? (done / mine.length) * 100 : 0} value={`${done} of ${mine.length} tasks`} />
              <div className="text-xs text-ink-3 mt-3">Lead: {p.leadAgentId ? names.agent(p.leadAgentId) : "none"}</div>
            </Card>
          );
        })}
      </div>
      {open && (
        <Modal title="New project" subtitle={`In ${org.name}`} onClose={() => setOpen(false)} footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={save} disabled={!name.trim() || create.isPending}>Create project</Button></>}>
          <div className="space-y-3">
            <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} placeholder="e.g. Customer portal" /></Field>
            <Field label="Description" hint="(optional)"><textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} className={textareaClass} /></Field>
            <Field label="Lead"><Select value={lead} onChange={(e) => setLead(e.target.value)}><option value="">No lead yet</option>{(agents.data ?? []).filter((a) => a.status !== "terminated").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
            <ActionError error={create.error} />
          </div>
        </Modal>
      )}
    </PageFrame>
  );
}

export function LiveActivity() {
  const { companyId, org } = useLiveOrg();
  const activity = useActivity(companyId);
  const names = useNames(companyId);
  return (
    <PageFrame width="4xl">
      <PageHeader title="Activity" subtitle="Everything that happened in this organization." />
      <Card className="divide-y divide-line">
        {activity.isPending && <Loading />}
        {activity.error && <LoadError error={activity.error} retry={() => void activity.refetch()} />}
        {activity.data?.length === 0 && <EmptyState icon={<History className="h-5 w-5" />} title="Nothing yet" body="What people and agents do here shows up as it happens." />}
        {(activity.data ?? []).map((a) => {
          const who = names.actor(a);
          return (
            <div key={a.id} className="flex items-center gap-3 px-5 py-3 text-sm">
              <Avatar name={who} hue={a.actorType === "agent" ? org.hue + 40 : 210} size={26} />
              <span className="flex-1 min-w-0"><span className="font-medium">{who}</span> <span className="text-ink-2">{describeActivity(a)}</span></span>
              <span className="text-xs text-ink-3 shrink-0">{ago(a.createdAt)}</span>
            </div>
          );
        })}
      </Card>
    </PageFrame>
  );
}

const ROLE: Record<string, string> = { owner: "Owner", admin: "Admin", operator: "Operator", viewer: "Viewer", member: "Member" };

export function LiveMembers() {
  const { companyId, org } = useLiveOrg();
  const members = useMembers(companyId);
  const list = (members.data?.members ?? []).filter((m) => m.status !== "archived");
  return (
    <PageFrame width="4xl">
      <PageHeader title="Members" subtitle={`People who can see and work in ${org.name}. Access follows their Proxmox permissions.`} />
      <Card className="divide-y divide-line">
        {members.isPending && <Loading />}
        {members.error && <LoadError error={members.error} retry={() => void members.refetch()} />}
        {members.data && list.length === 0 && <EmptyState icon={<Users className="h-5 w-5" />} title="No members" body="Nobody has access yet." />}
        {list.map((m) => {
          const name = memberName(m.user);
          return (
            <div key={m.id} className="flex items-center gap-3 px-5 py-3">
              <Avatar name={name} hue={210} size={30} />
              <div className="flex-1 min-w-0"><div className="text-sm font-medium truncate">{name}</div>{realEmail(m.user?.email) && m.user?.name && <div className="text-xs text-ink-3 truncate">{realEmail(m.user.email)}</div>}</div>
              {m.status !== "active" && <Chip tone="warning">{m.status === "pending" ? "Invited" : m.status}</Chip>}
              <span className="text-compact text-ink-2">{(m.membershipRole && ROLE[m.membershipRole]) ?? "Member"}</span>
            </div>
          );
        })}
      </Card>
    </PageFrame>
  );
}

