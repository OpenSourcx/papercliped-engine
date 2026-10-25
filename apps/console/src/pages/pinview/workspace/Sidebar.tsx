import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Check, ChevronDown, ChevronLeft, ChevronRight, CircleDot, Clock, FolderTree, GitPullRequest, Loader2, MoreHorizontal, Package, PanelLeft, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import { cn } from "../../../lib/storage.ts";
import type { ConversationItem } from "../../../pin/ConversationList.tsx";
import { Avatar, Menu, type MenuEntry } from "../../../ui/primitives.tsx";

/**
 * PinView's sidebar, in the manner of a desktop chat app: a short list of places (New chat, Search, Artifacts, Machine
 * files, Pull requests, Automations, Customize), then Pinned, one group per organization with its agent chats and Recents
 * with Pin's chats. Groups fold, long ones end in "Show more", every row and group has its own menu, and a row can end in
 * a status: working, waiting, unread.
 */

export interface SideRow extends ConversationItem { status?: "working" | "waiting" }
export interface SideGroup { id: string; label: string; rows: SideRow[]; actions?: MenuEntry[]; limit?: number; empty?: string }

function NavItem({ icon, label, onClick, to, badge, active }: { icon: ReactNode; label: string; onClick?: () => void; to?: string; badge?: ReactNode; active?: boolean }) {
  const cls = cn("transition-control w-full flex items-center gap-3 rounded-lg px-2.5 h-9 text-sm text-left", active ? "bg-surface-3 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink");
  const body = <><span aria-hidden className="w-4 flex justify-center text-ink-2">{icon}</span><span className="flex-1 truncate">{label}</span>{badge}</>;
  return to ? <Link to={to} className={cls}>{body}</Link> : <button type="button" onClick={onClick} aria-pressed={active} className={cls}>{body}</button>;
}

function Row({ r, active, onPick, menu, renaming, onRenamed, onCancelRename }: { r: SideRow; active: boolean; onPick: () => void; menu: MenuEntry[]; renaming: boolean; onRenamed: (t: string) => void; onCancelRename: () => void }) {
  const [title, setTitle] = useState(r.title);
  if (renaming) {
    return (
      <form className="flex items-center gap-1 px-1 py-0.5" onSubmit={(e) => { e.preventDefault(); onRenamed(title); }}>
        <input autoFocus aria-label="Chat name" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onCancelRename()} className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 h-8 text-sm outline-none focus:border-accent" />
        <button type="submit" aria-label="Save name" className="h-8 w-8 rounded-md flex items-center justify-center text-ink-3 hover:text-ink"><Check className="h-4 w-4" /></button>
        <button type="button" aria-label="Cancel" onClick={onCancelRename} className="h-8 w-8 rounded-md flex items-center justify-center text-ink-3 hover:text-ink"><X className="h-4 w-4" /></button>
      </form>
    );
  }
  const trailing = r.status === "working" ? <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-3" aria-label="Working" />
    : r.status === "waiting" ? <Clock className="h-3.5 w-3.5 text-warning" aria-label="Waiting for you" />
    : r.unread ? <span className="h-2 w-2 rounded-full bg-accent" aria-label="Unread" /> : null;
  return (
    <div className={cn("group flex items-center rounded-lg transition-control", active ? "bg-surface-3" : "hover:bg-surface-2")}>
      <button type="button" aria-current={active ? "true" : undefined} onClick={onPick} className="min-w-0 flex-1 flex items-center gap-2 pl-2.5 pr-1 h-9 text-left">
        <span className={cn("truncate text-sm flex-1", active || r.unread ? "text-ink" : "text-ink-2", r.unread && "font-semibold")}>{r.title}</span>
        {trailing && <span className="shrink-0 flex items-center group-hover:hidden group-focus-within:hidden">{trailing}</span>}
      </button>
      <span className="pr-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100"><Menu size="sm" label={`Options for ${r.title}`} icon={<MoreHorizontal className="h-4 w-4" />} items={menu} /></span>
    </div>
  );
}

