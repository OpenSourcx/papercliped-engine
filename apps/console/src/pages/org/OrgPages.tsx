import { useState, type ReactNode } from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { Check, CircleDollarSign, FolderOpen, Inbox as InboxIcon, Plus, Repeat, Target, X } from "lucide-react";
import { TASK_ICON, TASK_LABEL } from "../../data/meta.tsx";
import { useEngine } from "../../data/store.tsx";
import type { Agent, Org, TaskStatus } from "../../data/types.ts";
import { cn } from "../../lib/storage.ts";
import { BarMeter } from "../../ui/meters.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Avatar, Button, Card, Chip, EmptyState, Input, PageFrame, PageHeader, Segmented, Status, Toggle, type StatusKind } from "../../ui/primitives.tsx";
import { LiveAgents } from "./live/LiveAgents.tsx";
import { LiveTasks } from "./live/LiveTasks.tsx";
import { LiveRoutines } from "./live/LiveRoutines.tsx";
import { LiveDecisions, LiveInbox } from "./live/LiveInbox.tsx";
import { LiveActivity, LiveCosts, LiveGoals, LiveOrgSettings, LiveProjects } from "./live/LiveWork.tsx";

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

export function useOrg(): Org | null {
  const { org } = useParams();
  return useEngine().data.orgs.find((o) => o.slug === org) ?? null;
}

function OrgGate({ children }: { children: (org: Org) => ReactNode }) {
  const org = useOrg();
  const { setup } = useEngine();
  if (!org) return <Navigate to={`/${setup?.deviceName ?? "pve"}/home`} replace />;
  return <>{children(org)}</>;
}

function DemoInbox() {
  const { readInbox } = useEngine();
  return (
    <OrgGate>
      {(org) => (
        <PageFrame width="4xl">
          <PageHeader title="Inbox" subtitle="What your agents need from you." actions={<Button onClick={() => readInbox(org.slug)}><Check className="h-4 w-4" />Mark all read</Button>} />
          <Card className="divide-y divide-line">
            {org.inbox.length === 0 && <EmptyState icon={<InboxIcon className="h-5 w-5" />} title="Inbox zero" body="Nothing needs you right now." />}
            {org.inbox.map((i) => (
              <div key={i.id} className="flex items-center gap-3 px-5 py-3.5">
                <span className={cn("h-2 w-2 rounded-full shrink-0", i.read ? "bg-transparent" : "bg-accent")} aria-label={i.read ? undefined : "Unread"} />
                <Avatar name={i.from} hue={org.hue + 40} size={28} />
                <span className={cn("flex-1 text-sm", !i.read && "font-medium")}>{i.title}</span>
                <span className="text-xs text-ink-3">{ago(i.at)}</span>
              </div>
            ))}
          </Card>
        </PageFrame>
      )}
    </OrgGate>
  );
}

