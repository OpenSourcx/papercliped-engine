import { randomBytes } from "node:crypto";
import type { StateStore } from "../state.ts";

/**
 * Notes: what is stored and the rules every write follows. Each person's notes are one JSON document sealed by the
 * host's vault (AES-256-GCM, the name binds the owner), so notes are encrypted at rest like every other secret the host
 * keeps. Nothing here talks to Proxmox or a model.
 *
 * Growth is bounded everywhere: notes per person, characters per note, characters per person, tags, links, folders and
 * the undo history.
 */

export const LIMITS = {
  notes: 300,
  title: 120,
  body: 32_000,
  /** Sum of every note's body, and the cap on the sealed document. */
  totalBody: 1_000_000,
  tags: 12,
  tag: 32,
  links: 20,
  folders: 100,
  folderDepth: 3,
  folderName: 40,
  batches: 10,
  vaultSecretsPerNote: 20,
} as const;

export const INBOX = "Inbox";

export type LinkKind = "machine" | "storage" | "org" | "task";
export interface NoteLink {
  kind: LinkKind;
  /** vmid for a machine, storage id, organization id, task id. */
  id: string;
  /** What to show; the id is what counts. */
  label: string;
}

export interface VaultRef {
  /** The placeholder id in the body. */
  id: string;
  kind: string;
  label: string;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  /** "Runbooks/Networking". Never empty: unfiled notes live in Inbox. */
  folder: string;
  tags: string[];
  pinned: boolean;
  links: NoteLink[];
  /** Shared read-only with the members of one organization. Null: private. */
  share: { orgId: string; orgName: string } | null;
  /** Secrets moved to the host's vault from this note's text. Values never leave the vault except by an explicit reveal. */
  vault: VaultRef[];
  source: "manual" | "capture" | "sorted" | "import" | "pin";
  createdAt: number;
  updatedAt: number;
}

/** What an undo needs to put things back. */
export interface Batch {
  id: string;
  at: number;
  kind: "sort" | "import" | "file";
  created: string[];
  updated: { id: string; prev: Pick<Note, "title" | "folder" | "tags" | "links"> }[];
  undone: boolean;
}

export interface NotesSettings {
  /** File high-confidence results without a preview. Off by default. */
  autoFile: boolean;
}

export interface NotesDoc {
  v: 1;
  notes: Note[];
  /** Folders created on their own (a folder with notes exists without being listed). */
  folders: string[];
  settings: NotesSettings;
  batches: Batch[];
}

export class NotesError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const bad = (message: string, code = "bad_request") => new NotesError(400, code, message);

