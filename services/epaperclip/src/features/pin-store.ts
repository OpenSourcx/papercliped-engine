import { randomBytes } from "node:crypto";
import type { StateStore } from "../state.ts";

/**
 * What Pin keeps for a person: their conversations, and their SOUL.md and MEMORY.md. Like Notes, each is one JSON document
 * per person, sealed by the host's vault (AES-256-GCM, the name binds the owner), so none of it appears in `state.json`
 * in the clear. Nothing here talks to Proxmox or a model.
 *
 * Paperclip keeps an agent's instruction files as versioned files with a history you can restore, and its conversations on
 * the server; this follows the same shape: server-side, revisioned, and bounded in size everywhere.
 */

export const LIMITS = {
  chats: 60,
  messages: 240,
  chatChars: 240_000,
  totalChars: 1_200_000,
  title: 80,
  soul: 4_000,
  memory: 8_000,
  entry: 400,
  revisions: 20,
  toolArgs: 1_500,
  toolResult: 800,
  errorMessage: 600,
} as const;

export class LibraryError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const newId = () => randomBytes(8).toString("hex");
const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

// ---- Conversations

/** What a tool call looked like in the chat, kept compactly: enough to draw its chip again and to remind the model what it did. */
export interface StoredTool {
  id: string;
  name: string;
  status: string;
  args?: unknown;
  label?: string;
  result?: string;
  error?: string;
  vmid?: number;
}
export interface StoredMessage {
  id: string;
  from: "you" | "pin";
  at: number;
  text: string;
  tool?: StoredTool;
  error?: { message: string; code?: string };
}
export interface Chat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
}
export interface ChatMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  count: number;
}
interface ChatsDoc {
  v: 1;
  chats: Chat[];
}

export const NEW_CHAT = "New chat";

const chatsKey = (user: string) => `pin.chats:${user}`;
const memKey = (user: string) => `pin.mem:${user}`;
const meta = (c: Chat): ChatMeta => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, count: c.messages.length });
const sizeOf = (c: Chat) => c.messages.reduce((n, m) => n + m.text.length + (m.error?.message.length ?? 0) + (m.tool ? JSON.stringify(m.tool).length : 0), 0);

/** A tool call as it is stored: args and results cut down, nothing that could be large or secret-shaped kept whole. */
export function compactTool(t: Record<string, unknown>): StoredTool {
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
  let args: unknown;
  try {
    const j = JSON.stringify(t.args ?? {});
    args = j.length <= LIMITS.toolArgs ? JSON.parse(j) : {};
  } catch {
    args = {};
  }
  return {
    id: String(t.id ?? "").slice(0, 80),
    name: String(t.name ?? "").slice(0, 80),
    status: String(t.status ?? "done").slice(0, 20),
    args,
    ...(str(t.label, 300) ? { label: str(t.label, 300) } : {}),
    ...(str(t.result, LIMITS.toolResult) !== undefined ? { result: str(t.result, LIMITS.toolResult) } : {}),
    ...(str(t.error, LIMITS.toolResult) ? { error: str(t.error, LIMITS.toolResult) } : {}),
    ...(typeof t.vmid === "number" ? { vmid: t.vmid } : {}),
  };
}

