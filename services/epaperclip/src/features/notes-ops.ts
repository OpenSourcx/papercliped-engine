import type { ProxmoxClient } from "@papercliped-engine/proxmox-client";
import type { EngineGateway } from "../engine.ts";
import type { Session } from "../sessions.ts";
import type { StateStore } from "../state.ts";
import { INBOX, LIMITS, NotesError, NotesStore, addFolder, bad, cleanBody, cleanFolder, cleanLinks, cleanTags, folderCounts, newId, oneLine, search, summary, tagCounts, titleFrom, vaultSecretName, type Batch, type Note, type NotesDoc, type Query, type VaultRef } from "./notes-core.ts";
import { EMPTY_INVENTORY, type Inventory } from "./notes-rules.ts";
import { PLACEHOLDER, placeholdersIn, publicFinding, restoreSecrets, scanSecrets, type PublicFinding } from "./notes-secrets.ts";
import { AUTO_FILE_CONFIDENCE, propose, providerModel, type Draft, type NotesModel, type Proposal } from "./notes-sort.ts";
import { exportFiles, importFiles, readZip, writeZip } from "./notes-zip.ts";
import { runtimeFor } from "./pin-core.ts";

/**
 * What Notes does, independent of HTTP: create, edit, search, sort drafts, undo, secrets, sharing, export and import.
 * The routes (notes.ts) and Pin's tools (notes-tools.ts) both call these, so both get the same limits and the same rules.
 */

export interface OrgRef {
  id: string;
  name: string;
}

export interface NotesRuntimeOpts {
  /** The model that sorts for this person. Default: their own Pin provider and model; null when they have none. */
  model?: (user: string) => NotesModel | null;
  /** The organizations a person belongs to. Default: asks the engine as them. */
  orgsOf?: (s: Session, gw: EngineGateway | null) => Promise<OrgRef[]>;
  now?: () => number;
}

const DRAFT_TTL_MS = 30 * 60_000;
const DRAFTS_PER_PERSON = 5;

export class NotesRuntime {
  readonly store: NotesStore;
  readonly state: StateStore;
  readonly opts: NotesRuntimeOpts;
  readonly now: () => number;
  private readonly drafts = new Map<string, Draft>();
  constructor(state: StateStore, opts: NotesRuntimeOpts = {}) {
    this.state = state;
    this.store = new NotesStore(state);
    this.opts = opts;
    this.now = opts.now ?? runtimeFor(state).now;
  }

  modelFor(user: string): NotesModel | null {
    return this.opts.model ? this.opts.model(user) : providerModel(this.state, user);
  }

  async orgsOf(s: Session, gw: EngineGateway | null): Promise<OrgRef[]> {
    if (this.opts.orgsOf) return this.opts.orgsOf(s, gw);
    if (!gw) return [];
    try {
      const me = await gw.me(s);
      const active = new Set((me.memberships ?? []).filter((m) => m.status === "active").map((m) => m.companyId));
      let names = new Map<string, string>();
      try {
        const list = await gw.userJson<{ id: string; name: string }[]>(s, "GET", "/api/companies");
        names = new Map(list.map((c) => [c.id, c.name]));
      } catch {
        /* names are a nicety */
      }
      return [...active].map((id) => ({ id, name: names.get(id) ?? id }));
    } catch {
      return [];
    }
  }

  putDraft(d: Draft) {
    this.sweep();
    const mine = [...this.drafts.values()].filter((x) => x.owner === d.owner).sort((a, b) => a.createdAt - b.createdAt);
    while (mine.length >= DRAFTS_PER_PERSON) this.drafts.delete(mine.shift()!.id);
    this.drafts.set(d.id, d);
  }
  draft(owner: string, id: string): Draft {
    this.sweep();
    const d = this.drafts.get(id);
    if (!d || d.owner !== owner) throw new NotesError(404, "draft_gone", "That sort is no longer here (it is kept for 30 minutes). Sort again.");
    return d;
  }
  draftOrNull(owner: string, id: string): Draft | null {
    try {
      return this.draft(owner, id);
    } catch {
      return null;
    }
  }
  dropDraft(id: string) {
    this.drafts.delete(id);
  }
  private sweep() {
    const t = this.now();
    for (const [id, d] of this.drafts) if (t - d.createdAt > DRAFT_TTL_MS) this.drafts.delete(id);
  }
}

