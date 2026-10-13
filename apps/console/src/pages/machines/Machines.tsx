import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Box, Lock, Monitor, Plus, Search, SquareTerminal } from "lucide-react";
import { useEngine } from "../../data/store.tsx";
import { formatBytes } from "../../lib/storage.ts";
import { BarMeter } from "../../ui/meters.tsx";
import { Button, Card, Chip, EmptyState, Input, PageFrame, PageHeader, Segmented, Select, Status } from "../../ui/primitives.tsx";
import { Tag } from "../../ui/Tag.tsx";

/** Every machine on the device, or, inside an organization, the machines in its resource group. */
export function Machines() {
  const { org: orgSlug } = useParams();
  const { data, setup } = useEngine();
  const device = setup?.deviceName ?? "pve";
  const org = data.orgs.find((o) => o.slug === orgSlug);
  const nav = useNavigate();
  const [filter, setFilter] = useState<"all" | "running" | "stopped">("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"id" | "name" | "cpu" | "memory">("id");
  const scoped = data.guests.filter((g) => (org ? g.org === org.slug : true));
  const q = query.trim().toLowerCase();
  const list = scoped
    .filter((g) => (filter === "all" ? true : g.status === filter))
    .filter((g) => !q || g.name.toLowerCase().includes(q) || String(g.vmid).includes(q) || (g.tags ?? []).some((t) => t.includes(q)) || (g.os ?? "").toLowerCase().includes(q))
    .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name, undefined, { numeric: true }) : sort === "cpu" ? b.cpuPct - a.cpuPct : sort === "memory" ? b.memUsed - a.memUsed : a.vmid - b.vmid));
  const base = org ? `/${device}/${org.slug}/machines` : `/${device}/machines`;

  return (
    <PageFrame width="6xl">
      <PageHeader
        title="Machines"
        subtitle={org ? `Containers in ${org.name}'s resource group. Its agents create and remove these; you can open any of them.` : "Every virtual machine and container on this device."}
        actions={<Button variant="primary" onClick={() => nav("?modal=new-machine")}><Plus className="h-4 w-4" />New machine</Button>}
      />
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Segmented value={filter} onChange={setFilter} options={[{ value: "all", label: `All (${scoped.length})` }, { value: "running", label: "Running" }, { value: "stopped", label: "Stopped" }]} />
        <div className="relative flex-1 basis-56 min-w-0 max-w-sm">
          <Search className="h-4 w-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, number or tag" aria-label="Search machines" className="pl-9" />
        </div>
        <label className="inline-flex items-center gap-2 text-compact text-ink-3">Sort<Select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort machines" className="w-36"><option value="id">Number</option><option value="name">Name</option><option value="cpu">CPU use</option><option value="memory">Memory use</option></Select></label>
      </div>
      {list.length === 0 ? (
        <Card><EmptyState icon={<Box className="h-5 w-5" />} title={q || filter !== "all" ? "No machines match" : "No machines here"} body={q || filter !== "all" ? "Try a different search or filter." : org ? `${org.name}'s agents start containers in its resource group when they work.` : "Create a machine to get started."} action={!q && filter === "all" && !org ? <Button variant="primary" onClick={() => nav("?modal=new-machine")}><Plus className="h-4 w-4" />New machine</Button> : undefined} /></Card>
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
                      {(g.tags ?? []).slice(0, 3).map((t) => <Tag key={t} name={t} />)}
                    </div>
                  </div>
                </Link>
                <div className="grid grid-cols-2 gap-3 mt-4">
                  <BarMeter label="CPU" pct={g.cpuPct} value={`${g.cpuPct.toFixed(0)}%`} />
                  <BarMeter label="Memory" pct={g.memMax ? (g.memUsed / g.memMax) * 100 : 0} value={`${formatBytes(g.memUsed)} of ${formatBytes(g.memMax)}`} />
                </div>
                <div className="flex gap-2 mt-4">
                  <Button size="sm" className="flex-1" onClick={() => nav(`${base}/${g.vmid}`)} aria-label={`Manage ${g.name}`}>Manage</Button>
                  <Button size="sm" disabled={g.status !== "running"} onClick={() => nav(`${base}/${g.vmid}?tab=console`)} aria-label={`Console for ${g.name}`}><SquareTerminal className="h-3.5 w-3.5" />Console</Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </PageFrame>
  );
}
