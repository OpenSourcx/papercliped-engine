import { useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Link2, MessageSquarePlus, MoreHorizontal, Pencil, Pin, PinOff, Search, Trash2, X } from "lucide-react";
import { ago } from "../data/engine/map.ts";
import { errorText } from "../data/engine/queries.ts";
import { cn } from "../lib/storage.ts";
import { Button, Input, Menu, Segmented, type MenuEntry } from "../ui/primitives.tsx";

/** One line in a list of conversations, whoever the conversation is with. */
export interface ConversationItem {
  key: string;
  source: "pin" | "agent";
  title: string;
  /** Where it belongs: the organization of an agent chat. */
  context?: string;
  updatedAt: number;
  /** Something new arrived since the person last opened it. */
  unread?: boolean;
}

/** A named group of conversations (Pinned, Pin, an organization), shown with a heading that folds it away. */
export interface ConversationSection { id: string; label: string; icon?: ReactNode; items: ConversationItem[] }

const DAY = 86_400_000;
const groupOf = (t: number, now: number) => (now - t < DAY ? "Today" : now - t < 2 * DAY ? "Yesterday" : now - t < 7 * DAY ? "This week" : "Earlier");

/**
 * Conversations as a list: newest first, optionally searchable and filterable by source, grouped by day or in sections the
 * caller names. Rename and delete appear only when the owner of the list gives handlers (Pin's chats have them; an agent's chat
 * lives in its organization); a pin toggle appears when `onTogglePin` is given.
 */
