import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, FolderOpen, FolderPlus, Inbox, KeyRound, NotebookPen, Pencil, Pin, PinOff, Plus, Search, Share2, Sparkles, Trash2, Upload, Users } from "lucide-react";
import { useEngine } from "../../../data/store.tsx";
import { errorMessage } from "../../../data/engine/pinRuntimeApi.ts";
import { notesApi, type NoteFull, type NoteSummary, type SecretWarning } from "../../../data/engine/notesApi.ts";
import { cn } from "../../../lib/storage.ts";
import { Modal } from "../../../ui/Modal.tsx";
import { Tag } from "../../../ui/Tag.tsx";
import { Button, Card, Chip, EmptyState, Field, IconButton, Input, Notice, PageFrame, PageHeader, Segmented, Select, Skeleton, Toggle } from "../../../ui/primitives.tsx";
import { Markdown } from "./Markdown.tsx";
import { NoteEditor } from "./NoteEditor.tsx";
import { QuickNote, SecretBanner } from "./QuickNote.tsx";
import { SortModal } from "./SortReview.tsx";
import { LinkChip, NOTES_KEY, agoMs, useDevice } from "./common.tsx";

/**
 * The Notes page: dump text, let Pin sort it, stay in charge. Folders and tags on the left, search and the list in the
 * middle, one note open at a time. Everything here is the signed-in person's own (plus what an organization shared).
 */

type Scope = "all" | "pinned" | "shared";

