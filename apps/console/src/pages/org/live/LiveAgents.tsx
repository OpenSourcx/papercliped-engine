import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Ban, Bot, Pause, Play, Plus, RefreshCw, Zap } from "lucide-react";
import { AGENT_ROLES, type AgentRole } from "@papercliped-engine/engine-client";
import { useEngine } from "../../../data/store.tsx";
import { AGENT_ROLE_LABEL, ago, dollars } from "../../../data/engine/map.ts";
import { agentStatusOf, latestRunStatusOf } from "../../../data/engine/labels.tsx";
import { useAdapterModels, useAdapters, useAgent, useAgentAction, useAgents, useCreateAgent, useLatestRuns, useRuns, useSandboxAdapters } from "../../../data/engine/queries.ts";
import { useAgentReadiness } from "../../../data/engine/readiness.ts";
import { lifecycleError, setupState } from "../../../data/engine/lifecycle.ts";
import { ReadinessPanel, ReadinessPill } from "./AgentReadiness.tsx";
import { BarMeter } from "../../../ui/meters.tsx";
import { Modal } from "../../../ui/Modal.tsx";
import { useConfirm } from "../../../ui/Confirm.tsx";
import { Avatar, Button, Card, EmptyState, Input, Notice, PageFrame, PageHeader, Status, Tabs, Select } from "../../../ui/primitives.tsx";
import { AgentBudgetTab, AgentConfigTab, AgentInstructionsTab, AgentRunsTab, AgentSkillsTab } from "./LiveAgentTabs.tsx";
import { ActionError, Field, LoadError, Loading, selectClass, textareaClass, useLiveOrg } from "./common.tsx";
import { useNames } from "./names.ts";
import { useAgentsCanRun } from "../../containers/Banner.tsx";

export function LiveAgents() {
  const { org, companyId } = useLiveOrg();
  const { setup } = useEngine();
  const b = `/${setup?.deviceName ?? "pve"}/${org.slug}`;
  const agents = useAgents(companyId);
  const names = useNames(companyId);
  const [params, setParams] = useSearchParams();
  const creating = params.get("new") === "1";
  const setCreating = (v: boolean) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set("new", "1"); else n.delete("new"); return n; }, { replace: !v });
  const list = (agents.data ?? []).filter((a) => a.status !== "terminated");
  const latestRuns = useLatestRuns(companyId, list.map((a) => a.id));
  const latestByAgent = new Map(list.map((agent, index) => [agent.id, latestRuns[index]?.data]));
  const readiness = useAgentReadiness(companyId, list);
  const working = list.filter((a) => a.status === "running").length;
  return (
    <PageFrame width="6xl">
      <PageHeader title="Agents" subtitle={agents.data ? `${working} of ${list.length} working.` : undefined} actions={<Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New agent</Button>} />
      {agents.isPending && <Card><Loading label="Loading agents" /></Card>}
      {agents.error && <Card><LoadError error={agents.error} retry={() => void agents.refetch()} /></Card>}
      {agents.data && list.length === 0 && <Card><EmptyState icon={<Bot className="h-5 w-5" />} title="No agents yet" body="Create an agent, give it a role, and assign it tasks." action={<Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New agent</Button>} /></Card>}
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
        {list.map((a) => {
          const [kind, label] = agentStatusOf(a.status, (a as { lifecycleState?: unknown }).lifecycleState);
          const latest = latestRunStatusOf(latestByAgent.get(a.id));
          const ready = readiness.get(a.id);
          return (
            <Link key={a.id} to={`${b}/agents/${a.id}`} className="text-left">
              <Card interactive className="p-4 h-full">
                <div className="flex items-center gap-3"><Avatar name={a.name} hue={org.hue + 40} size={40} /><div className="flex-1 min-w-0"><div className="font-medium truncate">{a.name}</div><div className="text-xs text-ink-3 truncate">{names.role(a)} · {a.adapterType}</div></div><Status kind={kind} label={label} /></div>
                <div className="mt-2 flex flex-wrap items-center gap-2"><ReadinessPill readiness={ready} /></div>
                {ready && ready.state !== "ready" && <p className="text-xs text-ink-3 mt-1.5">{ready.summary}</p>}
                <div className="text-compact text-ink-2 mt-3 truncate">{a.reportsTo ? `Reports to ${names.agent(a.reportsTo)}` : "Reports to you"}{a.lastHeartbeatAt ? ` · last ran ${ago(a.lastHeartbeatAt)}` : ""}</div>
                {latest && <div className="mt-2"><Status kind={latest[0]} label={`Latest run: ${latest[1]}`} /></div>}
                {a.budgetMonthlyCents ? <BarMeter className="mt-3" label="Budget this month" pct={(a.spentMonthlyCents / a.budgetMonthlyCents) * 100} value={`${dollars(a.spentMonthlyCents)} of ${dollars(a.budgetMonthlyCents)}`} /> : null}
              </Card>
            </Link>
          );
        })}
      </div>
      {creating && <NewAgentModal onClose={() => setCreating(false)} />}
    </PageFrame>
  );
}

