import { Link } from "react-router-dom";
import type { Agent, HeartbeatRun } from "@papercliped-engine/engine-client";
import { GitBranch } from "lucide-react";
import { useEngine } from "../../../data/store.tsx";
import { useAgents, useLatestRuns } from "../../../data/engine/queries.ts";
import { useAgentSettingsWrites } from "../../../data/engine/more.ts";
import { AgentAvatar, Card, EmptyState, PageFrame, PageHeader, Select, Status } from "../../../ui/primitives.tsx";
import { ActionError, LoadError, Loading, useLiveOrg } from "./common.tsx";
import { useNames } from "./names.ts";
import { agentStatusOf, latestRunStatusOf } from "../../../data/engine/labels.tsx";
import { forestRoots, wouldLoop } from "../../../data/orgTree.ts";

/** The live Paperclip organization tree. It deliberately renders engine data, never the demo store. */
export function LiveOrgChart() {
  const { companyId, org } = useLiveOrg();
  const { setup } = useEngine();
  const agents = useAgents(companyId);
  const names = useNames(companyId);
  const list = (agents.data ?? []).filter((a) => a.status !== "terminated");
  const latestRuns = useLatestRuns(companyId, list.map((a) => a.id));
  const latestByAgent = new Map(list.map((agent, index) => [agent.id, latestRuns[index]?.data]));
  const roots = forestRoots(list);
  const base = `/${setup?.deviceName ?? "pve"}/${org.slug}`;
  return (
    <PageFrame width="6xl">
      <PageHeader title="Organization chart" subtitle="The real reporting structure for this organization. Change an agent’s manager directly from the chart." />
      {agents.isPending && <Card><Loading label="Loading agents" /></Card>}
      {agents.error && <Card><LoadError error={agents.error} retry={() => void agents.refetch()} /></Card>}
      {agents.data && list.length === 0 && <Card><EmptyState icon={<GitBranch className="h-5 w-5" />} title="No agents yet" body="Create an agent and it will appear here." /></Card>}
      {roots.length > 0 && <div className="overflow-x-auto pb-4"><div className="min-w-max flex gap-8 justify-center px-6 py-5">{roots.map((a) => <Branch key={a.id} agent={a} all={list} latestByAgent={latestByAgent} companyId={companyId} names={names} base={base} seen={new Set()} />)}</div></div>}
    </PageFrame>
  );
}

function Branch({ agent, all, latestByAgent, companyId, names, base, seen }: { agent: Agent; all: Agent[]; latestByAgent: Map<string, HeartbeatRun | null | undefined>; companyId: string; names: ReturnType<typeof useNames>; base: string; seen: Set<string> }) {
  if (seen.has(agent.id)) return null;
  const next = new Set(seen); next.add(agent.id);
  const reports = all.filter((a) => a.reportsTo === agent.id && !next.has(a.id));
  return <div className="flex flex-col items-center"><AgentNode agent={agent} all={all} latestRun={latestByAgent.get(agent.id)} companyId={companyId} names={names} base={base} />{reports.length > 0 && <><div className="h-7 w-px bg-line-strong" /><div className="flex items-start gap-6 border-t border-line-strong pt-7">{reports.map((a) => <Branch key={a.id} agent={a} all={all} latestByAgent={latestByAgent} companyId={companyId} names={names} base={base} seen={next} />)}</div></>}</div>;
}

function AgentNode({ agent, all, latestRun, companyId, names, base }: { agent: Agent; all: Agent[]; latestRun: HeartbeatRun | null | undefined; companyId: string; names: ReturnType<typeof useNames>; base: string }) {
  const write = useAgentSettingsWrites(companyId, agent.id);
  const [kind, label] = agentStatusOf(agent.status, (agent as { lifecycleState?: unknown }).lifecycleState);
  const latest = latestRunStatusOf(latestRun);
  return <Card className="w-64 p-4"><Link to={`${base}/agents/${agent.id}`} className="flex items-center gap-3 hover:text-ink"><AgentAvatar name={agent.name} hue={210} size={36} /><div className="min-w-0 flex-1"><div className="font-medium truncate">{agent.name}</div><div className="text-xs text-ink-3 truncate">{names.role(agent)}</div></div><Status kind={kind} label={label} /></Link>{latest && <div className="mt-2"><Status kind={latest[0]} label={`Latest run: ${latest[1]}`} /></div>}<label className="block mt-3 text-xs text-ink-3">Reports to<Select value={agent.reportsTo ?? ""} disabled={write.update.isPending} className="mt-1 h-8 text-xs" onChange={(e) => write.update.mutate({ reportsTo: e.target.value || null })}><option value="">You</option>{all.filter((a) => a.id !== agent.id).map((a) => <option key={a.id} value={a.id} disabled={wouldLoop(all, agent.id, a.id)}>{a.name}</option>)}</Select></label><ActionError error={write.update.error} /></Card>;
}