const runtimes = new WeakMap<StateStore, NotesRuntime>();
export function configureNotes(state: StateStore, opts: NotesRuntimeOpts = {}): NotesRuntime {
  const rt = new NotesRuntime(state, opts);
  runtimes.set(state, rt);
  return rt;
}
export function notesFor(state: StateStore): NotesRuntime {
  let rt = runtimes.get(state);
  if (!rt) {
    rt = new NotesRuntime(state);
    runtimes.set(state, rt);
  }
  return rt;
}

// ---- Inventory: only what the signed-in person can see

const GUEST_CONFIGS = 80;

export async function buildInventory(pve: ProxmoxClient, orgs: OrgRef[]): Promise<Inventory> {
  const res = await pve.clusterResources();
  const guests = res.filter((r) => (r.type === "lxc" || r.type === "qemu") && typeof r.vmid === "number" && r.template !== 1);
  const machines = guests.map((g) => ({ vmid: g.vmid!, name: g.name ?? String(g.vmid), type: g.type, ips: [] as string[], node: g.node }));
  // Addresses live in each machine's configuration; read a bounded number, a few at a time.
  const todo = machines.slice(0, GUEST_CONFIGS);
  for (let i = 0; i < todo.length; i += 8) {
    await Promise.all(
      todo.slice(i, i + 8).map(async (m) => {
        try {
          const cfg = await pve.guestConfig(m.node ?? "", m.type as "lxc" | "qemu", m.vmid);
          for (const [k, v] of Object.entries(cfg)) if (/^(?:net|ipconfig)\d+$/.test(k) && typeof v === "string") for (const x of v.matchAll(/\bip=((?:\d{1,3}\.){3}\d{1,3})/g)) m.ips.push(x[1]);
        } catch {
          /* a machine whose config can't be read is still matched by id and name */
        }
      }),
    );
  }
  return { machines: machines.map(({ vmid, name, type, ips }) => ({ vmid, name, type, ips })), storages: [...new Set(res.filter((r) => r.type === "storage" && r.storage).map((r) => r.storage!))], orgs };
}

export const emptyInventory = (): Inventory => EMPTY_INVENTORY;

// ---- Notes

export interface NoteInput {
  title?: unknown;
  body?: unknown;
  folder?: unknown;
  tags?: unknown;
  links?: unknown;
  pinned?: unknown;
}

export function checkBody(v: unknown): string {
  const body = cleanBody(v);
  if (body.length > LIMITS.body) throw bad(`A note holds ${LIMITS.body.toLocaleString("en")} characters at most. Split it into two notes.`, "too_large");
  return body;
}

export function warningsFor(body: string): PublicFinding[] {
  return scanSecrets(body).findings.map(publicFinding);
}

function makeNote(rt: NotesRuntime, input: NoteInput, source: Note["source"]): Note {
  const body = checkBody(input.body);
  if (!body.trim()) throw bad("A note needs some text.");
  const t = rt.now();
  return {
    id: newId(8),
    title: oneLine(input.title, LIMITS.title) || titleFrom(body),
    body,
    folder: cleanFolder(input.folder),
    tags: cleanTags(input.tags),
    pinned: input.pinned === true,
    links: cleanLinks(input.links),
    share: null,
    vault: [],
    source,
    createdAt: t,
    updatedAt: t,
  };
}

export function createNote(rt: NotesRuntime, user: string, input: NoteInput, source: Note["source"] = "manual") {
  const note = makeNote(rt, input, source);
  rt.store.edit(user, (doc) => {
    doc.notes.unshift(note);
  });
  return { note, warnings: warningsFor(note.body) };
}

