import { useState } from "react";
import { Link } from "react-router-dom";
import { Bot, Box, CircleDollarSign, ListChecks, Vote } from "lucide-react";
import { useEngine } from "../../../data/store.tsx";
import { ago, dollars } from "../../../data/engine/map.ts";
import { ISSUE_ICON, ISSUE_LABEL, agentStatusOf, isOpen } from "../../../data/engine/labels.tsx";
import { useActivity, useAgents, useDashboard, useIssues, useResourceGroup, useSetResourceGroup } from "../../../data/engine/queries.ts";
import { suggestSize } from "../../../pin/brain.ts";
import { formatBytes } from "../../../lib/storage.ts";
import { BarMeter } from "../../../ui/meters.tsx";
import { Avatar, Button, Card, PageFrame, PageHeader, SectionTitle, Status } from "../../../ui/primitives.tsx";
import { ActionError, LoadError, Loading, useLiveOrg } from "./common.tsx";
import { describeActivity, useNames } from "./names.ts";

function Stat({ icon, value, label, to }: { icon: React.ReactNode; value: string; label: string; to: string }) {
  return (
    <Link to={to}>
      <Card interactive className="p-4 flex items-center gap-3">
        <span className="h-9 w-9 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2">{icon}</span>
        <div>
          <div className="text-[20px] font-semibold tabular-nums leading-tight">{value}</div>
          <div className="text-[12px] text-ink-3">{label}</div>
        </div>
      </Card>
    </Link>
  );
}

/** The organization's resource group: its Proxmox pool and limits, or a way to set one up if it has none. */
function ResourceGroupCard() {
  const { org, companyId } = useLiveOrg();
  const engine = useEngine();
  const rg = useResourceGroup(companyId);
  const set = useSetResourceGroup(companyId, org.name);
  const [suggested] = useState(() => suggestSize(engine.host, engine.data));
  const g = org.resourceGroup;
  return (
    <Card className="p-5 lg:col-span-2">
      <SectionTitle>Resource group</SectionTitle>
      {rg.isPending ? (
        <Loading />
      ) : rg.error ? (
        <LoadError error={rg.error} retry={() => void rg.refetch()} />
      ) : !rg.group ? (
        <div>
          <p className="text-[14px] text-ink-2">{org.name} has no resource group yet, so its agents have nowhere on this device to run containers.</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button onClick={() => set.mutate(suggested)} disabled={set.isPending}>Create one ({suggested.cores} cores, {formatBytes(suggested.memoryMb * 1024 ** 2)}, {suggested.diskGb} GB)</Button>
          </div>
          <ActionError error={set.error} />
        </div>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 gap-5">
            <BarMeter label="CPU" pct={g.cores ? (org.usage.cpuCores / g.cores) * 100 : 0} value={`${org.usage.cpuCores.toFixed(1)} of ${g.cores} cores`} />
            <BarMeter label="Memory" pct={g.memoryMb ? (org.usage.memoryMb / g.memoryMb) * 100 : 0} value={`${formatBytes(org.usage.memoryMb * 1024 ** 2)} of ${formatBytes(g.memoryMb * 1024 ** 2)}`} />
            <BarMeter label="Disk" pct={g.diskGb ? (org.usage.diskGb / g.diskGb) * 100 : 0} value={`${org.usage.diskGb.toFixed(0)} of ${g.diskGb} GB`} />
            <BarMeter label="Containers" pct={g.maxGuests ? (org.usage.guests / g.maxGuests) * 100 : 0} value={`${org.usage.guests} of ${g.maxGuests}`} />
          </div>
          <p className="text-[12px] text-ink-3 mt-4">Agents in {org.name} can only use what's inside this group (Proxmox pool <span className="font-mono">{g.pool}</span>).</p>
        </>
      )}
    </Card>
  );
}