export function Sidebar({ groups, activeKey, onPick, rowMenu, renaming, onRenamed, onCancelRename, nav, onCollapse, back, forward, user, settingsTo, device }: {
  groups: SideGroup[];
  activeKey: string | null;
  onPick: (r: SideRow) => void;
  rowMenu: (r: SideRow) => MenuEntry[];
  renaming: string | null;
  onRenamed: (r: SideRow, title: string) => void;
  onCancelRename: () => void;
  nav: { newChat: () => void; search: () => void; artifacts: () => void; files: () => void; prs: () => void; automationsTo: string; customizeTo: string; active?: string; prBadge?: ReactNode };
  onCollapse: () => void;
  back: { can: boolean; go: () => void };
  forward: { can: boolean; go: () => void };
  user: string;
  settingsTo: string;
  device: string;
}) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [more, setMore] = useState<ReadonlySet<string>>(new Set());
  const flip = (set: (f: (s: ReadonlySet<string>) => ReadonlySet<string>) => void, id: string) => set((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const groupMenu = (g: SideGroup): MenuEntry[] => [
    ...(g.actions ?? []),
    ...(g.actions?.length ? [{ kind: "separator" as const }] : []),
    { label: "Collapse all", onSelect: () => setFolded(new Set(groups.map((x) => x.id))), disabled: folded.size === groups.length },
    { label: "Expand all", onSelect: () => setFolded(new Set()), disabled: folded.size === 0 },
  ];

  return (
    <nav aria-label="Conversations" className="flex flex-col min-h-0 h-full">
      <div className="h-11 shrink-0 flex items-center gap-0.5 px-2">
        <button type="button" aria-label="Hide the sidebar (Ctrl+B)" title="Hide the sidebar (Ctrl+B)" onClick={onCollapse} className="transition-control h-8 w-8 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2"><PanelLeft className="h-4 w-4" /></button>
        <button type="button" aria-label="Back" title="Back" disabled={!back.can} onClick={back.go} className="transition-control h-8 w-8 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2 disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button>
        <button type="button" aria-label="Forward" title="Forward" disabled={!forward.can} onClick={forward.go} className="transition-control h-8 w-8 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2 disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
        <span className="flex-1" />
        <Link to={`/${device}/home`} aria-label="Back to the console" title="Back to the console" className="transition-control h-8 w-8 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2"><ArrowLeft className="h-4 w-4" /></Link>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 pb-2">
        <div className="space-y-0.5 pb-3">
          <NavItem icon={<Plus className="h-4 w-4" />} label="New chat" onClick={nav.newChat} />
          <NavItem icon={<Search className="h-4 w-4" />} label="Search" onClick={nav.search} />
          <NavItem icon={<Package className="h-4 w-4" />} label="Artifacts" onClick={nav.artifacts} active={nav.active === "artifacts"} />
          <NavItem icon={<FolderTree className="h-4 w-4" />} label="Machine files" onClick={nav.files} active={nav.active === "files"} />
          <NavItem icon={<GitPullRequest className="h-4 w-4" />} label="Pull requests" onClick={nav.prs} active={nav.active === "prs"} badge={nav.prBadge} />
          <NavItem icon={<CircleDot className="h-4 w-4" />} label="Automations" to={nav.automationsTo} />
          <NavItem icon={<SlidersHorizontal className="h-4 w-4" />} label="Customize" to={nav.customizeTo} />
        </div>
        {groups.map((g) => {
          const open = !folded.has(g.id);
          const limit = g.limit ?? 5;
          const shown = more.has(g.id) ? g.rows : g.rows.slice(0, limit);
          const unread = g.rows.filter((r) => r.unread).length;
          return (
            <section key={g.id} aria-label={g.label} className="pb-3">
              <div className="group/head flex items-center pr-1">
                <button type="button" aria-expanded={open} onClick={() => flip(setFolded, g.id)} className="transition-control flex items-center gap-1 px-2.5 h-7 text-xs font-medium text-ink-3 hover:text-ink-2 min-w-0">
                  <span className="truncate">{g.label}</span>
                  <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", !open && "-rotate-90")} aria-hidden />
                  {unread > 0 && <span className="ml-1 text-micro font-bold text-accent" aria-label={`${unread} unread`}>{unread}</span>}
                </button>
                <span className="flex-1" />
                <span className="opacity-0 group-hover/head:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100"><Menu size="sm" label={`${g.label} options`} icon={<MoreHorizontal className="h-4 w-4" />} items={groupMenu(g)} /></span>
              </div>
              {open && (
                <div className="space-y-0.5">
                  {g.rows.length === 0 && g.empty && <p className="px-2.5 py-1 text-xs text-ink-3">{g.empty}</p>}
                  {shown.map((r) => (
                    <Row key={r.key} r={r} active={r.key === activeKey} onPick={() => onPick(r)} menu={rowMenu(r)} renaming={renaming === r.key} onRenamed={(t) => onRenamed(r, t)} onCancelRename={onCancelRename} />
                  ))}
                  {g.rows.length > limit && (
                    <button type="button" onClick={() => flip(setMore, g.id)} className="transition-control w-full text-left px-2.5 h-8 text-sm text-ink-3 hover:text-ink-2">{more.has(g.id) ? "Show less" : "Show more"}</button>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
      <Link to={settingsTo} className="transition-control shrink-0 flex items-center gap-2.5 mx-2 mb-2 rounded-lg px-2 h-11 hover:bg-surface-2">
        <Avatar name={user} hue={32} size={26} />
        <span className="text-sm truncate flex-1">{user}</span>
        <SlidersHorizontal className="h-4 w-4 text-ink-3" aria-hidden /><span className="sr-only">Settings</span>
      </Link>
    </nav>
  );
}