function NewAgentModal({ onClose }: { onClose: () => void }) {
  const { org, companyId } = useLiveOrg();
  const { setup } = useEngine();
  const navigate = useNavigate();
  const agents = useAgents(companyId);
  const adapters = useAdapters();
  const create = useCreateAgent(companyId);
  const [name, setName] = useState("");
  const [role, setRole] = useState<AgentRole>("general");
  const [title, setTitle] = useState("");
  const [reportsTo, setReportsTo] = useState("");
  const [adapter, setAdapter] = useState("");
  const [model, setModel] = useState("");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const usable = (adapters.data ?? []).filter((a) => a.loaded !== false && !a.disabled);
  // Agents run in containers, so start from an adapter that can: the first one the engine says supports a sandbox,
  // else any that isn't a bare command or HTTP call (those can never run in a container).
  const sandbox = useSandboxAdapters(companyId);
  useEffect(() => {
    if (adapter || !usable.length || (sandbox.isPending && !sandbox.isError)) return;
    const fits = (a: { type: string }) => sandbox.data?.has(a.type);
    setAdapter((usable.find(fits) ?? usable.find((a) => a.type !== "process" && a.type !== "http") ?? usable[0]).type);
  }, [adapter, usable, sandbox.data, sandbox.isPending, sandbox.isError]);
  const info = usable.find((a) => a.type === adapter);
  const models = useAdapterModels(companyId, info && info.modelsCount > 0 ? adapter : null);
  useEffect(() => setModel(""), [adapter]);

  const save = () => {
    if (!name.trim() || !adapter || create.isPending) return;
    const adapterConfig: Record<string, unknown> = {};
    if (model) adapterConfig.model = model;
    if (adapter === "process" && command.trim()) adapterConfig.command = command.trim();
    if (adapter === "http" && url.trim()) adapterConfig.url = url.trim();
    create.mutate(
      { name: name.trim(), role, title: title.trim() || null, reportsTo: reportsTo || null, adapterType: adapter, adapterConfig, capabilities: capabilities.trim() || null },
      { onSuccess: (a) => { onClose(); navigate(`/${setup?.deviceName ?? "pve"}/${org.slug}/agents/${a.id}`); } },
    );
  };

  return (
    <Modal size="lg" title="New agent" subtitle={`In ${org.name}`} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={!name.trim() || !adapter || create.isPending}>{create.isPending ? "Creating…" : "Create agent"}</Button></>}>
      <div className="space-y-3">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Forge" /></Field>
          <Field label="Title" hint="(optional)"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Backend engineer" /></Field>
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value as AgentRole)}>
              {AGENT_ROLES.map((r) => <option key={r} value={r}>{AGENT_ROLE_LABEL[r]}</option>)}
            </Select>
          </Field>
          <Field label="Reports to">
            <Select value={reportsTo} onChange={(e) => setReportsTo(e.target.value)}>
              <option value="">You</option>
              {(agents.data ?? []).filter((a) => a.status !== "terminated").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Runs with">
            {adapters.isPending ? <p className="text-compact text-ink-3 h-10 flex items-center">Loading…</p> : adapters.error ? <LoadError error={adapters.error} retry={() => void adapters.refetch()} /> : (
              <Select value={adapter} onChange={(e) => setAdapter(e.target.value)}>
                {usable.map((a) => <option key={a.type} value={a.type}>{a.label || a.type}</option>)}
              </Select>
            )}
          </Field>
          {info && info.modelsCount > 0 && (
            <Field label="Model">
              <Select value={model} onChange={(e) => setModel(e.target.value)} disabled={models.isPending}>
                <option value="">{models.isPending ? "Loading…" : "Default"}</option>
                {(models.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
              </Select>
            </Field>
          )}
          {adapter === "process" && <Field label="Command" hint="(optional)"><Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="The program the agent runs" className="font-mono text-compact" /></Field>}
          {adapter === "http" && <Field label="Address" hint="(optional)"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></Field>}
        </div>
        <Field label="Capabilities" hint="(optional)"><textarea rows={3} value={capabilities} onChange={(e) => setCapabilities(e.target.value)} className={textareaClass} placeholder="What this agent is good at, so others know when to hand it work" /></Field>
        <ActionError error={create.error} />
      </div>
    </Modal>
  );
}

const RUN_STATUS: Record<string, string> = { queued: "Queued", running: "Running", succeeded: "Finished", failed: "Failed", cancelled: "Cancelled", timed_out: "Timed out" };

export function LiveAgentDetail() {
  const { org, companyId } = useLiveOrg();
  const { setup } = useEngine();
  const { agentId = "" } = useParams();
  const b = `/${setup?.deviceName ?? "pve"}/${org.slug}`;
  const agent = useAgent(companyId, agentId);
  const runs = useRuns(companyId, agentId);
  const names = useNames(companyId);
  const act = useAgentAction(companyId);
  const terminate = useConfirm();
  const canRun = useAgentsCanRun();
  const a = agent.data;
  const readiness = useAgentReadiness(companyId, a ? [a] : []);
  const current = a ? readiness.get(a.id) : undefined;
  const [params, setParams] = useSearchParams();
  type AgentTab = "overview" | "runs" | "configuration" | "instructions" | "skills" | "budget";
  const tab = (["overview", "runs", "configuration", "instructions", "skills", "budget"].includes(params.get("tab") ?? "") ? params.get("tab") : "overview") as AgentTab;
  const setTab = (t: AgentTab) => setParams((p) => { const n = new URLSearchParams(p); if (t === "overview") n.delete("tab"); else n.set("tab", t); return n; }, { replace: true });
  const [kind, label] = a ? agentStatusOf(a.status, (a as { lifecycleState?: unknown }).lifecycleState) : ["idle" as const, ""];
  const settingUp = a ? setupState(a) : null;
  const blockers = (current?.checks ?? []).filter((c) => c.state === "blocked");
  const latestRun = runs.data?.[0] ?? null;
  const latestRunStatus = latestRunStatusOf(latestRun);
  return (
    <PageFrame width="4xl">
      <Link to={`${b}/agents`} className="inline-flex items-center gap-1.5 text-compact text-ink-3 hover:text-ink mb-4"><ArrowLeft className="h-3.5 w-3.5" />Agents</Link>
      {agent.isPending && <Card><Loading label="Loading agent" /></Card>}
      {agent.error && <Card><LoadError error={agent.error} retry={() => void agent.refetch()} /></Card>}
      {a && (
        <>
          <PageHeader
            title={<span className="inline-flex items-center gap-3"><Avatar name={a.name} hue={org.hue + 40} size={40} />{a.name}</span>}
            subtitle={<><Status kind={kind} label={label} /><ReadinessPill readiness={current} /><span className="text-ink-3 text-sm ml-3">{names.role(a)}</span></>}
            actions={
              <>
                {settingUp ? (
                  <Button onClick={() => act.mutate({ id: a.id, action: "retry" })} loading={act.isPending && act.variables?.action === "retry"} disabled={act.isPending}><RefreshCw className="h-4 w-4" />Check again</Button>
                ) : a.status === "paused" ? (
                  <Button onClick={() => act.mutate({ id: a.id, action: "resume" })} disabled={act.isPending}><Play className="h-4 w-4" />Resume</Button>
                ) : (
                  <Button onClick={() => act.mutate({ id: a.id, action: "pause" })} disabled={act.isPending || a.status === "terminated" || a.status === "pending_approval"}><Pause className="h-4 w-4" />Pause</Button>
                )}
                {a.status !== "terminated" && <Button variant="danger" onClick={() => terminate.ask({ title: `Terminate ${a.name}?`, body: "The agent stops for good and can't be brought back. Its tasks, comments and history stay.", label: "Terminate", danger: true, run: () => act.mutateAsync({ id: a.id, action: "terminate" }).catch(() => {}) })} disabled={act.isPending}><Ban className="h-4 w-4" />Terminate</Button>}
                <Button variant="primary" onClick={() => act.mutate({ id: a.id, action: "wakeup" })} disabled={!canRun || act.isPending || a.status === "paused" || a.status === "terminated" || a.status === "pending_approval"} title={canRun ? undefined : "Agents can't run until agent containers are set up"}><Zap className="h-4 w-4" />Wake up</Button>
              </>
            }
          />
          {terminate.dialog}
          {settingUp && (
            <Notice tone="warning" title={settingUp === "preparing" ? "This agent is being prepared" : settingUp === "verifying" ? "This agent is being verified" : "This agent is starting again"} className="mb-3">
              <p>The engine shows it as paused while it checks that the agent can run. Nobody paused it, and Resume does nothing until the checks pass. It starts by itself once they do.</p>
              {blockers.length > 0 ? (
                <>
                  <p className="mt-2">What it is waiting on:</p>
                  <ul className="list-disc pl-5 mt-1 space-y-0.5">{blockers.map((c) => <li key={c.id}><span className="font-medium">{c.label}.</span> {c.detail}{c.id === "model" && <> <Link to={`${b}/connectors`} className="text-accent">Connect a model account</Link>.</>}{c.id === "environment" && <> <Link to={`${b}/machines`} className="text-accent">See the organization's containers</Link>.</>}</li>)}</ul>
                </>
              ) : <p className="mt-2">Nothing is reported missing. Choose Check again to run the checks now.</p>}
              {lifecycleError(a) && <p className="mt-2 text-critical">The engine reported: {lifecycleError(a)}</p>}
            </Notice>
          )}
          <ActionError error={act.error} />
          {act.isSuccess && act.variables?.action === "retry" && <p className="text-compact text-ink-3 mb-3">Asked the engine to check {a.name} again.</p>}
          {act.isSuccess && act.variables?.action === "wakeup" && <p className="text-compact text-ink-3 mb-3">Asked {a.name} to run now.</p>}
          <Tabs value={tab} onChange={setTab} className="mb-4" tabs={[{ id: "overview", label: "Overview" }, { id: "runs", label: "Runs" }, { id: "configuration", label: "Configuration" }, { id: "instructions", label: "Instructions" }, { id: "skills", label: "Skills" }, { id: "budget", label: "Budget" }]} />
          {tab === "runs" && <AgentRunsTab agent={a} />}
          {tab === "configuration" && <AgentConfigTab key={a.updatedAt as unknown as string} agent={a} />}
          {tab === "instructions" && <AgentInstructionsTab agent={a} />}
          {tab === "skills" && <AgentSkillsTab agent={a} />}
          {tab === "budget" && <AgentBudgetTab key={a.budgetMonthlyCents} agent={a} />}
          {tab === "overview" && <>
            {current && <Card className="p-5 mb-4"><ReadinessPanel readiness={current} /></Card>}
            {latestRun && latestRunStatus && <Card className="p-5 mb-4 flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-48"><div className="text-compact font-semibold uppercase tracking-label text-ink-3">{latestRun.status === "queued" || latestRun.status === "running" ? "Live run" : "Latest run"}</div><div className="mt-1 text-sm text-ink-2">{String(latestRun.invocationSource).replace(/_/g, " ")} · started {ago(latestRun.startedAt ?? latestRun.createdAt)}</div></div>
              <Status kind={latestRunStatus[0]} label={latestRunStatus[1]} />
              <Button size="sm" variant="ghost" onClick={() => setTab("runs")}>{latestRun.status === "queued" || latestRun.status === "running" ? "Watch live" : "View run"}</Button>
            </Card>}
            <div className="grid md:grid-cols-2 gap-4">
            <Card className="p-5">
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
                <dt className="text-ink-3">Runs with</dt><dd>{a.adapterType}{typeof a.adapterConfig?.model === "string" ? ` · ${a.adapterConfig.model}` : ""}</dd>
                <dt className="text-ink-3">Reports to</dt><dd>{a.reportsTo ? names.agent(a.reportsTo) : "You"}</dd>
                <dt className="text-ink-3">Last ran</dt><dd>{ago(a.lastHeartbeatAt)}</dd>
                <dt className="text-ink-3">Spend</dt><dd>{a.budgetMonthlyCents ? `${dollars(a.spentMonthlyCents)} of ${dollars(a.budgetMonthlyCents)} this month` : `${dollars(a.spentMonthlyCents)} this month, no budget set`}</dd>
                {a.errorReason && <><dt className="text-ink-3">Error</dt><dd className="text-critical">{a.errorReason}</dd></>}
              </dl>
              {a.capabilities && <p className="text-compact text-ink-2 mt-4 whitespace-pre-wrap">{a.capabilities}</p>}
            </Card>
            <Card>
              <div className="px-5 pt-4 pb-2 text-compact font-semibold uppercase tracking-label text-ink-3">Recent runs</div>
              {runs.isPending && <Loading />}
              {runs.error && <LoadError error={runs.error} retry={() => void runs.refetch()} />}
              <div className="divide-y divide-line">
                {runs.data?.length === 0 && <p className="px-5 pb-4 text-sm text-ink-3">No runs yet.</p>}
                {(runs.data ?? []).map((r) => (
                  <div key={r.id} className="px-5 py-2.5 flex items-center gap-3 text-compact">
                    <span className="flex-1">{RUN_STATUS[r.status] ?? r.status}<span className="text-ink-3"> · {String(r.invocationSource).replace(/_/g, " ")}</span></span>
                    <span className="text-ink-3">{ago(r.startedAt ?? r.createdAt)}</span>
                  </div>
                ))}
              </div>
            </Card>
            </div>
          </>}
        </>
      )}
    </PageFrame>
  );
}