export const newId = (bytes = 8) => randomBytes(bytes).toString("hex");

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** One-line text: control characters become spaces. */
export const oneLine = (v: unknown, max: number): string => (typeof v === "string" ? v : "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Multi-line text: keeps newlines and tabs, drops other control characters and normalises line endings. */
export const cleanBody = (v: unknown): string => (typeof v === "string" ? v : "").replace(/\r\n?/g, "\n").replace(CONTROL, "");

export function cleanFolder(v: unknown): string {
  const raw = typeof v === "string" ? v : "";
  const parts = raw.split("/").map((p) => oneLine(p, LIMITS.folderName).replace(/^\.+$/, "")).filter(Boolean);
  if (parts.length > LIMITS.folderDepth) throw bad(`Folders go ${LIMITS.folderDepth} levels deep at most.`);
  return parts.join("/") || INBOX;
}

export function cleanTag(v: unknown): string {
  return (typeof v === "string" ? v : "").toLowerCase().replace(/^#+/, "").replace(/[^a-z0-9._/-]+/g, "-").replace(/^[-/.]+|[-/.]+$/g, "").slice(0, LIMITS.tag);
}

export function cleanTags(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad("Tags must be a list.");
  const out: string[] = [];
  for (const t of v) {
    const c = cleanTag(t);
    if (c && !out.includes(c)) out.push(c);
  }
  if (out.length > LIMITS.tags) throw bad(`A note has ${LIMITS.tags} tags at most.`);
  return out;
}

const LINK_KINDS: readonly LinkKind[] = ["machine", "storage", "org", "task"];
const LINK_ID = /^[\w.@:-]{1,80}$/;

export function cleanLinks(v: unknown): NoteLink[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad("Links must be a list.");
  const out: NoteLink[] = [];
  for (const l of v) {
    if (!l || typeof l !== "object") throw bad("Each link needs a kind and an id.");
    const r = l as Record<string, unknown>;
    if (!LINK_KINDS.includes(r.kind as LinkKind)) throw bad(`A link's kind is one of ${LINK_KINDS.join(", ")}.`);
    if (typeof r.id !== "string" && typeof r.id !== "number") throw bad("A link needs an id.");
    const id = String(r.id);
    if (!LINK_ID.test(id)) throw bad("That link id can't be used.");
    if (!out.some((x) => x.kind === r.kind && x.id === id)) out.push({ kind: r.kind as LinkKind, id, label: oneLine(r.label, 80) || id });
  }
  if (out.length > LIMITS.links) throw bad(`A note links to ${LIMITS.links} things at most.`);
  return out;
}

/** A title when none was given: the first heading or line, trimmed. */
export function titleFrom(body: string): string {
  for (const line of body.split("\n")) {
    const t = line.replace(/^\s*(?:#{1,6}\s+|[-*>]\s+|\d+[.)]\s+|\[[ x]\]\s+)/i, "").trim();
    if (t) return oneLine(t, LIMITS.title);
  }
  return "Untitled note";
}

const key = (user: string) => `notes:${user}`;
export const emptyDoc = (): NotesDoc => ({ v: 1, notes: [], folders: [], settings: { autoFile: false }, batches: [] });
export const vaultSecretName = (user: string, noteId: string, sid: string) => `notes.secret:${user}:${noteId}:${sid}`;

export class NotesStore {
  readonly state: StateStore;
  constructor(state: StateStore) {
    this.state = state;
  }

  load(user: string): NotesDoc {
    const raw = this.state.getSecret(key(user));
    if (!raw) return emptyDoc();
    try {
      const d = JSON.parse(raw) as Partial<NotesDoc>;
      return { ...emptyDoc(), ...d, settings: { ...emptyDoc().settings, ...(d.settings ?? {}) }, v: 1 };
    } catch {
      throw new NotesError(500, "notes_unreadable", "Your notes could not be read. They are still on the device; ask an administrator.");
    }
  }

  save(user: string, doc: NotesDoc) {
    if (doc.notes.length > LIMITS.notes) throw new NotesError(409, "notes_full", `You can keep ${LIMITS.notes} notes. Export or delete some first.`);
    const total = doc.notes.reduce((n, x) => n + x.body.length, 0);
    if (total > LIMITS.totalBody) throw new NotesError(409, "notes_full", "Your notes take up all the space they are given. Export or delete some first.");
    doc.batches = doc.batches.slice(-LIMITS.batches);
    this.state.setSecret(key(user), JSON.stringify(doc));
  }

  /** Runs `fn` on a copy of the person's document and saves it when `fn` returns. */
  edit<T>(user: string, fn: (doc: NotesDoc) => T): T {
    const doc = this.load(user);
    const out = fn(doc);
    this.save(user, doc);
    return out;
  }

  // ---- The organizations a person shares into. Only owners' names are listed here, never note content.
  shareIndex(): Record<string, string[]> {
    return this.state.getSetting<Record<string, string[]>>("notes.shares") ?? {};
  }
  setShareIndex(idx: Record<string, string[]>) {
    this.state.setSetting("notes.shares", idx);
  }
  /** Recomputes which orgs this owner shares into from their notes. */
  reindexShares(user: string, doc: NotesDoc) {
    const idx = this.shareIndex();
    for (const [org, owners] of Object.entries(idx)) {
      const rest = owners.filter((o) => o !== user);
      if (rest.length) idx[org] = rest;
      else delete idx[org];
    }
    for (const n of doc.notes) if (n.share) idx[n.share.orgId] = [...new Set([...(idx[n.share.orgId] ?? []), user])];
    this.setShareIndex(idx);
  }
}

// ---- Reading

export interface Query {
  q?: string;
  folder?: string;
  tag?: string;
  pinned?: boolean;
  machine?: string;
  org?: string;
}

const norm = (s: string) => s.toLowerCase();

/** Search words must all appear (in the title, tags, folder or body); title matches rank first. */
export function search(notes: Note[], query: Query): Note[] {
  const words = norm(query.q ?? "").split(/\s+/).filter(Boolean).slice(0, 8);
  const scored: { n: Note; score: number }[] = [];
  for (const n of notes) {
    if (query.folder && n.folder !== query.folder && !n.folder.startsWith(`${query.folder}/`)) continue;
    if (query.tag && !n.tags.includes(query.tag)) continue;
    if (query.pinned && !n.pinned) continue;
    if (query.machine && !n.links.some((l) => l.kind === "machine" && l.id === query.machine)) continue;
    if (query.org && !n.links.some((l) => l.kind === "org" && l.id === query.org)) continue;
    let score = 0;
    if (words.length) {
      const title = norm(n.title);
      const rest = norm(`${n.tags.join(" ")} ${n.folder} ${n.body}`);
      let ok = true;
      for (const w of words) {
        if (title.includes(w)) score += 3;
        else if (rest.includes(w)) score += 1;
        else ok = false;
      }
      if (!ok) continue;
    }
    scored.push({ n, score });
  }
  return scored.sort((a, b) => b.score - a.score || Number(b.n.pinned) - Number(a.n.pinned) || b.n.updatedAt - a.n.updatedAt).map((x) => x.n);
}

export function folderCounts(doc: Pick<NotesDoc, "notes" | "folders">): { path: string; count: number }[] {
  const counts = new Map<string, number>([[INBOX, 0]]);
  for (const f of doc.folders) counts.set(f, counts.get(f) ?? 0);
  for (const n of doc.notes) counts.set(n.folder, (counts.get(n.folder) ?? 0) + 1);
  // Parents of a nested folder exist too.
  for (const f of [...counts.keys()]) for (let i = f.lastIndexOf("/"); i > 0; i = f.lastIndexOf("/", i - 1)) if (!counts.has(f.slice(0, i))) counts.set(f.slice(0, i), 0);
  return [...counts].map(([path, count]) => ({ path, count })).sort((a, b) => (a.path === INBOX ? -1 : b.path === INBOX ? 1 : a.path.localeCompare(b.path)));
}

export function tagCounts(notes: Note[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const n of notes) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export const snippet = (body: string, max = 200) => body.replace(/[#>*`_\[\]]+/g, "").replace(/\s+/g, " ").trim().slice(0, max);

export function summary(n: Note, mine = true) {
  return { id: n.id, title: n.title, folder: n.folder, tags: n.tags, pinned: n.pinned, links: n.links, share: n.share, hasVault: n.vault.length > 0, source: n.source, createdAt: n.createdAt, updatedAt: n.updatedAt, snippet: snippet(n.body), mine };
}

export function addFolder(doc: NotesDoc, path: string) {
  if (path !== INBOX && !doc.folders.includes(path)) {
    if (doc.folders.length >= LIMITS.folders) throw new NotesError(409, "folders_full", `You can keep ${LIMITS.folders} folders.`);
    doc.folders.push(path);
  }
}
