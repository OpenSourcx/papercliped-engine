import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Box, Database, Monitor, Search, Server } from "lucide-react";
import { dcApi, type ResourceRow } from "../../data/engine/dcApi.ts";
import { useEngine } from "../../data/store.tsx";
import { formatBytes, formatUptime } from "../../lib/storage.ts";
import { BarMeter } from "../../ui/meters.tsx";
import { Card, Chip, EmptyState, Input, PageFrame, PageHeader, SectionTitle, Segmented, Select, Status } from "../../ui/primitives.tsx";
import { Async, LiveOnly } from "./common.tsx";
import { Fact, Td } from "./dc.tsx";

type View = "node" | "pool" | "tag" | "type";
type Kind = "all" | "machines" | "storage" | "node";

const ICON = { node: <Server className="h-4 w-4" aria-hidden />, qemu: <Monitor className="h-4 w-4" aria-hidden />, lxc: <Box className="h-4 w-4" aria-hidden />, storage: <Database className="h-4 w-4" aria-hidden />, pool: null, sdn: null } as const;
const KIND_LABEL = { node: "Node", qemu: "Virtual machine", lxc: "Container", storage: "Storage", pool: "Pool", sdn: "Network zone" } as const;

const groupOf = (r: ResourceRow, view: View): string[] => {
  if (view === "node") return [r.node ?? "Datacenter"];
  if (view === "pool") return [r.pool ?? "No pool"];
  if (view === "tag") return r.tags.length ? r.tags : ["No tag"];
  return [KIND_LABEL[r.type]];
};

/** Where a row leads inside the console. */
function useLink() {
  const { setup } = useEngine();
  const d = setup?.deviceName ?? "pve";
  return (r: ResourceRow): string | null => (r.type === "qemu" || r.type === "lxc" ? `/${d}/machines/${r.vmid}` : r.type === "storage" ? `/${d}/storage` : r.type === "node" ? `/${d}/datacenter/summary` : null);
}

