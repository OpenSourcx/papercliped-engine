import { Link, Navigate, useParams } from "react-router-dom";
import { Box, Cable, CircleCheck, CircleDot, Circle, OctagonAlert, Sparkles } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import type { Agent } from "../data/types.ts";
import { formatBytes } from "../lib/storage.ts";
import { BarMeter } from "../ui/meters.tsx";
import { Avatar, Card, Chip, PageHeader, SectionTitle, Status, type StatusKind, PageFrame } from "../ui/primitives.tsx";

const AGENT_STATUS: Record<Agent["status"], [StatusKind, string]> = { working: ["working", "Working"], idle: ["idle", "Idle"], paused: ["paused", "Paused"], error: ["critical", "Error"] };
const TASK_ICON = { todo: <Circle className="h-4 w-4 text-ink-3" />, in_progress: <CircleDot className="h-4 w-4 text-accent" />, done: <CircleCheck className="h-4 w-4 text-good" />, blocked: <OctagonAlert className="h-4 w-4 text-critical" /> };
const TASK_LABEL = { todo: "To do", in_progress: "In progress", done: "Done", blocked: "Blocked" };

export function OrgDashboard() {
  const { org: slug } = useParams();
  const { setup, data } = useEngine();
  const device = setup?.deviceName ?? "pve";
  const org = data.orgs.find((o) => o.slug === slug);
  if (!org) return <Navigate to={`/${device}/home`} replace />;
  const rg = org.resourceGroup;
  const working = org.agents.filter((a) => a.status === "working").length;
  const guests = data.guests.filter((g) => g.org === org.slug);
  const connectors = data.connectors.filter((c) => c.access.orgs.includes(org.slug));
  const members = data.users.filter((u) => u.orgs.some((o) => o.slug === org.slug));

  return (
    <PageFrame width="6xl">
      <PageHeader
        eyebrow={<Link to={`/${device}/home`} className="hover:text-ink">{device}</Link>}
        title={<span className="inline-flex items-center gap-3"><Avatar name={org.name} hue={org.hue} size={40} />{org.name}</span>}
        subtitle={<>{working ? <Status kind="working" label={`${working} of ${org.agents.length} agents working`} /> : <Status kind="idle" label="Idle" />}{org.createdBy === "pin" && <Chip tone="accent" className="ml-2"><Sparkles className="h-3 w-3" />Created by Pin</Chip>}</>}
      />

      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="p-5 lg:col-span-2">
          <SectionTitle>Resource group</SectionTitle>
          <div className="grid sm:grid-cols-2 gap-5">
            <BarMeter label="CPU" pct={(org.usage.cpuCores / rg.cores) * 100} value={`${org.usage.cpuCores.toFixed(1)} of ${rg.cores} cores`} />
            <BarMeter label="Memory" pct={(org.usage.memoryMb / rg.memoryMb) * 100} value={`${formatBytes(org.usage.memoryMb * 1024 ** 2)} of ${formatBytes(rg.memoryMb * 1024 ** 2)}`} />
            <BarMeter label="Disk" pct={(org.usage.diskGb / rg.diskGb) * 100} value={`${org.usage.diskGb} of ${rg.diskGb} GB`} />
            <BarMeter label="Containers" pct={(org.usage.guests / rg.maxGuests) * 100} value={`${org.usage.guests} of ${rg.maxGuests}`} />
          </div>
          <p className="text-[12px] text-ink-3 mt-4">Agents in {org.name} can only use what's inside this group (Proxmox pool <span className="font-mono">{rg.pool}</span>). Pin can resize it.</p>
        </Card>
        <Card className="p-5">
          <SectionTitle>Access</SectionTitle>
          <div className="space-y-2.5">
            {members.map((u) => (
              <div key={u.id} className="flex items-center gap-2.5">
                <Avatar name={u.name} hue={210} size={26} />
                <span className="text-[14px] flex-1 truncate">{u.name}</span>
                <span className="text-[12px] text-ink-3 capitalize">{u.orgs.find((o) => o.slug === org.slug)?.role}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 pt-3 border-t border-line">
            <div className="text-[12px] text-ink-3 mb-2 flex items-center gap-1.5"><Cable className="h-3.5 w-3.5" />Connectors</div>
            <div className="flex flex-wrap gap-1.5">{connectors.length ? connectors.map((c) => <Chip key={c.id}>{c.name}</Chip>) : <span className="text-[13px] text-ink-3">None granted</span>}</div>
          </div>
        </Card>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mt-4">
        <Card className="p-5">
          <SectionTitle>Agents</SectionTitle>
          <div className="divide-y divide-line">
            {org.agents.length === 0 && <p className="text-[14px] text-ink-3 py-2">No agents yet. Ask Pin to hire one.</p>}
            {org.agents.map((a) => {
              const [kind, label] = AGENT_STATUS[a.status];
              return (
                <div key={a.id} className="flex items-center gap-3 py-3">
                  <Avatar name={a.name} hue={org.hue + 40} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium">{a.name} <span className="text-ink-3 font-normal">· {a.role}</span></div>
                    <div className="text-[12px] text-ink-3 truncate">{a.task ?? `${a.adapter} · ${a.engine === "native" ? "runs natively" : "runs in a container session"}`}</div>
                  </div>
                  <Status kind={kind} label={label} />
                </div>
              );
            })}
          </div>
        </Card>
        <Card className="p-5">
          <SectionTitle>Tasks</SectionTitle>
          <div className="divide-y divide-line">
            {org.tasks.length === 0 && <p className="text-[14px] text-ink-3 py-2">No tasks yet.</p>}
            {org.tasks.map((t) => (
              <div key={t.id} className="flex items-center gap-3 py-3">
                <span title={TASK_LABEL[t.status]}>{TASK_ICON[t.status]}</span>
                <span className="flex-1 text-[14px] truncate">{t.title}</span>
                <span className="text-[12px] text-ink-3">{TASK_LABEL[t.status]}{t.agent ? ` · ${t.agent}` : ""}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

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
                  <BarMeter className="mt-1.5" label="Memory" pct={(g.memUsed / g.memMax) * 100} value={`${formatBytes(g.memUsed)} of ${formatBytes(g.memMax)}`} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </PageFrame>
  );
}