export function getNote(rt: NotesRuntime, user: string, id: string): Note {
  const n = rt.store.load(user).notes.find((x) => x.id === id);
  if (!n) throw new NotesError(404, "not_found", "There is no such note.");
  return n;
}

export interface NotePatch extends NoteInput {
  /** The note's `updatedAt` as the editor saw it. A different value means someone changed it meanwhile. */
  expectedUpdatedAt?: unknown;
}

function dropUnusedVault(rt: NotesRuntime, user: string, n: Note) {
  const here = new Set(placeholdersIn(n.body));
  for (const v of n.vault) if (!here.has(v.id)) rt.state.deleteSecret(vaultSecretName(user, n.id, v.id));
  n.vault = n.vault.filter((v) => here.has(v.id));
}

export function updateNote(rt: NotesRuntime, user: string, id: string, patch: NotePatch) {
  return rt.store.edit(user, (doc) => {
    const n = doc.notes.find((x) => x.id === id);
    if (!n) throw new NotesError(404, "not_found", "There is no such note.");
    if (patch.expectedUpdatedAt !== undefined && patch.expectedUpdatedAt !== n.updatedAt) throw new NotesError(409, "changed", "This note changed since you opened it. Reload it to see the latest.");
    if (patch.body !== undefined) {
      const body = checkBody(patch.body);
      if (!body.trim()) throw bad("A note needs some text.");
      n.body = body;
      dropUnusedVault(rt, user, n);
    }
    if (patch.title !== undefined) n.title = oneLine(patch.title, LIMITS.title) || titleFrom(n.body);
    if (patch.folder !== undefined) n.folder = cleanFolder(patch.folder);
    if (patch.tags !== undefined) n.tags = cleanTags(patch.tags);
    if (patch.links !== undefined) n.links = cleanLinks(patch.links);
    if (patch.pinned !== undefined) n.pinned = patch.pinned === true;
    n.updatedAt = Math.max(rt.now(), n.updatedAt + 1);
    return { note: n, warnings: warningsFor(n.body) };
  });
}

export function deleteNote(rt: NotesRuntime, user: string, id: string) {
  rt.store.edit(user, (doc) => {
    const i = doc.notes.findIndex((x) => x.id === id);
    if (i < 0) throw new NotesError(404, "not_found", "There is no such note.");
    for (const v of doc.notes[i].vault) rt.state.deleteSecret(vaultSecretName(user, id, v.id));
    doc.notes.splice(i, 1);
  });
  rt.store.reindexShares(user, rt.store.load(user));
}

export function listNotes(rt: NotesRuntime, user: string, q: Query) {
  const doc = rt.store.load(user);
  const notes = search(doc.notes, q);
  return { notes: notes.map((n) => summary(n)), total: doc.notes.length, folders: folderCounts(doc), tags: tagCounts(doc.notes), settings: doc.settings, limits: { notes: LIMITS.notes, body: LIMITS.body, totalBody: LIMITS.totalBody, used: doc.notes.reduce((n, x) => n + x.body.length, 0) }, batches: doc.batches.filter((b) => !b.undone).slice(-3).map(batchView) };
}

export const batchView = (b: Batch) => ({ id: b.id, at: b.at, kind: b.kind, created: b.created.length, updated: b.updated.length, undone: b.undone });

// ---- Folders

export function createFolder(rt: NotesRuntime, user: string, path: unknown) {
  const p = cleanFolder(path);
  rt.store.edit(user, (doc) => addFolder(doc, p));
  return p;
}

export function renameFolder(rt: NotesRuntime, user: string, from: unknown, to: unknown) {
  const a = cleanFolder(from);
  const b = cleanFolder(to);
  if (a === INBOX) throw bad("The Inbox can't be renamed.");
  if (a === b) return b;
  rt.store.edit(user, (doc) => {
    const move = (p: string) => (p === a ? b : p.startsWith(`${a}/`) ? `${b}${p.slice(a.length)}` : p);
    for (const n of doc.notes) n.folder = move(n.folder);
    const moved = doc.folders.map(move);
    doc.folders = [...new Set(moved)];
    for (const n of doc.notes) if (n.folder.split("/").length > LIMITS.folderDepth) throw bad(`Folders go ${LIMITS.folderDepth} levels deep at most.`);
    addFolder(doc, b);
  });
  return b;
}

