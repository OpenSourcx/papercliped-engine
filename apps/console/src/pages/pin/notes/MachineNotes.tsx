import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { NotebookPen, Plus } from "lucide-react";
import { notesApi, type NoteFull } from "../../../data/engine/notesApi.ts";
import { Tag } from "../../../ui/Tag.tsx";
import { Button, Card, SectionTitle } from "../../../ui/primitives.tsx";
import { NoteEditor } from "./NoteEditor.tsx";
import { NOTES_KEY, agoMs, useDevice } from "./common.tsx";

/** The Notes linked to one machine, on its Overview. Add a note here and it is linked to the machine already. */
export function MachineNotes({ vmid, name }: { vmid: number; name: string }) {
  const device = useDevice();
  const q = useQuery({ queryKey: [...NOTES_KEY, "machine", vmid], queryFn: () => notesApi.list({ machine: vmid }), retry: false });
  const [adding, setAdding] = useState(false);
  if (q.error) return null; // Notes unavailable on this host: the card simply isn't there.
  const notes = q.data?.notes ?? [];
  return (
    <Card className="p-5">
      <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" />Add note</Button>}>Pin notes</SectionTitle>
      {notes.length === 0 ? (
        <p className="text-compact text-ink-3 text-pretty">{q.isPending ? "Reading..." : `No notes about ${name} yet. Notes that mention it (by name, address or id) can be linked to it when Pin sorts them.`}</p>
      ) : (
        <ul className="space-y-2">
          {notes.slice(0, 5).map((n) => (
            <li key={n.id}>
              <Link to={`/${device}/notes?note=${n.id}`} className="transition-control block rounded-lg border border-line p-3 hover:border-line-strong hover:bg-surface-2">
                <div className="flex items-center gap-2"><span className="text-sm font-medium truncate flex-1">{n.title}</span><span className="text-xs text-ink-3 tabular-nums shrink-0">{agoMs(n.updatedAt)}</span></div>
                <p className="text-compact text-ink-3 line-clamp-2 mt-0.5">{n.snippet}</p>
                {n.tags.length > 0 && <div className="flex flex-wrap gap-1.5 mt-2">{n.tags.slice(0, 4).map((t) => <Tag key={t} name={t} />)}</div>}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {notes.length > 5 && <Link to={`/${device}/notes`} className="transition-control mt-3 inline-flex items-center gap-1.5 text-compact text-ink-3 hover:text-ink"><NotebookPen className="h-3.5 w-3.5" />All {notes.length} notes</Link>}
      {adding && <NoteEditor folders={q.data?.folders.map((f) => f.path) ?? []} initial={{ links: [{ kind: "machine", id: String(vmid), label: `${name} #${vmid}` }] }} onClose={() => setAdding(false)} onSaved={(_n: NoteFull) => setAdding(false)} />}
    </Card>
  );
}
