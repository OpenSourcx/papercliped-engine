import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { House, Menu, Plug, Plus, Settings, X } from "lucide-react";
import { ContextSidebar } from "./ContextSidebar.tsx";
import { useSession } from "../auth/session.tsx";
import { useEngine } from "../data/store.tsx";
import { cn } from "../lib/storage.ts";
import { ModalHost } from "../modals/ModalHost.tsx";
import { modalHref, settingsHref, useModals } from "../modals/useModals.ts";
import { PinIsland, PinOrb } from "../pin/PinIsland.tsx";
import { RouteActions } from "../pin/RouteActions.tsx";
import { Avatar } from "../ui/primitives.tsx";

/**
 * The rail, Discord style: a slim column of round buttons that square off on hover, with a pill on the left edge that
 * marks the current view. Main views live here; everything else opens as a modal.
 */

function Tip({ label, sub, anchor }: { label: string; sub?: string; anchor: DOMRect }) {
  return createPortal(
    <span role="tooltip" style={{ left: anchor.right + 14, top: anchor.top + anchor.height / 2 }} className="pointer-events-none fixed -translate-y-1/2 z-(--z-tooltip) whitespace-nowrap rounded-lg bg-surface-3 border border-line-strong px-3 py-1.5 text-compact font-semibold text-ink shadow-overlay tooltip-in">
      {label}
      {sub && <span className="block text-micro font-normal text-ink-3">{sub}</span>}
    </span>,
    document.body,
  );
}

/** Shows a tooltip beside an element while it is hovered or focused, rendered outside any scrolling container. */
function useTip() {
  const ref = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const show = () => ref.current && setAnchor(ref.current.getBoundingClientRect());
  const hide = () => setAnchor(null);
  // Touch screens fire mouseenter on tap; tooltips there only get in the way. Keyboard focus still shows them.
  const canHover = typeof window !== "undefined" && window.matchMedia?.("(hover: hover)").matches;
  return {
    ref,
    anchor,
    handlers: {
      onMouseEnter: () => canHover && show(),
      onMouseLeave: hide,
      onFocus: (e: React.FocusEvent) => (e.target as HTMLElement).matches?.(":focus-visible") && show(),
      onBlur: hide,
    },
  };
}

function RailButton({ active, label, sub, children, badge, expanded }: { active: boolean; label: string; sub?: string; children: ReactNode; badge?: ReactNode; expanded?: boolean }) {
  const tip = useTip();
  return (
    <span ref={tip.ref} {...tip.handlers} className={cn("relative flex items-center", expanded ? "gap-3 w-full" : "justify-center w-18")}>
      {!expanded && <span aria-hidden className={cn("rail-pill absolute left-0 w-1 rounded-r-full bg-ink", active ? "h-10 opacity-100" : "h-2 opacity-0 group-hover:opacity-100 group-hover:h-5")} />}
      <span className="relative shrink-0">
        <span className={cn("h-12 w-12 flex items-center justify-center overflow-hidden transition-[border-radius,background-color,color] duration-(--duration-base) ease-spring", active ? "rounded-rail-active bg-accent text-primary-ink" : "rounded-rail bg-surface-2 text-ink-2 group-hover:rounded-rail-active group-hover:bg-surface-3 group-hover:text-ink")}>
          {children}
        </span>
        {badge}
      </span>
      {expanded ? <span className="text-sm font-medium truncate">{label}{sub && <span className="block text-xs text-ink-3 font-normal">{sub}</span>}</span> : tip.anchor && <Tip label={label} sub={sub} anchor={tip.anchor} />}
    </span>
  );
}

