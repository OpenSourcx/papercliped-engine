import { useQuery } from "@tanstack/react-query";
import { OrgChartCanvas } from "./LiveOrgChart.tsx";
import { connectApi } from "../../../data/engine/connectApi.ts";
import { useAgentSkills, useSkills } from "../../../data/engine/more.ts";
import { PinOrb } from "../../../pin/PinIsland.tsx";
import { agentIdentity } from "../../../ui/agentIdentity.ts";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Ban, Bot, Pause, Play, Plus, RefreshCw, Search, Zap } from "lucide-react";
import { AGENT_ROLES, type AgentRole } from "@papercliped-engine/engine-client";
import { useEngine } from "../../../data/store.tsx";
import { AGENT_ROLE_LABEL, ago, dollars } from "../../../data/engine/map.ts";
import { agentStatusOf, latestRunStatusOf } from "../../../data/engine/labels.tsx";
import { useAdapterModels, useAdapters, useAgent, useAgentAction, useAgents, accountProviderOf, hasAccountBinding, isPinIdentity, useCreateAgent, useGiveMyAccount, useLatestRuns, usePinIdentity, useRuns, useSandboxAdapters } from "../../../data/engine/queries.ts";
import { useAgentReadiness } from "../../../data/engine/readiness.ts";
import { lifecycleError, setupState } from "../../../data/engine/lifecycle.ts";
import { ReadinessPanel, ReadinessPill } from "./AgentReadiness.tsx";
import { BarMeter } from "../../../ui/meters.tsx";
import { Modal } from "../../../ui/Modal.tsx";
import { useConfirm } from "../../../ui/Confirm.tsx";
import { Avatar, Button, Card, EmptyState, Input, Notice, PageFrame, PageHeader, Segmented, Status, Tabs, Select, AgentAvatar } from "../../../ui/primitives.tsx";
import { AgentBudgetTab, AgentConfigTab, AgentInstructionsTab, AgentRunsTab, AgentSkillsTab } from "./LiveAgentTabs.tsx";
import { ActionError, Field, LoadError, Loading, selectClass, textareaClass, useLiveOrg } from "./common.tsx";
import { useNames } from "./names.ts";
import { useAgentsCanRun } from "../../containers/Banner.tsx";

/** Pin's page in an organization. It is not an agent to run: nothing to resume, wake up, set up or terminate. */
function PinTeammate({ orgName, base }: { orgName: string; base: string }) {
  return (
    <>
      <div className="mb-8 flex items-start gap-4">
        <PinOrb size={64} />
        <div className="min-w-0">
          <h1 className="text-heading sm:text-display font-semibold tracking-tight">Pin</h1>
          <p className="mt-1 text-compact text-ink-3">Works in {orgName} through the host</p>
        </div>
      </div>
      <Card className="p-5 space-y-4 max-w-2xl">
        <p className="text-sm text-ink-2">Pin is your assistant for the Proxmox host. In {orgName} it acts under the name "Pin (host)", through the host, never inside a container. So there is nothing to resume, wake up or set up here.</p>
        <ul className="list-disc pl-5 space-y-1.5 text-sm text-ink-2">
          <li>Everything Pin may do is allowed one app and one action at a time. Anything not allowed is refused.</li>
          <li>Every action is recorded under Pin's name in Activity.</li>
          <li>You can allow or revoke what Pin may use at any time.</li>
        </ul>
        <div className="flex flex-wrap gap-2"><Link to={`${base}/connectors`}><Button variant="primary">What Pin may use</Button></Link><Link to={`${base}/activity`}><Button>See what Pin did</Button></Link></div>
      </Card>
    </>
  );
}

