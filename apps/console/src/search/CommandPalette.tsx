import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Boxes, CircleCheck, FolderOpen, Monitor, Search, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useEngine } from "../data/store.tsx";
import { useAgents, useProjects } from "../data/engine/queries.ts";
import { useSearch } from "../data/engine/more.ts";
import { Modal } from "../ui/Modal.tsx";
import { Input, Kbd } from "../ui/primitives.tsx";
import { cn } from "../lib/storage.ts";

/**
 * Search across the organization you're in (tasks and files from the engine's search; agents and projects from what is
 * already loaded) and the machines on this device, plus the organization's pages. Press / anywhere, or use a Search
 * button. (Ctrl/Cmd+K belongs to Pin.)
 */

export const OPEN_SEARCH_EVENT = "epc:search";
export const openSearch = () => window.dispatchEvent(new Event(OPEN_SEARCH_EVENT));

interface Hit { id: string; label: string; hint?: string; icon: ReactNode; to: string; group: string }

const PAGES: [string, string][] = [["Dashboard", ""], ["Inbox", "inbox"], ["Chat", "chat"], ["Decisions", "decisions"], ["Tasks", "tasks"], ["Projects", "projects"], ["Routines", "routines"], ["Artifacts", "artifacts"], ["Goals", "goals"], ["Workspaces", "workspaces"], ["Agents", "agents"], ["Org chart", "org"], ["Members", "members"], ["Skills", "skills"], ["Costs", "costs"], ["Activity", "activity"], ["Settings", "settings"]];

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

export function CommandPalette() {
  const { live } = useEngine();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target) && !document.querySelector('[aria-modal="true"]')) {
        e.preventDefault();
        setOpen(true);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_SEARCH_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_SEARCH_EVENT, onOpen);
    };
  }, []);
  if (!open || !live) return null;
  return <Palette onClose={() => setOpen(false)} />;
}

function Palette({ onClose }: { onClose: () => void }) {
  const { data, setup } = useEngine();
  const loc = useLocation();
  const navigate = useNavigate();
  const d = setup?.deviceName ?? "pve";
  const slug = loc.pathname.split("/")[2];
  const org = data.orgs.find((o) => o.slug === slug && o.engine) ?? null;
  const companyId = org?.engine?.companyId ?? null;
  const base = org ? `/${d}/${org.slug}` : `/${d}`;
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const needle = q.trim().toLowerCase();
  const found = useSearch(companyId, q);
  const agents = useAgents(companyId);
  const projects = useProjects(companyId);

  const hits = useMemo<Hit[]>(() => {
    const out: Hit[] = [];
    const has = (...t: (string | null | undefined)[]) => !needle || t.some((x) => x?.toLowerCase().includes(needle));
    if (org) {
      for (const [label, path] of PAGES) if (needle && has(label)) out.push({ id: `page-${path}`, label, hint: "Page", icon: <Boxes className="h-4 w-4" />, to: path ? `${base}/${path}` : base, group: "Pages" });
      for (const r of found.data?.results ?? []) {
        if (r.type === "issue" && r.issue) out.push({ id: `t-${r.id}`, label: r.issue.title, hint: r.issue.identifier ?? "Task", icon: <CircleCheck className="h-4 w-4" />, to: `${base}/tasks/${r.issue.identifier ?? r.issue.id}`, group: "Tasks" });
        else if (r.type === "artifact" && r.artifact) out.push({ id: `f-${r.id}`, label: r.title, hint: r.artifact.issueIdentifier, icon: <Boxes className="h-4 w-4" />, to: `${base}/artifacts`, group: "Artifacts" });
      }
      for (const a of agents.data ?? []) if (needle && a.status !== "terminated" && has(a.name, a.title, a.role)) out.push({ id: `a-${a.id}`, label: a.name, hint: a.title || a.role, icon: <Users className="h-4 w-4" />, to: `${base}/agents/${a.id}`, group: "Agents" });
      for (const p of projects.data ?? []) if (needle && has(p.name)) out.push({ id: `p-${p.id}`, label: p.name, hint: "Project", icon: <FolderOpen className="h-4 w-4" />, to: `${base}/projects`, group: "Projects" });
    }
    for (const g of data.guests) if (needle && !g.template && (has(g.name) || String(g.vmid).includes(needle))) out.push({ id: `m-${g.vmid}`, label: g.name, hint: `${g.type === "lxc" ? "Container" : "Virtual machine"} ${g.vmid}`, icon: <Monitor className="h-4 w-4" />, to: g.org ? `/${d}/${g.org}/machines/${g.vmid}` : `/${d}/machines/${g.vmid}`, group: "Machines" });
    // The same task can come back twice (as a title and as a comment match); keep the first.
    const seen = new Set<string>();
    return out.filter((h) => (seen.has(h.id) ? false : (seen.add(h.id), true))).slice(0, 30);
  }, [needle, org, found.data, agents.data, projects.data, data.guests, base, d]);

  useEffect(() => setActive(0), [needle]);
  const go = (h: Hit) => {
    onClose();
    navigate(h.to);
  };
  return (
    <Modal title="Search" subtitle={org ? `In ${org.name} and on this device` : "On this device"} size="md" onClose={onClose}>
      <div className="relative">
        <Search className="h-4 w-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden />
        <Input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls="palette-list"
          aria-activedescendant={hits[active] ? `palette-${hits[active].id}` : undefined}
          aria-label="Search tasks, agents, projects and machines"
          className="pl-9"
          placeholder="Search tasks, agents, projects, machines"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(hits.length - 1, i + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
            else if (e.key === "Enter" && hits[active]) { e.preventDefault(); go(hits[active]); }
          }}
        />
      </div>
      <ul id="palette-list" role="listbox" aria-label="Results" className="mt-3 max-h-80 overflow-y-auto -mx-1">
        {needle.length < 1 && <li className="px-3 py-6 text-center text-sm text-ink-3">Type to search. <Kbd>Esc</Kbd> closes.</li>}
        {needle.length >= 1 && hits.length === 0 && !found.isFetching && <li className="px-3 py-6 text-center text-sm text-ink-3">Nothing matches “{q.trim()}”.</li>}
        {hits.map((h, i) => (
          <li key={h.id} id={`palette-${h.id}`} role="option" aria-selected={i === active}>
            {(i === 0 || hits[i - 1].group !== h.group) && <div className="px-3 pt-2 pb-1 text-micro font-semibold uppercase tracking-label text-ink-3">{h.group}</div>}
            <button onClick={() => go(h)} onMouseMove={() => setActive(i)} className={cn("w-full flex items-center gap-3 rounded-md px-3 h-10 text-left text-sm", i === active ? "bg-surface-3 text-ink" : "text-ink-2")}>
              <span className="text-ink-3 shrink-0">{h.icon}</span>
              <span className="flex-1 truncate">{h.label}</span>
              {h.hint && <span className="text-xs text-ink-3 shrink-0 font-mono">{h.hint}</span>}
            </button>
          </li>
        ))}
        {found.isFetching && <li className="px-3 py-2 text-xs text-ink-3">Searching</li>}
      </ul>
    </Modal>
  );
}
