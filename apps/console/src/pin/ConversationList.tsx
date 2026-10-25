import { useMemo, useState } from "react";
import { Check, MessageSquarePlus, Pencil, Search, Trash2, X } from "lucide-react";
import { ago } from "../data/engine/map.ts";
import { errorText } from "../data/engine/queries.ts";
import { cn } from "../lib/storage.ts";
import { Button, Input, Segmented } from "../ui/primitives.tsx";

/** One line in a list of conversations, whoever the conversation is with. */
export interface ConversationItem {
  key: string;
  source: "pin" | "agent";
  title: string;
  /** Where it belongs: the organization of an agent chat. */
  context?: string;
  updatedAt: number;
}

const DAY = 86_400_000;
const groupOf = (t: number, now: number) => (now - t < DAY ? "Today" : now - t < 2 * DAY ? "Yesterday" : now - t < 7 * DAY ? "This week" : "Earlier");

/**
 * Conversations as a list: newest first, optionally searchable, filterable by source and grouped by day. Rename and delete
 * appear only when the owner of the list gives handlers (Pin's chats have them; an agent's chat lives in its organization).
 */
export function ConversationList({ items, activeKey, onPick, onNew, onRename, onDelete, search, filter, grouped, empty, label = "Conversations", className }: {
  items: ConversationItem[];
  activeKey: string | null;
  onPick: (c: ConversationItem) => void;
  onNew?: () => void;
  onRename?: (c: ConversationItem, title: string) => Promise<unknown>;
  onDelete?: (c: ConversationItem) => Promise<unknown>;
  search?: boolean;
  filter?: boolean;
  grouped?: boolean;
  empty?: string;
  label?: string;
  className?: string;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"all" | "pin" | "agent">("all");
  const fail = (e: unknown) => setError(errorText(e));
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((c) => (source === "all" || c.source === source) && (!q || `${c.title} ${c.context ?? ""}`.toLowerCase().includes(q)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [items, query, source]);
  const now = Date.now();
  const mixed = new Set(items.map((i) => i.source)).size > 1;

  return (
    <nav aria-label={label} className={cn("flex flex-col min-h-0", className)}>
      {onNew && <Button size="sm" variant="secondary" className="mb-2 justify-start" onClick={onNew}><MessageSquarePlus className="h-4 w-4" />New chat</Button>}
      {search && <div className="relative mb-2"><Search className="h-4 w-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden /><Input aria-label="Search conversations" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9 h-9" /></div>}
      {filter && mixed && <div className="mb-2"><Segmented size="sm" label="Show" value={source} onChange={setSource} options={[{ value: "all", label: "All" }, { value: "pin", label: "Pin" }, { value: "agent", label: "Agents" }]} /></div>}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden space-y-0.5 -mx-1 px-1">
        {items.length === 0 && <p className="text-xs text-ink-3 px-2 py-3">{empty ?? "Your conversations are kept here."}</p>}
        {items.length > 0 && shown.length === 0 && <p className="text-xs text-ink-3 px-2 py-3">Nothing matches.</p>}
        {shown.map((c, i) => {
          const active = activeKey === c.key;
          const head = grouped && (i === 0 || groupOf(shown[i - 1]!.updatedAt, now) !== groupOf(c.updatedAt, now)) ? groupOf(c.updatedAt, now) : null;
          return (
            <div key={c.key}>
              {head && <div className="text-xs font-medium text-ink-3 px-2.5 pt-3 pb-1">{head}</div>}
              {renaming === c.key ? (
              <form className="flex items-center gap-1 px-1 py-1" onSubmit={(e) => { e.preventDefault(); void onRename!(c, title).then(() => setRenaming(null), fail); }}>
                <input autoFocus aria-label="Chat name" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 h-8 text-compact outline-none focus:border-accent" />
                <button type="submit" aria-label="Save name" className="h-8 w-8 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2"><Check className="h-4 w-4" /></button>
                <button type="button" aria-label="Cancel" onClick={() => setRenaming(null)} className="h-8 w-8 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2"><X className="h-4 w-4" /></button>
              </form>
              ) : (
            <div className={cn("group flex items-center rounded-lg transition-control", active ? "bg-accent-soft" : "hover:bg-surface-2")}>
              <button type="button" aria-current={active ? "true" : undefined} onClick={() => { onPick(c); }} className="min-w-0 flex-1 text-left px-2.5 py-2">
                <div className="text-compact truncate">{c.title}</div>
                <div className="text-xs text-ink-3">{c.context ? `${c.context} · ` : ""}{ago(new Date(c.updatedAt))}</div>
              </button>
              {!onRename && !onDelete ? null : confirm === c.key ? (
                <Button size="sm" variant="danger" className="mr-1" onClick={() => void onDelete!(c).then(() => setConfirm(null), (e) => { setConfirm(null); fail(e); })}>Delete</Button>
              ) : (
                <span className="flex opacity-0 group-hover:opacity-100 focus-within:opacity-100 pr-1">
                  {onRename && <button type="button" aria-label={`Rename ${c.title}`} onClick={() => { setRenaming(c.key); setTitle(c.title); }} className="h-7 w-7 rounded-md flex items-center justify-center text-ink-3 hover:text-ink"><Pencil className="h-3.5 w-3.5" /></button>}
                  {onDelete && <button type="button" aria-label={`Delete ${c.title}`} onClick={() => setConfirm(c.key)} className="h-7 w-7 rounded-md flex items-center justify-center text-ink-3 hover:text-critical"><Trash2 className="h-3.5 w-3.5" /></button>}
                </span>
              )}
            </div>
              )}
            </div>
          );
        })}
      </div>
      {error && <p role="alert" className="text-xs text-critical mt-2">{error}</p>}
    </nav>
  );
}
