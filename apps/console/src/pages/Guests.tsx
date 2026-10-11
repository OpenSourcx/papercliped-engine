import { useState } from "react";
import { Box, Lock, Monitor, Play, Power } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import { formatBytes } from "../lib/storage.ts";
import { BarMeter } from "../ui/meters.tsx";
import { Button, Card, Chip, PageHeader, Segmented, Status } from "../ui/primitives.tsx";

export function Guests() {
  const { data, guestPower, notify } = useEngine();
  const [filter, setFilter] = useState<"all" | "running" | "orgs">("all");
  const [error, setError] = useState<string | null>(null);
  const list = data.guests.filter((g) => (filter === "running" ? g.status === "running" : filter === "orgs" ? g.org : true));

  const power = (vmid: number, action: "start" | "shutdown", name: string) => {
    const r = guestPower(vmid, action);
    if (!r.ok) return setError(r.error ?? "Failed");
    setError(null);
    notify({ kind: "info", title: `${name} ${action === "start" ? "started" : "shut down"}`, body: `Guest ${vmid} was ${action === "start" ? "started" : "shut down"} from the console.` });
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-20 sm:pt-24 pb-20">
      <PageHeader title="Guests" subtitle="Every virtual machine and container on this device. Organization containers are created and removed by their agents; protected guests can't be touched by automations." />
      <div className="flex items-center justify-between gap-3 mb-4">
        <Segmented value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "running", label: "Running" }, { value: "orgs", label: "Organizations" }]} />
        {error && <span className="text-[13px] text-critical">{error}</span>}
      </div>
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
        {list.map((g) => {
          const org = data.orgs.find((o) => o.slug === g.org);
          return (
            <Card key={g.vmid} className="p-4">
              <div className="flex items-start gap-3">
                <span className="h-9 w-9 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2">{g.type === "qemu" ? <Monitor className="h-4 w-4" /> : <Box className="h-4 w-4" />}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><span className="font-medium truncate">{g.name}</span><span className="text-[12px] text-ink-3 tabular-nums">#{g.vmid}</span></div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1">
                    {g.status === "running" ? <Status kind="good" label="Running" /> : <Status kind="off" label="Stopped" />}
                    <Chip>{g.type === "qemu" ? "VM" : "Container"}</Chip>
                    {org && <Chip tone="accent">{org.name}</Chip>}
                    {g.protected && <Chip><Lock className="h-3 w-3" />Protected</Chip>}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 mt-4">
                <BarMeter label="CPU" pct={g.cpuPct} value={`${g.cpuPct.toFixed(0)}% · ${g.cores} cores`} />
                <BarMeter label="Memory" pct={g.memMax ? (g.memUsed / g.memMax) * 100 : 0} value={`${formatBytes(g.memUsed)} / ${formatBytes(g.memMax)}`} />
              </div>
              <div className="flex gap-2 mt-4">
                {g.status === "running" ? (
                  <Button size="sm" disabled={g.protected} title={g.protected ? "Protected guest" : undefined} onClick={() => power(g.vmid, "shutdown", g.name)}><Power className="h-3.5 w-3.5" />Shut down</Button>
                ) : (
                  <Button size="sm" disabled={g.protected} title={g.protected ? "Protected guest" : undefined} onClick={() => power(g.vmid, "start", g.name)}><Play className="h-3.5 w-3.5" />Start</Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
