import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ClipboardList, FileText, Maximize2, Minimize2, MoreHorizontal, SquareTerminal, X } from "lucide-react";
import { cn } from "../../lib/storage.ts";
import { Chip, Menu, Status, type MenuEntry, type StatusKind } from "../../ui/primitives.tsx";
import type { Tile, TileStatus } from "./tiles.ts";

const STATUS: Record<TileStatus, [StatusKind, string]> = { running: ["working", "Running"], done: ["good", "Done"], failed: ["critical", "Failed"], waiting: ["idle", "Waiting for you"] };

export const copyText = (text: string) => void navigator.clipboard?.writeText(text).catch(() => undefined);

/**
 * A pane: a header (what it is, its menu, expand, close) over its content. As a tab in the workspace's editor group
 * (`tab`), the tab already names it and closes it, so the header shrinks to a thin bar with the detail line and the menu.
 */
export function Pane({ icon, title, sub, menu, expanded, onExpand, onClose, children, className, tab }: { icon: ReactNode; title: string; sub?: ReactNode; menu?: MenuEntry[]; expanded?: boolean; onExpand?: () => void; onClose: () => void; children: ReactNode; className?: string; tab?: boolean }) {
  if (tab) {
    return (
      <section aria-label={title} className="flex flex-col min-h-0 h-full">
        <header className="h-9 shrink-0 flex items-center gap-2 pl-4 pr-2 border-b border-line text-xs text-ink-3">
          <div className="min-w-0 flex-1 truncate">{sub}</div>
          {menu && menu.length > 0 && <Menu size="sm" label={`${title} options`} icon={<MoreHorizontal className="h-4 w-4" />} items={menu} />}
        </header>
        <div className="flex-1 min-h-0 overflow-auto">{children}</div>
      </section>
    );
  }
  return (
    <section aria-label={title} className={cn("flex flex-col min-h-0 rounded-xl border border-line bg-surface overflow-hidden", className)}>
      <header className="h-11 shrink-0 flex items-center gap-2 pl-3 pr-1.5 border-b border-line">
        <span aria-hidden className="text-ink-3 shrink-0">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-compact font-medium truncate">{title}</div>
          {sub && <div className="text-xs text-ink-3 truncate -mt-0.5">{sub}</div>}
        </div>
        {menu && menu.length > 0 && <Menu size="sm" label={`${title} options`} icon={<MoreHorizontal className="h-4 w-4" />} items={menu} />}
        {onExpand && <button type="button" aria-label={expanded ? "Restore" : "Expand"} title={expanded ? "Restore" : "Expand"} onClick={onExpand} className="transition-control h-7 w-7 rounded-lg flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2">{expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}</button>}
        <button type="button" aria-label={`Close ${title}`} title="Close" onClick={onClose} className="transition-control h-7 w-7 rounded-lg flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2"><X className="h-3.5 w-3.5" /></button>
      </header>
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
    </section>
  );
}