export function LiveAgents() {
  const { org, companyId } = useLiveOrg();
  const { setup } = useEngine();
  const b = `/${setup?.deviceName ?? "pve"}/${org.slug}`;
  const agents = useAgents(companyId);
  const pinTeammate = usePinIdentity(companyId);
  const names = useNames(companyId);
  const [params, setParams] = useSearchParams();
  const creating = params.get("new") === "1";
  const setCreating = (v: boolean) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set("new", "1"); else n.delete("new"); return n; }, { replace: !v });
  const all = (agents.data ?? []).filter((a) => a.status !== "terminated");
  const [q, setQ] = useState("");
  const view = params.get("view") === "chart" ? "chart" : "list";
  const setView = (v: "list" | "chart") => setParams((p) => { const n = new URLSearchParams(p); if (v === "list") n.delete("view"); else n.set("view", v); return n; }, { replace: true });
  const needle = q.trim().toLowerCase();
  const list = needle ? all.filter((a) => [a.name, a.title, a.role, a.adapterType].some((x) => typeof x === "string" && x.toLowerCase().includes(needle))) : all;
  const latestRuns = useLatestRuns(companyId, list.map((a) => a.id));
  const latestByAgent = new Map(list.map((agent, index) => [agent.id, latestRuns[index]?.data]));
  const readiness = useAgentReadiness(companyId, list);
  const working = all.filter((a) => a.status === "running").length;
  return (
    <PageFrame width="6xl">
      <PageHeader title="Agents" subtitle={agents.data ? `${working} of ${all.length} working.` : undefined} actions={<Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New agent</Button>} />
      {agents.isPending && <Card><Loading label="Loading agents" /></Card>}
      {agents.error && <Card><LoadError error={agents.error} retry={() => void agents.refetch()} /></Card>}
      {agents.data && list.length === 0 && <Card><EmptyState icon={<Bot className="h-5 w-5" />} title="No agents yet" body="Create an agent, give it a role, and assign it tasks." action={<Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New agent</Button>} /></Card>}
      {pinTeammate.data && (
        <Card className="p-4 mb-4 flex items-center gap-4">
          <PinOrb size={44} />
          <div className="flex-1 min-w-0">
            <div className="font-medium">Pin <span className="ml-1 text-compact font-normal text-ink-3">works in {org.name} through the host</span></div>
            <p className="text-compact text-ink-3">Everything Pin does here is allowed one app and one action at a time, and recorded under Pin's name. Pin never runs inside a container, so it has no sandbox to set up.</p>
          </div>
          <Link to={`${b}/connectors`} className="text-compact text-accent whitespace-nowrap">What Pin may use</Link>
        </Card>
      )}
      {all.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
            <Input aria-label="Search agents" className="pl-9" placeholder="Search agents..." value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Segmented label="View" value={view} onChange={(v) => setView(v as "list" | "chart")} options={[{ value: "list", label: "List" }, { value: "chart", label: "Org chart" }]} />
          <span className="ml-auto text-compact text-ink-3">{list.length} {list.length === 1 ? "agent" : "agents"}</span>
        </div>
      )}
      {all.length > 0 && list.length === 0 && <Card><p className="px-5 py-4 text-sm text-ink-3">No agent matches "{q}".</p></Card>}
      {view === "chart" && list.length > 0 && <OrgChartCanvas list={list} companyId={companyId} base={b} />}
      {view === "list" && list.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-compact text-ink-3">
                <th scope="col" className="px-5 py-3 font-normal">Agent</th>
                <th scope="col" className="px-4 py-3 font-normal">Harness</th>
                <th scope="col" className="px-4 py-3 font-normal">Connection</th>
                <th scope="col" className="px-4 py-3 font-normal">Default model</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.map((a) => {
                const [kind, label] = agentStatusOf(a.status, (a as { lifecycleState?: unknown }).lifecycleState);
                const ready = readiness.get(a.id);
                const rc = (a as unknown as { runtimeConfig?: { aiConnection?: { mode?: string } } }).runtimeConfig;
                const connection = !accountProviderOf(a.adapterType) ? "Not needed" : rc?.aiConnection?.mode === "responsible_user" ? "Your account" : rc?.aiConnection ? "Organization account" : "Not connected";
                const model = typeof a.adapterConfig?.model === "string" ? a.adapterConfig.model : "Default";
                return (
                  <tr key={a.id} className="hover:bg-surface-2/50">
                    <td className="px-5 py-3">
                      <Link to={`${b}/agents/${a.id}`} className="flex items-center gap-3 min-w-0">
                        <AgentAvatar name={a.name} hue={org.hue + 40} size={40} />
                        <span className="min-w-0">
                          <span className="block font-medium truncate">{a.name}</span>
                          <span className="block text-xs text-ink-3 truncate">{names.role(a)}{a.title ? ` · ${a.title}` : ""}{a.lastHeartbeatAt ? ` · ran ${ago(a.lastHeartbeatAt)}` : ""}</span>
                        </span>
                        <span className="ml-auto flex shrink-0 items-center gap-2"><ReadinessPill readiness={ready} /><Status kind={kind} label={label} /></span>
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-ink-2 whitespace-nowrap">{a.adapterType}</td>
                    <td className={`px-4 py-3 whitespace-nowrap ${connection === "Not connected" ? "text-warning" : "text-ink-2"}`}>{connection}</td>
                    <td className="px-4 py-3 font-mono text-compact text-ink-2 whitespace-nowrap">{model}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
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
  const everyone = useAgents(companyId);
  const accounts = useQuery({ queryKey: ["connect", "org-ai", companyId], queryFn: () => connectApi.orgAi(companyId), retry: 1 });
  const giveMine = useGiveMyAccount(companyId);
  const skillSnap = useAgentSkills(companyId, agentId);
  const skillList = useSkills(companyId);
  const skillNames = (skillSnap.data?.supported ? skillSnap.data.desiredSkills : []).map((key) => (skillList.data ?? []).find((k) => k.key === key)?.name ?? key.split("/").pop() ?? key);
  const directReports = (everyone.data ?? []).filter((x) => x.reportsTo === agentId && x.status !== "terminated").length;
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
      {a && isPinIdentity(a) && <PinTeammate orgName={org.name} base={b} />}
      {a && !isPinIdentity(a) && (
        <>
          <div className="mb-8 flex flex-wrap items-start justify-between gap-x-4 gap-y-4">
            <div className="flex min-w-0 flex-1 basis-72 items-start gap-4">
              <AgentAvatar name={a.name} hue={org.hue + 40} size={64} className="mt-0.5" />
              <div className="min-w-0">
                <h1 className="text-heading sm:text-display font-semibold tracking-tight text-balance">{a.name}</h1>
                <p className="mt-1 text-compact text-ink-3">{agentIdentity(a.name).mood} · {agentIdentity(a.name).trait}</p>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink-2"><Status kind={kind} label={label} /><ReadinessPill readiness={current} /><span className="text-ink-3">{names.role(a)}</span></div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">

                {settingUp ? (
                  <Button onClick={() => act.mutate({ id: a.id, action: "retry" })} loading={act.isPending && act.variables?.action === "retry"} disabled={act.isPending}><RefreshCw className="h-4 w-4" />Check again</Button>
                ) : a.status === "paused" ? (
                  <Button onClick={() => act.mutate({ id: a.id, action: "resume" })} disabled={act.isPending}><Play className="h-4 w-4" />Resume</Button>
                ) : (
                  <Button onClick={() => act.mutate({ id: a.id, action: "pause" })} disabled={act.isPending || a.status === "terminated" || a.status === "pending_approval"}><Pause className="h-4 w-4" />Pause</Button>
                )}
                {a.status !== "terminated" && <Button variant="danger" onClick={() => terminate.ask({ title: `Terminate ${a.name}?`, body: "The agent stops for good and can't be brought back. Its tasks, comments and history stay.", label: "Terminate", danger: true, run: () => act.mutateAsync({ id: a.id, action: "terminate" }).catch(() => {}) })} disabled={act.isPending}><Ban className="h-4 w-4" />Terminate</Button>}
                <Button variant="primary" onClick={() => act.mutate({ id: a.id, action: "wakeup" })} disabled={!canRun || act.isPending || a.status === "paused" || a.status === "terminated" || a.status === "pending_approval"} disabledReason={canRun ? undefined : "Agents can't run until agent containers are set up"}><Zap className="h-4 w-4" />Wake up</Button>
            </div>
          </div>
          {terminate.dialog}
          {(() => {
            const provider = accountProviderOf(a.adapterType);
            const mine = provider ? (accounts.data?.connections ?? []).find((c) => c.provider === provider && c.status === "connected") : undefined;
            const modelBlocked = (current?.checks ?? []).some((c) => c.id === "model" && c.state === "blocked");
            if (!provider || !mine || !modelBlocked || hasAccountBinding(a)) return null;
            const nice = provider === "anthropic" ? "Claude" : "ChatGPT";
            return (
              <Notice tone="info" title={`Your ${nice} account is connected, but ${a.name} isn't using it yet`} className="mb-3">
                <p>Use it for {a.name}: its tasks will run with your {nice} login. Nothing is shared with anyone else.</p>
                <div className="mt-2"><Button variant="primary" size="sm" loading={giveMine.isPending} onClick={() => giveMine.mutate({ agent: a, provider, method: mine.method })}>Use my {nice} account{a.status === "paused" ? " and resume" : ""}</Button></div>
                <ActionError error={giveMine.error} />
              </Notice>
            );
          })()}
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
                <dt className="text-ink-3">Role</dt><dd>{names.role(a)}</dd>
                <dt className="text-ink-3">Title</dt><dd>{a.title || "Not set"}</dd>
                <dt className="text-ink-3">Direct reports</dt><dd>{directReports}</dd>
                <dt className="text-ink-3">Runs with</dt><dd>{a.adapterType}{typeof a.adapterConfig?.model === "string" ? ` · ${a.adapterConfig.model}` : ""}</dd>
                <dt className="text-ink-3">Reports to</dt><dd>{a.reportsTo ? names.agent(a.reportsTo) : "You"}</dd>
                <dt className="text-ink-3">Last ran</dt><dd>{ago(a.lastHeartbeatAt)}</dd>
                <dt className="text-ink-3">Spend</dt><dd>{a.budgetMonthlyCents ? `${dollars(a.spentMonthlyCents)} of ${dollars(a.budgetMonthlyCents)} this month` : `${dollars(a.spentMonthlyCents)} this month, no budget set`}</dd>
                {a.errorReason && <><dt className="text-ink-3">Error</dt><dd className="text-critical">{a.errorReason}</dd></>}
              </dl>
              <div className="mt-4"><div className="text-compact font-semibold uppercase tracking-label text-ink-3 mb-2">Capabilities</div>{a.capabilities ? <p className="text-compact text-ink-2 whitespace-pre-wrap">{a.capabilities}</p> : <p className="text-compact text-ink-3">No capability summary has been added.</p>}</div>
              <div className="mt-4"><div className="flex items-center justify-between mb-2"><div className="text-compact font-semibold uppercase tracking-label text-ink-3">Skills</div><button type="button" className="text-compact text-accent" onClick={() => setTab("skills")}>Manage</button></div>
                {skillNames.length === 0 ? <p className="text-compact text-ink-3">No skills turned on.</p> : <div className="flex flex-wrap gap-1.5">{skillNames.map((n) => <span key={n} className="rounded-full border border-line px-2.5 py-0.5 text-compact text-ink-2">{n}</span>)}</div>}
              </div>
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