function DemoTasks() {
  const { addTask, setTaskStatus } = useEngine();
  const [filter, setFilter] = useState<"open" | "all" | "done">("open");
  const [params, setParams] = useSearchParams();
  const creating = params.get("new") === "1";
  const setCreating = (v: boolean) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set("new", "1"); else n.delete("new"); return n; }, { replace: !v });
  const [title, setTitle] = useState("");
  const [agent, setAgent] = useState<string>("");
  return (
    <OrgGate>
      {(org) => {
        const list = org.tasks.filter((t) => (filter === "all" ? true : filter === "done" ? t.status === "done" : t.status !== "done"));
        const save = () => {
          if (!title.trim()) return;
          addTask(org.slug, title.trim(), agent || null);
          setTitle("");
          setAgent("");
          setCreating(false);
        };
        return (
          <PageFrame width="6xl">
            <PageHeader title="Tasks" subtitle={`${org.tasks.filter((t) => t.status !== "done").length} open in ${org.name}.`} actions={<Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New task</Button>} />
            <div className="mb-4"><Segmented value={filter} onChange={setFilter} options={[{ value: "open", label: "Open" }, { value: "done", label: "Done" }, { value: "all", label: "All" }]} /></div>
            <Card className="divide-y divide-line">
              {list.length === 0 && <EmptyState icon={<Check className="h-5 w-5" />} title="Nothing here" body="No tasks match this filter." />}
              {list.map((t) => (
                <div key={t.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <span title={TASK_LABEL[t.status]}>{TASK_ICON[t.status]}</span>
                  <span className="text-xs text-ink-3 font-mono w-16">{t.id}</span>
                  <span className="flex-1 min-w-[180px] text-sm">{t.title}</span>
                  {t.project && <Chip>{t.project}</Chip>}
                  {t.priority === "high" && <Chip tone="warning">High</Chip>}
                  <span className="text-compact text-ink-2 w-20 truncate">{t.agent ?? "Unassigned"}</span>
                  <select value={t.status} onChange={(e) => setTaskStatus(org.slug, t.id, e.target.value as TaskStatus)} className="bg-surface-2 border border-line rounded-md h-7 text-xs px-1.5" aria-label={`Status of ${t.id}`}>
                    {(Object.keys(TASK_LABEL) as TaskStatus[]).map((s) => <option key={s} value={s}>{TASK_LABEL[s]}</option>)}
                  </select>
                </div>
              ))}
            </Card>
            {creating && (
              <Modal title="New task" subtitle={`In ${org.name}`} onClose={() => setCreating(false)} footer={<><Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" onClick={save} disabled={!title.trim()}>Create task</Button></>}>
                <div className="space-y-3">
                  <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Title</span><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} placeholder="What needs doing?" /></label>
                  <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Assign to</span>
                    <select value={agent} onChange={(e) => setAgent(e.target.value)} className="h-11 w-full rounded-lg bg-surface-2 border border-line px-3 text-body">
                      <option value="">Unassigned</option>
                      {org.agents.map((a) => <option key={a.id} value={a.name}>{a.name} · {a.role}</option>)}
                    </select>
                  </label>
                </div>
              </Modal>
            )}
          </PageFrame>
        );
      }}
    </OrgGate>
  );
}

function DemoProjects() {
  return (
    <OrgGate>
      {(org) => (
        <PageFrame width="6xl">
          <PageHeader title="Projects" />
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {org.projects.length === 0 && <Card className="md:col-span-3"><EmptyState icon={<FolderOpen className="h-5 w-5" />} title="No projects yet" body="Group related tasks into a project." /></Card>}
            {org.projects.map((p) => (
              <Card key={p.id} className="p-5">
                <div className="flex items-center gap-2 font-medium"><FolderOpen className="h-4 w-4 text-ink-3" />{p.name}</div>
                <BarMeter className="mt-4" label="Progress" pct={(p.done / p.tasks) * 100} value={`${p.done} of ${p.tasks} tasks`} />
                <div className="text-xs text-ink-3 mt-3">Lead: {p.lead ?? "none"}</div>
              </Card>
            ))}
          </div>
        </PageFrame>
      )}
    </OrgGate>
  );
}

function DemoGoals() {
  return (
    <OrgGate>
      {(org) => (
        <PageFrame width="4xl">
          <PageHeader title="Goals" subtitle="What the organization is working toward. Agents plan their tasks against these." />
          <div className="space-y-3">
            {org.goals.length === 0 && <Card><EmptyState icon={<Target className="h-5 w-5" />} title="No goals yet" body="Set a goal and the CEO agent plans toward it." /></Card>}
            {org.goals.map((g) => (
              <Card key={g.id} className="p-5">
                <div className="flex items-center gap-2"><Target className="h-4 w-4 text-ink-3" /><span className="font-medium flex-1">{g.title}</span>{g.due && <span className="text-xs text-ink-3">Due {g.due}</span>}</div>
                <BarMeter className="mt-3" label="Progress" pct={g.progress} value={`${g.progress}%`} />
              </Card>
            ))}
          </div>
        </PageFrame>
      )}
    </OrgGate>
  );
}