/** A title from the first thing the person said. */
export function titleFrom(text: string): string {
  const t = oneLine(text.replace(/[`*_#>]/g, ""), LIMITS.title);
  return t || NEW_CHAT;
}

/**
 * A saved conversation as the model should see it: what the person said, what Pin said, a short note of what Pin did
 * (the tool calls and how they ended) and of any request that failed, so the next message has the whole context and a
 * retry knows what the earlier attempt was. Roles alternate.
 */
export function historyFor(chat: Chat): { role: "user" | "assistant"; content: string }[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  const add = (role: "user" | "assistant", content: string) => {
    if (!content.trim()) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else out.push({ role, content });
  };
  for (const m of chat.messages) {
    if (m.from === "you") add("user", m.text);
    else if (m.tool) {
      const t = m.tool;
      const outcome = t.error ? `failed: ${t.error}` : t.result ? `${t.status}: ${t.result}` : t.status;
      add("assistant", `[Earlier in this chat, ${t.label ? `“${t.label}”` : t.name} ${outcome.slice(0, 400)}]`);
    } else if (m.error) add("assistant", `[That request failed: ${m.error.message.slice(0, 300)}]`);
    else add("assistant", m.text);
  }
  return out;
}

// ---- SOUL.md and MEMORY.md

export const DEFAULT_SOUL = `# SOUL.md

I'm Pin, the copilot that lives on this device.

## How I work
- I look after the machines, storage and backups here, and the organizations that run on them.
- In Assistant mode I ask before I change anything. In Agent mode I act and tell you after.
- I never delete machines, backups or data on my own, and I never touch protected machines.
- I keep answers short and say plainly when I'm not sure.

## What I care about
- Nothing important goes without a recent backup.
- Machines stay within their resource groups.
- You hear about updates and problems before they become urgent.
`;

export const DEFAULT_MEMORY = `# MEMORY.md

What I've learned about you and this device. Edit anything that's wrong; I read this before every conversation.

## You
-

## This device
-

## Preferences
-
`;

export type MemoryFile = "soul" | "memory";
export interface Revision {
  rev: number;
  file: MemoryFile;
  text: string;
  at: number;
  by: string;
}
interface MemoryDoc {
  v: 1;
  rev: number;
  soul: string | null;
  memory: string | null;
  at: { soul: number | null; memory: number | null };
  history: Revision[];
}
export interface MemoryView {
  soul: string;
  memory: string;
  soulIsDefault: boolean;
  memoryIsDefault: boolean;
  rev: number;
  editedAt: { soul: number | null; memory: number | null };
  limits: { soul: number; memory: number };
}

const emptyMemory = (): MemoryDoc => ({ v: 1, rev: 0, soul: null, memory: null, at: { soul: null, memory: null }, history: [] });
const REMEMBERED = "## Remembered";

export class PinLibrary {
  readonly state: StateStore;
  readonly now: () => number;

  constructor(state: StateStore, now: () => number = Date.now) {
    this.state = state;
    this.now = now;
  }

  // ---- chats

  private loadChats(user: string): ChatsDoc {
    const raw = this.state.getSecret(chatsKey(user));
    if (!raw) return { v: 1, chats: [] };
    try {
      const d = JSON.parse(raw) as Partial<ChatsDoc>;
      return { v: 1, chats: Array.isArray(d.chats) ? d.chats : [] };
    } catch {
      throw new LibraryError(500, "chats_unreadable", "Your chats could not be read. They are still on the device; ask an administrator.");
    }
  }

  private saveChats(user: string, doc: ChatsDoc) {
    for (const c of doc.chats) {
      if (c.messages.length > LIMITS.messages) c.messages = c.messages.slice(-LIMITS.messages);
      while (c.messages.length > 2 && sizeOf(c) > LIMITS.chatChars) c.messages.shift();
    }
    doc.chats.sort((a, b) => b.updatedAt - a.updatedAt);
    doc.chats = doc.chats.slice(0, LIMITS.chats);
    while (doc.chats.length > 1 && doc.chats.reduce((n, c) => n + sizeOf(c), 0) > LIMITS.totalChars) doc.chats.pop();
    this.state.setSecret(chatsKey(user), JSON.stringify(doc));
  }

  listChats(user: string): ChatMeta[] {
    return this.loadChats(user).chats.map(meta).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getChat(user: string, id: string): Chat {
    const c = this.loadChats(user).chats.find((x) => x.id === id);
    if (!c) throw new LibraryError(404, "not_found", "That chat doesn't exist, or it was deleted.");
    return c;
  }

  findChat(user: string, id: string): Chat | null {
    return this.loadChats(user).chats.find((x) => x.id === id) ?? null;
  }

  createChat(user: string, title = NEW_CHAT): Chat {
    const doc = this.loadChats(user);
    const t = this.now();
    const chat: Chat = { id: newId(), title: oneLine(title, LIMITS.title) || NEW_CHAT, createdAt: t, updatedAt: t, messages: [] };
    doc.chats.unshift(chat);
    this.saveChats(user, doc);
    return chat;
  }

  renameChat(user: string, id: string, title: unknown): Chat {
    if (typeof title !== "string" || !oneLine(title, LIMITS.title)) throw new LibraryError(400, "bad_request", "Give the chat a name.");
    const doc = this.loadChats(user);
    const c = doc.chats.find((x) => x.id === id);
    if (!c) throw new LibraryError(404, "not_found", "That chat doesn't exist, or it was deleted.");
    c.title = oneLine(title, LIMITS.title);
    this.saveChats(user, doc);
    return c;
  }

  deleteChat(user: string, id: string) {
    const doc = this.loadChats(user);
    const next = doc.chats.filter((x) => x.id !== id);
    if (next.length === doc.chats.length) throw new LibraryError(404, "not_found", "That chat doesn't exist, or it was deleted.");
    doc.chats = next;
    this.saveChats(user, doc);
  }

  /** Adds messages to a chat and gives an untitled one a title from the first thing the person said. Returns the chat. */
  append(user: string, id: string, add: { from: "you" | "pin"; text?: string; tool?: Record<string, unknown>; error?: { message: string; code?: string } }[]): Chat {
    const doc = this.loadChats(user);
    const c = doc.chats.find((x) => x.id === id);
    if (!c) throw new LibraryError(404, "not_found", "That chat doesn't exist, or it was deleted.");
    const t = this.now();
    for (const m of add) {
      c.messages.push({
        id: newId(),
        from: m.from,
        at: t,
        text: (m.text ?? "").slice(0, 32_000),
        ...(m.tool ? { tool: compactTool(m.tool) } : {}),
        ...(m.error ? { error: { message: m.error.message.slice(0, LIMITS.errorMessage), ...(m.error.code ? { code: m.error.code } : {}) } } : {}),
      });
    }
    c.updatedAt = t;
    if (c.title === NEW_CHAT) {
      const first = c.messages.find((x) => x.from === "you" && x.text.trim());
      if (first) c.title = titleFrom(first.text);
    }
    this.saveChats(user, doc);
    return c;
  }

  // ---- SOUL.md and MEMORY.md

  private loadMemory(user: string): MemoryDoc {
    const raw = this.state.getSecret(memKey(user));
    if (!raw) return emptyMemory();
    try {
      return { ...emptyMemory(), ...(JSON.parse(raw) as Partial<MemoryDoc>), v: 1 };
    } catch {
      throw new LibraryError(500, "memory_unreadable", "Your memory could not be read. It is still on the device; ask an administrator.");
    }
  }

  view(user: string): MemoryView {
    const d = this.loadMemory(user);
    return {
      soul: d.soul ?? DEFAULT_SOUL,
      memory: d.memory ?? DEFAULT_MEMORY,
      soulIsDefault: d.soul === null,
      memoryIsDefault: d.memory === null,
      rev: d.rev,
      editedAt: d.at,
      limits: { soul: LIMITS.soul, memory: LIMITS.memory },
    };
  }

  /** What goes into Pin's instructions: only text the person (or Pin, at their word) actually wrote. */
  promptParts(user: string): { soul: string | null; memory: string | null } {
    const d = this.loadMemory(user);
    const memory = d.memory && d.memory !== DEFAULT_MEMORY && /\S/.test(d.memory.replace(/^#.*$/gm, "").replace(/^\s*-\s*$/gm, "")) ? d.memory : null;
    return { soul: d.soul && d.soul !== DEFAULT_SOUL ? d.soul : null, memory };
  }

  history(user: string): Omit<Revision, "text">[] {
    return this.loadMemory(user).history.map(({ rev, file, at, by }) => ({ rev, file, at, by })).reverse();
  }

  /** Saves a file. `baseRev` is the revision the editor started from: a save over a newer one is refused, as Paperclip does. */
  setFile(user: string, file: MemoryFile, text: unknown, opts: { baseRev?: number; by?: string } = {}): MemoryView {
    if (file !== "soul" && file !== "memory") throw new LibraryError(400, "bad_request", "That file doesn't exist.");
    if (typeof text !== "string") throw new LibraryError(400, "bad_request", "text must be a string.");
    const max = file === "soul" ? LIMITS.soul : LIMITS.memory;
    if (text.length > max) throw new LibraryError(413, "too_large", `${file === "soul" ? "SOUL.md" : "MEMORY.md"} can hold ${max.toLocaleString("en")} characters. This is ${text.length.toLocaleString("en")}.`);
    const d = this.loadMemory(user);
    if (opts.baseRev !== undefined && opts.baseRev !== d.rev) throw new LibraryError(409, "stale", "This changed somewhere else since you opened it (Pin may have remembered something). Reload to see the newest version.");
    const before = d[file];
    // Keep what was there before every change, the first one included (a default file is still text to go back to),
    // so undo always has a revision to restore.
    const beforeText = before ?? (file === "soul" ? DEFAULT_SOUL : DEFAULT_MEMORY);
    if (beforeText !== text) {
      d.history.push({ rev: d.rev, file, text: beforeText, at: d.at[file] ?? this.now(), by: opts.by ?? "you" });
      d.history = d.history.slice(-LIMITS.revisions);
    }
    d[file] = text;
    d.at[file] = this.now();
    d.rev += 1;
    this.state.setSecret(memKey(user), JSON.stringify(d));
    return this.view(user);
  }

  /** Puts an earlier version of a file back (as a new revision, so even a restore can be undone). */
  restore(user: string, rev: unknown): MemoryView {
    const d = this.loadMemory(user);
    const r = d.history.find((x) => x.rev === rev);
    if (!r) throw new LibraryError(404, "not_found", "That version is no longer kept.");
    return this.setFile(user, r.file, r.text, { by: "you (restored)" });
  }

  /** Pin writes down something the person asked it to. Returns what it did, in words, for Pin to relay. */
  remember(user: string, raw: unknown): { ok: boolean; message: string } {
    const text = typeof raw === "string" ? oneLine(raw, LIMITS.entry) : "";
    if (text.length < 3) return { ok: false, message: "Nothing to remember: say what to keep." };
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const line = `- ${day}: ${text}`;
    const cur = this.view(user).memory;
    if (cur.toLowerCase().includes(text.toLowerCase())) return { ok: true, message: `Already in MEMORY.md: ${text}` };
    const body = cur.includes(REMEMBERED) ? `${cur.replace(/\s+$/, "")}\n${line}\n` : `${cur.replace(/\s+$/, "")}\n\n${REMEMBERED}\n${line}\n`;
    if (body.length > LIMITS.memory) return { ok: false, message: "MEMORY.md is full. Ask the person to tidy it on Pin's Soul and memory tab." };
    this.setFile(user, "memory", body, { by: "pin" });
    return { ok: true, message: `Saved to MEMORY.md: ${text}` };
  }

  /** Pin removes lines the person asked it to forget. Only bullet lines are touched, and the match must be specific. */
  forget(user: string, raw: unknown): { ok: boolean; message: string; removed: string[] } {
    const m = typeof raw === "string" ? oneLine(raw, LIMITS.entry).toLowerCase() : "";
    if (m.length < 3) return { ok: false, message: "Say what to forget (at least a few letters).", removed: [] };
    const lines = this.view(user).memory.split("\n");
    const removed: string[] = [];
    const kept = lines.filter((l) => {
      if (/^\s*-\s+\S/.test(l) && l.toLowerCase().includes(m)) {
        removed.push(l.replace(/^\s*-\s+/, ""));
        return false;
      }
      return true;
    });
    if (!removed.length) return { ok: false, message: `Nothing in MEMORY.md mentions “${m}”.`, removed };
    if (removed.length > 5) return { ok: false, message: `That matches ${removed.length} lines; be more specific so nothing else is lost.`, removed: [] };
    this.setFile(user, "memory", kept.join("\n"), { by: "pin" });
    return { ok: true, message: `Removed from MEMORY.md: ${removed.join("; ")}`, removed };
  }
}

const libraries = new WeakMap<StateStore, PinLibrary>();
export function libraryFor(state: StateStore): PinLibrary {
  let lib = libraries.get(state);
  if (!lib) {
    lib = new PinLibrary(state);
    libraries.set(state, lib);
  }
  return lib;
}
