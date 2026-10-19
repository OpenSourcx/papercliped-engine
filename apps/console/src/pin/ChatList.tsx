import { useState } from "react";
import { Check, MessageSquarePlus, Pencil, Trash2, X } from "lucide-react";
import { ago } from "../data/engine/map.ts";
import { errorText } from "../data/engine/queries.ts";
import { cn } from "../lib/storage.ts";
import { Button } from "../ui/primitives.tsx";
import { usePin } from "./PinContext.tsx";

/** Pin's saved chats, like a chat list: newest first, rename and delete in place. Only on a device (demo chats aren't kept). */
export function ChatList({ className, onPick }: { className?: string; onPick?: () => void }) {
  const pin = usePin();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fail = (e: unknown) => setError(errorText(e));
  return (
    <nav aria-label="Saved chats" className={cn("flex flex-col min-h-0", className)}>
      <Button size="sm" variant="secondary" className="mb-2 justify-start" onClick={() => { pin.newChat(); onPick?.(); }}><MessageSquarePlus className="h-4 w-4" />New chat</Button>
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden space-y-0.5 -mx-1 px-1">
        {pin.chats.length === 0 && <p className="text-xs text-ink-3 px-2 py-3">Your conversations with Pin are kept here.</p>}
        {pin.chats.map((c) => {
          const active = pin.chatId === c.id;
          if (renaming === c.id) {
            return (
              <form key={c.id} className="flex items-center gap-1 px-1 py-1" onSubmit={(e) => { e.preventDefault(); void pin.renameChat(c.id, title).then(() => setRenaming(null), fail); }}>
                <input autoFocus aria-label="Chat name" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 h-8 text-compact outline-none focus:border-accent" />
                <button type="submit" aria-label="Save name" className="h-8 w-8 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2"><Check className="h-4 w-4" /></button>
                <button type="button" aria-label="Cancel" onClick={() => setRenaming(null)} className="h-8 w-8 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2"><X className="h-4 w-4" /></button>
              </form>
            );
          }
          return (
            <div key={c.id} className={cn("group flex items-center rounded-lg transition-control", active ? "bg-accent-soft" : "hover:bg-surface-2")}>
              <button type="button" aria-current={active ? "true" : undefined} onClick={() => { void pin.openChat(c.id); onPick?.(); }} className="min-w-0 flex-1 text-left px-2.5 py-2">
                <div className="text-compact truncate">{c.title}</div>
                <div className="text-xs text-ink-3">{ago(new Date(c.updatedAt))}</div>
              </button>
              {confirm === c.id ? (
                <Button size="sm" variant="danger" className="mr-1" onClick={() => void pin.deleteChat(c.id).then(() => setConfirm(null), (e) => { setConfirm(null); fail(e); })}>Delete</Button>
              ) : (
                <span className="flex opacity-0 group-hover:opacity-100 focus-within:opacity-100 pr-1">
                  <button type="button" aria-label={`Rename ${c.title}`} onClick={() => { setRenaming(c.id); setTitle(c.title); }} className="h-7 w-7 rounded-md flex items-center justify-center text-ink-3 hover:text-ink"><Pencil className="h-3.5 w-3.5" /></button>
                  <button type="button" aria-label={`Delete ${c.title}`} onClick={() => setConfirm(c.id)} className="h-7 w-7 rounded-md flex items-center justify-center text-ink-3 hover:text-critical"><Trash2 className="h-3.5 w-3.5" /></button>
                </span>
              )}
            </div>
          );
        })}
      </div>
      {error && <p role="alert" className="text-xs text-critical mt-2">{error}</p>}
    </nav>
  );
}