function DemoRoutines() {
  const { toggleRoutine } = useEngine();
  return (
    <OrgGate>
      {(org) => (
        <PageFrame width="4xl">
          <PageHeader title="Routines" subtitle="Recurring work your agents do on a schedule." />
          <Card className="divide-y divide-line">
            {org.routines.length === 0 && <EmptyState icon={<Repeat className="h-5 w-5" />} title="No routines yet" body="Give an agent a recurring job." />}
            {org.routines.map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-5 py-3.5">
                <Repeat className="h-4 w-4 text-ink-3" />
                <div className="flex-1 min-w-0"><div className="text-sm font-medium">{r.name}</div><div className="text-xs text-ink-3">{r.schedule} · {r.agent} · last run {ago(r.lastRun)}</div></div>
                <Toggle label={`Enable ${r.name}`} checked={r.enabled} onChange={() => toggleRoutine(org.slug, r.id)} />
              </div>
            ))}
          </Card>
        </PageFrame>
      )}
    </OrgGate>
  );
}

function DemoDecisions() {
  const { decideApproval } = useEngine();
  return (
    <OrgGate>
      {(org) => (
        <PageFrame width="4xl">
          <PageHeader title="Decisions" subtitle="Hires, budget changes and actions your agents asked you to approve." />
          <div className="space-y-3">
            {org.approvals.length === 0 && <Card><EmptyState icon={<Check className="h-5 w-5" />} title="Nothing to decide" body="Approval requests from agents show up here." /></Card>}
            {org.approvals.map((a) => (
              <Card key={a.id} className="p-4 flex flex-wrap items-center gap-3">
                <Avatar name={a.requestedBy} hue={org.hue + 40} size={32} />
                <div className="flex-1 min-w-[200px]"><div className="text-sm font-medium">{a.title}</div><div className="text-xs text-ink-3">{a.requestedBy} · {a.kind} · {ago(a.at)}</div></div>
                {a.status === "pending" ? (
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => decideApproval(org.slug, a.id, false)}><X className="h-3.5 w-3.5" />Reject</Button>
                    <Button size="sm" variant="primary" onClick={() => decideApproval(org.slug, a.id, true)}><Check className="h-3.5 w-3.5" />Approve</Button>
                  </div>
                ) : a.status === "approved" ? <Status kind="good" label="Approved" /> : <Status kind="critical" label="Rejected" />}
              </Card>
            ))}
          </div>
        </PageFrame>
      )}
    </OrgGate>
  );
}

const AGENT: Record<Agent["status"], [StatusKind, string]> = { working: ["working", "Working"], idle: ["idle", "Idle"], paused: ["paused", "Paused"], error: ["critical", "Error"] };