export function NotesPage() {
  const engine = useEngine();
  const device = useDevice();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const folder = params.get("folder") ?? undefined;
  const tag = params.get("tag") ?? undefined;
  const q = params.get("q") ?? "";
  const scope = (params.get("scope") as Scope | null) ?? "all";
  const openId = params.get("note");
  const owner = params.get("owner");
  const draftId = params.get("draft") ?? undefined;
  const set = (patch: Record<string, string | null>) => setParams((p) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(patch)) { if (v === null || v === "") n.delete(k); else n.set(k, v); } return n; }, { replace: true });

  const list = useQuery({ queryKey: [...NOTES_KEY, "list", q, folder, tag, scope === "pinned"], queryFn: () => notesApi.list({ q, folder, tag, pinned: scope === "pinned" }), enabled: engine.live, placeholderData: (prev) => prev });
  const shared = useQuery({ queryKey: [...NOTES_KEY, "shared"], queryFn: notesApi.shared, enabled: engine.live });
  const [edit, setEdit] = useState<{ note?: NoteFull } | null>(null);
  const [sorting, setSorting] = useState(!!draftId);
  const [folderModal, setFolderModal] = useState<null | { from?: string }>(null);
  const [message, setMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const done = () => qc.invalidateQueries({ queryKey: NOTES_KEY });
  const auto = useMutation({ mutationFn: (v: boolean) => notesApi.setAutoFile(v), onSuccess: done });
  const imp = useMutation({
    mutationFn: (f: File) => notesApi.importFile(f),
    onSuccess: (r) => {
      setMessage(`Imported ${r.imported} note${r.imported === 1 ? "" : "s"}${r.duplicates ? `, ${r.duplicates} already here` : ""}${r.skipped ? `, ${r.skipped} file${r.skipped === 1 ? "" : "s"} skipped` : ""}${r.noSpace ? `, ${r.noSpace} didn't fit` : ""}${r.secrets ? `. ${r.secrets} likely secret${r.secrets === 1 ? "" : "s"} in the imported text: open a note to move them to the vault` : ""}.`);
      done();
    },
  });

  if (!engine.live) {
    return (
      <PageFrame width="4xl">
        <PageHeader title="Notes" subtitle="Dump text, let Pin sort it into folders and tags." />
        <Card><EmptyState icon={<NotebookPen className="h-5 w-5" />} title="Notes live on a device" body="Notes are stored encrypted on your ePaperclip host and sorted with the model Pin uses there. The demo has no host, so there is nothing to save to." /></Card>
      </PageFrame>
    );
  }

  const data = list.data;
  const folders = data?.folders ?? [];
  const sharedNotes = shared.data?.notes ?? [];
  const notes: NoteSummary[] = scope === "shared" ? sharedNotes.filter((n) => !q || `${n.title} ${n.snippet}`.toLowerCase().includes(q.toLowerCase())) : (data?.notes ?? []);
  const inbox = folders.find((f) => f.path === "Inbox")?.count ?? 0;

  return (
    <PageFrame width="6xl">
      <PageHeader
        title="Notes"
        subtitle="Dump anything here. Pin sorts it into folders and tags, you review it, and everything stays yours."
        actions={<>
          <Button variant="primary" onClick={() => setSorting(true)}><Sparkles className="h-4 w-4" />Sort a pile</Button>
          <Button onClick={() => setEdit({})}><Plus className="h-4 w-4" />New note</Button>
          <Button variant="ghost" onClick={() => fileInput.current?.click()} loading={imp.isPending}><Upload className="h-4 w-4" />Import</Button>
          <a href={notesApi.exportUrl} download="notes.zip" className="transition-control inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium text-ink-2 hover:text-ink hover:bg-surface-2"><Download className="h-4 w-4" />Export</a>
          <input ref={fileInput} type="file" accept=".zip,.md,.markdown,.txt,application/zip" className="sr-only" aria-label="Import notes" onChange={(e) => { const f = e.target.files?.[0]; if (f) imp.mutate(f); e.target.value = ""; }} />
        </>}
      />
      {message && <Notice tone="good" className="mb-4" action={<Button size="sm" variant="ghost" onClick={() => setMessage(null)}>Dismiss</Button>}>{message}</Notice>}
      {imp.error && <Notice tone="critical" title="Couldn't import" className="mb-4">{errorMessage(imp.error)}</Notice>}

      <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="space-y-5 min-w-0" aria-label="Folders and tags">
          <Segmented<Scope> label="Show" size="sm" value={scope} onChange={(v) => set({ scope: v === "all" ? null : v, note: null, owner: null })} options={[{ value: "all", label: "All" }, { value: "pinned", label: "Pinned" }, { value: "shared", label: `Shared${sharedNotes.length ? ` ${sharedNotes.length}` : ""}` }]} />
          <nav aria-label="Folders">
            <div className="flex items-center justify-between mb-2"><h2 className="text-compact font-semibold uppercase tracking-label text-ink-3">Folders</h2><IconButton size="sm" label="New folder" onClick={() => setFolderModal({})}><FolderPlus className="h-4 w-4" /></IconButton></div>
            <ul className="space-y-0.5">
              <li><FolderButton active={!folder} onClick={() => set({ folder: null, note: null })} icon={<FolderOpen className="h-4 w-4" />} label="All notes" count={data?.total} /></li>
              {folders.map((f) => (
                <li key={f.path}><FolderButton active={folder === f.path} onClick={() => set({ folder: f.path, note: null, scope: null })} icon={f.path === "Inbox" ? <Inbox className="h-4 w-4" /> : <FolderOpen className="h-4 w-4" />} label={f.path.split("/").pop()!} depth={f.path.split("/").length - 1} count={f.count} title={f.path} /></li>
              ))}
            </ul>
            {folder && folder !== "Inbox" && <Button size="sm" variant="ghost" className="mt-2" onClick={() => setFolderModal({ from: folder })}><Pencil className="h-3.5 w-3.5" />Rename or delete folder</Button>}
          </nav>
          {(data?.tags.length ?? 0) > 0 && (
            <div>
              <h2 className="text-compact font-semibold uppercase tracking-label text-ink-3 mb-2">Tags</h2>
              <div className="flex flex-wrap gap-1.5">
                {data!.tags.map((t) => (
                  <button key={t.tag} type="button" aria-pressed={tag === t.tag} onClick={() => set({ tag: tag === t.tag ? null : t.tag, note: null })} className={cn("transition-control rounded-sm", tag === t.tag && "ring-2 ring-accent")}><Tag name={`${t.tag} ${t.count}`} /></button>
                ))}
              </div>
            </div>
          )}
          <Card className="p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div><div className="text-sm font-medium">Auto-file</div><p className="text-xs text-ink-3 mt-0.5 text-pretty">File high-confidence results without the preview. Never when a secret was found. You can undo.</p></div>
              <Toggle checked={!!data?.settings.autoFile} onChange={(v) => auto.mutate(v)} label="Auto-file high-confidence results" disabled={!data} />
            </div>
            {data && <p className="text-xs text-ink-3 tabular-nums">{data.total} of {data.limits.notes} notes · {Math.round((data.limits.used / data.limits.totalBody) * 100)}% of space</p>}
          </Card>
        </aside>

        <section className="min-w-0 space-y-4" aria-label="Notes">
          {openId ? <NoteView id={openId} owner={owner} folders={folders.map((f) => f.path)} onBack={() => set({ note: null, owner: null })} onEdit={(n) => setEdit({ note: n })} onGone={() => set({ note: null, owner: null })} /> : (
            <>
              <Card className="p-4"><QuickNote compact /></Card>
              {inbox > 0 && scope === "all" && !folder && (
                <Notice tone="info" title={`${inbox} note${inbox === 1 ? "" : "s"} in the Inbox`} action={<Button size="sm" onClick={() => setSorting(true)}><Sparkles className="h-3.5 w-3.5" />Sort the Inbox</Button>}>Unsorted notes wait here. Pin can file them, and you review first.</Notice>
              )}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-3 pointer-events-none" aria-hidden />
                <Input aria-label="Search notes" placeholder="Search titles, text, tags" value={q} onChange={(e) => set({ q: e.target.value })} className="pl-9" />
              </div>
              {list.isPending ? <div className="space-y-3" aria-busy="true">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div> : list.error ? (
                <Notice tone="critical" title="Couldn't read your notes" action={<Button size="sm" onClick={() => list.refetch()}>Try again</Button>}>{errorMessage(list.error)}</Notice>
              ) : notes.length === 0 ? (
                <Card><EmptyState icon={<NotebookPen className="h-5 w-5" />} title={q || folder || tag ? "No notes match" : scope === "shared" ? "Nothing shared with you" : "No notes yet"} body={q || folder || tag ? "Try fewer words or clear the folder and tag." : scope === "shared" ? "When someone in one of your organizations shares a note, it shows up here." : "Jot something above, or paste a pile of text and let Pin sort it. You always get a preview first."} action={!q && !folder && !tag && scope === "all" ? <Button variant="primary" onClick={() => setSorting(true)}><Sparkles className="h-4 w-4" />Sort a pile</Button> : undefined} /></Card>
              ) : (
                <ul className="space-y-2">
                  {notes.map((n) => <li key={`${n.owner ?? ""}${n.id}`}><NoteRow n={n} onOpen={() => set({ note: n.id, owner: n.owner ?? null })} /></li>)}
                </ul>
              )}
            </>
          )}
        </section>
      </div>

      {edit && <NoteEditor note={edit.note} folders={folders.map((f) => f.path)} initial={folder ? { folder } : undefined} onClose={() => setEdit(null)} onSaved={(n) => { setEdit(null); set({ note: n.id, owner: null }); }} />}
      {sorting && <SortModal draftId={draftId} folders={folders.map((f) => f.path)} onClose={() => { setSorting(false); set({ draft: null }); done(); }} />}
      {folderModal && <FolderModal from={folderModal.from} folders={folders} onClose={() => setFolderModal(null)} onChanged={(next) => { done(); setFolderModal(null); set({ folder: next }); }} />}
      <p className="sr-only">Device {device}</p>
    </PageFrame>
  );
}

function FolderButton({ active, onClick, icon, label, count, depth = 0, title }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count?: number; depth?: number; title?: string }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-current={active ? "true" : undefined} style={{ paddingLeft: `${0.5 + depth * 0.85}rem` }} className={cn("transition-control w-full flex items-center gap-2 h-9 pr-2 rounded-lg text-sm text-left", active ? "bg-surface-3 text-ink font-medium" : "text-ink-2 hover:bg-surface-2 hover:text-ink")}>
      <span className="text-ink-3 shrink-0">{icon}</span><span className="flex-1 truncate">{label}</span>{count !== undefined && <span className="text-xs text-ink-3 tabular-nums">{count}</span>}
    </button>
  );
}

