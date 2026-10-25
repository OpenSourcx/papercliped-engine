import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, ChevronRight, FileText, Folder, FolderSymlink, HardDrive, Link2, Pencil, RefreshCw, Save, Undo2 } from "lucide-react";
import type { Guest } from "../../data/types.ts";
import { errorText } from "../../data/engine/queries.ts";
import { useEngine } from "../../data/store.tsx";
import { machineFilesApi, MAX_EDIT, type FileEntry } from "../../data/engine/machineFilesApi.ts";
import { cn } from "../../lib/storage.ts";
import { Button, Input, Notice, Select, Spinner } from "../../ui/primitives.tsx";
import { Code, copyText, Pane } from "./TileView.tsx";

/**
 * An editor for one file of a machine, as a PinView tab (the Explorer in workspace/Explorer.tsx finds the files). It goes
 * through the host's machine-files routes, so it works wherever Pin can run commands in that machine (the guest agent for a
 * VM; for a container, its console must open into a shell) and only as far as the person's Proxmox permissions reach.
 */

const KEY = (vmid: number, path: string) => ["machine-files", vmid, path] as const;
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);
const up = (p: string) => (p === "/" ? "/" : p.slice(0, p.lastIndexOf("/")) || "/");
const ICON: Record<FileEntry["kind"], typeof Folder> = { dir: Folder, linkdir: FolderSymlink, file: FileText, link: Link2 };

/** One file of a machine: read it, then edit it in place and save it back (Ctrl+S). A change made elsewhere meanwhile is never overwritten. */
export function FileEditor({ vmid, path, machineName, expanded, onExpand, onClose, startEditing, tab, onDirty }: { vmid: number; path: string; machineName?: string; expanded: boolean; onExpand: () => void; onClose: () => void; startEditing?: boolean; tab?: boolean; /** Told whether there are unsaved changes, so a tab can show it. */ onDirty?: (dirty: boolean) => void }) {
  const qc = useQueryClient();
  const key = ["machine-file", vmid, path] as const;
  const file = useQuery({ queryKey: key, queryFn: () => machineFilesApi.read(vmid, path), retry: false, staleTime: Infinity });
  const [editing, setEditing] = useState(!!startEditing);
  const [draft, setDraft] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);
  const [numbers, setNumbers] = useState(true);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const escaped = useRef(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const text = draft ?? file.data?.content ?? "";
  const dirty = draft !== null && draft !== (file.data?.content ?? "");
  const save = useMutation({
    mutationFn: () => machineFilesApi.write(vmid, path, text, file.data?.etag ?? null),
    onSuccess: (r) => { qc.setQueryData(key, { ...file.data!, content: text, size: r.size, etag: r.etag }); setDraft(null); },
  });
  const conflict = (save.error as { status?: number } | null)?.status === 409;
  const editable = !!file.data && file.data.content !== null;
  useEffect(() => onDirty?.(dirty), [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = path.split("/").pop() || path;

  const reload = () => { setDraft(null); save.reset(); void file.refetch(); };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (dirty && !save.isPending) save.mutate();
      return;
    }
    if (e.key === "Escape") { escaped.current = true; return; }
    // Tab indents; Escape then Tab moves on, so the keyboard is never trapped.
    if (e.key === "Tab" && !e.shiftKey && !escaped.current) {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: a, selectionEnd: b } = el;
      setDraft(text.slice(0, a) + "\t" + text.slice(b));
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = a + 1; });
    }
    escaped.current = false;
  };
  const where = (el: HTMLTextAreaElement) => {
    const before = el.value.slice(0, el.selectionStart);
    const lines = before.split("\n");
    setCursor({ line: lines.length, col: lines[lines.length - 1]!.length + 1 });
  };
  useEffect(() => { if (editing) setTimeout(() => area.current?.focus(), 0); }, [editing]);

  return (
    <Pane tab={tab} icon={<FileText className="h-4 w-4" />} title={`${dirty ? "● " : ""}${name}`} sub={<>{machineName ? `${machineName} · ` : ""}<span className="font-mono">{path}</span></>} expanded={expanded} onExpand={onExpand} onClose={onClose} className={cn("shrink-0", expanded ? "flex-1" : "h-120")}
      menu={[
        { kind: "check", label: "Word wrap", checked: wrap, onToggle: setWrap },
        { kind: "check", label: "Line numbers", checked: numbers, onToggle: setNumbers },
        { kind: "separator" },
        { label: "Copy contents", onSelect: () => copyText(text), disabled: !editable },
        { label: "Copy path", onSelect: () => copyText(path) },
        { label: "Reload from the machine", onSelect: reload },
      ]}>
      <div className="px-3 py-2 border-b border-line flex items-center gap-2 flex-wrap">
        {editable && !editing && <Button size="sm" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" />Edit</Button>}
        {editing && <Button size="sm" variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}><Save className="h-3.5 w-3.5" />Save</Button>}
        {editing && <Button size="sm" variant="ghost" disabled={!dirty || save.isPending} onClick={() => { setDraft(null); save.reset(); }}><Undo2 className="h-3.5 w-3.5" />Revert</Button>}
        {editing && !dirty && <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Done</Button>}
        <span className="flex-1" />
        {file.data && <span className="text-xs text-ink-3 tabular-nums">{editing ? `Ln ${cursor.line}, Col ${cursor.col} · ` : ""}{size(editing ? new Blob([text]).size : file.data.size)}{save.isSuccess && !dirty ? " · Saved" : ""}</span>}
      </div>
      {save.error && (
        <div className="p-3 border-b border-line">
          <Notice tone={conflict ? "warning" : "critical"} title={conflict ? "Changed in the machine" : "Not saved"} action={conflict ? <Button size="sm" onClick={reload}>Reload</Button> : undefined}>
            {conflict ? "Someone or something changed this file after you opened it. Reload to see it (your edits are dropped), or copy them first." : errorText(save.error)}
          </Notice>
        </div>
      )}
      {file.isPending && <div className="py-8 flex justify-center"><Spinner label="Opening the file" /></div>}
      {file.error && <div className="p-3"><Notice tone="warning">{errorText(file.error)}</Notice></div>}
      {file.data?.binary && <div className="p-3"><Notice>This is a binary file, so it isn't shown or edited here.</Notice></div>}
      {file.data?.tooLarge && <div className="p-3"><Notice>This file is {size(file.data.size)}; files up to {MAX_EDIT / 1024} KB open here. Use the machine's shell for bigger ones.</Notice></div>}
      {editable && (editing ? (
        <textarea
          ref={area}
          aria-label={`Edit ${path}`}
          value={text}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          style={{ tabSize: 4 }}
          onChange={(e) => { setDraft(e.target.value); where(e.target); }}
          onKeyDown={keys}
          onKeyUp={(e) => where(e.currentTarget)}
          onClick={(e) => where(e.currentTarget)}
          className={cn("block w-full h-full min-h-80 resize-none bg-code text-ink font-mono text-xs leading-5 p-4 outline-none", wrap ? "whitespace-pre-wrap" : "whitespace-pre overflow-x-auto")}
        />
      ) : (
        <Code text={text} wrap={wrap} numbers={numbers} empty="This file is empty." />
      ))}
    </Pane>
  );
}
