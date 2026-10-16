import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, KeyRound, Sparkles, Undo2 } from "lucide-react";
import { errorMessage } from "../../../data/engine/pinRuntimeApi.ts";
import { notesApi, type Applied, type Draft, type Edit, type Proposal, type SecretMode } from "../../../data/engine/notesApi.ts";
import { cn } from "../../../lib/storage.ts";
import { Modal } from "../../../ui/Modal.tsx";
import { Tag } from "../../../ui/Tag.tsx";
import { Button, Chip, Field, Input, Notice, Skeleton } from "../../../ui/primitives.tsx";
import { Markdown } from "./Markdown.tsx";
import { LinkChip, NOTES_KEY } from "./common.tsx";

/**
 * Sort a pile: paste, Pin proposes notes with a title, folder, tags and links, and you review before anything is filed.
 * Accept all, accept the ones you ticked after editing them, or discard. Filed notes can be undone.
 */

const pct = (c: number) => `${Math.round(c * 100)}%`;
const tone = (c: number) => (c >= 0.85 ? "good" : c >= 0.5 ? "warning" : "neutral");

export function SortModal({ draftId, folders, onClose }: { draftId?: string; folders: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [undone, setUndone] = useState(false);
  const loaded = useQuery({
    queryKey: [...NOTES_KEY, "draft", draftId],
    enabled: !!draftId && !draft,
    queryFn: async () => (await call(draftId!)),
    retry: false,
  });
  const current = draft ?? loaded.data ?? null;
  const done = () => qc.invalidateQueries({ queryKey: NOTES_KEY });
  const sort = useMutation({
    mutationFn: (body: Parameters<typeof notesApi.sort>[0]) => notesApi.sort(body),
    onSuccess: (r) => {
      setDraft(r.draft);
      if (r.autoFiled) setApplied(r.autoFiled);
      done();
    },
  });
  const discard = async () => {
    if (current) await notesApi.discard(current.id).catch(() => undefined);
    onClose();
  };
  const undo = useMutation({ mutationFn: (b: string) => notesApi.undo(b), onSuccess: () => { setUndone(true); done(); } });

  // Step 3: filed.
  if (applied && (!current || current.proposals.length === 0)) {
    const n = applied.created.length + applied.updated.length;
    return (
      <Modal size="md" title={undone ? "Undone" : "Filed"} onClose={onClose} footer={<>{applied.batch && !undone && <Button variant="ghost" loading={undo.isPending} onClick={() => undo.mutate(applied.batch!)}><Undo2 className="h-4 w-4" />Undo</Button>}<Button variant="primary" onClick={onClose}>Done</Button></>}>
        <p className="text-sm text-pretty">{undone ? "Those changes were put back." : `${n} note${n === 1 ? "" : "s"} filed${applied.created.length ? `: ${applied.created.map((x) => `"${x.title}" in ${x.folder}`).slice(0, 4).join(", ")}${applied.created.length > 4 ? ", ..." : ""}` : ""}.`}</p>
        {!undone && applied.secrets.redacted + applied.secrets.vaulted > 0 && <p className="text-compact text-ink-3 mt-2">{applied.secrets.vaulted ? `${applied.secrets.vaulted} secret${applied.secrets.vaulted === 1 ? "" : "s"} went to the vault. ` : ""}{applied.secrets.redacted ? `${applied.secrets.redacted} secret${applied.secrets.redacted === 1 ? " was" : "s were"} left out of the notes.` : ""}</p>}
        {undo.error && <p role="alert" className="text-compact text-critical mt-2">{errorMessage(undo.error)}</p>}
      </Modal>
    );
  }

  if (!current) {
    return (
      <Modal size="lg" title="Sort a pile" subtitle="Paste anything: runbooks, IPs, ticket text, logs, to-dos, terminal output. You review before anything is filed." onClose={onClose}
        footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={sort.isPending} onClick={() => sort.mutate({ inbox: true })}>Sort the Inbox instead</Button><Button variant="primary" disabled={!text.trim()} loading={sort.isPending} onClick={() => sort.mutate({ text })}><Sparkles className="h-4 w-4" />Sort it</Button></>}>
        <div className="space-y-3">
          {draftId && loaded.isPending ? <Skeleton className="h-40 w-full" /> : draftId && loaded.error ? <Notice tone="warning" title="That sort has expired">Sorts are kept for 30 minutes. Paste the text again.</Notice> : null}
          <Field label="Text to sort" htmlFor="sort-text" hint="Likely passwords, keys and tokens are found first and never sent to a model.">
            <textarea id="sort-text" value={text} onChange={(e) => setText(e.target.value)} rows={12} autoFocus className="transition-control w-full rounded-lg bg-surface-2 border border-line text-compact font-mono text-ink placeholder:text-ink-3 outline-none hover:border-line-strong focus:border-line-strong focus:ring-2 focus:ring-accent/30 px-3 py-2.5 leading-relaxed resize-y min-h-48" placeholder="Paste here" />
          </Field>
          {sort.error && <p role="alert" className="text-compact text-critical">{errorMessage(sort.error)}</p>}
        </div>
      </Modal>
    );
  }
  return <Review draft={current} folders={folders} onClose={discard} onFiled={(r) => { setApplied(r); setDraft(null); done(); }} close={onClose} autoFiled={applied} onUndoAuto={(b) => undo.mutate(b)} />;
}

