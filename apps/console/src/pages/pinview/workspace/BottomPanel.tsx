import { useMemo, useState } from "react";
import { CircleCheck, CircleDot, CircleX, Clock, SquareTerminal, X } from "lucide-react";
import { useEngine } from "../../../data/store.tsx";
import { cn } from "../../../lib/storage.ts";
import { Terminal } from "../../../terminal/LazyTerminal.tsx";
import { DemoTransport, LiveTransport } from "../../../terminal/transport.ts";
import type { ThreadMessage } from "../../../pin/useThread.ts";
import { Select } from "../../../ui/primitives.tsx";
import type { BottomTab } from "./layout.ts";

/**
 * The bottom panel, like an editor's: a real terminal (any running machine, or this device's own shell) and Pin's steps
 * in the open conversation, each one a click away from its full output in the editor.
 */

const ICON = { done: CircleCheck, failed: CircleX, running: CircleDot, proposed: Clock, approval: Clock } as const;
const TONE = { done: "text-good", failed: "text-critical", running: "text-warning", proposed: "text-ink-3", approval: "text-ink-3" } as const;

function MachineTerminal({ target }: { target: string }) {
  const { live, data, host, setup } = useEngine();
  const guest = target === "host" ? null : (data.guests ?? []).find((g) => String(g.vmid) === target) ?? null;
  const make = useMemo(() => () => {
    if (live) return new LiveTransport(guest ? `/api/console/guests/${guest.vmid}` : "/api/console/node");
    return guest
      ? new DemoTransport({ kind: guest.type, name: guest.name, os: guest.os ?? "Linux", ip: guest.ip ?? null, cores: guest.cores, memUsed: guest.memUsed, memMax: guest.memMax, diskMax: guest.diskMax, uptimeSec: guest.uptimeSec ?? 3600 })
      : new DemoTransport({ kind: "host", name: setup?.deviceName ?? "pve", os: "Debian 13 (trixie)", ip: host.ip, cores: host.cpus, memUsed: host.memUsed, memMax: host.memTotal, diskMax: host.diskTotal, uptimeSec: host.uptimeSec ?? 86400 });
  }, [live, guest, host, setup]);
  return <Terminal key={target} make={make} title={guest ? `root@${guest.name}` : `root@${setup?.deviceName ?? "pve"}`} className="h-full rounded-none border-0" />;
}

export function BottomPanel({ tab, onTab, onClose, messages, onOpenStep }: { tab: BottomTab; onTab: (t: BottomTab) => void; onClose: () => void; messages: ThreadMessage[]; onOpenStep: (toolId: string) => void }) {
  const { data } = useEngine();
  const running = (data.guests ?? []).filter((g) => g.status === "running" && !g.template);
  const [target, setTarget] = useState("host");
  const steps = messages.filter((m) => m.tool).map((m) => m.tool!);

  return (
    <section aria-label="Panel" className="flex flex-col min-h-0 h-full border-t border-line bg-surface/30">
      <div className="h-9 shrink-0 flex items-center gap-1 pl-2 pr-1 border-b border-line">
        <div role="tablist" aria-label="Panel" className="flex items-center gap-0.5">
          {(["terminal", "steps"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => onTab(t)}
              className={cn("transition-control h-7 px-2.5 rounded-md text-xs font-semibold uppercase tracking-label", tab === t ? "text-ink bg-surface-2" : "text-ink-3 hover:text-ink-2")}>
              {t === "terminal" ? "Terminal" : `Steps${steps.length ? ` ${steps.length}` : ""}`}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {tab === "terminal" && (
          <div className="w-60 max-w-[50%]">
            <Select aria-label="Terminal on" size="sm" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="host">This device (host shell)</option>
              {running.map((g) => <option key={g.vmid} value={String(g.vmid)}>{g.name} ({g.vmid})</option>)}
            </Select>
          </div>
        )}
        <button type="button" aria-label="Close the panel" title="Close the panel (Ctrl+J)" onClick={onClose} className="transition-control h-7 w-7 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2"><X className="h-3.5 w-3.5" /></button>
      </div>
      <div className="flex-1 min-h-0">
        {tab === "terminal" ? <MachineTerminal target={target} /> : (
          <div className="h-full overflow-y-auto py-1">
            {steps.length === 0 && <p className="px-4 py-3 text-compact text-ink-3">Pin's steps in this conversation appear here: what it looked up, what it ran, and how each one went.</p>}
            <ul>
              {steps.map((t) => {
                const Icon = ICON[t.status as keyof typeof ICON] ?? SquareTerminal;
                return (
                  <li key={t.id}>
                    <button type="button" onClick={() => onOpenStep(t.id)} className="transition-control w-full flex items-center gap-2.5 px-4 py-1.5 text-left hover:bg-surface-2">
                      <Icon className={cn("h-3.5 w-3.5 shrink-0", TONE[t.status as keyof typeof TONE] ?? "text-ink-3")} aria-label={t.status} />
                      <span className="text-compact truncate flex-1">{t.label ?? t.title ?? t.name.replace(/_/g, " ")}</span>
                      <span className="font-mono text-xs text-ink-3 shrink-0">{t.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
