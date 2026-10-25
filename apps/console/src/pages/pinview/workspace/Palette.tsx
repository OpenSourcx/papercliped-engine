import { useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "../../../lib/storage.ts";
import { Modal } from "../../../ui/Modal.tsx";
import { Input, Kbd } from "../../../ui/primitives.tsx";

export interface Command { id: string; label: string; group: string; hint?: string; icon?: ReactNode; run: () => void }

/** Go to anything: conversations, open editors, recent files and every workspace command. Ctrl/Cmd+P. */
export function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    const scored = commands.filter((c) => !t || `${c.label} ${c.group} ${c.hint ?? ""}`.toLowerCase().includes(t));
    return scored.slice(0, 50);
  }, [commands, q]);
  useEffect(() => setActive(0), [q]);
  const run = (c: Command) => { onClose(); c.run(); };
  let lastGroup = "";
  return (
    <Modal title="Go to" subtitle="Conversations, files and commands" size="md" onClose={onClose}>
      <Input autoFocus aria-label="Go to" placeholder="Type to search" value={q} onChange={(e) => setQ(e.target.value)} role="combobox" aria-expanded aria-controls="pv-palette" aria-activedescendant={hits[active] ? `pv-${hits[active].id}` : undefined}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(hits.length - 1, a + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          else if (e.key === "Enter" && hits[active]) { e.preventDefault(); run(hits[active]); }
        }} />
      <ul id="pv-palette" role="listbox" aria-label="Results" className="mt-3 max-h-96 overflow-y-auto -mx-1">
        {hits.length === 0 && <li className="px-3 py-6 text-center text-compact text-ink-3">Nothing matches.</li>}
        {hits.map((c, i) => {
          const head = c.group !== lastGroup ? (lastGroup = c.group) : null;
          return (
            <li key={c.id} role="presentation">
              {head && <div className="px-3 pt-2 pb-1 text-xs font-medium text-ink-3">{head}</div>}
              <div id={`pv-${c.id}`} role="option" aria-selected={i === active} onMouseMove={() => setActive(i)} onClick={() => run(c)}
                className={cn("flex items-center gap-3 rounded-md px-3 h-9 text-sm cursor-pointer", i === active ? "bg-surface-3 text-ink" : "text-ink-2")}>
                {c.icon && <span aria-hidden className="text-ink-3 shrink-0">{c.icon}</span>}
                <span className="truncate flex-1">{c.label}</span>
                {c.hint && <Kbd>{c.hint}</Kbd>}
              </div>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
