import { useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { Archive, Box, Boxes, Cable, ChevronDown, CircleDollarSign, Database, FolderOpen, GitBranch, History, House, Gauge, Inbox, LayoutDashboard, ListTree, ListChecks, MessageCircle, Monitor, Network, Package, Repeat, Settings, Sparkles, SquareTerminal, Target, Users, Vote, Workflow } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import type { Guest, Org } from "../data/types.ts";
import { cn } from "../lib/storage.ts";

/**
 * The second column, like a Discord channel list. On the device it manages the machine; inside an organization it
 * carries Paperclip's navigation plus the organization's machines.
 */

function Item({ to, icon, children, count, end, muted }: { to: string; icon: ReactNode; children: ReactNode; count?: number | string; end?: boolean; muted?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => cn("group flex items-center gap-2 h-8 px-2 rounded-md text-[14px] transition-colors", isActive ? "bg-surface-3 text-ink" : muted ? "text-ink-3 hover:text-ink-2 hover:bg-surface-2" : "text-ink-2 hover:text-ink hover:bg-surface-2")}>
      <span className="text-ink-3 shrink-0">{icon}</span>
      <span className="flex-1 truncate">{children}</span>
      {count !== undefined && count !== 0 && <span className="text-[11px] tabular-nums text-ink-3">{count}</span>}
    </NavLink>
  );
}

function Section({ label, children, action, id }: { label: string; children: ReactNode; action?: ReactNode; id: string }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mt-4">
      <div className="flex items-center px-1 mb-0.5">
        <button onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={id} className="flex-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3 hover:text-ink-2 h-6">
          <ChevronDown className={cn("h-3 w-3 transition-transform", !open && "-rotate-90")} />
          {label}
        </button>
        {action}
      </div>
      {open && <div id={id} className="space-y-px">{children}</div>}
    </div>
  );
}

/** Running machines get a solid dot, stopped ones a hollow ring: shape carries the state, not only color. */
function MachineIcon({ g }: { g: Guest }) {
  return (
    <span className="relative inline-flex">
      {g.type === "qemu" ? <Monitor className="h-4 w-4" /> : <Box className="h-4 w-4" />}
      <span aria-label={g.status} className={cn("absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-bg", g.status === "running" ? "bg-good" : "bg-bg ring-1 ring-ink-3")} />
    </span>
  );
}

function DeviceSidebar() {
  const { setup, data, host } = useEngine();
  const d = setup?.deviceName ?? "pve";
  return (
    <>
      <div className="px-3 h-14 flex items-center border-b border-line">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold truncate">{d}</div>
          <div className="text-[11px] text-ink-3">CPU {host.cpuPct.toFixed(0)}% · Memory {Math.round((host.memUsed / host.memTotal) * 100)}%</div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-4">
        <div className="mt-3 space-y-px">
          <Item to={`/${d}/home`} icon={<House className="h-4 w-4" />}>Overview</Item>
          <Item to={`/${d}/summary`} icon={<Gauge className="h-4 w-4" />}>Summary</Item>
          <Item to={`/${d}/resources`} icon={<ListTree className="h-4 w-4" />}>Resources</Item>
          <Item to={`/${d}/automations`} icon={<Workflow className="h-4 w-4" />} count={data.rules.filter((r) => r.enabled).length}>Automations</Item>
        </div>
        <Section id="sec-machines" label="Machines" action={<Link to={`/${d}/machines`} className="text-[11px] text-ink-3 hover:text-ink px-1">All</Link>}>
          {data.guests.map((g) => <Item key={g.vmid} to={`/${d}/machines/${g.vmid}`} icon={<MachineIcon g={g} />} muted={g.status !== "running"} count={g.vmid}>{g.name}</Item>)}
        </Section>
        <Section id="sec-host" label="Host">
          <Item to={`/${d}/shell`} icon={<SquareTerminal className="h-4 w-4" />}>Host shell</Item>
          <Item to={`/${d}/storage`} icon={<Database className="h-4 w-4" />}>Storage</Item>
          <Item to={`/${d}/network`} icon={<Network className="h-4 w-4" />}>Network</Item>
          <Item to={`/${d}/backups`} icon={<Archive className="h-4 w-4" />}>Backups</Item>
        </Section>
      </div>
    </>
  );
}