export function LiveDashboard() {
  const { org, companyId } = useLiveOrg();
  const { setup } = useEngine();
  const device = setup?.deviceName ?? "pve";
  const b = `/${device}/${org.slug}`;
  const dash = useDashboard(companyId);
  const agents = useAgents(companyId);
  const issues = useIssues(companyId);
  const activity = useActivity(companyId);
  const names = useNames(companyId);
  const d = dash.data;
  const working = (agents.data ?? []).filter((a) => a.status === "running").length;
  const live = (agents.data ?? []).filter((a) => a.status !== "terminated");
  const open = (issues.data ?? []).filter((i) => isOpen(i.status));

  return (
    <PageFrame width="6xl">
      <PageHeader
        eyebrow={<Link to={`/${device}/home`} className="hover:text-ink">{device}</Link>}
        title={<span className="inline-flex items-center gap-3"><Avatar name={org.name} hue={org.hue} size={40} />{org.name}</span>}
        subtitle={<>{working ? <Status kind="working" label={`${working} of ${live.length} agents working`} /> : <Status kind="idle" label={live.length ? "Idle" : "No agents yet"} />}<span className="text-ink-3 text-[13px] ml-3 font-mono">{org.engine?.prefix}</span></>}
      />

      {dash.error && <Card className="mb-4"><LoadError error={dash.error} retry={() => void dash.refetch()} /></Card>}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Stat icon={<Bot className="h-4 w-4" />} value={d ? String(d.agents.active + d.agents.running + d.agents.paused + d.agents.error) : "–"} label={d ? `${d.agents.running} working · ${d.agents.paused} paused${d.agents.error ? ` · ${d.agents.error} with errors` : ""}` : "Agents"} to={`${b}/agents`} />
        <Stat icon={<ListChecks className="h-4 w-4" />} value={d ? String(d.tasks.open) : "–"} label={d ? `Open tasks · ${d.tasks.inProgress} in progress${d.tasks.blocked ? ` · ${d.tasks.blocked} blocked` : ""}` : "Open tasks"} to={`${b}/tasks`} />
        <Stat icon={<Vote className="h-4 w-4" />} value={d ? String(d.pendingApprovals) : "–"} label="Waiting for your decision" to={`${b}/decisions`} />
        <Stat icon={<CircleDollarSign className="h-4 w-4" />} value={d ? dollars(d.costs.monthSpendCents) : "–"} label={d && d.costs.monthBudgetCents ? `Spent this month of ${dollars(d.costs.monthBudgetCents)}` : "Spent this month"} to={`${b}/costs`} />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <ResourceGroupCard />
        <Card className="p-5">
          <SectionTitle action={<Link to={`${b}/activity`} className="text-[13px] text-ink-3 hover:text-ink">All</Link>}>Recent activity</SectionTitle>
          {activity.isPending ? <Loading /> : activity.error ? <LoadError error={activity.error} retry={() => void activity.refetch()} /> : (
            <div className="space-y-2.5">
              {(activity.data ?? []).length === 0 && <p className="text-[14px] text-ink-3">Nothing has happened yet.</p>}
              {(activity.data ?? []).slice(0, 6).map((a) => (
                <div key={a.id} className="text-[13px]">
                  <span className="font-medium">{names.actor(a)}</span> <span className="text-ink-2">{describeActivity(a)}</span>
                  <div className="text-[12px] text-ink-3">{ago(a.createdAt)}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mt-4">
        <Card className="p-5">
          <SectionTitle action={<Link to={`${b}/agents`} className="text-[13px] text-ink-3 hover:text-ink">All</Link>}>Agents</SectionTitle>
          {agents.isPending ? <Loading /> : agents.error ? <LoadError error={agents.error} retry={() => void agents.refetch()} /> : (
            <div className="divide-y divide-line">
              {live.length === 0 && <p className="text-[14px] text-ink-3 py-2">No agents yet. <Link className="text-accent hover:underline" to={`${b}/agents?new=1`}>Create one</Link>.</p>}
              {live.slice(0, 6).map((a) => {
                const [kind, label] = agentStatusOf(a.status);
                return (
                  <Link key={a.id} to={`${b}/agents/${a.id}`} className="flex items-center gap-3 py-3 hover:bg-surface-2/40 -mx-2 px-2 rounded-md">
                    <Avatar name={a.name} hue={org.hue + 40} size={32} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-medium">{a.name} <span className="text-ink-3 font-normal">· {names.role(a)}</span></div>
                      <div className="text-[12px] text-ink-3 truncate">{a.adapterType}{a.lastHeartbeatAt ? ` · last ran ${ago(a.lastHeartbeatAt)}` : ""}</div>
                    </div>
                    <Status kind={kind} label={label} />
                  </Link>
                );
              })}
            </div>
          )}
        </Card>
        <Card className="p-5">
          <SectionTitle action={<Link to={`${b}/tasks`} className="text-[13px] text-ink-3 hover:text-ink">All</Link>}>Open tasks</SectionTitle>
          {issues.isPending ? <Loading /> : issues.error ? <LoadError error={issues.error} retry={() => void issues.refetch()} /> : (
            <div className="divide-y divide-line">
              {open.length === 0 && <p className="text-[14px] text-ink-3 py-2">No open tasks.</p>}
              {open.slice(0, 6).map((t) => (
                <Link key={t.id} to={`${b}/tasks/${t.identifier ?? t.id}`} className="flex items-center gap-3 py-3 hover:bg-surface-2/40 -mx-2 px-2 rounded-md">
                  <span title={ISSUE_LABEL[t.status]}>{ISSUE_ICON[t.status]}</span>
                  <span className="flex-1 text-[14px] truncate">{t.title}</span>
                  <span className="text-[12px] text-ink-3">{ISSUE_LABEL[t.status]}{t.assigneeAgentId ? ` · ${names.agent(t.assigneeAgentId)}` : ""}</span>
                </Link>
              ))}
            </div>
          )}
        </Card>
      </div>

      <MachinesCard />
    </PageFrame>
  );
}

function MachinesCard() {
  const { org } = useLiveOrg();
  const { data } = useEngine();
  const guests = data.guests.filter((g) => g.org === org.slug);
  return (
    <Card className="p-5 mt-4">
      <SectionTitle>Container sessions</SectionTitle>
      {guests.length === 0 ? (
        <p className="text-[14px] text-ink-3">No containers running for {org.name}.</p>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {guests.map((g) => (
            <div key={g.vmid} className="rounded-lg border border-line p-3 flex items-center gap-3">
              <Box className="h-4 w-4 text-ink-3" />
              <div className="min-w-0 flex-1">
                <div className="text-[14px] truncate">{g.name} <span className="text-ink-3 tabular-nums">#{g.vmid}</span></div>
                <BarMeter className="mt-1.5" label="Memory" pct={g.memMax ? (g.memUsed / g.memMax) * 100 : 0} value={`${formatBytes(g.memUsed)} of ${formatBytes(g.memMax)}`} />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