export function deleteFolder(rt: NotesRuntime, user: string, path: unknown) {
  const p = cleanFolder(path);
  if (p === INBOX) throw bad("The Inbox can't be deleted.");
  rt.store.edit(user, (doc) => {
    if (doc.notes.some((n) => n.folder === p || n.folder.startsWith(`${p}/`))) throw new NotesError(409, "not_empty", "Move or delete the notes in this folder first.");
    doc.folders = doc.folders.filter((f) => f !== p && !f.startsWith(`${p}/`));
  });
}

// ---- Secrets

/** Replaces likely secrets in a saved note with placeholders; `vault` keeps the values in the host's vault. */
export function secretsAction(rt: NotesRuntime, user: string, id: string, action: "redact" | "vault") {
  return rt.store.edit(user, (doc) => {
    const n = doc.notes.find((x) => x.id === id);
    if (!n) throw new NotesError(404, "not_found", "There is no such note.");
    const start = Math.max(0, ...placeholdersIn(n.body).map((s) => Number(s.slice(1))), ...n.vault.map((v) => Number(v.id.slice(1))));
    const scan = scanSecrets(n.body, start);
    if (!scan.findings.length) return { note: n, count: 0 };
    if (action === "vault") {
      if (n.vault.length + scan.findings.length > LIMITS.vaultSecretsPerNote) throw bad(`A note can keep ${LIMITS.vaultSecretsPerNote} secrets in the vault.`);
      for (const f of scan.findings) {
        rt.state.setSecret(vaultSecretName(user, n.id, f.id), f.value);
        n.vault.push({ id: f.id, kind: f.kind, label: f.label });
      }
    }
    n.body = scan.redacted;
    n.updatedAt = Math.max(rt.now(), n.updatedAt + 1);
    return { note: n, count: scan.findings.length };
  });
}

export function revealSecret(rt: NotesRuntime, user: string, id: string, sid: string): { value: string; label: string } {
  const n = getNote(rt, user, id);
  const ref = n.vault.find((v) => v.id === sid);
  const value = ref ? rt.state.getSecret(vaultSecretName(user, id, sid)) : null;
  if (!ref || value === null) throw new NotesError(404, "not_found", "That secret isn't in the vault.");
  runtimeFor(rt.state).audit(user, "notes.secret.reveal", id, ref.label);
  return { value, label: ref.label };
}

// ---- Sorting

export type SecretMode = "redact" | "vault" | "keep";

export async function startSort(rt: NotesRuntime, user: string, inp: { text?: unknown; inbox?: unknown; noteIds?: unknown; folder?: unknown }, inv: Inventory, autoFileAllowed = true) {
  const doc = rt.store.load(user);
  let text: string | undefined;
  let notes: Note[] | undefined;
  if (typeof inp.text === "string" && inp.text.trim()) {
    text = cleanBody(inp.text);
    if (text.length > 120_000) throw bad("That is more than 120,000 characters. Paste it in two or more parts.", "too_large");
  } else if (inp.inbox === true || Array.isArray(inp.noteIds)) {
    const ids = Array.isArray(inp.noteIds) ? new Set(inp.noteIds.filter((x): x is string => typeof x === "string").slice(0, 60)) : null;
    notes = doc.notes.filter((n) => (ids ? ids.has(n.id) : n.folder === INBOX)).slice(0, 60);
    if (!notes.length) throw bad(ids ? "None of those notes exist." : "The Inbox is empty.", "nothing_to_sort");
  } else throw bad("Paste some text to sort, or ask to sort the Inbox.");
  const folderHint = inp.folder === undefined || inp.folder === "" ? undefined : cleanFolder(inp.folder);
  const draft = await propose({ owner: user, now: rt.now(), id: newId(8), doc, inv, model: rt.modelFor(user), text, notes, folderHint });
  rt.putDraft(draft);
  if (doc.settings.autoFile && autoFileAllowed) {
    const sure = draft.proposals.filter((p) => p.confidence >= AUTO_FILE_CONFIDENCE && p.secrets.length === 0);
    if (sure.length) {
      const result = applyDraft(rt, user, draft.id, { only: sure.map((p) => p.key) }, "redact");
      return { draft: draftView(rt.draftOrNull(user, draft.id)), autoFiled: result };
    }
  }
  return { draft: draftView(draft), autoFiled: null };
}