function DemoAgents() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <OrgGate>
      {(org) => {
        const a = org.agents.find((x) => x.id === open);
        return (
          <PageFrame width="6xl">
            <PageHeader title="Agents" subtitle={`${org.agents.filter((x) => x.status === "working").length} of ${org.agents.length} working.`} actions={<Button variant="primary" disabled title="Hiring from the console arrives with the ePaperclip fork; agents can request hires in Decisions"><Plus className="h-4 w-4" />Hire agent</Button>} />
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
              {org.agents.map((x) => {
                const [kind, label] = AGENT[x.status];
                return (
                  <button key={x.id} onClick={() => setOpen(x.id)} className="text-left">
                    <Card interactive className="p-4 h-full">
                      <div className="flex items-center gap-3"><Avatar name={x.name} hue={org.hue + 40} size={40} /><div className="flex-1 min-w-0"><div className="font-medium">{x.name}</div><div className="text-xs text-ink-3">{x.role} · {x.adapter}</div></div><Status kind={kind} label={label} /></div>
                      <div className="text-compact text-ink-2 mt-3 truncate">{x.task ?? (x.engine === "native" ? "Runs natively on the host" : "Runs in container sessions")}</div>
                      {x.budgetUsd ? <BarMeter className="mt-3" label="Budget this month" pct={((x.spendUsd ?? 0) / x.budgetUsd) * 100} value={`$${(x.spendUsd ?? 0).toFixed(2)} of $${x.budgetUsd}`} /> : null}
                    </Card>
                  </button>
                );
              })}
            </div>
            {a && (
              <Modal title={a.name} subtitle={`${a.role} in ${org.name}`} icon={<Avatar name={a.name} hue={org.hue + 40} size={40} />} onClose={() => setOpen(null)}>
                <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
                  <dt className="text-ink-3">Status</dt><dd><Status kind={AGENT[a.status][0]} label={AGENT[a.status][1]} /></dd>
                  <dt className="text-ink-3">Harness</dt><dd>{a.adapter}</dd>
                  <dt className="text-ink-3">Engine</dt><dd>{a.engine === "native" ? "Native on the host" : "Container session in the resource group"}</dd>
                  <dt className="text-ink-3">Working on</dt><dd>{a.task ?? "Nothing right now"}</dd>
                  <dt className="text-ink-3">Reports to</dt><dd>{org.agents.find((x) => x.id === a.reportsTo)?.name ?? "You"}</dd>
                  <dt className="text-ink-3">Spend</dt><dd>{a.budgetUsd ? `$${(a.spendUsd ?? 0).toFixed(2)} of $${a.budgetUsd} this month` : "No budget set"}</dd>
                </dl>
              </Modal>
            )}
          </PageFrame>
        );
      }}
    </OrgGate>
  );
}

function DemoCosts() {
  return (
    <OrgGate>
      {(org) => {
        const spent = org.agents.reduce((s, a) => s + (a.spendUsd ?? 0), 0);
        const budget = org.agents.reduce((s, a) => s + (a.budgetUsd ?? 0), 0);
        return (
          <PageFrame width="4xl">
            <PageHeader title="Costs" subtitle="AI spend this month, by agent." />
            <Card className="p-5 mb-4">
              <div className="flex items-baseline gap-2"><CircleDollarSign className="h-5 w-5 text-ink-3 self-center" /><span className="text-display font-semibold tabular-nums">${spent.toFixed(2)}</span><span className="text-ink-3">of ${budget} budgeted</span></div>
              <BarMeter className="mt-3" label="Month to date" pct={budget ? (spent / budget) * 100 : 0} value={`${budget ? Math.round((spent / budget) * 100) : 0}%`} />
            </Card>
            <Card className="divide-y divide-line">
              {org.agents.map((a) => (
                <div key={a.id} className="flex items-center gap-3 px-5 py-3">
                  <Avatar name={a.name} hue={org.hue + 40} size={28} />
                  <span className="w-28 text-sm">{a.name}</span>
                  <BarMeter className="flex-1" label={a.role} pct={a.budgetUsd ? ((a.spendUsd ?? 0) / a.budgetUsd) * 100 : 0} value={a.budgetUsd ? `$${(a.spendUsd ?? 0).toFixed(2)} of $${a.budgetUsd}` : "No budget"} />
                </div>
              ))}
            </Card>
          </PageFrame>
        );
      }}
    </OrgGate>
  );
}