function Rail({ expanded, onNavigate }: { expanded?: boolean; onNavigate?: () => void }) {
  const { setup, data, host } = useEngine();
  const d = setup?.deviceName ?? "pve";
  const loc = useLocation();
  const modals = useModals();
  const updates = data.notices.filter((n) => !n.read && n.kind === "update").length;
  const onOrg = data.orgs.some((o) => o.slug === loc.pathname.split("/")[2]);
  const onPin = loc.pathname.split("/")[2] === "pin";
  const nav = (to: string, label: string, icon: ReactNode, sub?: string, badge?: ReactNode) => (
    <NavLink key={to} to={to} onClick={onNavigate} aria-label={label} className={cn("group block outline-none", expanded && "px-3")}>
      {({ isActive }) => <RailButton active={isActive || loc.pathname.startsWith(`${to}/`)} label={label} sub={sub} badge={badge} expanded={expanded}>{icon}</RailButton>}
    </NavLink>
  );
  const modalLink = (href: string, label: string, icon: ReactNode, active: boolean, badge?: ReactNode) => (
    <Link to={href} onClick={onNavigate} aria-label={label} className={cn("group block outline-none", expanded && "px-3")}>
      <RailButton active={active} label={label} badge={badge} expanded={expanded}>{icon}</RailButton>
    </Link>
  );
  const sep = <div className={cn("h-0.5 rounded-full bg-line-strong my-1", expanded ? "mx-4" : "w-8 mx-auto")} />;

  return (
    <nav className="flex flex-col h-full py-3 gap-2" aria-label="Main">
      {/* The device is "active" on every device page (home, machines, host tools), like Discord's home button. */}
      <NavLink to={`/${d}/home`} onClick={onNavigate} aria-label={d} className={cn("group block outline-none", expanded && "px-3")}>
        {() => <RailButton active={!onOrg && !onPin} label={d} sub={`Online · ${host.ip}`} expanded={expanded}><House className="h-5 w-5" /></RailButton>}
      </NavLink>
      {nav(`/${d}/pin`, "Pin", <PinOrb size={30} />, setup?.pinMode === "agent" ? "Agent mode" : "Assistant mode")}
      {sep}
      <div className="flex-1 overflow-y-auto overflow-x-visible flex flex-col gap-2 [scrollbar-width:none]">
        {data.orgs.map((o) => {
          const working = o.agents.filter((a) => a.status === "working").length;
          return nav(
            `/${d}/${o.slug}`,
            o.name,
            <Avatar name={o.name} hue={o.hue} size={48} className="rounded-none text-lead" />,
            working ? `${working} agents working` : "Idle",
            working ? <span aria-hidden className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full bg-good border-3 border-bg" /> : undefined,
          );
        })}
        {modalLink(modalHref("new-org"), "Create an organization", <Plus className="h-5 w-5" />, modals.modal === "new-org")}
      </div>
      {sep}
      {modalLink(settingsHref("apps"), "Connected apps", <Plug className="h-5 w-5" />, modals.settings === "apps")}
      {modalLink(
        settingsHref(updates ? "updates" : "general"),
        "Settings",
        <Settings className="h-5 w-5" />,
        modals.settings !== null && modals.settings !== "apps",
        updates ? <span className="absolute -top-0.5 -right-0.5 min-w-5 h-5 px-1 rounded-full bg-critical text-on-status text-micro font-bold flex items-center justify-center border-3 border-bg tabular-nums" aria-label={`${updates} update`}>{updates}</span> : undefined,
      )}
      <Link to={settingsHref("general")} onClick={onNavigate} className={cn("group block mt-1", expanded && "px-3")} aria-label={`${setup?.ownerName || "You"}, settings`}>
        <UserChip name={setup?.ownerName || "You"} expanded={expanded} />
      </Link>
      <span className="sr-only">{loc.pathname}</span>
    </nav>
  );
}

function UserChip({ name, expanded }: { name: string; expanded?: boolean }) {
  const tip = useTip();
  const { session } = useSession();
  const { liveError } = useEngine();
  const sub = session.mode === "live" ? (liveError ? `Offline · ${session.user.username}` : `Live · ${session.user.username}`) : "Demo data";
  const tone = session.mode === "live" && !liveError ? "text-good" : "text-warning";
  return (
    <span ref={tip.ref} {...tip.handlers} className={cn("relative flex items-center", expanded ? "gap-3" : "justify-center w-18")}>
      <Avatar name={name} hue={32} size={40} />
      {expanded ? <span className="text-sm min-w-0">{name}<span className={cn("block text-micro truncate", tone)}>{sub}</span></span> : tip.anchor && <Tip label={name} sub={session.mode === "live" ? sub : "Demo data · owner@pve"} anchor={tip.anchor} />}
    </span>
  );
}

export function AppShell() {
  const [drawer, setDrawer] = useState(false);
  const loc = useLocation();
  useEffect(() => setDrawer(false), [loc.pathname, loc.search]);
  return (
    <div className="min-h-dvh flex">
      <aside className="hidden md:block w-18 shrink-0 bg-surface/80 border-r border-line sticky top-0 h-dvh z-(--z-rail)">
        <Rail />
      </aside>
      <aside className="hidden md:block w-60 shrink-0 bg-surface/40 border-r border-line sticky top-0 h-dvh z-(--z-sidebar)">
        <ContextSidebar />
      </aside>
      {drawer && (
        <div className="md:hidden fixed inset-0 z-(--z-drawer)">
          <div aria-hidden className="absolute inset-0 bg-scrim modal-backdrop-in" onClick={() => setDrawer(false)} />
          <aside aria-label="Menu" className="absolute left-0 top-0 bottom-0 w-[min(312px,88vw)] flex bg-surface border-r border-line shadow-modal drawer-in">
            <div className="w-18 shrink-0 border-r border-line bg-surface/80"><Rail onNavigate={() => setDrawer(false)} /></div>
            <div className="flex-1 min-w-0 relative">
              <button onClick={() => setDrawer(false)} className="transition-control absolute right-2 top-2.5 h-9 w-9 rounded-lg text-ink-3 hover:text-ink hover:bg-surface-2 flex items-center justify-center z-(--z-raised)" aria-label="Close menu"><X className="h-4 w-4" /></button>
              <ContextSidebar />
            </div>
          </aside>
        </div>
      )}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="md:hidden sticky top-0 z-(--z-rail) h-14 flex items-center px-2 bg-bg/85 backdrop-blur border-b border-line">
          <button onClick={() => setDrawer(true)} className="transition-control h-10 w-10 rounded-lg text-ink-2 hover:text-ink hover:bg-surface-2 flex items-center justify-center" aria-label="Open menu" aria-expanded={drawer}><Menu className="h-5 w-5" /></button>
        </div>
        <main className="flex-1 min-w-0">
          <Outlet />
        </main>
      </div>
      <RouteActions />
      <PinIsland />
      <ModalHost />
    </div>
  );
}