export function ConversationList({ items, sections, activeKey, onPick, onNew, onRename, onDelete, pinned, onTogglePin, linkFor, search, filter, grouped, empty, label = "Conversations", className }: {
  items?: ConversationItem[];
  sections?: ConversationSection[];
  activeKey: string | null;
  onPick: (c: ConversationItem) => void;
  onNew?: () => void;
  onRename?: (c: ConversationItem, title: string) => Promise<unknown>;
  onDelete?: (c: ConversationItem) => Promise<unknown>;
  pinned?: ReadonlySet<string>;
  onTogglePin?: (c: ConversationItem) => void;
  /** An address that opens this conversation, for "Copy link". */
  linkFor?: (c: ConversationItem) => string;
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
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const fail = (e: unknown) => setError(errorText(e));
  const keep = (c: ConversationItem) => {
    const q = query.trim().toLowerCase();
    return (source === "all" || c.source === source) && (!q || `${c.title} ${c.context ?? ""}`.toLowerCase().includes(q));
  };
  const all = useMemo(() => (sections ? sections.flatMap((s) => s.items) : items ?? []), [sections, items]);
  const shown = useMemo(() => all.filter(keep).sort((a, b) => b.updatedAt - a.updatedAt), [all, query, source]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownSections = useMemo(() => (sections ?? []).map((s) => ({ ...s, items: s.items.filter(keep).sort((a, b) => b.updatedAt - a.updatedAt) })).filter((s) => s.items.length > 0 || (!query.trim() && source === "all" && s.id !== "pinned")), [sections, query, source]); // eslint-disable-line react-hooks/exhaustive-deps
  const now = Date.now();
  const mixed = new Set(all.map((i) => i.source)).size > 1;
  const compact = !!sections;

  const row = (c: ConversationItem) => {
    const active = activeKey === c.key;
    if (renaming === c.key) {
      return (
        <form className="flex items-center gap-1 px-1 py-1" onSubmit={(e) => { e.preventDefault(); void onRename!(c, title).then(() => setRenaming(null), fail); }}>
          <input autoFocus aria-label="Chat name" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 h-8 text-compact outline-none focus:border-accent" />
          <button type="submit" aria-label="Save name" className="h-8 w-8 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2"><Check className="h-4 w-4" /></button>
          <button type="button" aria-label="Cancel" onClick={() => setRenaming(null)} className="h-8 w-8 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2"><X className="h-4 w-4" /></button>
        </form>
      );
    }
    const isPinned = pinned?.has(c.key) ?? false;
    return (
      <div className={cn("group flex items-center rounded-lg transition-control", active ? "bg-accent-soft" : "hover:bg-surface-2")}>
        <button type="button" aria-current={active ? "true" : undefined} onClick={() => onPick(c)} className={cn("min-w-0 flex-1 text-left px-2.5", compact ? "py-1.5 flex items-center gap-2" : "py-2")}>
          {c.unread && <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden />}
          <div className={cn("text-compact truncate", compact && "flex-1 min-w-0", c.unread && "font-semibold text-ink")}>{c.title}{c.unread && <span className="sr-only"> (unread)</span>}</div>
          {compact ? <span className="text-xs text-ink-3 shrink-0 group-hover:hidden group-focus-within:hidden">{ago(new Date(c.updatedAt))}</span> : <div className="text-xs text-ink-3">{c.context ? `${c.context} · ` : ""}{ago(new Date(c.updatedAt))}</div>}
        </button>
        {confirm === c.key ? (
          <span className="flex items-center gap-1 pr-1">
            <Button size="sm" variant="danger" onClick={() => void onDelete!(c).then(() => setConfirm(null), (e) => { setConfirm(null); fail(e); })}>Delete</Button>
            <button type="button" aria-label="Keep it" title="Keep it" onClick={() => setConfirm(null)} className="h-7 w-7 rounded-md flex items-center justify-center text-ink-3 hover:text-ink"><X className="h-3.5 w-3.5" /></button>
          </span>
        ) : (
          (() => {
            const entries: MenuEntry[] = [
              ...(onTogglePin ? [{ label: isPinned ? "Unpin" : "Pin", icon: isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />, onSelect: () => onTogglePin(c) }] : []),
              ...(onRename ? [{ label: "Rename", icon: <Pencil className="h-4 w-4" />, onSelect: () => { setRenaming(c.key); setTitle(c.title); } }] : []),
              ...(linkFor ? [{ label: "Copy link", icon: <Link2 className="h-4 w-4" />, onSelect: () => void navigator.clipboard?.writeText(linkFor(c)).catch(() => undefined) }] : []),
              ...(onDelete ? [{ kind: "separator" as const }, { label: "Delete", danger: true, icon: <Trash2 className="h-4 w-4" />, onSelect: () => setConfirm(c.key) }] : []),
            ];
            return entries.length ? <span className="flex opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 pr-1"><Menu size="sm" label={`Options for ${c.title}`} icon={<MoreHorizontal className="h-4 w-4" />} items={entries} /></span> : null;
          })()
        )}
      </div>
    );
  };

  return (
    <nav aria-label={label} className={cn("flex flex-col min-h-0", className)}>
      {onNew && <Button size="sm" variant="secondary" className="mb-2 justify-start" onClick={onNew}><MessageSquarePlus className="h-4 w-4" />New chat</Button>}
      {search && <div className="relative mb-2"><Search className="h-4 w-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden /><Input aria-label="Search conversations" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9 h-9" /></div>}
      {filter && mixed && <div className="mb-2"><Segmented size="sm" label="Show" value={source} onChange={setSource} options={[{ value: "all", label: "All" }, { value: "pin", label: "Pin" }, { value: "agent", label: "Agents" }]} /></div>}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden space-y-0.5 -mx-1 px-1">
        {all.length === 0 && <p className="text-xs text-ink-3 px-2 py-3">{empty ?? "Your conversations are kept here."}</p>}
        {all.length > 0 && shown.length === 0 && <p className="text-xs text-ink-3 px-2 py-3">Nothing matches.</p>}
        {sections ? shownSections.map((s) => {
          const open = !folded.has(s.id) || !!query.trim();
          return (
            <section key={s.id} aria-label={s.label} className="pb-2">
              <button type="button" aria-expanded={open} onClick={() => setFolded((f) => { const n = new Set(f); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} className="transition-control w-full flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-ink-3 hover:text-ink-2">
                {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
                {s.icon}<span className="truncate">{s.label}</span>
                {s.items.some((c) => c.unread) && <span className="ml-auto min-w-5 h-5 px-1.5 rounded-full bg-accent text-on-accent text-micro font-bold flex items-center justify-center" aria-label={`${s.items.filter((c) => c.unread).length} unread`}>{s.items.filter((c) => c.unread).length}</span>}
              </button>
              {open && (s.items.length === 0 ? <p className="text-xs text-ink-3 px-2.5 py-1">No chats yet.</p> : s.items.map((c) => <div key={c.key}>{row(c)}</div>))}
            </section>
          );
        }) : shown.map((c, i) => {
          const head = grouped && (i === 0 || groupOf(shown[i - 1]!.updatedAt, now) !== groupOf(c.updatedAt, now)) ? groupOf(c.updatedAt, now) : null;
          return (
            <div key={c.key}>
              {head && <div className="text-xs font-medium text-ink-3 px-2.5 pt-3 pb-1">{head}</div>}
              {row(c)}
            </div>
          );
        })}
      </div>
      {error && <p role="alert" className="text-xs text-critical mt-2">{error}</p>}
    </nav>
  );
}