async function call(id: string): Promise<Draft> {
  const r = await fetch(`/api/notes/sort/${id}`, { credentials: "same-origin", headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("expired");
  return ((await r.json()) as { draft: Draft }).draft;
}

function Review({ draft, folders, onClose, onFiled, close, autoFiled, onUndoAuto }: { draft: Draft; folders: string[]; onClose: () => void; close: () => void; onFiled: (r: Applied) => void; autoFiled: Applied | null; onUndoAuto: (batch: string) => void }) {
  const [edits, setEdits] = useState<Record<string, Partial<Edit>>>({});
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<SecretMode>("redact");
  const [open, setOpen] = useState<string | null>(null);
  const secrets = useMemo(() => draft.proposals.reduce((n, p) => n + p.secrets.length, 0), [draft]);
  const keep = draft.proposals.filter((p) => !skip.has(p.key));
  const accept = useMutation({
    mutationFn: () => notesApi.accept(draft.id, { edits: draft.proposals.map((p) => ({ key: p.key, ...(edits[p.key] ?? {}), include: !skip.has(p.key) })), secrets: mode }),
    onSuccess: onFiled,
  });
  const set = (k: string, patch: Partial<Edit>) => setEdits((e) => ({ ...e, [k]: { ...e[k], ...patch } }));
  const known = new Set(folders);
  return (
    <Modal
      size="lg"
      title="Review before filing"
      subtitle={`${draft.proposals.length} note${draft.proposals.length === 1 ? "" : "s"} proposed. Nothing is filed until you accept.`}
      onClose={close}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Discard</Button>
        <Button variant="primary" disabled={keep.length === 0} loading={accept.isPending} onClick={() => accept.mutate()}><Check className="h-4 w-4" />{keep.length === draft.proposals.length ? "Accept all" : `Accept ${keep.length} of ${draft.proposals.length}`}</Button>
      </>}
    >
      <div className="space-y-4">
        {autoFiled && autoFiled.created.length > 0 && <Notice tone="good" title={`${autoFiled.created.length} note${autoFiled.created.length === 1 ? " was" : "s were"} filed automatically`} action={autoFiled.batch ? <Button size="sm" onClick={() => onUndoAuto(autoFiled.batch!)}><Undo2 className="h-3.5 w-3.5" />Undo</Button> : undefined}>Auto-file is on, and these were high-confidence with no secrets: {autoFiled.created.map((n) => `"${n.title}" in ${n.folder}`).join(", ")}. The rest need your decision.</Notice>}
        {draft.fallback && <Notice tone="info" title="Sorted with keywords">{draft.fallback} You can still edit every proposal.</Notice>}
        {draft.engine === "model" && <p className="text-compact text-ink-3 flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" />Pin's model grouped and named these. Links to your machines were found on the device, not by the model.</p>}
        {secrets > 0 && (
          <Notice tone="warning" title={`${secrets} likely secret${secrets === 1 ? "" : "s"} found`}>
            <p className="mb-2">They were taken out before anything went to a model. Choose what happens to them:</p>
            <div className="space-y-1.5" role="radiogroup" aria-label="What to do with secrets">
              {([["redact", "Leave them out", "The notes keep a marker where each one was. Recommended."], ["vault", "Store them in the vault", "Sealed on the device. Reveal one from its note when you need it."], ["keep", "Keep them in the notes as written", "Not recommended."]] as const).map(([v, label, hint]) => (
                <label key={v} className="flex items-start gap-2 cursor-pointer"><input type="radio" name="secret-mode" checked={mode === v} onChange={() => setMode(v)} className="mt-1 accent-(--accent)" /><span><span className="font-medium">{label}</span> <span className="text-ink-3">{hint}</span></span></label>
              ))}
            </div>
          </Notice>
        )}
        <ul className="space-y-3">
          {draft.proposals.map((p) => {
            const e = edits[p.key] ?? {};
            const off = skip.has(p.key);
            const folder = e.folder ?? p.folder;
            const isOpen = open === p.key;
            return (
              <li key={p.key} className={cn("rounded-xl border border-line bg-surface-2/40 p-3 transition-control", off && "opacity-50")}>
                <div className="flex flex-wrap items-start gap-3">
                  <input type="checkbox" checked={!off} onChange={() => setSkip((s) => { const n = new Set(s); if (n.has(p.key)) n.delete(p.key); else n.add(p.key); return n; })} aria-label={`File "${e.title ?? p.title}"`} className="mt-3 h-4 w-4 accent-(--accent)" />
                  <div className="flex-1 min-w-0 basis-64 space-y-2">
                    <Input aria-label="Title" value={e.title ?? p.title} onChange={(ev) => set(p.key, { title: ev.target.value })} maxLength={120} />
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div>
                        <Input aria-label="Folder" list="sort-folders" value={folder} onChange={(ev) => set(p.key, { folder: ev.target.value })} />
                        <div className="text-xs text-ink-3 mt-1">{known.has(folder) ? "Existing folder" : "New folder"}</div>
                      </div>
                      <Input aria-label="Tags" value={(e.tags ?? p.tags).join(", ")} onChange={(ev) => set(p.key, { tags: ev.target.value.split(/[,\s]+/).filter(Boolean) })} placeholder="tags" />
                    </div>
                    {(e.links ?? p.links).length > 0 && <div className="flex flex-wrap gap-1.5" aria-label="Linked to">{(e.links ?? p.links).map((l) => <LinkChip key={`${l.kind}:${l.id}`} link={l} onRemove={() => set(p.key, { links: (e.links ?? p.links).filter((x) => x !== l) })} />)}</div>}
                    {p.noteId ? <p className="text-xs text-ink-3">Moves an existing note; its text isn't changed.</p> : (
                      <button type="button" onClick={() => setOpen(isOpen ? null : p.key)} aria-expanded={isOpen} className="transition-control inline-flex items-center gap-1 text-compact text-ink-3 hover:text-ink">{isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}{isOpen ? "Hide text" : "Show text"}</button>
                    )}
                    {isOpen && <div className="rounded-lg border border-line bg-surface p-3 max-h-64 overflow-y-auto"><Markdown text={p.body} /></div>}
                  </div>
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <Chip tone={tone(p.confidence)}>{pct(p.confidence)} sure</Chip>
                    <Chip>{p.source === "model" ? "Model" : "Keywords"}</Chip>
                    {p.secrets.length > 0 && <Chip tone="warning"><KeyRound className="h-3 w-3" aria-hidden />{p.secrets.length} secret{p.secrets.length === 1 ? "" : "s"}</Chip>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2 ml-7">{(e.tags ?? p.tags).map((t) => <Tag key={t} name={t} />)}</div>
              </li>
            );
          })}
        </ul>
        <datalist id="sort-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
        {accept.error && <p role="alert" className="text-compact text-critical">{errorMessage(accept.error)}</p>}
      </div>
    </Modal>
  );
}

export type { Proposal };