function Body() {
  const q = useQuery({ queryKey: ["node", "resources"], queryFn: dcApi.resources, retry: 1, refetchInterval: 20_000 });
  const link = useLink();
  const [view, setView] = useState<View>("node");
  const [kind, setKind] = useState<Kind>("all");
  const [pool, setPool] = useState("");
  const [tag, setTag] = useState("");
  const [search, setSearch] = useState("");
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const tags = useMemo(() => [...new Set(rows.flatMap((r) => r.tags))].sort(), [rows]);
  const f = search.trim().toLowerCase();
  const shown = rows.filter((r) => (kind === "all" || (kind === "machines" ? r.type === "qemu" || r.type === "lxc" : r.type === kind)) && (!pool || r.pool === pool) && (!tag || r.tags.includes(tag)) && (!f || `${r.name} ${r.vmid ?? ""} ${r.node} ${r.tags.join(" ")}`.toLowerCase().includes(f)));
  const groups = useMemo(() => {
    const m = new Map<string, ResourceRow[]>();
    for (const r of shown) for (const g of groupOf(r, view)) m.set(g, [...(m.get(g) ?? []), r]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  }, [shown, view]);

  return (
    <Async q={q}>
      {(d) => {
        const t = d.totals;
        return (
          <div className="space-y-4">
            <Card className="p-5">
              <SectionTitle>Whole datacenter</SectionTitle>
              <div className="grid gap-5 sm:grid-cols-3 mt-4">
                <BarMeter label="Processor" pct={t.cpu.total ? (t.cpu.used / t.cpu.total) * 100 : 0} value={`${t.cpu.used.toFixed(1)} of ${t.cpu.total} cores busy`} />
                <BarMeter label="Memory" pct={t.memory.total ? (t.memory.used / t.memory.total) * 100 : 0} value={`${formatBytes(t.memory.used)} of ${formatBytes(t.memory.total)}`} />
                <BarMeter label="Storage" pct={t.storage.total ? (t.storage.used / t.storage.total) * 100 : 0} value={`${formatBytes(t.storage.used)} of ${formatBytes(t.storage.total)}`} />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5">
                <Fact label="Nodes online">{t.nodes.online} of {t.nodes.total}</Fact>
                <Fact label="Machines running">{t.guests.running} of {t.guests.running + t.guests.stopped}</Fact>
                <Fact label="Virtual machines and containers">{t.guests.vms} · {t.guests.containers}</Fact>
                <Fact label="Templates">{t.guests.templates}</Fact>
              </div>
              <p className="text-xs text-ink-3 mt-4">Storage shared between nodes is counted once. Offline nodes are left out of processor and memory.</p>
            </Card>
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative flex-1 basis-56 max-w-sm">
                <Search className="h-4 w-4 text-ink-3 absolute left-3 top-3" aria-hidden />
                <Input className="pl-9" placeholder="Search by name, number or tag" aria-label="Search resources" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <Segmented<Kind> label="Show" value={kind} onChange={setKind} options={[{ value: "all", label: "All" }, { value: "machines", label: "Machines" }, { value: "storage", label: "Storage" }, { value: "node", label: "Nodes" }]} />
              <Select aria-label="Pool" value={pool} onChange={(e) => setPool(e.target.value)} className="w-40"><option value="">Any pool</option>{d.pools.map((p) => <option key={p.pool} value={p.pool}>{p.pool}</option>)}</Select>
              <Select aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)} className="w-40"><option value="">Any tag</option>{tags.map((x) => <option key={x} value={x}>{x}</option>)}</Select>
            </div>
            <Segmented<View> label="Group by" value={view} onChange={setView} options={[{ value: "node", label: "Node" }, { value: "pool", label: "Pool" }, { value: "tag", label: "Tag" }, { value: "type", label: "Type" }]} />
            {groups.length === 0 ? <EmptyState icon={<Search className="h-5 w-5" />} title="Nothing matches" body="Change the filters to see more." /> : groups.map(([name, list]) => (
              <Card key={name}>
                <div className="px-5 pt-4 pb-2 flex items-center gap-2"><SectionTitle>{name}</SectionTitle><Chip>{list.length}</Chip></div>
                <div className="overflow-x-auto edge-fade-x">
                  <table className="w-full text-compact min-w-[640px]" aria-label={`Resources: ${name}`}>
                    <tbody>
                      {list.map((r) => {
                        const to = link(r);
                        return (
                          <tr key={`${name}-${r.id}`} className="border-t border-line">
                            <Td><span className="inline-flex items-center gap-2">{ICON[r.type]}{r.vmid !== null && <span className="font-mono text-xs text-ink-3">{r.vmid}</span>}{to ? <Link to={to} className="hover:underline">{r.name ?? r.id}</Link> : r.name ?? r.id}{r.template && <Chip>template</Chip>}</span></Td>
                            <Td className="text-ink-2">{KIND_LABEL[r.type]}</Td>
                            <Td>{r.status ? <Status kind={r.status === "running" || r.status === "online" || r.status === "available" ? "good" : "off"} label={r.status} /> : null}</Td>
                            <Td className="text-ink-2">{r.maxmem ? formatBytes(r.mem ?? 0) + " / " + formatBytes(r.maxmem) : r.maxdisk ? formatBytes(r.disk ?? 0) + " / " + formatBytes(r.maxdisk) : ""}</Td>
                            <Td className="text-ink-2">{r.uptime ? formatUptime(r.uptime) : ""}</Td>
                            <Td><div className="flex flex-wrap gap-1">{r.tags.map((x) => <Chip key={x}>{x}</Chip>)}</div></Td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            ))}
          </div>
        );
      }}
    </Async>
  );
}

export function ResourceTreePage() {
  return (
    <PageFrame width="6xl">
      <PageHeader title="Resources" subtitle="Every node, machine and storage in the datacenter, with totals, grouped by node, pool or tag." />
      <LiveOnly><Body /></LiveOnly>
    </PageFrame>
  );
}