export const draftView = (d: Draft | null) =>
  d && {
    id: d.id,
    createdAt: d.createdAt,
    engine: d.engine,
    fallback: d.fallback,
    proposals: d.proposals,
    secretCount: d.secretValues.length,
  };

export interface Edit {
  key: string;
  include?: boolean;
  title?: unknown;
  folder?: unknown;
  tags?: unknown;
  links?: unknown;
  body?: unknown;
}

export interface ApplyInput {
  edits?: Edit[];
  /** Apply only these proposals (everything else stays in the draft). */
  only?: string[];
}

/** Files the accepted proposals. Nothing is filed before this call. */
export function applyDraft(rt: NotesRuntime, user: string, draftId: string, input: ApplyInput, mode: SecretMode) {
  const draft = rt.draft(user, draftId);
  const edits = new Map<string, Edit>();
  for (const e of input.edits ?? []) {
    if (!draft.proposals.some((p) => p.key === e.key)) throw bad(`There is no proposal ${String(e.key).slice(0, 20)} in this sort.`);
    edits.set(e.key, e);
  }
  const only = input.only ? new Set(input.only) : null;
  const chosen = draft.proposals.filter((p) => (only ? only.has(p.key) : true) && edits.get(p.key)?.include !== false);
  const t = rt.now();
  const out = rt.store.edit(user, (doc) => {
    const created: Note[] = [];
    const updated: Note[] = [];
    const batch: Batch = { id: newId(6), at: t, kind: "sort", created: [], updated: [], undone: false };
    const counts = { redacted: 0, vaulted: 0, kept: 0 };
    for (const p of chosen) {
      const e = edits.get(p.key);
      const title = e?.title !== undefined ? oneLine(e.title, LIMITS.title) || p.title : p.title;
      const folder = e?.folder !== undefined ? cleanFolder(e.folder) : p.folder;
      const tags = cleanTags(e?.tags !== undefined ? e.tags : p.tags);
      const links = cleanLinks(e?.links !== undefined ? e.links : p.links);
      if (p.noteId) {
        const n = doc.notes.find((x) => x.id === p.noteId);
        if (!n) continue;
        batch.updated.push({ id: n.id, prev: { title: n.title, folder: n.folder, tags: [...n.tags], links: n.links.map((l) => ({ ...l })) } });
        n.title = title;
        n.folder = folder;
        n.tags = cleanTags([...n.tags, ...tags]).slice(0, LIMITS.tags);
        n.links = cleanLinks([...n.links, ...links].slice(0, LIMITS.links));
        n.updatedAt = Math.max(t, n.updatedAt + 1);
        updated.push(n);
        continue;
      }
      let body = e?.body !== undefined ? checkBody(e.body) : p.body;
      if (!body.trim()) continue;
      const note: Note = { id: newId(8), title, body, folder, tags, pinned: false, links, share: null, vault: [], source: "sorted", createdAt: t, updatedAt: t };
      const holds = placeholdersIn(body);
      if (mode === "keep") {
        body = restoreSecrets(body, draft.secretValues);
        note.body = body;
        counts.kept += holds.length;
      } else if (mode === "vault") {
        const refs: VaultRef[] = [];
        for (const sid of new Set(holds)) {
          const f = draft.secretValues.find((x) => x.id === sid);
          if (!f) continue;
          if (refs.length >= LIMITS.vaultSecretsPerNote) throw bad(`A note can keep ${LIMITS.vaultSecretsPerNote} secrets in the vault.`);
          rt.state.setSecret(vaultSecretName(user, note.id, sid), f.value);
          refs.push({ id: sid, kind: f.kind, label: f.label });
        }
        note.vault = refs;
        counts.vaulted += refs.length;
      } else counts.redacted += holds.length;
      addFolder(doc, folder);
      doc.notes.unshift(note);
      batch.created.push(note.id);
      created.push(note);
    }
    for (const u of updated) addFolder(doc, u.folder);
    if (created.length || updated.length) doc.batches.push(batch);
    return { created, updated, batch: created.length || updated.length ? batch.id : null, secrets: counts };
  });
  // Filed proposals leave the draft; the rest wait for a decision.
  const filed = new Set(chosen.map((p) => p.key));
  const rest = only ? draft.proposals.filter((p) => !filed.has(p.key)) : [];
  if (rest.length) draft.proposals = rest;
  else rt.dropDraft(draft.id);
  return { created: out.created.map((n) => summary(n)), updated: out.updated.map((n) => summary(n)), batch: out.batch, secrets: out.secrets };
}