function NoteRow({ n, onOpen }: { n: NoteSummary; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="transition-control w-full text-left rounded-xl border border-line bg-surface p-4 hover:border-line-strong hover:bg-surface-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">{n.pinned && <Pin className="h-3.5 w-3.5 text-accent shrink-0" aria-label="Pinned" />}<span className="font-medium truncate">{n.title}</span></div>
          <p className="text-compact text-ink-3 mt-1 line-clamp-2 text-pretty">{n.snippet}</p>
        </div>
        <span className="text-xs text-ink-3 shrink-0 tabular-nums">{agoMs(n.updatedAt)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
        <Chip>{n.folder}</Chip>
        {n.tags.map((t) => <Tag key={t} name={t} />)}
        {n.links.slice(0, 3).map((l) => <Chip key={`${l.kind}:${l.id}`} tone="live">{l.label}</Chip>)}
        {n.share && <Chip tone="live"><Users className="h-3 w-3" aria-hidden />{n.share.orgName}</Chip>}
        {!n.mine && n.owner && <Chip>from {n.owner}</Chip>}
        {n.hasVault && <Chip tone="warning"><KeyRound className="h-3 w-3" aria-hidden />vault</Chip>}
      </div>
    </button>
  );
}

function NoteView({ id, owner, folders, onBack, onEdit, onGone }: { id: string; owner: string | null; folders: string[]; onBack: () => void; onEdit: (n: NoteFull) => void; onGone: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: [...NOTES_KEY, "one", id, owner], queryFn: (): Promise<{ note: NoteFull; warnings: SecretWarning[] }> => (owner ? notesApi.sharedNote(owner, id).then((r) => ({ ...r, warnings: [] })) : notesApi.get(id)), retry: false });
  const [warnings, setWarnings] = useState<SecretWarning[] | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: NOTES_KEY }); setWarnings(null); };
  const pin = useMutation({ mutationFn: (n: NoteFull) => notesApi.update(n.id, { pinned: !n.pinned, expectedUpdatedAt: n.updatedAt }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => notesApi.remove(id), onSuccess: () => { refresh(); onGone(); } });
  if (q.isPending) return <Skeleton className="h-64 w-full" />;
  if (q.error || !q.data) return <Notice tone="warning" title="That note isn't here" action={<Button size="sm" onClick={onBack}>Back to notes</Button>}>{errorMessage(q.error)}</Notice>;
  const n = q.data.note;
  const w = warnings ?? q.data.warnings;
  const mine = n.mine !== false;
  return (
    <Card className="p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}><ArrowLeft className="h-4 w-4" />All notes</Button>
        <span className="flex-1" />
        {mine && <>
          <Button size="sm" variant="ghost" loading={pin.isPending} onClick={() => pin.mutate(n)}>{n.pinned ? <><PinOff className="h-4 w-4" />Unpin</> : <><Pin className="h-4 w-4" />Pin</>}</Button>
          <Button size="sm" variant="ghost" onClick={() => setSharing(true)}><Share2 className="h-4 w-4" />Share</Button>
          <Button size="sm" onClick={() => onEdit(n)}><Pencil className="h-4 w-4" />Edit</Button>
          <Button size="sm" variant="danger" onClick={() => setConfirm(true)}><Trash2 className="h-4 w-4" />Delete</Button>
        </>}
      </div>
      <div>
        <h2 className="text-title font-semibold tracking-tight text-balance">{n.title}</h2>
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          <Chip>{n.folder}</Chip>
          {mine && <button type="button" onClick={() => setMoveOpen(true)} className="text-xs text-ink-3 hover:text-ink">Move</button>}
          {n.tags.map((t) => <Tag key={t} name={t} />)}
          {n.share && <Chip tone="live"><Users className="h-3 w-3" aria-hidden />Shared with {n.share.orgName}</Chip>}
          {!mine && n.owner && <Chip>from {n.owner} · read only</Chip>}
          <span className="text-xs text-ink-3 ml-1">Updated {agoMs(n.updatedAt)}</span>
        </div>
      </div>
      {mine && w.length > 0 && <SecretBanner note={n} warnings={w} onChanged={refresh} />}
      {n.links.length > 0 && <div className="flex flex-wrap gap-2" aria-label="Linked to">{n.links.map((l) => <LinkChip key={`${l.kind}:${l.id}`} link={l} />)}</div>}
      <Markdown text={n.body} />
      {mine && n.vault.length > 0 && <VaultList note={n} />}
      {confirm && (
        <Modal size="sm" title="Delete this note?" onClose={() => setConfirm(false)} footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Keep it</Button><Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>Delete note</Button></>}>
          <p className="text-sm text-pretty">"{n.title}" is removed from your notes{n.vault.length ? ", along with its vault secrets" : ""}. Export first if you might want it back.</p>
          {remove.error && <p role="alert" className="text-compact text-critical mt-2">{errorMessage(remove.error)}</p>}
        </Modal>
      )}
      {sharing && <ShareModal note={n} onClose={() => setSharing(false)} onChanged={() => { setSharing(false); refresh(); }} />}
      {moveOpen && <MoveModal note={n} folders={folders} onClose={() => setMoveOpen(false)} onMoved={() => { setMoveOpen(false); refresh(); }} />}
    </Card>
  );
}

