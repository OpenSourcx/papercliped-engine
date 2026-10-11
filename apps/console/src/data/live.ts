import type { RrdPoint } from "@papercliped-engine/proxmox-client";
import type { LiveHost } from "./api.ts";
import type { Guest, HostMetrics, HostStorage, Org } from "./types.ts";

/** Maps the host service's live answers onto the console's data shapes. Pure, so it is easy to test. */

export function liveHostMetrics(h: LiveHost, prev: HostMetrics): HostMetrics {
  const s = h.status;
  return {
    ...prev,
    hostname: h.node,
    ip: typeof window === "undefined" ? prev.ip : window.location.hostname,
    version: h.version,
    cpuModel: s?.cpuinfo?.model ?? prev.cpuModel,
    cpus: s?.cpuinfo?.cpus ?? prev.cpus,
    cpuPct: s ? s.cpu * 100 : 0,
    memUsed: s?.memory.used ?? 0,
    memTotal: s?.memory.total ?? 0,
    diskUsed: s?.rootfs?.used ?? 0,
    diskTotal: s?.rootfs?.total ?? 0,
    uptimeSec: s?.uptime ?? 0,
  };
}

export function liveGuests(h: LiveHost, orgs: Org[], prev: Guest[]): Guest[] {
  const byPool = new Map(orgs.map((o) => [o.resourceGroup.pool, o.slug]));
  return h.resources
    .filter((r) => (r.type === "lxc" || r.type === "qemu") && typeof r.vmid === "number")
    .map((r): Guest => {
      const old = prev.find((g) => g.vmid === r.vmid);
      return {
        vmid: r.vmid!,
        name: r.name ?? `${r.type === "lxc" ? "CT" : "VM"} ${r.vmid}`,
        type: r.type as Guest["type"],
        status: r.status === "running" ? "running" : "stopped",
        cpuPct: (r.cpu ?? 0) * 100,
        cores: r.maxcpu ?? 0,
        memUsed: r.mem ?? 0,
        memMax: r.maxmem ?? 0,
        diskMax: r.maxdisk ?? 0,
        template: r.template === 1,
        diskUsed: r.type === "lxc" ? r.disk : undefined,
        uptimeSec: r.uptime,
        org: (r.pool && byPool.get(r.pool)) ?? null,
        protected: false,
        tags: r.tags ? r.tags.split(/[;,\s]+/).filter(Boolean) : [],
        tasks: old?.tasks ?? [],
        snapshots: old?.snapshots,
      };
    })
    .sort((a, b) => a.vmid - b.vmid);
}

/** Proxmox names the node's memory series memused/memtotal; the graphs read mem/maxmem for both. */
export const normalizeRrd = (points: RrdPoint[]): RrdPoint[] => points.map((p) => (p.mem === undefined && p.memused !== undefined ? { ...p, mem: p.memused, maxmem: p.memtotal } : p));

const CONTENT: Record<string, string> = { images: "Disk images", rootdir: "Containers", vztmpl: "Templates", iso: "ISO images", backup: "Backups", snippets: "Snippets", import: "Import" };

/** Every storage on the node (local disks, extra drives, network shares), named and labelled the way Proxmox's tree does. */
export function liveStorage(h: LiveHost): HostStorage[] {
  return (h.storage ?? [])
    .map((s) => ({
      id: s.storage,
      type: s.plugintype ?? "unknown",
      used: s.used,
      total: s.total,
      content: s.content.split(",").filter(Boolean).map((c) => CONTENT[c] ?? c).sort(),
      active: s.status === "available",
      shared: s.shared,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
