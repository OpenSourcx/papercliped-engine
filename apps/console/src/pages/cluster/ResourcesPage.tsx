import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LayoutGrid } from "lucide-react";
import { clusterMoreApi, type ResourceRow } from "../../data/engine/w3Api.ts";
import { formatBytes } from "../../lib/storage.ts";
import { BarMeter } from "../../ui/meters.tsx";
import { Card, Chip, Input, PageFrame, PageHeader, Segmented, Status } from "../../ui/primitives.tsx";
import { Async, LiveOnly } from "../node/common.tsx";

type Kind = "all" | "node" | "vm" | "storage";
const pct = (a: number | null, b: number | null) => (a !== null && b ? Math.min(100, (a / b) * 100) : 0);

function kindOf(r: ResourceRow): Kind | "other" {
  if (r.type === "node") return "node";
  if (r.type === "qemu" || r.type === "lxc") return "vm";
  if (r.type === "storage") return "storage";
  return "other";
}

export function ClusterResourcesPage() {
  const q = useQuery({ queryKey: ["cluster", "resources"], queryFn: () => clusterMoreApi.resources(), refetchInterval: 15_000, retry: 1 });
  const [kind, setKind] = useState<Kind>("all");
  const [needle, setNeedle] = useState("");
  const rows = useMemo(() => {
    const n = needle.trim().toLowerCase();
    return (q.data?.resources ?? [])
      .filter((r) => (kind === "all" ? kindOf(r) !== "other" : kindOf(r) === kind))
      .filter((r) => !n || [r.name, r.node, r.storage, r.vmid, r.pool, ...r.tags].some((v) => String(v ?? "").toLowerCase().includes(n)))
      .sort((a, b) => kindOf(a).localeCompare(kindOf(b)) || String(a.node).localeCompare(String(b.node)) || (a.vmid ?? 0) - (b.vmid ?? 0));
  }, [q.data, kind, needle]);
  return (
    <PageFrame width="6xl">
      <PageHeader title="Cluster resources" subtitle="Every node, machine and storage in the cluster, with what they use." eyebrow={<LayoutGrid className="h-4 w-4" />} />
      <LiveOnly>
        <Async q={q}>
          {(d) => (
            <div className="space-y-5">
              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <Card className="p-4"><div className="text-xs text-ink-3">Nodes</div><div className="text-heading font-semibold tabular-nums">{d.summary.nodes.online}<span className="text-ink-3 text-compact"> of {d.summary.nodes.total} online</span></div></Card>
                <Card className="p-4"><BarMeter label="Processors" pct={pct(d.summary.cpu.usedCores, d.summary.cpu.cores)} value={`${d.summary.cpu.usedCores.toFixed(1)} of ${d.summary.cpu.cores} cores`} /></Card>
                <Card className="p-4"><BarMeter label="Memory" pct={pct(d.summary.memory.used, d.summary.memory.total)} value={`${formatBytes(d.summary.memory.used)} of ${formatBytes(d.summary.memory.total)}`} /></Card>
                <Card className="p-4"><BarMeter label="Storage" pct={pct(d.summary.storage.used, d.summary.storage.total)} value={`${formatBytes(d.summary.storage.used)} of ${formatBytes(d.summary.storage.total)}`} /></Card>
              </div>
              <p className="text-compact text-ink-2">{d.summary.guests.vms.running} of {d.summary.guests.vms.total} virtual machines and {d.summary.guests.containers.running} of {d.summary.guests.containers.total} containers running{d.summary.guests.templates ? `, ${d.summary.guests.templates} templates` : ""}. Shared storage is counted once.</p>
              <div className="flex gap-3 flex-wrap items-center">
                <Segmented<Kind> value={kind} onChange={setKind} label="Show" options={[{ value: "all", label: "All" }, { value: "node", label: "Nodes" }, { value: "vm", label: "Machines" }, { value: "storage", label: "Storage" }]} />
                <Input aria-label="Filter" placeholder="Filter by name, node, pool or tag" value={needle} onChange={(e) => setNeedle(e.target.value)} className="max-w-xs" />
              </div>
              <Card className="overflow-x-auto"><table className="w-full text-compact min-w-[760px]">
                <thead><tr className="border-b border-line text-ink-3 text-left"><th className="font-normal px-4 h-10">Name</th><th className="font-normal px-3">Kind</th><th className="font-normal px-3">Node</th><th className="font-normal px-3">Status</th><th className="font-normal px-3">CPU</th><th className="font-normal px-3">Memory</th><th className="font-normal px-3">Disk</th></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.id + (r.node ?? "")} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5"><span className="font-mono">{r.storage ?? r.name ?? r.node}</span>{r.vmid ? <span className="text-ink-3 text-xs ml-2">{r.vmid}</span> : null}{r.pool && <Chip className="ml-2">{r.pool}</Chip>}</td>
                    <td className="px-3">{r.type === "lxc" ? "Container" : r.type === "qemu" ? (r.template ? "Template" : "VM") : r.type === "node" ? "Node" : "Storage"}</td>
                    <td className="px-3 font-mono">{r.shared ? "shared" : r.node}</td>
                    <td className="px-3"><Status kind={r.status === "running" || r.status === "online" || r.status === "available" ? "good" : r.status === "stopped" || r.status === "offline" ? "off" : "idle"} label={r.status ?? "–"} /></td>
                    <td className="px-3 tabular-nums">{r.cpu !== null && r.maxcpu ? `${Math.round(r.cpu * 100)}% of ${r.maxcpu}` : "–"}</td>
                    <td className="px-3 tabular-nums">{r.maxmem ? `${formatBytes(r.mem ?? 0)} / ${formatBytes(r.maxmem)}` : "–"}</td>
                    <td className="px-3 tabular-nums">{r.maxdisk ? `${formatBytes(r.disk ?? 0)} / ${formatBytes(r.maxdisk)}` : "–"}</td>
                  </tr>
                ))}</tbody>
              </table>{rows.length === 0 && <p className="px-4 py-3 text-compact text-ink-3">Nothing matches.</p>}</Card>
            </div>
          )}
        </Async>
      </LiveOnly>
    </PageFrame>
  );
}
