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
import { PinIsland } from "../pin/PinIsland.tsx";
import { RouteActions } from "../pin/RouteActions.tsx";
import { Avatar } from "../ui/primitives.tsx";

/**
 * The rail, Discord style: a slim column of round buttons that square off on hover, with a pill on the left edge that
 * marks the current view. Main views live here; everything else opens as a modal.
 */

function Tip({ label, sub, anchor }: { label: string; sub?: string; anchor: DOMRect }) {
  return createPortal(
    <span role="tooltip" style={{ left: anchor.right + 14, top: anchor.top + anchor.height / 2 }} className="pointer-events-none fixed -translate-y-1/2 z-[70] whitespace-nowrap rounded-lg bg-surface-3 border border-line-strong px-3 py-1.5 text-[13px] font-semibold text-ink shadow-xl modal-in origin-left">
      {label}
      {sub && <span className="block text-[11px] font-normal text-ink-3">{sub}</span>}
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
    <span ref={tip.ref} {...tip.handlers} className={cn("relative flex items-center", expanded ? "gap-3 w-full" : "justify-center w-[72px]")}>
      {!expanded && <span aria-hidden className={cn("rail-pill absolute left-0 w-1 rounded-r-full bg-ink", active ? "h-10 opacity-100" : "h-2 opacity-0 group-hover:opacity-100 group-hover:h-5")} />}
      <span className="relative shrink-0">
        <span className={cn("h-12 w-12 flex items-center justify-center overflow-hidden transition-[border-radius,background,color] duration-200", active ? "rounded-[16px] bg-accent text-primary-ink" : "rounded-[24px] bg-surface-2 text-ink-2 group-hover:rounded-[16px] group-hover:bg-surface-3 group-hover:text-ink")}>
          {children}
        </span>
        {badge}
      </span>
      {expanded ? <span className="text-[14px] font-medium truncate">{label}{sub && <span className="block text-[12px] text-ink-3 font-normal">{sub}</span>}</span> : tip.anchor && <Tip label={label} sub={sub} anchor={tip.anchor} />}
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
        {() => <RailButton active={!onOrg} label={d} sub={`Online · ${host.ip}`} expanded={expanded}><House className="h-5 w-5" /></RailButton>}
      </NavLink>
      {sep}
      <div className="flex-1 overflow-y-auto overflow-x-visible flex flex-col gap-2 [scrollbar-width:none]">
        {data.orgs.map((o) => {
          const working = o.agents.filter((a) => a.status === "working").length;
          return nav(
            `/${d}/${o.slug}`,
            o.name,
            <span className="h-12 w-12 flex items-center justify-center text-[17px] font-semibold" style={{ background: `oklch(0.42 0.09 ${o.hue})`, color: `oklch(0.95 0.03 ${o.hue})` }}>{o.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase()}</span>,
            working ? `${working} agents working` : "Idle",
            working ? <span aria-hidden className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full bg-good border-[3px] border-bg" /> : undefined,
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
        updates ? <span className="absolute -top-0.5 -right-0.5 min-w-5 h-5 px-1 rounded-full bg-critical text-white text-[11px] font-bold flex items-center justify-center border-[3px] border-bg tabular-nums" aria-label={`${updates} update`}>{updates}</span> : undefined,
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
    <span ref={tip.ref} {...tip.handlers} className={cn("relative flex items-center", expanded ? "gap-3" : "justify-center w-[72px]")}>
      <Avatar name={name} hue={32} size={40} />
      {expanded ? <span className="text-[14px] min-w-0">{name}<span className={cn("block text-[11px] truncate", tone)}>{sub}</span></span> : tip.anchor && <Tip label={name} sub={session.mode === "live" ? sub : "Demo data · owner@pve"} anchor={tip.anchor} />}
    </span>
  );
}

export function AppShell() {
  const [drawer, setDrawer] = useState(false);
  const loc = useLocation();
  useEffect(() => setDrawer(false), [loc.pathname, loc.search]);
  return (
    <div className="min-h-dvh flex">
      <aside className="hidden md:block w-[72px] shrink-0 bg-surface/80 border-r border-line sticky top-0 h-dvh z-30">
        <Rail />
      </aside>
      <aside className="hidden md:block w-60 shrink-0 bg-surface/40 border-r border-line sticky top-0 h-dvh z-20">
        <ContextSidebar />
      </aside>
      {drawer && (
        <div className="md:hidden fixed inset-0 z-[59]">
          <div className="absolute inset-0 bg-black/60 modal-backdrop-in" onClick={() => setDrawer(false)} />
          <aside className="absolute left-0 top-0 bottom-0 w-[min(312px,88vw)] flex bg-surface border-r border-line modal-in origin-left">
            <div className="w-[72px] shrink-0 border-r border-line bg-surface/80"><Rail onNavigate={() => setDrawer(false)} /></div>
            <div className="flex-1 min-w-0 relative">
              <button onClick={() => setDrawer(false)} className="absolute right-2 top-3 h-8 w-8 rounded-lg hover:bg-surface-2 flex items-center justify-center z-10" aria-label="Close menu"><X className="h-4 w-4" /></button>
              <ContextSidebar />
            </div>
          </aside>
        </div>
      )}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="md:hidden sticky top-0 z-30 h-14 flex items-center px-3 bg-bg/80 backdrop-blur border-b border-line">
          <button onClick={() => setDrawer(true)} className="h-9 w-9 rounded-lg hover:bg-surface-2 flex items-center justify-center" aria-label="Open menu"><Menu className="h-5 w-5" /></button>
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
