import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { BookMarked, ChevronDown, ChevronRight, Cloud, GitPullRequest, HardDrive, Loader2, MoreHorizontal, Plus, Settings } from "lucide-react";
import { cn, readJson, writeJson } from "../../../lib/storage.ts";
import { Button, IconButton, Menu, type MenuEntry } from "../../../ui/primitives.tsx";

/**
 * The card column beside the conversation, in the manner of a desktop chat app: Environment (the device, the machines
 * this conversation touched, the repositories followed), Context (how full the conversation is), Connectors (with what
 * each needs), Changes (pull requests) and Background tasks (what is still running). A Show menu picks the cards.
 */

export type CardId = "environment" | "context" | "connectors" | "changes" | "tasks";
const LABEL: Record<CardId, string> = { environment: "Environment", context: "Context", connectors: "Connectors", changes: "Changes", tasks: "Background tasks" };
const HIDDEN = "epc.pinview.cards";

function Card({ title, open: start = true, right, children }: { title: string; open?: boolean; right?: ReactNode; children?: ReactNode }) {
  const [open, setOpen] = useState(start);
  return (
    <section aria-label={title} className="rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-2 pr-4">
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="transition-control flex items-center gap-1.5 pl-4 h-11 text-compact font-semibold">
          {title}{children ? (open ? <ChevronDown className="h-3.5 w-3.5 text-ink-3" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5 text-ink-3" aria-hidden />) : null}
        </button>
        <span className="flex-1" />
        {right}
      </div>
      {open && children && <div className="px-4 pb-3 space-y-0.5">{children}</div>}
    </section>
  );
}

/** A line in a card: an icon, words, and something to do or a state on the right. */
export function CardRow({ icon, children, action }: { icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 min-h-8 text-compact leading-5">
      <span aria-hidden className="w-4 flex justify-center text-ink-3 shrink-0">{icon}</span>
      <span className="flex-1 min-w-0 truncate">{children}</span>
      {action}
    </div>
  );
}

export const cardAction = "text-xs font-medium text-warning hover:underline shrink-0";

export interface CardsModel {
  device: string;
  live: boolean;
  settingsTo: string;
  machines: { vmid: number; name: string; onOpen: () => void }[];
  repos: string[];
  githubConnected: boolean;
  onConnectGithub: () => void;
  context: { used: number; total: number } | null;
  connectors: { id: string; label: string; state: "ok" | "attention" | "off"; to: string }[];
  connectorsTo: string;
  changes: { open: number; failing: number; merged: number } | null;
  onOpenPrs: () => void;
  tasks: { id: string; label: string; onOpen: () => void }[];
}

export function Cards({ m }: { m: CardsModel }) {
  const [hidden, setHidden] = useState<ReadonlySet<CardId>>(() => new Set(readJson<CardId[]>(HIDDEN, [])));
  const [allConnectors, setAllConnectors] = useState(false);
  const save = (n: ReadonlySet<CardId>) => { setHidden(n); writeJson(HIDDEN, [...n]); };
  const show: MenuEntry[] = [
    { kind: "heading", label: "Show" },
    ...(Object.keys(LABEL) as CardId[]).map((id): MenuEntry => ({ kind: "check", label: LABEL[id], checked: !hidden.has(id), onToggle: (v) => { const n = new Set(hidden); if (v) n.delete(id); else n.add(id); save(n); } })),
    { kind: "separator" },
    { label: "Reset to defaults", onSelect: () => save(new Set()) },
  ];
  const on = (id: CardId) => !hidden.has(id);
  const pct = m.context ? Math.min(100, Math.round((m.context.used / m.context.total) * 100)) : 0;
  const connectors = allConnectors ? m.connectors : m.connectors.slice(0, 3);

  return (
    <div className="space-y-3">
      <div className="flex justify-end -mb-1.5"><Menu size="sm" label="Show cards" icon={<MoreHorizontal className="h-4 w-4" />} items={show} /></div>
      {on("environment") && (
        <Card title="Environment">
          <CardRow icon={<Cloud className="h-4 w-4" />} action={<Link to={m.settingsTo} aria-label="Device settings" className="transition-control h-7 w-7 -mr-1.5 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2"><Settings className="h-4 w-4" /></Link>}>{m.device}{m.live ? "" : " (demo)"}</CardRow>
          {m.machines.map((x) => <CardRow key={x.vmid} icon={<HardDrive className="h-4 w-4" />} action={<button type="button" onClick={x.onOpen} className="transition-control h-7 px-2 -mr-2 rounded-md text-xs text-ink-3 hover:text-ink hover:bg-surface-2">Files</button>}>{x.name} <span className="text-ink-3">({x.vmid})</span></CardRow>)}
          {m.repos.map((r) => <CardRow key={r} icon={<BookMarked className="h-4 w-4" />}>{r}</CardRow>)}
          {!m.githubConnected && <CardRow icon={<BookMarked className="h-4 w-4" />} action={<IconButton variant="bare" size="xs" label="Connect GitHub" onClick={m.onConnectGithub} className="-mr-1.5"><Plus className="h-4 w-4" /></IconButton>}><span className="text-ink-3">No repositories followed</span></CardRow>}
        </Card>
      )}
      {on("context") && (
        <Card title="Context" open={false} right={m.context ? <span className="flex items-center gap-2 text-xs text-ink-2 tabular-nums" title="An estimate of how much of the model's window this conversation uses">{pct}%<span className="h-1 w-12 rounded-full bg-surface-3 overflow-hidden" aria-hidden><span className={cn("block h-full rounded-full", pct > 80 ? "bg-warning" : "bg-accent")} style={{ width: `${pct}%` }} /></span></span> : <span className="text-xs text-ink-3">Empty</span>}>
          <p className="text-xs text-ink-3 text-pretty">{m.context ? `About ${Math.round(m.context.used / 1000)}K of ${Math.round(m.context.total / 1000)}K tokens, estimated from the conversation's length. Start a new chat when it gets full.` : "Nothing said yet."}</p>
        </Card>
      )}
      {on("connectors") && (
        <Card title="Connectors">
          {m.connectors.length === 0 && <CardRow icon={<Plus className="h-4 w-4" />} action={<Link to={m.connectorsTo} className={cardAction}>Set up</Link>}><span className="text-ink-3">No connectors yet</span></CardRow>}
          {connectors.map((c) => (
            <CardRow key={c.id} icon={<span className={cn("h-2 w-2 rounded-full", c.state === "ok" ? "bg-good" : c.state === "attention" ? "bg-warning" : "bg-ink-3")} />}
              action={c.state === "attention" ? <Link to={c.to} className={cardAction}>Reconnect</Link> : c.state === "off" ? <Link to={c.to} className={cardAction}>Set up</Link> : undefined}>{c.label}</CardRow>
          ))}
          {m.connectors.length > 3 && <button type="button" onClick={() => setAllConnectors((v) => !v)} className="transition-control text-xs text-ink-3 hover:text-ink-2 pt-1.5">{allConnectors ? "Show less" : "Show more"}</button>}
        </Card>
      )}
      {on("changes") && (
        <Card title="Changes">
          {m.changes ? (
            <CardRow icon={<GitPullRequest className="h-4 w-4" />} action={<Button size="sm" onClick={m.onOpenPrs} className="h-7 text-xs">Open</Button>}>
              <span className="text-good">{m.changes.open} open</span>{m.changes.failing ? <span className="text-critical"> · {m.changes.failing} failing</span> : null}<span className="text-ink-3"> · {m.changes.merged} merged</span>
            </CardRow>
          ) : (
            <CardRow icon={<GitPullRequest className="h-4 w-4" />} action={<Button size="sm" onClick={m.onConnectGithub} className="h-7 text-xs">Connect</Button>}><span className="text-ink-3">GitHub isn't connected</span></CardRow>
          )}
        </Card>
      )}
      {on("tasks") && (
        <Card title="Background tasks" right={m.tasks.length ? <span className="text-xs text-ink-2 tabular-nums">{m.tasks.length}</span> : undefined}>
          {m.tasks.length === 0 ? <p className="text-xs text-ink-3 pb-1">Nothing running.</p> : m.tasks.map((t) => <CardRow key={t.id} icon={<Loader2 className="h-3.5 w-3.5 animate-spin" />} action={<button type="button" onClick={t.onOpen} className="transition-control h-7 px-2 -mr-2 rounded-md text-xs text-ink-3 hover:text-ink hover:bg-surface-2">View</button>}>{t.label}</CardRow>)}
        </Card>
      )}
      {(Object.keys(LABEL) as CardId[]).every((id) => hidden.has(id)) && <p className="text-compact text-ink-3 px-1">Every card is hidden. Choose some from the menu above.</p>}
    </div>
  );
}