/** Puts back what a batch changed: created notes go, changed notes get their old title, folder, tags and links. */
export function undoBatch(rt: NotesRuntime, user: string, batchId: string) {
  return rt.store.edit(user, (doc) => {
    const b = doc.batches.find((x) => x.id === batchId);
    if (!b) throw new NotesError(404, "not_found", "That change is no longer in the undo history.");
    if (b.undone) throw new NotesError(409, "undone", "That change was already undone.");
    for (const id of b.created) {
      const i = doc.notes.findIndex((n) => n.id === id);
      if (i < 0) continue;
      for (const v of doc.notes[i].vault) rt.state.deleteSecret(vaultSecretName(user, id, v.id));
      doc.notes.splice(i, 1);
    }
    for (const u of b.updated) {
      const n = doc.notes.find((x) => x.id === u.id);
      if (n) Object.assign(n, { title: u.prev.title, folder: u.prev.folder, tags: u.prev.tags, links: u.prev.links, updatedAt: Math.max(rt.now(), n.updatedAt + 1) });
    }
    b.undone = true;
    return { removed: b.created.length, restored: b.updated.length };
  });
}

// ---- Sharing with an organization (read only for its members)

export async function shareNote(rt: NotesRuntime, s: Session, gw: EngineGateway | null, id: string, orgId: unknown) {
  const user = s.username;
  let share: Note["share"] = null;
  if (orgId !== null && orgId !== undefined) {
    if (typeof orgId !== "string") throw bad("Choose an organization.");
    const orgs = await rt.orgsOf(s, gw);
    const org = orgs.find((o) => o.id === orgId);
    if (!org) throw new NotesError(403, "not_a_member", "You can only share with organizations you belong to.");
    share = { orgId: org.id, orgName: org.name };
  }
  const note = rt.store.edit(user, (doc) => {
    const n = doc.notes.find((x) => x.id === id);
    if (!n) throw new NotesError(404, "not_found", "There is no such note.");
    n.share = share;
    n.updatedAt = Math.max(rt.now(), n.updatedAt + 1);
    return n;
  });
  rt.store.reindexShares(user, rt.store.load(user));
  runtimeFor(rt.state).audit(user, share ? "notes.share" : "notes.unshare", id, share?.orgName);
  return note;
}