function VaultList({ note }: { note: NoteFull }) {
  const [shown, setShown] = useState<Record<string, string>>({});
  const reveal = useMutation({ mutationFn: (sid: string) => notesApi.reveal(note.id, sid), onSuccess: (r, sid) => setShown((s) => ({ ...s, [sid]: r.value })) });
  return (
    <div className="rounded-xl border border-line p-4 space-y-2">
      <h3 className="text-compact font-semibold uppercase tracking-label text-ink-3 flex items-center gap-1.5"><KeyRound className="h-3.5 w-3.5" aria-hidden />In the vault</h3>
      {note.vault.map((v) => (
        <div key={v.id} className="flex flex-wrap items-center gap-2">
          <span className="text-sm flex-1 min-w-0 truncate">{v.label}</span>
          {shown[v.id] !== undefined ? <><code className="font-mono text-compact bg-code rounded-sm px-1.5 py-0.5 break-all">{shown[v.id]}</code><Button size="sm" variant="ghost" onClick={() => setShown((s) => { const n = { ...s }; delete n[v.id]; return n; })}>Hide</Button></> : <Button size="sm" loading={reveal.isPending} onClick={() => reveal.mutate(v.id)}>Reveal</Button>}
        </div>
      ))}
      {reveal.error && <p role="alert" className="text-compact text-critical">{errorMessage(reveal.error)}</p>}
    </div>
  );
}