/** Text with a line-number gutter, wrapped or scrolled sideways. Plain text only: nothing in it is ever interpreted. */
export function Code({ text, wrap, numbers, empty }: { text: string; wrap: boolean; numbers: boolean; empty: string }) {
  if (!text) return <p className="p-4 text-compact text-ink-3">{empty}</p>;
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <div className="font-mono text-xs leading-5 py-2 bg-code min-w-full w-max">
      {lines.map((l, i) => (
        <div key={i} className="flex">
          {numbers && <span aria-hidden className="select-none text-ink-3 text-right w-10 shrink-0 pr-3">{i + 1}</span>}
          <span className={cn("pr-4 text-ink-2", numbers ? "" : "pl-4", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")}>{l || " "}</span>
        </div>
      ))}
    </div>
  );
}

export function TileView({ tile, device, expanded, onExpand, onClose, onEditLive, tab }: { tile: Tile; device: string; expanded: boolean; onExpand: () => void; onClose: () => void; /** Opens the file as it is now in the machine, in an editor tile. */ onEditLive?: (vmid: number, path: string) => void; tab?: boolean }) {
  const [wrap, setWrap] = useState(true);
  const [numbers, setNumbers] = useState(true);
  const [kind, label] = STATUS[tile.status];
  const status = <Status kind={kind} label={label} />;
  const view: MenuEntry[] = [{ kind: "check", label: "Word wrap", checked: wrap, onToggle: setWrap }, { kind: "check", label: "Line numbers", checked: numbers, onToggle: setNumbers }];

  if (tile.kind === "file") {
    return (
      <Pane icon={<FileText className="h-4 w-4" />} title={tile.title} sub={<>{tile.write ? "Written" : "Read"}{tile.vmid !== null ? ` in machine ${tile.vmid}` : ""} · <span className="font-mono">{tile.path}</span></>} tab={tab} expanded={expanded} onExpand={onExpand} onClose={onClose} className="flex-1"
        menu={[...view, { kind: "separator" }, ...(onEditLive && tile.vmid !== null ? [{ label: "Open the live file to edit", onSelect: () => onEditLive(tile.vmid!, tile.path) }] : []), { label: "Copy contents", onSelect: () => copyText(tile.text), disabled: !tile.text }, { label: "Copy path", onSelect: () => copyText(tile.path) }]}>
        <div className="px-3 py-2 border-b border-line flex items-center gap-2">{status}{tile.write && <Chip>Proposed contents</Chip>}<span className="flex-1" />{onEditLive && tile.vmid !== null && tile.path && <button type="button" onClick={() => onEditLive(tile.vmid!, tile.path)} className="text-compact text-accent hover:underline">Edit the live file</button>}</div>
        <Code text={tile.text} wrap={wrap} numbers={numbers} empty={tile.status === "running" ? "Reading…" : tile.status === "waiting" ? "Waiting for your approval in the chat." : "Nothing came back."} />
      </Pane>
    );
  }
  if (tile.kind === "command") {
    return (
      <Pane icon={<SquareTerminal className="h-4 w-4" />} title={tile.title} sub={tile.vmid !== null ? `In machine ${tile.vmid}` : undefined} tab={tab} expanded={expanded} onExpand={onExpand} onClose={onClose} className="flex-1"
        menu={[...view, { kind: "separator" }, { label: "Copy command", onSelect: () => copyText(tile.command) }, { label: "Copy output", onSelect: () => copyText(tile.text), disabled: !tile.text }]}>
        <div className="px-3 py-2 border-b border-line flex items-center gap-2">{status}</div>
        <pre className="px-4 pt-3 font-mono text-xs text-ink whitespace-pre-wrap break-all"><span className="text-ink-3 select-none">$ </span>{tile.command}</pre>
        <Code text={tile.text} wrap={wrap} numbers={numbers} empty={tile.status === "running" ? "Running…" : tile.status === "waiting" ? "Waiting for your approval in the chat." : "(no output)"} />
      </Pane>
    );
  }
  return (
    <Pane icon={<ClipboardList className="h-4 w-4" />} title={tile.title} sub="Plan" tab={tab} expanded={expanded} onExpand={onExpand} onClose={onClose} className="flex-1"
      menu={[{ label: "Copy as a list", onSelect: () => copyText(tile.steps.map((s, i) => `${i + 1}. ${s.label}`).join("\n")) }]}>
      <div className="p-4 space-y-3">
        {tile.summary && <p className="text-compact text-ink-2 text-pretty">{tile.summary}</p>}
        <ol className="space-y-2">
          {tile.steps.map((s, i) => (
            <li key={i} className="flex items-start gap-2.5 text-compact">
              <span className="h-5 w-5 shrink-0 rounded-full bg-surface-2 text-ink-3 text-xs flex items-center justify-center tabular-nums">{i + 1}</span>
              <span className="flex-1 text-pretty">{s.label}</span>
              {s.destructive && <Chip tone="critical">Can't be undone</Chip>}
            </li>
          ))}
        </ol>
        <Link to={`/${device}/pin?tab=plans`} className="text-compact text-accent hover:underline">Review and approve on the Plans tab</Link>
      </div>
    </Pane>
  );
}