/** Notes other people shared with organizations this person belongs to. Membership is checked now, every time. */
export async function sharedWithMe(rt: NotesRuntime, s: Session, gw: EngineGateway | null) {
  const orgs = await rt.orgsOf(s, gw);
  const mine = new Set(orgs.map((o) => o.id));
  const idx = rt.store.shareIndex();
  const out: (ReturnType<typeof summary> & { owner: string })[] = [];
  for (const org of mine) {
    for (const owner of idx[org] ?? []) {
      if (owner === s.username) continue;
      for (const n of rt.store.load(owner).notes) if (n.share?.orgId === org) out.push({ ...summary(n, false), owner });
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200);
}

export async function sharedNote(rt: NotesRuntime, s: Session, gw: EngineGateway | null, owner: string, id: string) {
  const n = rt.store.load(owner).notes.find((x) => x.id === id);
  const orgs = await rt.orgsOf(s, gw);
  if (!n || !n.share || owner === s.username || !orgs.some((o) => o.id === n.share!.orgId)) throw new NotesError(404, "not_found", "There is no such note.");
  return { ...n, vault: [], mine: false, owner };
}

// ---- Export and import

export function exportZip(rt: NotesRuntime, user: string): Buffer {
  return writeZip(exportFiles(rt.store.load(user).notes), new Date(rt.now()));
}

export function importZip(rt: NotesRuntime, user: string, data: Buffer) {
  const isZip = data.length > 4 && data.readUInt32LE(0) === 0x04034b50;
  const files = isZip ? readZip(data) : [{ name: "Imported note.md", data }];
  const { notes: found, skipped } = importFiles(files);
  const t = rt.now();
  return rt.store.edit(user, (doc) => {
    const batch: Batch = { id: newId(6), at: t, kind: "import", created: [], updated: [], undone: false };
    let duplicates = 0;
    let noSpace = 0;
    let used = doc.notes.reduce((n, x) => n + x.body.length, 0);
    for (const f of found) {
      if (doc.notes.some((n) => n.title === f.title && n.folder === f.folder && n.body === f.body)) {
        duplicates++;
        continue;
      }
      if (doc.notes.length >= LIMITS.notes || used + f.body.length > LIMITS.totalBody) {
        noSpace++;
        continue;
      }
      const note: Note = { id: newId(8), title: f.title, body: f.body, folder: f.folder, tags: f.tags, pinned: f.pinned, links: f.links, share: null, vault: [], source: "import", createdAt: t, updatedAt: t };
      used += f.body.length;
      addFolder(doc, f.folder);
      doc.notes.unshift(note);
      batch.created.push(note.id);
    }
    if (batch.created.length) doc.batches.push(batch);
    const secrets = batch.created.reduce((n, id) => n + scanSecrets(doc.notes.find((x) => x.id === id)!.body).findings.length, 0);
    return { imported: batch.created.length, duplicates, skipped, noSpace, batch: batch.created.length ? batch.id : null, secrets };
  });
}

export function setSettings(rt: NotesRuntime, user: string, b: Record<string, unknown>) {
  return rt.store.edit(user, (doc) => {
    for (const k of Object.keys(b)) if (k !== "autoFile") throw bad(`Unknown setting ${k.slice(0, 30)}.`);
    if (b.autoFile !== undefined) {
      if (typeof b.autoFile !== "boolean") throw bad("autoFile is true or false.");
      doc.settings.autoFile = b.autoFile;
    }
    return doc.settings;
  });
}

// ---- Filing existing notes (Pin's file_notes and the "File" action)

export function fileNotes(rt: NotesRuntime, user: string, input: { noteIds: string[]; folder?: unknown; addTags?: unknown }) {
  const folder = input.folder === undefined ? undefined : cleanFolder(input.folder);
  const add = cleanTags(input.addTags);
  const t = rt.now();
  return rt.store.edit(user, (doc) => {
    const batch: Batch = { id: newId(6), at: t, kind: "file", created: [], updated: [], undone: false };
    for (const id of input.noteIds.slice(0, 50)) {
      const n = doc.notes.find((x) => x.id === id);
      if (!n) continue;
      batch.updated.push({ id: n.id, prev: { title: n.title, folder: n.folder, tags: [...n.tags], links: n.links.map((l) => ({ ...l })) } });
      if (folder) n.folder = folder;
      n.tags = cleanTags([...n.tags, ...add]).slice(0, LIMITS.tags);
      n.updatedAt = Math.max(t, n.updatedAt + 1);
    }
    if (folder) addFolder(doc, folder);
    if (batch.updated.length) doc.batches.push(batch);
    return { filed: batch.updated.length, batch: batch.updated.length ? batch.id : null };
  });
}

export type { Draft, Proposal, NotesDoc };
export { PLACEHOLDER };
