import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Box, Lock, Monitor, Plus, SquareTerminal } from "lucide-react";
import { useEngine } from "../../data/store.tsx";
import { formatBytes } from "../../lib/storage.ts";
import { BarMeter } from "../../ui/meters.tsx";
import { Button, Card, Chip, EmptyState, PageFrame, PageHeader, Segmented, Status } from "../../ui/primitives.tsx";

/** Every machine on the device, or, inside an organization, the machines in its resource group. */
export function Machines() {
  const { org: orgSlug } = useParams();
  const { data, setup } = useEngine();
  const device = setup?.deviceName ?? "pve";
  const org = data.orgs.find((o) => o.slug === orgSlug);
  const [filter, setFilter] = useState<"all" | "running" | "stopped">("all");
  const scoped = data.guests.filter((g) => (org ? g.org === org.slug : true));
  const list = scoped.filter((g) => (filter === "all" ? true : g.status === filter));
  const base = org ? `/${device}/${org.slug}/machines` : `/${device}/machines`;

  return (
    <PageFrame width="6xl">
      <PageHeader
        title="Machines"
        subtitle={org ? `Containers in ${org.name}'s resource group. Its agents create and remove these; you can open any of them.` : "Every virtual machine and container on this device."}
        actions={org ? <Button variant="primary" disabled title="Creating machines from the console arrives with the host broker"><Plus className="h-4 w-4" />New machine</Button> : undefined}
      />
      <div className="mb-4"><Segmented value={filter} onChange={setFilter} options={[{ value: "all", label: `All (${scoped.length})` }, { value: "running", label: "Running" }, { value: "stopped", label: "Stopped" }]} /></div>
      {list.length === 0 ? (
        <Card><EmptyState icon={<Box className="h-5 w-5" />} title="No machines here" body={org ? `${org.name}'s agents start containers in its resource group when they work.` : "Nothing matches this filter."} /></Card>
      ) : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {list.map((g) => {
            const owner = data.orgs.find((o) => o.slug === g.org);
            return (
              <Card key={g.vmid} interactive className="p-4 flex flex-col">
                <Link to={`${base}/${g.vmid}`} className="flex items-start gap-3">
                  <span className="h-9 w-9 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2">{g.type === "qemu" ? <Monitor className="h-4 w-4" /> : <Box className="h-4 w-4" />}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2"><span className="font-medium truncate">{g.name}</span><span className="text-xs text-ink-3 tabular-nums">#{g.vmid}</span></div>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1">
                      {g.template ? <Chip tone="accent">Template</Chip> : g.status === "running" ? <Status kind="good" label="Running" /> : <Status kind="off" label="Stopped" />}
                      {!org && owner && <Chip tone="accent">{owner.name}</Chip>}
                      {g.protected && <Chip><Lock className="h-3 w-3" />Protected</Chip>}
                    </div>
                  </div>
                </Link>
                <div className="grid grid-cols-2 gap-3 mt-4">
                  <BarMeter label="CPU" pct={g.cpuPct} value={`${g.cpuPct.toFixed(0)}%`} />
                  <BarMeter label="Memory" pct={g.memMax ? (g.memUsed / g.memMax) * 100 : 0} value={`${formatBytes(g.memUsed)} / ${formatBytes(g.memMax)}`} />
                </div>
                <div className="flex gap-2 mt-4">
                  <Link to={`${base}/${g.vmid}`} className="flex-1"><Button size="sm" className="w-full">Manage</Button></Link>
                  <Link to={`${base}/${g.vmid}?tab=console`}><Button size="sm" disabled={g.status !== "running"} aria-label={`Console for ${g.name}`}><SquareTerminal className="h-3.5 w-3.5" />Console</Button></Link>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </PageFrame>
  );
}
