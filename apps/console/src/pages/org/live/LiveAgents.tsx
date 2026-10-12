import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Bot, Pause, Play, Plus, Zap } from "lucide-react";
import { AGENT_ROLES, type AgentRole } from "@papercliped-engine/engine-client";
import { useEngine } from "../../../data/store.tsx";
import { AGENT_ROLE_LABEL, ago, dollars } from "../../../data/engine/map.ts";
import { agentStatusOf } from "../../../data/engine/labels.tsx";
import { useAdapterModels, useAdapters, useAgent, useAgentAction, useAgents, useCreateAgent, useRuns } from "../../../data/engine/queries.ts";
import { BarMeter } from "../../../ui/meters.tsx";
import { Modal } from "../../../ui/Modal.tsx";
import { Avatar, Button, Card, EmptyState, Input, PageFrame, PageHeader, Status } from "../../../ui/primitives.tsx";
import { ActionError, Field, LoadError, Loading, selectClass, textareaClass, useLiveOrg } from "./common.tsx";
import { useNames } from "./names.ts";

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
  const working = list.filter((a) => a.status === "running").length;
  return (
    <PageFrame width="6xl">
      <PageHeader title="Agents" subtitle={agents.data ? `${working} of ${list.length} working.` : undefined} actions={<Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New agent</Button>} />
      {agents.isPending && <Card><Loading label="Loading agents" /></Card>}
      {agents.error && <Card><LoadError error={agents.error} retry={() => void agents.refetch()} /></Card>}
      {agents.data && list.length === 0 && <Card><EmptyState icon={<Bot className="h-5 w-5" />} title="No agents yet" body="Create an agent, give it a role, and assign it tasks." action={<Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New agent</Button>} /></Card>}
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
        {list.map((a) => {
          const [kind, label] = agentStatusOf(a.status);
          return (
            <Link key={a.id} to={`${b}/agents/${a.id}`} className="text-left">
              <Card interactive className="p-4 h-full">
                <div className="flex items-center gap-3"><Avatar name={a.name} hue={org.hue + 40} size={40} /><div className="flex-1 min-w-0"><div className="font-medium truncate">{a.name}</div><div className="text-xs text-ink-3 truncate">{names.role(a)} · {a.adapterType}</div></div><Status kind={kind} label={label} /></div>
                <div className="text-compact text-ink-2 mt-3 truncate">{a.reportsTo ? `Reports to ${names.agent(a.reportsTo)}` : "Reports to you"}{a.lastHeartbeatAt ? ` · last ran ${ago(a.lastHeartbeatAt)}` : ""}</div>
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
  useEffect(() => {
    if (!adapter && usable.length) setAdapter(usable.find((a) => a.type === "process")?.type ?? usable[0].type);
  }, [adapter, usable]);
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
            <select value={role} onChange={(e) => setRole(e.target.value as AgentRole)} className={selectClass}>
              {AGENT_ROLES.map((r) => <option key={r} value={r}>{AGENT_ROLE_LABEL[r]}</option>)}
            </select>
          </Field>
          <Field label="Reports to">
            <select value={reportsTo} onChange={(e) => setReportsTo(e.target.value)} className={selectClass}>
              <option value="">You</option>
              {(agents.data ?? []).filter((a) => a.status !== "terminated").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Runs with">
            {adapters.isPending ? <p className="text-compact text-ink-3 h-10 flex items-center">Loading…</p> : adapters.error ? <LoadError error={adapters.error} retry={() => void adapters.refetch()} /> : (
              <select value={adapter} onChange={(e) => setAdapter(e.target.value)} className={selectClass}>
                {usable.map((a) => <option key={a.type} value={a.type}>{a.label || a.type}</option>)}
              </select>
            )}
          </Field>
          {info && info.modelsCount > 0 && (
            <Field label="Model">
              <select value={model} onChange={(e) => setModel(e.target.value)} className={selectClass} disabled={models.isPending}>
                <option value="">{models.isPending ? "Loading…" : "Default"}</option>
                {(models.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
              </select>
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
  const a = agent.data;
  const [kind, label] = a ? agentStatusOf(a.status) : ["idle" as const, ""];
  return (
    <PageFrame width="4xl">
      <Link to={`${b}/agents`} className="inline-flex items-center gap-1.5 text-compact text-ink-3 hover:text-ink mb-4"><ArrowLeft className="h-3.5 w-3.5" />Agents</Link>
      {agent.isPending && <Card><Loading label="Loading agent" /></Card>}
      {agent.error && <Card><LoadError error={agent.error} retry={() => void agent.refetch()} /></Card>}
      {a && (
        <>
          <PageHeader
            title={<span className="inline-flex items-center gap-3"><Avatar name={a.name} hue={org.hue + 40} size={40} />{a.name}</span>}
            subtitle={<><Status kind={kind} label={label} /><span className="text-ink-3 text-sm ml-3">{names.role(a)}</span></>}
            actions={
              <>
                {a.status === "paused" ? (
                  <Button onClick={() => act.mutate({ id: a.id, action: "resume" })} disabled={act.isPending}><Play className="h-4 w-4" />Resume</Button>
                ) : (
                  <Button onClick={() => act.mutate({ id: a.id, action: "pause" })} disabled={act.isPending || a.status === "terminated" || a.status === "pending_approval"}><Pause className="h-4 w-4" />Pause</Button>
                )}
                <Button variant="primary" onClick={() => act.mutate({ id: a.id, action: "wakeup" })} disabled={act.isPending || a.status === "paused" || a.status === "terminated" || a.status === "pending_approval"}><Zap className="h-4 w-4" />Wake up</Button>
              </>
            }
          />
          <ActionError error={act.error} />
          {act.isSuccess && act.variables?.action === "wakeup" && <p className="text-compact text-ink-3 mb-3">Asked {a.name} to run now.</p>}
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
        </>
      )}
    </PageFrame>
  );
}
