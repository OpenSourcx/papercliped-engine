import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "../../../data/engine/pinRuntimeApi.ts";
import { notesApi, type NoteFull, type NoteLink, type SecretWarning } from "../../../data/engine/notesApi.ts";
import { Modal } from "../../../ui/Modal.tsx";
import { Button, Field, Input, Select, Textarea, Toggle } from "../../../ui/primitives.tsx";
import { LinkChip, NOTES_KEY, useLinkOptions } from "./common.tsx";

/** Create or edit one note: title, folder, tags, text (Markdown), links to machines and storage, pinned. */
export function NoteEditor({ note, folders, initial, onClose, onSaved }: { note?: NoteFull; folders: string[]; initial?: { links?: NoteLink[]; folder?: string }; onClose: () => void; onSaved: (n: NoteFull, warnings: SecretWarning[]) => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(note?.title ?? "");
  const [body, setBody] = useState(note?.body ?? "");
  const [folder, setFolder] = useState(note?.folder ?? initial?.folder ?? "Inbox");
  const [tags, setTags] = useState((note?.tags ?? []).join(", "));
  const [links, setLinks] = useState<NoteLink[]>(note?.links ?? initial?.links ?? []);
  const [pinned, setPinned] = useState(note?.pinned ?? false);
  const options = useLinkOptions();
  const save = useMutation({
    mutationFn: () => {
      const input = { title: title.trim() || undefined, body, folder: folder.trim() || "Inbox", tags: tags.split(/[,\s]+/).filter(Boolean), links, pinned };
      return note ? notesApi.update(note.id, { ...input, title, expectedUpdatedAt: note.updatedAt }) : notesApi.create(input);
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: NOTES_KEY });
      onSaved(r.note, r.warnings);
    },
  });
  const addLink = (value: string) => {
    if (!value) return;
    const [kind, ...rest] = value.split(":");
    const id = rest.join(":");
    const m = kind === "machine" ? options.data?.machines.find((x) => String(x.vmid) === id) : null;
    const label = kind === "machine" ? (m ? `${m.name} #${m.vmid}` : id) : kind === "org" ? (options.data?.orgs.find((o) => o.id === id)?.name ?? id) : id;
    if (!links.some((l) => l.kind === kind && l.id === id)) setLinks([...links, { kind: kind as NoteLink["kind"], id, label }]);
  };
  return (
    <Modal
      size="lg"
      title={note ? "Edit note" : "New note"}
      subtitle="Markdown works. Raw HTML is shown as text, never run."
      onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!body.trim()} loading={save.isPending} onClick={() => save.mutate()}>{note ? "Save changes" : "Save note"}</Button></>}
    >
      <div className="space-y-4">
        <Field label="Title" htmlFor="note-title" hint="Leave empty and the first line becomes the title."><Input id="note-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} autoFocus={!note} /></Field>
        <Field label="Text" htmlFor="note-body"><Textarea id="note-body" value={body} onChange={(e) => setBody(e.target.value)} rows={12} className="font-mono text-compact min-h-48" spellCheck /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Folder" htmlFor="note-folder" hint="Up to 3 levels, like Runbooks/Networking.">
            <Input id="note-folder" list="note-folders" value={folder} onChange={(e) => setFolder(e.target.value)} />
            <datalist id="note-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
          </Field>
          <Field label="Tags" htmlFor="note-tags" hint="Separate with commas."><Input id="note-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="zfs, backup" /></Field>
        </div>
        <Field label="Links" hint="Show this note on a machine's page.">
          <div className="flex flex-wrap items-center gap-2">
            {links.map((l) => <LinkChip key={`${l.kind}:${l.id}`} link={l} onRemove={() => setLinks(links.filter((x) => x !== l))} />)}
            <Select aria-label="Add a link" value="" onChange={(e) => addLink(e.target.value)} className="w-auto max-w-full">
              <option value="">Add a link...</option>
              {options.data?.machines.map((m) => <option key={m.vmid} value={`machine:${m.vmid}`}>{m.name} #{m.vmid}</option>)}
              {options.data?.storages.map((s) => <option key={s} value={`storage:${s}`}>Storage {s}</option>)}
              {options.data?.orgs.map((o) => <option key={o.id} value={`org:${o.id}`}>Organization {o.name}</option>)}
            </Select>
          </div>
        </Field>
        <div className="flex items-center gap-3"><Toggle checked={pinned} onChange={setPinned} label="Pin this note" /><span className="text-sm">Pin to the top</span></div>
        {save.error && <p role="alert" className="text-compact text-critical">{errorMessage(save.error)}</p>}
      </div>
    </Modal>
  );
}
