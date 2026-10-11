import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Boxes, Cable, House, KeyRound, Menu, Palette, Plus, RefreshCw, Server, Settings, ShieldCheck, Workflow, X } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import { cn } from "../lib/storage.ts";
import { PinIsland } from "../pin/PinIsland.tsx";
import { Avatar, Chip } from "../ui/primitives.tsx";

function Item({ to, icon, children, end, badge }: { to: string; icon: ReactNode; children: ReactNode; end?: boolean; badge?: ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn("group flex items-center gap-2.5 h-9 px-2.5 rounded-lg text-[14px] transition-colors", isActive ? "bg-surface-3 text-ink font-medium" : "text-ink-2 hover:text-ink hover:bg-surface-2")
      }
    >
      <span className="text-ink-3 group-hover:text-ink-2 [.active_&]:text-ink">{icon}</span>
      <span className="flex-1 truncate">{children}</span>
      {badge}
    </NavLink>
  );
}

function Group({ label, children, action }: { label: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mt-5">
      <div className="flex items-center justify-between px-2.5 mb-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">{label}</span>
        {action}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { setup, data, host } = useEngine();
  const d = setup?.deviceName ?? "pve";
  const unread = data.notices.filter((n) => !n.read && n.kind === "update").length;
  return (
    <nav className="flex flex-col h-full" onClick={(e) => (e.target as HTMLElement).closest("a") && onNavigate?.()}>
      <div className="px-3 pt-4 pb-3">
        <div className="flex items-center gap-2.5 rounded-xl p-2 border border-line bg-surface-2/60">
          <div className="h-9 w-9 rounded-lg bg-surface-3 flex items-center justify-center"><Server className="h-[18px] w-[18px] text-ink-2" /></div>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold truncate">{d}</div>
            <div className="text-[12px] text-ink-3 flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-good" aria-hidden />Online · {host.ip}</div>
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-4">
        <div className="space-y-0.5">
          <Item to={`/${d}/home`} icon={<House className="h-4 w-4" />}>Home</Item>
          <Item to={`/${d}/guests`} icon={<Boxes className="h-4 w-4" />}>Guests</Item>
          <Item to={`/${d}/automations`} icon={<Workflow className="h-4 w-4" />}>Automations</Item>
          <Item to={`/${d}/updates`} icon={<RefreshCw className="h-4 w-4" />} badge={unread ? <Chip tone="accent">{unread}</Chip> : null}>Updates</Item>
        </div>
        <Group label="Organizations" action={<NavLink to={`/${d}/orgs/new`} className="h-6 w-6 rounded-md hover:bg-surface-2 flex items-center justify-center text-ink-3 hover:text-ink" aria-label="New organization"><Plus className="h-3.5 w-3.5" /></NavLink>}>
          {data.orgs.map((o) => {
            const working = o.agents.filter((a) => a.status === "working").length;
            return (
              <Item key={o.slug} to={`/${d}/${o.slug}`} icon={<Avatar name={o.name} hue={o.hue} size={20} />} badge={<span className="text-[11px] text-ink-3 tabular-nums">{working ? `${working} working` : "idle"}</span>}>
                {o.name}
              </Item>
            );
          })}
        </Group>
        <Group label="Administration">
          <Item to={`/${d}/access`} icon={<ShieldCheck className="h-4 w-4" />}>Access control</Item>
          <Item to={`/${d}/connectors`} icon={<Cable className="h-4 w-4" />}>Connectors</Item>
          <Item to={`/${d}/appearance`} icon={<Palette className="h-4 w-4" />}>Appearance</Item>
          <Item to={`/${d}/settings`} icon={<Settings className="h-4 w-4" />}>Settings</Item>
        </Group>
      </div>
      <div className="px-3 py-3 border-t border-line flex items-center gap-2.5">
        <Avatar name={setup?.ownerName || "You"} hue={32} size={30} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium truncate">{setup?.ownerName || "You"}</div>
          <div className="text-[11px] text-ink-3 flex items-center gap-1"><KeyRound className="h-3 w-3" />owner@pve</div>
        </div>
        <Chip tone="warning">Demo data</Chip>
      </div>
    </nav>
  );
}

export function AppShell() {
  const [drawer, setDrawer] = useState(false);
  const loc = useLocation();
  useEffect(() => setDrawer(false), [loc.pathname]);
  return (
    <div className="min-h-dvh flex">
      <aside className="hidden lg:block w-64 shrink-0 border-r border-line bg-surface/60 sticky top-0 h-dvh">
        <Sidebar />
      </aside>
      {drawer && (
        <div className="lg:hidden fixed inset-0 z-40">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDrawer(false)} />
          <aside className="absolute left-0 top-0 bottom-0 w-72 max-w-[85vw] bg-surface border-r border-line fade-in">
            <button onClick={() => setDrawer(false)} className="absolute right-2 top-2 h-8 w-8 rounded-lg hover:bg-surface-2 flex items-center justify-center z-10" aria-label="Close menu"><X className="h-4 w-4" /></button>
            <Sidebar onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      )}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="lg:hidden sticky top-0 z-30 h-14 flex items-center px-3 bg-bg/80 backdrop-blur border-b border-line">
          <button onClick={() => setDrawer(true)} className="h-9 w-9 rounded-lg hover:bg-surface-2 flex items-center justify-center" aria-label="Open menu"><Menu className="h-5 w-5" /></button>
        </div>
        <main className="flex-1 min-w-0">
          <Outlet />
        </main>
      </div>
      <PinIsland />
    </div>
  );
}
