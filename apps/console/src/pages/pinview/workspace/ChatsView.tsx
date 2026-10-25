import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, Search, SquarePen, X } from "lucide-react";
import { ConversationList, type ConversationItem, type ConversationSection } from "../../../pin/ConversationList.tsx";
import { Input, Menu, type MenuEntry } from "../../../ui/primitives.tsx";
import { BarButton, SideHeader } from "./parts.tsx";

/**
 * The Conversations view of the side panel: a quiet heading with New chat, Search and a menu (what to show, mark as read,
 * fold sections), then the chats in sections, each with its own menu. Nothing on screen until it is needed.
 */

export interface AgentChoice { companyId: string; org: string; agentId: string; name: string }

export function ChatsView({ sections, activeKey, onPick, onNewPin, onNewAgent, agents, scope, setScope, scopes, unreadCount, markAllRead, pinned, onTogglePin, linkFor, onRename, onDelete, emptyNote }: {
  sections: ConversationSection[];
  activeKey: string | null;
  onPick: (c: ConversationItem) => void;
  onNewPin: () => void;
  onNewAgent: (a: AgentChoice) => void;
  agents: AgentChoice[];
  scope: string;
  setScope: (s: string) => void;
  scopes: { id: string; label: string }[];
  unreadCount: number;
  markAllRead: () => void;
  pinned: ReadonlySet<string>;
  onTogglePin: (c: ConversationItem) => void;
  linkFor: (c: ConversationItem) => string;
  onRename: (c: ConversationItem, title: string) => Promise<unknown>;
  onDelete: (c: ConversationItem) => Promise<unknown>;
  emptyNote?: string;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { if (searching) box.current?.focus(); }, [searching]);
  const scopeLabel = scopes.find((s) => s.id === scope)?.label;

  const newMenu: MenuEntry[] = [
    { label: "New chat with Pin", onSelect: onNewPin, shortcut: "Alt+N" },
    ...(agents.length ? [{ kind: "heading" as const, label: "Chat with an agent" }, ...agents.slice(0, 30).map((a): MenuEntry => ({ label: `${a.name} · ${a.org}`, onSelect: () => onNewAgent(a) }))] : []),
  ];
  const viewMenu: MenuEntry[] = [
    { kind: "heading", label: "Show" },
    ...scopes.map((s): MenuEntry => ({ kind: "check", label: s.id === "unread" && unreadCount ? `${s.label} (${unreadCount})` : s.label, checked: scope === s.id, onToggle: () => setScope(s.id) })),
    { kind: "separator" },
    { label: "Mark all as read", onSelect: markAllRead, disabled: unreadCount === 0 },
    { label: "Collapse all", onSelect: () => setFolded(new Set(sections.map((s) => s.id))), disabled: folded.size === sections.length },
    { label: "Expand all", onSelect: () => setFolded(new Set()), disabled: folded.size === 0 },
  ];

  return (
    <div className="flex flex-col min-h-0 h-full">
      <SideHeader title="Conversations" actions={
        <>
          <Menu size="sm" label="New chat" icon={<SquarePen className="h-4 w-4" />} items={newMenu} />
          <BarButton label="Search conversations" pressed={searching} onClick={() => { setSearching((v) => !v); setQuery(""); }}><Search className="h-4 w-4" /></BarButton>
          <Menu size="sm" label="Conversation options" icon={<MoreHorizontal className="h-4 w-4" />} items={viewMenu} />
        </>
      } />
      {searching && (
        <div className="px-3 pb-2">
          <Input ref={box} aria-label="Search conversations" placeholder="Search conversations" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { setSearching(false); setQuery(""); } }} className="h-8 text-compact" />
        </div>
      )}
      {scope !== "all" && (
        <div className="px-3 pb-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 border border-line pl-2.5 pr-1 h-6 text-xs text-ink-2">
            Showing {scopeLabel?.toLowerCase()}
            <button type="button" aria-label="Show all conversations" onClick={() => setScope("all")} className="h-4 w-4 rounded-full flex items-center justify-center text-ink-3 hover:text-ink"><X className="h-3 w-3" /></button>
          </span>
        </div>
      )}
      <ConversationList
        className="flex-1 px-2"
        label="Conversations"
        sections={sections}
        activeKey={activeKey}
        query={query}
        folded={folded}
        onFoldedChange={setFolded}
        pinned={pinned}
        onTogglePin={onTogglePin}
        linkFor={linkFor}
        onPick={onPick}
        onRename={onRename}
        onDelete={onDelete}
        empty={emptyNote}
      />
    </div>
  );
}
