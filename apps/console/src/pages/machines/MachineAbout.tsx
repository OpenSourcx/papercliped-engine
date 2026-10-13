import { useState } from "react";
import { Pencil, X } from "lucide-react";
import { errorText, useGuestApi, type GuestAddresses } from "../../data/engine/guestApi.ts";
import { useEngine } from "../../data/store.tsx";
import { Tag } from "../../ui/Tag.tsx";
import { Button, Card, Input, Notice, SectionTitle, Textarea } from "../../ui/primitives.tsx";
import { Loading, useLoad } from "../disks/common.tsx";

/** The Overview's extras: the machine's hostname and addresses, and its notes and tags (editable). */

/** Addresses worth showing first: not loopback, not link-local. Everything else stays one click away. */
const plain = (a: { ip: string }) => !a.ip.startsWith("127.") && a.ip !== "::1" && !a.ip.toLowerCase().startsWith("fe80:");

export function AddressRows({ vmid, status }: { vmid: number; status: string }) {
  const api = useGuestApi();
  const engine = useEngine();
  const q = useLoad(() => api.addresses(vmid), [api, vmid, status, engine.contentVersion]);
  const [all, setAll] = useState(false);
  const a: GuestAddresses | null = q.data;
  if (q.error) return <><dt className="text-ink-3">Address</dt><dd className="text-compact text-ink-3">Couldn't read it</dd></>;
  if (!a) return <><dt className="text-ink-3">Address</dt><dd className="text-compact text-ink-3">Reading…</dd></>;
  const shown = a.interfaces.map((i) => ({ ...i, addresses: all ? i.addresses : i.addresses.filter(plain) })).filter((i) => i.addresses.length > 0);
  const hidden = a.interfaces.reduce((n, i) => n + i.addresses.length, 0) - shown.reduce((n, i) => n + i.addresses.length, 0);
  return (
    <>
      <dt className="text-ink-3">Hostname</dt><dd className="font-mono text-compact break-all">{a.hostname ?? <span className="font-sans text-ink-3">Unknown</span>}</dd>
      <dt className="text-ink-3">Address</dt>
      <dd className="text-compact min-w-0">
        {shown.length === 0 ? <span className="text-ink-3">{a.note ?? "None yet"}</span> : (
          <ul className="space-y-1">
            {shown.map((i) => (
              <li key={i.name} className="min-w-0">
                {shown.length > 1 && <span className="text-xs text-ink-3 mr-2">{i.name}</span>}
                {i.addresses.map((x, n) => <span key={x.ip} className="font-mono break-all">{n > 0 && ", "}{x.ip}{x.prefix !== null ? <span className="text-ink-3">/{x.prefix}</span> : null}</span>)}
              </li>
            ))}
          </ul>
        )}
        {a.note && shown.length > 0 && <span className="block text-xs text-ink-3 mt-1">{a.note}</span>}
        {(hidden > 0 || all) && <button onClick={() => setAll(!all)} className="block text-xs text-ink-3 hover:text-ink mt-1">{all ? "Hide loopback and link-local" : `Show ${hidden} more`}</button>}
      </dd>
    </>
  );
}

export function NotesCard({ vmid }: { vmid: number }) {
  const api = useGuestApi();
  const engine = useEngine();
  const q = useLoad(() => api.devices(vmid), [api, vmid, engine.contentVersion]);
  const [edit, setEdit] = useState(false);
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = q.data;
  const begin = () => {
    if (!d) return;
    setNotes(d.notes);
    setTags(d.tags);
    setDraft("");
    setError(null);
    setEdit(true);
  };
  const addDraft = () => {
    const t = draft.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (t.length) setTags([...new Set([...tags, ...t])]);
    setDraft("");
    return [...new Set([...tags, ...t])];
  };
  const save = async () => {
    if (!d) return;
    const finalTags = addDraft();
    setBusy(true);
    setError(null);
    try {
      await api.saveNotes(vmid, { digest: d.digest ?? "", description: notes, tags: finalTags });
      setEdit(false);
      q.reload();
      engine.watchTask(null, "");
    } catch (e) {
      setError(errorText(e, "Couldn't save"));
      if (e instanceof Error && (e as { code?: string }).code === "stale") q.reload();
    }
    setBusy(false);
  };
  return (
    <Card className="p-5 lg:col-span-3">
      <SectionTitle action={d && !edit && <Button size="sm" variant="ghost" onClick={begin} disabled={!!d.locked}><Pencil className="h-3.5 w-3.5" />Edit</Button>}>Notes and tags</SectionTitle>
      {q.error && <p role="alert" className="text-compact text-critical">{q.error}</p>}
      {!d && !q.error && <Loading label="Reading notes" />}
      {d && !edit && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">{d.tags.length ? d.tags.map((t) => <Tag key={t} name={t} />) : <span className="text-sm text-ink-3">No tags.</span>}</div>
          {d.notes ? <p className="text-sm text-ink-2 whitespace-pre-wrap break-words max-w-3xl">{d.notes}</p> : <p className="text-sm text-ink-3">No notes. Write down what this machine is for and who looks after it.</p>}
        </div>
      )}
      {d && edit && (
        <div className="space-y-4 max-w-3xl">
          <div>
            <label htmlFor="notes-text" className="block text-compact font-medium text-ink-2 mb-1.5">Notes</label>
            <Textarea id="notes-text" rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={8192} />
          </div>
          <div>
            <label htmlFor="notes-tag" className="block text-compact font-medium text-ink-2 mb-1.5">Tags</label>
            <div className="flex flex-wrap items-center gap-1.5 mb-2">
              {tags.map((t) => (
                <span key={t} className="inline-flex items-center gap-1"><Tag name={t} /><button onClick={() => setTags(tags.filter((x) => x !== t))} aria-label={`Remove tag ${t}`} className="h-5 w-5 rounded-sm text-ink-3 hover:text-ink hover:bg-surface-2 inline-flex items-center justify-center"><X className="h-3 w-3" /></button></span>
              ))}
            </div>
            <Input id="notes-tag" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addDraft(); } }} placeholder="Type a tag and press Enter" />
            <p className="text-xs text-ink-3 mt-1.5">Letters, digits, and _ - . + only. Tags are lowercase.</p>
          </div>
          {error && <Notice tone="critical">{error}</Notice>}
          <div className="flex gap-2"><Button variant="primary" onClick={save} loading={busy}>Save</Button><Button variant="ghost" onClick={() => setEdit(false)}>Cancel</Button></div>
        </div>
      )}
    </Card>
  );
}