function OrgSidebar({ org }: { org: Org }) {
  const { setup, data } = useEngine();
  const d = setup?.deviceName ?? "pve";
  const b = `/${d}/${org.slug}`;
  const machines = data.guests.filter((g) => g.org === org.slug);
  const rg = org.resourceGroup;
  return (
    <>
      <Link to={`${b}/settings`} className="px-3 h-14 flex items-center gap-2 border-b border-line hover:bg-surface-2/60 transition-colors">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold truncate">{org.name}</div>
          <div className="text-[11px] text-ink-3">{org.usage.cpuCores.toFixed(1)}/{rg.cores} cores · {(org.usage.memoryMb / 1024).toFixed(1)}/{Math.round(rg.memoryMb / 1024)} GiB</div>
        </div>
        <ChevronDown className="h-4 w-4 text-ink-3" />
      </Link>
      <div className="flex-1 overflow-y-auto px-2 pb-4">
        <div className="mt-3 space-y-px">
          <Item to={b} end icon={<LayoutDashboard className="h-4 w-4" />}>Dashboard</Item>
          <Item to={`${b}/inbox`} icon={<Inbox className="h-4 w-4" />} count={org.inbox.filter((i) => !i.read).length}>Inbox</Item>
          <Item to={`${b}/chat`} icon={<MessageCircle className="h-4 w-4" />}>Chat</Item>
          <Item to={`${b}/decisions`} icon={<Vote className="h-4 w-4" />} count={org.approvals.filter((a) => a.status === "pending").length}>Decisions</Item>
        </div>
        <Section id="sec-work" label="Work">
          <Item to={`${b}/tasks`} icon={<ListChecks className="h-4 w-4" />} count={org.tasks.filter((t) => t.status !== "done").length}>Tasks</Item>
          <Item to={`${b}/projects`} icon={<FolderOpen className="h-4 w-4" />}>Projects</Item>
          <Item to={`${b}/goals`} icon={<Target className="h-4 w-4" />}>Goals</Item>
          <Item to={`${b}/routines`} icon={<Repeat className="h-4 w-4" />}>Routines</Item>
          <Item to={`${b}/artifacts`} icon={<Package className="h-4 w-4" />}>Artifacts</Item>
          <Item to={`${b}/workspaces`} icon={<GitBranch className="h-4 w-4" />}>Workspaces</Item>
        </Section>
        <Section id="sec-machines" label="Machines" action={<Link to={`${b}/machines`} className="text-[11px] text-ink-3 hover:text-ink px-1">All</Link>}>
          {machines.length === 0 && <p className="px-2 text-[12px] text-ink-3 py-1">None running</p>}
          {machines.map((g) => <Item key={g.vmid} to={`${b}/machines/${g.vmid}`} icon={<MachineIcon g={g} />} muted={g.status !== "running"}>{g.name.replace(`${org.slug}-`, "")}</Item>)}
        </Section>
        <Section id="sec-agents" label="Agents" action={<Link to={`${b}/agents`} className="text-[11px] text-ink-3 hover:text-ink px-1">All</Link>}>
          {org.agents.map((a) => (
            <Item key={a.id} to={`${b}/agents`} icon={<span className="relative inline-flex"><Users className="h-4 w-4" />{a.status === "working" && <span aria-label="working" className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-good border border-bg" />}</span>} muted={a.status !== "working"} count={a.status === "working" ? "working" : a.status}>
              {a.name}
            </Item>
          ))}
        </Section>
        <Section id="sec-org" label="Organization">
          <Item to={`${b}/org`} icon={<Boxes className="h-4 w-4" />}>Org chart</Item>
          <Item to={`${b}/skills`} icon={<Sparkles className="h-4 w-4" />}>Skills</Item>
          <Item to={`${b}/connectors`} icon={<Cable className="h-4 w-4" />}>Connectors</Item>
          <Item to={`${b}/costs`} icon={<CircleDollarSign className="h-4 w-4" />}>Costs</Item>
          <Item to={`${b}/activity`} icon={<History className="h-4 w-4" />}>Activity</Item>
          <Item to={`${b}/settings`} icon={<Settings className="h-4 w-4" />}>Settings</Item>
        </Section>
      </div>
    </>
  );
}

export function ContextSidebar() {
  const { data } = useEngine();
  const loc = useLocation();
  const second = loc.pathname.split("/")[2];
  const org = data.orgs.find((o) => o.slug === second);
  return <nav className="flex flex-col h-full" aria-label={org ? `${org.name} navigation` : "Device navigation"}>{org ? <OrgSidebar org={org} /> : <DeviceSidebar />}</nav>;
}
