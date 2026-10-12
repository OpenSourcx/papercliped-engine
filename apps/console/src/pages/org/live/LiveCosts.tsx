import { useState } from "react";
import { CircleDollarSign } from "lucide-react";
import type { BudgetPolicySummary } from "@papercliped-engine/engine-client";
import { dollars } from "../../../data/engine/map.ts";
import { useAgents, useCosts } from "../../../data/engine/queries.ts";
import { useBudgets, useBudgetWrites, useCostBreakdown, useOrgSettingsWrites } from "../../../data/engine/more.ts";
import { BarMeter } from "../../../ui/meters.tsx";
import { Avatar, Button, Card, Chip, EmptyState, Input, Notice, PageFrame, PageHeader, SectionTitle, Tabs } from "../../../ui/primitives.tsx";
import { ActionError, LoadError, Loading, useLiveOrg } from "./common.tsx";

type View = "agent" | "project" | "provider" | "model";
const centsOf = (dollarsText: string): number | null => {
  const n = Number(dollarsText.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
const tokens = (n: number) => n.toLocaleString();

/** One row of a spend breakdown: a name, tokens and a bar sized against the largest row. */
function Row({ name, sub, cents, max, hue }: { name: string; sub: string; cents: number; max: number; hue?: number }) {
  return (
    <div className="flex items-center gap-3 px-5 py-3">
      {hue !== undefined && <Avatar name={name} hue={hue} size={28} />}
      <span className="w-40 text-sm truncate" title={name}>{name}</span>
      <BarMeter className="flex-1" label={sub} pct={(cents / Math.max(1, max)) * 100} value={dollars(cents)} />
    </div>
  );
}

function PolicyRow({ p }: { p: BudgetPolicySummary }) {
  const tone = p.status === "hard_stop" ? "critical" : p.status === "warning" ? "warning" : "neutral";
  return (
    <div className="flex flex-wrap items-center gap-3 px-5 py-3">
      <div className="w-40 min-w-0"><div className="text-sm truncate">{p.scopeName}</div><div className="text-xs text-ink-3 capitalize">{p.scopeType}</div></div>
      <BarMeter className="flex-1 min-w-48" label={`${dollars(p.observedAmount)} of ${dollars(p.amount)} this month`} pct={p.utilizationPercent} value={`${Math.round(p.utilizationPercent)}%`} />
      {p.paused ? <Chip tone="critical">Paused</Chip> : p.status !== "ok" ? <Chip tone={tone}>{p.status === "hard_stop" ? "Limit reached" : "Nearly there"}</Chip> : null}
    </div>
  );
}

export function LiveCosts() {
  const { companyId, org } = useLiveOrg();
  const costs = useCosts(companyId);
  const breakdown = useCostBreakdown(companyId);
  const budgets = useBudgets(companyId);
  const agents = useAgents(companyId);
  const bw = useBudgetWrites(companyId);
  const ow = useOrgSettingsWrites(companyId);
  const [view, setView] = useState<View>("agent");
  const [orgBudget, setOrgBudget] = useState<string | null>(null);
  const [agentBudget, setAgentBudget] = useState<Record<string, string>>({});
  const s = costs.data?.summary;
  const incidents = budgets.data?.activeIncidents ?? [];
  const policies = budgets.data?.policies ?? [];
  const warn = policies.filter((p) => p.isActive && p.status !== "ok" && !incidents.some((i) => i.policyId === p.policyId));

  const byAgent = [...(costs.data?.byAgent ?? [])].sort((a, b) => b.costCents - a.costCents);
  const byProject = [...(breakdown.data?.byProject ?? [])].sort((a, b) => b.costCents - a.costCents);
  const byProvider = [...(breakdown.data?.byProvider ?? [])].sort((a, b) => b.costCents - a.costCents);
  const providers = new Map<string, number>();
  for (const r of byProvider) providers.set(r.provider, (providers.get(r.provider) ?? 0) + r.costCents);
  const providerRows = [...providers.entries()].sort((a, b) => b[1] - a[1]);
  const modelRows = byProvider;
  const rows = { agent: byAgent.length, project: byProject.length, provider: providerRows.length, model: modelRows.length }[view];
  const max = Math.max(1, ...byAgent.map((r) => r.costCents), ...byProject.map((r) => r.costCents), ...byProvider.map((r) => r.costCents), ...providerRows.map(([, c]) => c));

  const saveOrgBudget = () => {
    const c = centsOf(orgBudget ?? "");
    if (c !== null) ow.budget.mutate(c, { onSuccess: () => setOrgBudget(null) });
  };

  return (
    <PageFrame width="4xl">
      <PageHeader title="Costs" subtitle="What your agents spend this month, and the limits that keep it in check." />
      {costs.isPending && <Card><Loading /></Card>}
      {costs.error && <Card><LoadError error={costs.error} retry={() => void costs.refetch()} /></Card>}

      {(incidents.length > 0 || warn.length > 0) && (
        <div className="space-y-2 mb-4" aria-label="Budget alerts">
          {incidents.map((i) => (
            <Notice key={i.id} tone={i.thresholdType === "hard" ? "critical" : "warning"} title={`${i.scopeName}: ${i.thresholdType === "hard" ? "budget limit reached" : "budget warning"}`}
              action={i.thresholdType === "hard" ? (
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" loading={bw.resolve.isPending} onClick={() => bw.resolve.mutate({ incidentId: i.id, action: "keep_paused" })}>Keep paused</Button>
                  <Button size="sm" variant="primary" loading={bw.resolve.isPending} onClick={() => bw.resolve.mutate({ incidentId: i.id, action: "raise_budget_and_resume", amount: Math.ceil(i.amountLimit * 1.25) })}>Raise 25% and resume</Button>
                </div>
              ) : undefined}>
              {dollars(i.amountObserved)} spent of {dollars(i.amountLimit)}.
            </Notice>
          ))}
          {warn.map((p) => <Notice key={p.policyId} tone={p.status === "hard_stop" ? "critical" : "warning"} title={`${p.scopeName} is at ${Math.round(p.utilizationPercent)}% of its budget`}>{dollars(p.observedAmount)} of {dollars(p.amount)} this month.</Notice>)}
          <ActionError error={bw.resolve.error} />
        </div>
      )}

      {s && (
        <Card className="p-5 mb-6">
          <div className="flex flex-wrap items-baseline gap-2"><CircleDollarSign className="h-5 w-5 text-ink-3 self-center" /><span className="text-display font-semibold tabular-nums">{dollars(s.spendCents)}</span><span className="text-ink-3">{s.budgetCents ? `of ${dollars(s.budgetCents)} budgeted` : "spent, no budget set"}</span></div>
          {s.budgetCents ? <BarMeter className="mt-3" label="Month to date" pct={s.utilizationPercent} value={`${Math.round(s.utilizationPercent)}%`} /> : null}
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <label className="block"><span className="block text-compact font-medium text-ink-2 mb-1.5">Monthly budget for {org.name} (US dollars)</span>
              <Input aria-label="Monthly budget in dollars" inputMode="decimal" className="w-48" value={orgBudget ?? (s.budgetCents ? String(s.budgetCents / 100) : "")} onChange={(e) => setOrgBudget(e.target.value)} placeholder="0 means no limit" /></label>
            <Button disabled={orgBudget === null || centsOf(orgBudget) === null} loading={ow.budget.isPending} onClick={saveOrgBudget}>Save budget</Button>
          </div>
          <ActionError error={ow.budget.error} />
        </Card>
      )}

      <SectionTitle>Spend</SectionTitle>
      <Tabs value={view} onChange={setView} className="mb-3" tabs={[{ id: "agent", label: "By agent" }, { id: "project", label: "By project" }, { id: "provider", label: "By provider" }, { id: "model", label: "By model" }]} />
      <Card className="divide-y divide-line mb-6">
        {breakdown.error && <LoadError error={breakdown.error} retry={() => void breakdown.refetch()} />}
        {costs.data && rows === 0 && !breakdown.isPending && <EmptyState icon={<CircleDollarSign className="h-5 w-5" />} title="No spend yet" body="Costs show up here once agents start running." />}
        {view === "agent" && byAgent.map((r) => <Row key={r.agentId} name={r.agentName ?? "Removed agent"} hue={210} cents={r.costCents} max={max} sub={`${tokens(r.inputTokens + r.outputTokens)} tokens · ${r.apiRunCount + r.subscriptionRunCount} runs`} />)}
        {view === "project" && byProject.map((r) => <Row key={r.projectId ?? "none"} name={r.projectName ?? "No project"} cents={r.costCents} max={max} sub={`${tokens(r.inputTokens + r.outputTokens)} tokens`} />)}
        {view === "provider" && providerRows.map(([name, cents]) => <Row key={name} name={name} cents={cents} max={max} sub={`${byProvider.filter((x) => x.provider === name).length} models`} />)}
        {view === "model" && modelRows.map((r) => <Row key={`${r.provider}/${r.model}`} name={r.model} cents={r.costCents} max={max} sub={`${r.provider} · ${tokens(r.inputTokens + r.outputTokens)} tokens · ${r.billingType === "subscription_included" ? "subscription" : "billed per use"}`} />)}
      </Card>

      <SectionTitle>Agent budgets</SectionTitle>
      <Card className="divide-y divide-line mb-6">
        {agents.data && agents.data.filter((a) => a.status !== "terminated").length === 0 && <p className="px-5 py-4 text-sm text-ink-3">No agents yet.</p>}
        {(agents.data ?? []).filter((a) => a.status !== "terminated").map((a) => {
          const value = agentBudget[a.id] ?? (a.budgetMonthlyCents ? String(a.budgetMonthlyCents / 100) : "");
          const cents = centsOf(value);
          const dirty = agentBudget[a.id] !== undefined;
          return (
            <div key={a.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <Avatar name={a.name} hue={210} size={28} />
              <span className="w-32 text-sm truncate">{a.name}</span>
              <BarMeter className="flex-1 min-w-48" label="This month" pct={a.budgetMonthlyCents ? (a.spentMonthlyCents / a.budgetMonthlyCents) * 100 : 0} value={a.budgetMonthlyCents ? `${dollars(a.spentMonthlyCents)} of ${dollars(a.budgetMonthlyCents)}` : `${dollars(a.spentMonthlyCents)}, no limit`} />
              <Input aria-label={`Monthly budget for ${a.name} in dollars`} inputMode="decimal" className="w-28" value={value} onChange={(e) => setAgentBudget({ ...agentBudget, [a.id]: e.target.value })} placeholder="No limit" />
              <Button size="sm" disabled={!dirty || cents === null} loading={bw.agent.isPending && bw.agent.variables?.agentId === a.id} onClick={() => cents !== null && bw.agent.mutate({ agentId: a.id, cents }, { onSuccess: () => setAgentBudget(({ [a.id]: _gone, ...rest }) => rest) })}>Save</Button>
            </div>
          );
        })}
      </Card>
      <ActionError error={bw.agent.error} />

      <SectionTitle>Budget policies</SectionTitle>
      <Card className="divide-y divide-line">
        {budgets.isPending && <Loading />}
        {budgets.error && <LoadError error={budgets.error} retry={() => void budgets.refetch()} />}
        {budgets.data && policies.length === 0 && <p className="px-5 py-4 text-sm text-ink-3">No limits are set. Saving a budget above creates a monthly policy that warns at 80% and pauses at the limit.</p>}
        {policies.map((p) => <PolicyRow key={p.policyId} p={p} />)}
      </Card>
    </PageFrame>
  );
}
