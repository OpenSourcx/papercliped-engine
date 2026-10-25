import { useMemo, useState } from "react";
import { CircleCheck, CircleDot, CircleX, Clock, SquareTerminal, X } from "lucide-react";
import { useEngine } from "../../../data/store.tsx";
import { cn } from "../../../lib/storage.ts";
import { Terminal } from "../../../terminal/LazyTerminal.tsx";
import { DemoTransport, LiveTransport } from "../../../terminal/transport.ts";
import type { ThreadMessage } from "../../../pin/useThread.ts";
import { Select } from "../../../ui/primitives.tsx";

/** The Terminal tile's shell: this device's own, or a running machine's, through the same relay as the console's terminals. */

const ICON = { done: CircleCheck, failed: CircleX, running: CircleDot, proposed: Clock, approval: Clock } as const;
const TONE = { done: "text-good", failed: "text-critical", running: "text-warning", proposed: "text-ink-3", approval: "text-ink-3" } as const;

/** A terminal on this device ("host") or on a machine (its vmid), live on a device and a demo shell otherwise. */
export function MachineTerminal({ target }: { target: string }) {
  const { live, data, host, setup } = useEngine();
  const guest = target === "host" ? null : (data.guests ?? []).find((g) => String(g.vmid) === target) ?? null;
  const make = useMemo(() => () => {
    if (live) return new LiveTransport(guest ? `/api/console/guests/${guest.vmid}` : "/api/console/node");
    return guest
      ? new DemoTransport({ kind: guest.type, name: guest.name, os: guest.os ?? "Linux", ip: guest.ip ?? null, cores: guest.cores, memUsed: guest.memUsed, memMax: guest.memMax, diskMax: guest.diskMax, uptimeSec: guest.uptimeSec ?? 3600 })
      : new DemoTransport({ kind: "host", name: setup?.deviceName ?? "pve", os: "Debian 13 (trixie)", ip: host.ip, cores: host.cpus, memUsed: host.memUsed, memMax: host.memTotal, diskMax: host.diskTotal, uptimeSec: host.uptimeSec ?? 86400 });
  }, [live, guest, host, setup]);
  return <Terminal key={target} make={make} title={guest ? `root@${guest.name}` : `root@${setup?.deviceName ?? "pve"}`} embedded className="h-full" />;
}
