import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, FolderTree, GitPullRequest, MessagesSquare, Package, PanelBottom, PanelRight, Settings } from "lucide-react";
import { cn } from "../../../lib/storage.ts";
import { settingsHref } from "../../../modals/useModals.ts";
import { Modal } from "../../../ui/Modal.tsx";
import { Input, Kbd } from "../../../ui/primitives.tsx";
import type { SideView } from "./layout.ts";

/** The activity bar: one icon per side view, then the panel toggles, Settings and the way back to the console. */
export function ActivityBar({ side, sideOpen, onSide, bottomOpen, onBottom, details, onDetails, device, unread }: {
  side: SideView; sideOpen: boolean; onSide: (v: SideView) => void;
  bottomOpen: boolean; onBottom: () => void; details: boolean; onDetails: () => void; device: string; unread: number;
}) {
  const item = (v: SideView, label: string, icon: ReactNode, badge?: number) => {
    const on = sideOpen && side === v;
    return (
      <button key={v} type="button" aria-label={label} title={label} aria-pressed={on} onClick={() => onSide(v)}
        className={cn("transition-control relative h-11 w-11 rounded-lg flex items-center justify-center", on ? "text-ink" : "text-ink-3 hover:text-ink")}>
        {on && <span aria-hidden className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r bg-accent -ml-1.5" />}
        {icon}
        {badge ? <span className="absolute top-1 right-1 min-w-4 h-4 px-1 rounded-full bg-accent text-on-accent text-micro font-bold flex items-center justify-center" aria-label={`${badge} unread`}>{badge > 99 ? "99+" : badge}</span> : null}
      </button>
    );
  };
  const toggle = (label: string, on: boolean, onClick: () => void, icon: ReactNode) => (
    <button type="button" aria-label={label} title={label} aria-pressed={on} onClick={onClick} className={cn("transition-control h-10 w-10 rounded-lg flex items-center justify-center hover:bg-surface-2", on ? "text-ink" : "text-ink-3 hover:text-ink")}>{icon}</button>
  );
  return (
    <nav aria-label="Workspace" className="w-14 shrink-0 glass-bar border-r border-line flex flex-col items-center gap-1 py-2">
      <Link to={`/${device}/home`} aria-label="Back to the console" title="Back to the console" className="transition-control h-10 w-10 rounded-lg flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2 mb-1"><ArrowLeft className="h-4 w-4" /></Link>
      {item("chats", "Conversations", <MessagesSquare className="h-5 w-5" />, unread)}
      {item("explorer", "Explorer", <FolderTree className="h-5 w-5" />)}
      {item("artifacts", "Artifacts", <Package className="h-5 w-5" />)}
      {item("prs", "Pull requests", <GitPullRequest className="h-5 w-5" />)}
      <span className="flex-1" />
      {toggle("Toggle the panel (Ctrl+J)", bottomOpen, onBottom, <PanelBottom className="h-4 w-4" />)}
      {toggle("Toggle details (Ctrl+.)", details, onDetails, <PanelRight className="h-4 w-4" />)}
      <Link to={settingsHref("general")} aria-label="Settings" title="Settings" className="transition-control h-10 w-10 rounded-lg flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2"><Settings className="h-4 w-4" /></Link>
    </nav>
  );
}

/** The status bar: what this workspace is connected to and running with, each part a shortcut to where it is changed. */
export function StatusBar({ items }: { items: { id: string; label: ReactNode; title: string; onClick?: () => void; tone?: "good" | "warning" | "critical"; side?: "left" | "right"; /** Left out on a phone, where the bar is narrow. */ wideOnly?: boolean }[] }) {
  const part = (i: (typeof items)[number]) => {
    const cls = cn("transition-control h-6 px-2 rounded items-center gap-1.5 text-xs whitespace-nowrap", i.wideOnly ? "hidden sm:inline-flex" : "inline-flex", i.tone === "critical" ? "text-critical" : i.tone === "warning" ? "text-warning" : "text-ink-3", i.onClick && "hover:bg-surface-2 hover:text-ink");
    return i.onClick ? <button key={i.id} type="button" title={i.title} onClick={i.onClick} className={cls}>{i.label}</button> : <span key={i.id} title={i.title} className={cls}>{i.label}</span>;
  };
  return (
    <footer aria-label="Status" className="h-7 shrink-0 flex items-center gap-0.5 px-2 border-t border-line glass-bar overflow-hidden">
      {items.filter((i) => i.side !== "right").map(part)}
      <span className="flex-1" />
      {items.filter((i) => i.side === "right").map(part)}
    </footer>
  );
}

export interface Command { id: string; label: string; group: string; hint?: string; icon?: ReactNode; run: () => void }

/** Go to anything: conversations, open editors, recent files and every workspace command. Ctrl/Cmd+P. */
export function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    const scored = commands.filter((c) => !t || `${c.label} ${c.group} ${c.hint ?? ""}`.toLowerCase().includes(t));
    return scored.slice(0, 50);
  }, [commands, q]);
  useEffect(() => setActive(0), [q]);
  const run = (c: Command) => { onClose(); c.run(); };
  let lastGroup = "";
  return (
    <Modal title="Go to" subtitle="Conversations, files and commands" size="md" onClose={onClose}>
      <Input autoFocus aria-label="Go to" placeholder="Type to search" value={q} onChange={(e) => setQ(e.target.value)} role="combobox" aria-expanded aria-controls="pv-palette" aria-activedescendant={hits[active] ? `pv-${hits[active].id}` : undefined}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(hits.length - 1, a + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          else if (e.key === "Enter" && hits[active]) { e.preventDefault(); run(hits[active]); }
        }} />
      <ul id="pv-palette" role="listbox" aria-label="Results" className="mt-3 max-h-96 overflow-y-auto -mx-1">
        {hits.length === 0 && <li className="px-3 py-6 text-center text-compact text-ink-3">Nothing matches.</li>}
        {hits.map((c, i) => {
          const head = c.group !== lastGroup ? (lastGroup = c.group) : null;
          return (
            <li key={c.id} role="presentation">
              {head && <div className="px-3 pt-2 pb-1 text-xs font-medium text-ink-3">{head}</div>}
              <div id={`pv-${c.id}`} role="option" aria-selected={i === active} onMouseMove={() => setActive(i)} onClick={() => run(c)}
                className={cn("flex items-center gap-3 rounded-md px-3 h-9 text-sm cursor-pointer", i === active ? "bg-surface-3 text-ink" : "text-ink-2")}>
                {c.icon && <span aria-hidden className="text-ink-3 shrink-0">{c.icon}</span>}
                <span className="truncate flex-1">{c.label}</span>
                {c.hint && <Kbd>{c.hint}</Kbd>}
              </div>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