function DemoActivity() {
  return (
    <OrgGate>
      {(org) => (
        <PageFrame width="4xl">
          <PageHeader title="Activity" subtitle="Everything that happened in this organization." />
          <Card className="divide-y divide-line">
            {org.activity.map((a) => (
              <div key={a.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                <Avatar name={a.who} hue={a.who === "Pin" ? 30 : org.hue + 40} size={26} />
                <span className="flex-1"><span className="font-medium">{a.who}</span> <span className="text-ink-2">{a.what}</span></span>
                <span className="text-xs text-ink-3">{ago(a.at)}</span>
              </div>
            ))}
          </Card>
        </PageFrame>
      )}
    </OrgGate>
  );
}

export function OrgConnectors() {
  const { data, setConnectorAccess } = useEngine();
  return (
    <OrgGate>
      {(org) => (
        <PageFrame width="4xl">
          <PageHeader title="Connectors" subtitle={`System-wide connectors ${org.name}'s agents may use. Set up new ones in Settings → Connectors.`} />
          <Card className="divide-y divide-line">
            {data.connectors.map((c) => (
              <div key={c.id} className="flex items-center gap-3 px-5 py-3.5">
                <span className="flex-1 text-sm font-medium">{c.name}</span>
                {c.status === "connected" ? <Status kind="good" label="Connected" /> : <Status kind="warning" label="Needs setup" />}
                <Toggle label={`${org.name} can use ${c.name}`} checked={c.access.orgs.includes(org.slug)} disabled={c.status !== "connected"} onChange={(v) => setConnectorAccess(c.id, org.slug, v)} />
              </div>
            ))}
          </Card>
        </PageFrame>
      )}
    </OrgGate>
  );
}

function DemoOrgSettings() {
  return (
    <OrgGate>
      {(org) => (
        <PageFrame width="3xl">
          <PageHeader title="Organization settings" />
          <Card className="p-5 space-y-4">
            <div className="flex items-center gap-3"><Avatar name={org.name} hue={org.hue} size={44} /><div><div className="font-medium">{org.name}</div><div className="text-xs text-ink-3 font-mono">/{org.slug} · pool {org.resourceGroup.pool}</div></div></div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-ink-3">Resources</dt><dd>{org.resourceGroup.cores} cores · {Math.round(org.resourceGroup.memoryMb / 1024)} GiB memory · {org.resourceGroup.diskGb} GB disk · up to {org.resourceGroup.maxGuests} containers</dd>
              <dt className="text-ink-3">Agent memory</dt><dd>{org.memory === "postgres" ? "Postgres" : "Postgres + memory files"}</dd>
              <dt className="text-ink-3">Created by</dt><dd>{org.createdBy === "pin" ? "Pin" : "You"}</dd>
            </dl>
          </Card>
        </PageFrame>
      )}
    </OrgGate>
  );
}

/** Paperclip features that arrive with the ePaperclip fork. Listed so the navigation matches Paperclip. */
export function ComingFromPaperclip({ title, body }: { title: string; body: string }) {
  return (
    <PageFrame width="3xl">
      <PageHeader title={title} />
      <Card className="p-6">
        <p className="text-ink-2">{body}</p>
        <p className="text-compact text-ink-3 mt-3">This page comes from Paperclip itself and lands when the ePaperclip fork is merged into the console.</p>
      </Card>
    </PageFrame>
  );
}

// Live, each page reads the organization's work from the engine; the demo keeps its in-browser data.
const pick = (live: ReactNode, demo: ReactNode) => function Page() {
  return <>{useEngine().live ? live : demo}</>;
};
export const Routines = pick(<LiveRoutines />, <DemoRoutines />);
export const Inbox = pick(<LiveInbox />, <DemoInbox />);
export const Tasks = pick(<LiveTasks />, <DemoTasks />);
export const Projects = pick(<LiveProjects />, <DemoProjects />);
export const Goals = pick(<LiveGoals />, <DemoGoals />);
export const Decisions = pick(<LiveDecisions />, <DemoDecisions />);
export const Agents = pick(<LiveAgents />, <DemoAgents />);
export const Costs = pick(<LiveCosts />, <DemoCosts />);
export const Activity = pick(<LiveActivity />, <DemoActivity />);
export const OrgSettings = pick(<LiveOrgSettings />, <DemoOrgSettings />);
