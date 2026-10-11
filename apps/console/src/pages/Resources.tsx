import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowDown, ArrowUp, Box, Database, Grid3x3, Monitor, Search, Server } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import { cn, formatUptime } from "../lib/storage.ts";
import { Card, Input, PageFrame, PageHeader, Segmented, Status } from "../ui/primitives.tsx";
import { Tag } from "../ui/Tag.tsx";

type Kind = "node" | "qemu" | "lxc" | "storage" | "zone";
interface Row {
  key: string;
  kind: Kind;
  name: string;
  status: "running" | "stopped" | "online" | "available";
  disk: number | null; // percent
  mem: number | null;
  cpu: number | null;
  uptime: number | null; // seconds
  hostCpu: number | null; // share of the host's CPU
  hostMem: number | null;
  tags: string[];
  to: string | null;
}

const ICON: Record<Kind, React.ReactNode> = { node: <Server className="h-4 w-4" />, qemu: <Monitor className="h-4 w-4" />, lxc: <Box className="h-4 w-4" />, storage: <Database className="h-4 w-4" />, zone: <Grid3x3 className="h-4 w-4" /> };
const KIND: Record<Kind, string> = { node: "Node", qemu: "VM", lxc: "Container", storage: "Storage", zone: "Zone" };
const COLS: { key: keyof Row; label: string; num?: boolean }[] = [
  { key: "kind", label: "Type" },
  { key: "name", label: "Description" },
  { key: "disk", label: "Disk", num: true },
  { key: "mem", label: "Memory", num: true },
  { key: "cpu", label: "CPU", num: true },
  { key: "uptime", label: "Uptime", num: true },
  { key: "hostCpu", label: "Host CPU", num: true },
  { key: "hostMem", label: "Host memory", num: true },
];

/** Every resource on the device in one sortable, searchable table, like the Search view in Proxmox. */
export function Resources() {
  const { data, host, setup } = useEngine();
  const nav = useNavigate();
  const d = setup?.deviceName ?? "pve";
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "machines" | "node" | "storage">("all");
  const [sort, setSort] = useState<{ key: keyof Row; dir: 1 | -1 }>({ key: "kind", dir: 1 });

  const rows = useMemo<Row[]>(() => {
    const list: Row[] = [
      { key: "node", kind: "node", name: d, status: "online", disk: (host.diskUsed / host.diskTotal) * 100, mem: (host.memUsed / host.memTotal) * 100, cpu: host.cpuPct, uptime: host.uptimeSec, hostCpu: null, hostMem: null, tags: [], to: `/${d}/summary` },
      { key: "zone", kind: "zone", name: `localnetwork (${d})`, status: "available", disk: null, mem: null, cpu: null, uptime: null, hostCpu: null, hostMem: null, tags: [], to: `/${d}/network` },
      ...data.host.storage.map((s): Row => ({ key: `st-${s.id}`, kind: "storage", name: `${s.id} (${d})`, status: "available", disk: (s.used / s.total) * 100, mem: null, cpu: null, uptime: null, hostCpu: null, hostMem: null, tags: [], to: `/${d}/storage` })),
      ...data.guests.map((g): Row => {
        const up = g.status === "running";
        return {
          key: `g-${g.vmid}`,
          kind: g.type,
          name: `${g.vmid} (${g.name})`,
          status: up ? "running" : "stopped",
          disk: up ? 31 : null,
          mem: up && g.memMax ? (g.memUsed / g.memMax) * 100 : null,
          cpu: up ? g.cpuPct : null,
          uptime: up ? Math.max(0, host.uptimeSec - 3600 - (g.vmid % 7) * 60) : null,
          hostCpu: up ? (g.cpuPct * g.cores) / host.cpus : null,
          hostMem: up ? (g.memUsed / host.memTotal) * 100 : null,
          tags: g.tags ?? [],
          to: g.org ? `/${d}/${g.org}/machines/${g.vmid}` : `/${d}/machines/${g.vmid}`,
        };
      }),
    ];
    const needle = q.trim().toLowerCase();
    const filtered = list.filter((r) => {
      if (kind === "machines" && r.kind !== "qemu" && r.kind !== "lxc") return false;
      if (kind === "node" && r.kind !== "node") return false;
      if (kind === "storage" && r.kind !== "storage") return false;
      return !needle || r.name.toLowerCase().includes(needle) || r.tags.some((t) => t.includes(needle)) || KIND[r.kind].toLowerCase().includes(needle);
    });
    return filtered.sort((a, b) => {
      const x = a[sort.key], y = b[sort.key];
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sort.dir;
    });
  }, [data, host, d, q, kind, sort]);

  const pct = (v: number | null) => (v === null ? <span className="text-ink-3">—</span> : `${v < 10 ? v.toFixed(1) : Math.round(v)}%`);

  return (
    <PageFrame width="6xl">
      <PageHeader title="Resources" subtitle={`Everything on ${d}: the node, its machines, storage and network zones.`} />
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="h-4 w-4 text-ink-3 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, type or tag" className="pl-10 h-10" aria-label="Search resources" />
        </div>
        <Segmented value={kind} onChange={setKind} options={[{ value: "all", label: "All" }, { value: "machines", label: "Machines" }, { value: "node", label: "Node" }, { value: "storage", label: "Storage" }]} />
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full text-[13px] min-w-[880px]">
          <thead>
            <tr className="border-b border-line text-ink-3 text-left">
              {COLS.map((c) => (
                <th key={c.key} className={cn("font-normal px-3 h-10 whitespace-nowrap", c.num && "text-right")} aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                  <button onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? (s.dir === 1 ? -1 : 1) : 1 }))} className="inline-flex items-center gap-1 hover:text-ink">
                    {c.label}
                    {sort.key === c.key && (sort.dir === 1 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                  </button>
                </th>
              ))}
              <th className="font-normal px-3">Tags</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} onClick={() => r.to && nav(r.to)} className={cn("border-b border-line last:border-0", r.to && "cursor-pointer hover:bg-surface-2/60")}>
                <td className="px-3 py-2.5 whitespace-nowrap"><span className="inline-flex items-center gap-2 text-ink-2"><span className="text-ink-3">{ICON[r.kind]}</span>{KIND[r.kind]}</span></td>
                <td className="px-3 py-2.5 whitespace-nowrap"><span className="inline-flex items-center gap-2">{r.name}{r.status === "stopped" ? <Status kind="off" label="Stopped" className="text-[12px]" /> : null}</span></td>
                <td className="px-3 text-right tabular-nums">{pct(r.disk)}</td>
                <td className="px-3 text-right tabular-nums">{pct(r.mem)}</td>
                <td className="px-3 text-right tabular-nums">{r.cpu === null ? <span className="text-ink-3">—</span> : `${pct(r.cpu)}${r.kind !== "node" ? "" : ` of ${host.cpus}`}`}</td>
                <td className="px-3 text-right tabular-nums whitespace-nowrap">{r.uptime === null ? <span className="text-ink-3">—</span> : formatUptime(r.uptime)}</td>
                <td className="px-3 text-right tabular-nums">{pct(r.hostCpu)}</td>
                <td className="px-3 text-right tabular-nums">{pct(r.hostMem)}</td>
                <td className="px-3 py-2"><span className="flex flex-wrap gap-1">{r.tags.map((t) => <Tag key={t} name={t} />)}</span></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9} className="px-3 py-8 text-center text-ink-3">Nothing matches.</td></tr>}
          </tbody>
        </table>
      </Card>
    </PageFrame>
  );
}