function ShareModal({ note, onClose, onChanged }: { note: NoteFull; onClose: () => void; onChanged: () => void }) {
  const orgs = useQuery({ queryKey: [...NOTES_KEY, "options"], queryFn: notesApi.options });
  const [org, setOrg] = useState(note.share?.orgId ?? "");
  const save = useMutation({ mutationFn: () => notesApi.share(note.id, org || null), onSuccess: onChanged });
  return (
    <Modal size="sm" title="Share with an organization" subtitle="Members of the organization can read this note. Only you can change or delete it." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>{org ? "Share" : "Make private"}</Button></>}>
      <Field label="Organization" htmlFor="share-org" hint="Vault secrets are never shared. Choose none to make the note private again.">
        <Select id="share-org" value={org} onChange={(e) => setOrg(e.target.value)}>
          <option value="">Private (only me)</option>
          {orgs.data?.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </Select>
      </Field>
      {save.error && <p role="alert" className="text-compact text-critical mt-2">{errorMessage(save.error)}</p>}
    </Modal>
  );
}

function MoveModal({ note, folders, onClose, onMoved }: { note: NoteFull; folders: string[]; onClose: () => void; onMoved: () => void }) {
  const [to, setTo] = useState(note.folder);
  const move = useMutation({ mutationFn: () => notesApi.update(note.id, { folder: to, expectedUpdatedAt: note.updatedAt }), onSuccess: onMoved });
  return (
    <Modal size="sm" title="Move note" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={move.isPending} onClick={() => move.mutate()}>Move</Button></>}>
      <Field label="Folder" htmlFor="move-folder" hint="Pick one or type a new name.">
        <Input id="move-folder" list="move-folders" value={to} onChange={(e) => setTo(e.target.value)} autoFocus />
        <datalist id="move-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
      </Field>
      {move.error && <p role="alert" className="text-compact text-critical mt-2">{errorMessage(move.error)}</p>}
    </Modal>
  );
}

function FolderModal({ from, folders, onClose, onChanged }: { from?: string; folders: { path: string; count: number }[]; onClose: () => void; onChanged: (next: string | null) => void }) {
  const [name, setName] = useState(from ?? "");
  const count = folders.find((f) => f.path === from)?.count ?? 0;
  const save = useMutation({ mutationFn: () => (from ? notesApi.renameFolder(from, name) : notesApi.createFolder(name)), onSuccess: (r) => onChanged(r.path) });
  const del = useMutation({ mutationFn: () => notesApi.deleteFolder(from!), onSuccess: () => onChanged(null) });
  return (
    <Modal size="sm" title={from ? "Rename or delete folder" : "New folder"} onClose={onClose}
      footer={<>{from && <Button variant="danger" disabled={count > 0} loading={del.isPending} onClick={() => del.mutate()} title={count > 0 ? "Move or delete the notes in it first" : undefined}>Delete folder</Button>}<span className="flex-1" /><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim() || name === from} loading={save.isPending} onClick={() => save.mutate()}>{from ? "Rename" : "Create folder"}</Button></>}>
      <Field label="Folder name" htmlFor="folder-name" hint="Up to 3 levels, like Runbooks/Networking. Renaming moves the notes and sub-folders with it.">
        <Input id="folder-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      {(save.error || del.error) && <p role="alert" className="text-compact text-critical mt-2">{errorMessage(save.error ?? del.error)}</p>}
    </Modal>
  );
}

