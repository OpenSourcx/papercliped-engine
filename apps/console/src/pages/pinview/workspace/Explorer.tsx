import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, FolderSymlink, Link2, Loader2, MoreHorizontal, RefreshCw } from "lucide-react";
import type { Guest } from "../../../data/types.ts";
import { errorText } from "../../../data/engine/queries.ts";
import { machineFilesApi, type FileEntry } from "../../../data/engine/machineFilesApi.ts";
import { useEngine } from "../../../data/store.tsx";
import { cn } from "../../../lib/storage.ts";
import { Menu, Select } from "../../../ui/primitives.tsx";
import { copyText } from "../TileView.tsx";
import { SideHeader } from "./parts.tsx";

/**
 * The Explorer: a machine's file tree, folder by folder as you open them, like an editor's file explorer. Files open in
 * the editor group. It reads through the host's machine-files routes, as the signed-in person.
 */

const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);

function Folder_({ vmid, path, depth, hidden, open, toggle, onOpenFile, activePath }: { vmid: number; path: string; depth: number; hidden: boolean; open: ReadonlySet<string>; toggle: (p: string) => void; onOpenFile: (path: string) => void; activePath: string | null }) {
  const q = useQuery({ queryKey: ["machine-files", vmid, path], queryFn: () => machineFilesApi.list(vmid, path), retry: false, staleTime: 30_000 });
  const pad = { paddingLeft: `${0.5 + depth * 0.875}rem` };
  if (q.isPending) return <div className="flex items-center gap-2 py-1 text-xs text-ink-3" style={pad}><Loader2 className="h-3 w-3 animate-spin" aria-hidden />Loading…</div>;
  if (q.error) return <div className="py-1 pr-2 text-xs text-warning text-pretty" style={pad}>{errorText(q.error)}</div>;
  const entries = (q.data?.entries ?? []).filter((e) => hidden || !e.name.startsWith("."));
  if (entries.length === 0) return <div className="py-1 text-xs text-ink-3" style={pad}>Empty</div>;
  return (
    <ul role="group">
      {entries.map((e: FileEntry) => {
        const p = join(path, e.name);
        const folder = e.kind === "dir" || e.kind === "linkdir";
        const isOpen = folder && open.has(p);
        const Icon = folder ? (e.kind === "linkdir" ? FolderSymlink : isOpen ? FolderOpen : Folder) : e.kind === "link" ? Link2 : FileText;
        return (
          <li key={e.name} role="treeitem" aria-expanded={folder ? isOpen : undefined} aria-selected={activePath === p}>
            <button type="button" onClick={() => (folder ? toggle(p) : onOpenFile(p))} title={p}
              className={cn("transition-control w-full flex items-center gap-1.5 py-1 pr-2 text-left text-compact hover:bg-surface-2", activePath === p && "bg-accent-soft text-ink")} style={{ paddingLeft: `${0.25 + depth * 0.875}rem` }}>
              <span className="w-4 shrink-0 flex justify-center text-ink-3" aria-hidden>{folder ? (isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />) : null}</span>
              <Icon className={cn("h-4 w-4 shrink-0", folder ? "text-accent" : "text-ink-3")} aria-hidden />
              <span className="truncate font-mono text-xs">{e.name}</span>
            </button>
            {isOpen && <Folder_ vmid={vmid} path={p} depth={depth + 1} hidden={hidden} open={open} toggle={toggle} onOpenFile={onOpenFile} activePath={activePath} />}
          </li>
        );
      })}
      {q.data?.truncated && <li className="py-1 text-xs text-ink-3" style={pad}>Only the first 2000 are shown.</li>}
    </ul>
  );
}

export function Explorer({ machines, vmid, onVmid, onOpenFile, activePath }: { machines: Guest[]; vmid: number | null; onVmid: (vmid: number) => void; onOpenFile: (vmid: number, path: string) => void; activePath: string | null }) {
  const { live } = useEngine();
  const qc = useQueryClient();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [hidden, setHidden] = useState(false);
  const [root, setRoot] = useState("/");
  const machine = machines.find((m) => m.vmid === vmid) ?? null;
  const toggle = (p: string) => setOpen((o) => { const n = new Set(o); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const roots = ["/", "/root", "/etc", "/home", "/srv", "/opt", "/var/log"];

  return (
    <div className="flex flex-col min-h-0 h-full">
      <SideHeader title="Explorer" actions={
        <>
          <button type="button" aria-label="Refresh" title="Refresh" disabled={!machine} onClick={() => void qc.invalidateQueries({ queryKey: ["machine-files", vmid] })} className="transition-control h-7 w-7 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2 disabled:opacity-40"><RefreshCw className="h-3.5 w-3.5" /></button>
          <Menu size="sm" label="Explorer options" icon={<MoreHorizontal className="h-4 w-4" />} items={[
            { kind: "check", label: "Show hidden files", checked: hidden, onToggle: setHidden },
            { kind: "separator" },
            { label: "Collapse all folders", onSelect: () => setOpen(new Set()), disabled: open.size === 0 },
            { label: "Copy the root path", onSelect: () => copyText(root) },
          ]} />
        </>
      } />
      <div className="px-3 pb-2 space-y-2">
        <Select aria-label="Machine" size="sm" value={vmid === null ? "" : String(vmid)} onChange={(e) => { if (e.target.value) { onVmid(Number(e.target.value)); setOpen(new Set()); } }}>
          <option value="">Choose a machine…</option>
          {machines.filter((m) => !m.template).map((m) => <option key={m.vmid} value={String(m.vmid)} disabled={m.status !== "running"}>{m.name} ({m.vmid}){m.status !== "running" ? " · off" : ""}</option>)}
        </Select>
        {machine && (
          <Select aria-label="Start from" size="sm" value={root} onChange={(e) => { setRoot(e.target.value); setOpen(new Set()); }}>
            {roots.map((r) => <option key={r} value={r}>{r === "/" ? "/ (the whole machine)" : r}</option>)}
          </Select>
        )}
      </div>
      <div role="tree" aria-label={machine ? `${machine.name} files` : "Files"} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pb-3">
        {!live && <p className="px-4 py-2 text-xs text-ink-3 text-pretty">On a device, a machine's folders and files appear here and open in the editor. The demo has no machines to look inside.</p>}
        {live && !machine && <p className="px-4 py-2 text-xs text-ink-3 text-pretty">Choose a running machine to see its files. For a container, its console must open into a shell (Options → Console mode); a VM needs the QEMU guest agent.</p>}
        {live && machine && <Folder_ vmid={machine.vmid} path={root} depth={0} hidden={hidden} open={open} toggle={toggle} onOpenFile={(p) => onOpenFile(machine.vmid, p)} activePath={activePath} />}
      </div>
    </div>
  );
}
