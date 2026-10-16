import type { Transport } from "@papercliped-engine/proxmox-client";
import { createHash } from "node:crypto";
import { fakeNodePve } from "./fakes-node.ts";

/** Proxmox digests are SHA-1 hex. */
export const dg = (s: string) => createHash("sha1").update(s).digest("hex");

/**
 * A Proxmox for the hardware, backup, SDN and resource-mapping screens. It answers those endpoints first and passes
 * everything else to the node fake (sign-in, nodes, tasks, options…). sam@pve administers; lee@pve gets 403 on writes.
 */

const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ status: 200, body: JSON.stringify({ data, ...extra }) });
const fail = (status: number, message: string) => ({ status, body: JSON.stringify({ message: `${message}\n` }) });
const deny = { status: 403, body: JSON.stringify({ message: "Permission check failed\n" }) };

export function fakeDcPve() {
  const base = fakeNodePve();
  const calls: { method: string; path: string; body: string; user: string }[] = [];
  const st = {
    jobs: new Map<string, Record<string, unknown>>([["daily", { id: "daily", type: "vzdump", schedule: "02:00", storage: "pbs", all: 1, mode: "snapshot", compress: "zstd", enabled: 1, "next-run": 1_800_000_000, digest: dg("j1"), "prune-backups": "keep-last=3" }]]),
    backups: [
      { volid: "pbs:backup/vm/100/2026-01-02T01:00:00Z", vmid: 100, subtype: "qemu", format: "pbs-vm", size: 5e9, ctime: 1_790_000_000, notes: "before upgrade", protected: 0, verification: { state: "ok" } },
      { volid: "local:backup/vzdump-lxc-101-2026_01_01-02_00_00.tar.zst", vmid: 101, subtype: "lxc", format: "tar.zst", size: 1e9, ctime: 1_780_000_000, protected: 1 },
    ] as Record<string, unknown>[],
    uncovered: [{ vmid: 102, name: "db", type: "qemu" }] as Record<string, unknown>[],
    restores: [] as { path: string; body: string }[],
    zones: new Map<string, Record<string, unknown>>([["lab", { zone: "lab", type: "vlan", bridge: "vmbr0", ipam: "pve", state: "new", digest: dg("z1") }]]),
    vnets: new Map<string, Record<string, unknown>>([["web", { vnet: "web", zone: "lab", tag: 100, digest: dg("v1") }]]),
    subnets: new Map<string, Record<string, unknown>[]>([["web", [{ subnet: "lab-10.0.0.0-24", cidr: "10.0.0.0/24", gateway: "10.0.0.1", snat: 1, "dhcp-range": ["start-address=10.0.0.10,end-address=10.0.0.50"], type: "subnet" }]]]),
    ipams: new Map<string, Record<string, unknown>>([["pve", { ipam: "pve", type: "pve" }], ["nb", { ipam: "nb", type: "netbox", url: "https://nb.lan", token: "NETBOXSECRETTOKEN" }]]),
    dns: new Map<string, Record<string, unknown>>(),
    controllers: new Map<string, Record<string, unknown>>(),
    fwOptions: { enable: 0, policy_forward: "ACCEPT", digest: dg("f1") } as Record<string, unknown>,
    sdnApplied: 0,
    sdnRolledBack: 0,
    mappings: { pci: new Map<string, Record<string, unknown>>([["gpu0", { id: "gpu0", description: "GPU", map: ["node=pve,path=0000:01:00,id=10de:2204,iommugroup=14"], mdev: 0, digest: dg("m1") }]]), usb: new Map<string, Record<string, unknown>>(), dir: new Map<string, Record<string, unknown>>() },
    bulk: [] as { action: string; body: string }[],
  };
  const task = (user: string, type: string) => base.task("pve", type, user, { end: 1_700_000_900, status: "OK" });

  const transport: Transport = async (req) => {
    const u = new URL(req.url);
    const path = u.pathname.replace("/api2/json", "");
    const ticket = decodeURIComponent((req.headers.Cookie ?? "").replace("PVEAuthCookie=", ""));
    const user = ticket.split(":")[1] ?? "";
    const known = path !== "/access/ticket" && !!ticket;
    const admin = user === "sam@pve";
    const m = req.method;
    const f = new URLSearchParams(req.body ?? "");
    const q = u.searchParams;
    const mine = known && (/^\/(nodes\/pve\/(hardware|report|startall|stopall|suspendall|migrateall|vzdump|sdn|qemu$|lxc$|storage)|cluster\/(backup|sdn|mapping|metrics\/export|jobs|resources$)|pools|storage$)/.test(path) || (path === "/nodes/pve/status" && m === "GET"));
    if (!mine) return base.transport(req);
    calls.push({ method: m, path, body: req.body ?? "", user });
    if (m !== "GET" && !admin) return deny;
    const record = (store: Map<string, Record<string, unknown>>, key: string, id: string, extra: Record<string, unknown> = {}) => {
      const cur = store.get(id) ?? {};
      const next: Record<string, unknown> = { ...cur, [key]: id, ...extra };
      for (const [k, v] of f.entries()) if (!["delete", "digest", key].includes(k)) next[k] = f.getAll(k).length > 1 ? f.getAll(k) : v;
      for (const k of (f.get("delete") ?? "").split(",").filter(Boolean)) delete next[k];
      store.set(id, next);
    };

    // Node hardware
    if (path === "/nodes/pve/status") return ok({ cpu: 0.2, wait: 0.01, loadavg: ["0.1", "0.2", "0.3"], uptime: 100, memory: { total: 16e9, used: 4e9, free: 12e9, available: 11e9 }, swap: { total: 1e9, used: 0, free: 1e9 }, rootfs: { total: 100e9, used: 20e9, avail: 80e9 }, ksm: { shared: 0 }, cpuinfo: { model: "AMD EPYC 7302", sockets: 1, cores: 16, cpus: 32, mhz: "3000.0", flags: "fpu vme sse4_2", hvm: 1 }, "boot-info": { mode: "efi", secureboot: 0 }, kversion: "Linux 6.8.12-3-pve", "current-kernel": { release: "6.8.12-3-pve", machine: "x86_64" }, pveversion: "pve-manager/9.0.3" });
    if (path === "/nodes/pve/hardware/pci") return admin ? ok([{ id: "0000:01:00.0", class: "0x030000", vendor: "0x10de", vendor_name: "NVIDIA", device: "0x2204", device_name: "GA102", iommugroup: 14, mdev: 1 }, { id: "0000:00:1f.3", class: "0x040300", vendor: "0x8086", device: "0xa0c8", iommugroup: -1 }]) : deny;
    if (path === "/nodes/pve/hardware/usb") return ok([{ busnum: 1, devnum: 2, port: 1, level: 1, vendid: "0781", prodid: "5583", manufacturer: "SanDisk", product: "Ultra Fit", speed: "5000", usbpath: "1-1", class: 0 }]);
    const md = path.match(/^\/nodes\/pve\/hardware\/pci\/([\w:.%-]+)\/mdev$/);
    if (md) return ok([{ type: "nvidia-256", available: 2, description: "num_heads=4", name: "GRID P40-1B" }]);
    if (path === "/nodes/pve/report") return ok("==== general system info ====\npve 9.0\n");
    if (path === "/nodes/pve/sdn/zones") return ok([{ zone: "lab", status: "available" }]);
    if (path === "/nodes/pve/sdn/zones/lab/content") return ok([{ vnet: "web", status: "pending", statusmsg: "needs apply" }]);
    if (path === "/nodes/pve/sdn/vnets/web/mac-vrf") return ok([{ ip: "10.0.0.5", mac: "BC:24:11:00:00:01", nexthop: "pve" }]);
    if (path === "/cluster/metrics/export") return ok({ data: [{ id: "nodes/pve", metric: "cpu", timestamp: 1_700_000_000, type: "gauge", value: 0.2 }] });
    if (path === "/cluster/jobs/schedule-analyze") return q.get("schedule") === "bogus" ? fail(400, "invalid schedule") : ok([{ timestamp: 1_800_000_000 }, { timestamp: 1_800_086_400 }].slice(0, Number(q.get("iterations") ?? 10)));
    if (path === "/cluster/resources" && !q.get("type")) return ok([
      { id: "node/pve", type: "node", node: "pve", status: "online", cpu: 0.25, maxcpu: 4, mem: 2e9, maxmem: 8e9, uptime: 5000 },
      { id: "qemu/100", type: "qemu", vmid: 100, node: "pve", name: "web", status: "running", pool: "prod", tags: "prod;web", cpu: 0.1, maxcpu: 2, mem: 1e9, maxmem: 2e9 },
      { id: "lxc/101", type: "lxc", vmid: 101, node: "pve", name: "ct", status: "stopped", tags: "lab" },
      { id: "qemu/9000", type: "qemu", vmid: 9000, node: "pve", name: "tpl", status: "stopped", template: 1 },
      { id: "storage/pve/local", type: "storage", storage: "local", node: "pve", status: "available", disk: 10e9, maxdisk: 100e9 },
      { id: "storage/pve/nfs", type: "storage", storage: "nfs", node: "pve", status: "available", shared: 1, disk: 20e9, maxdisk: 200e9 },
    ]);
    if (path === "/pools") return ok([{ poolid: "prod", comment: "production" }]);
    if (path === "/storage") return ok([{ storage: "pbs", content: "backup" }, { storage: "local", content: "iso,backup" }, { storage: "scratch", content: "images" }]);
    const bulk = path.match(/^\/nodes\/pve\/(startall|stopall|suspendall|migrateall)$/);
    if (bulk) return st.bulk.push({ action: bulk[1], body: req.body ?? "" }), ok(task(user, bulk[1]));

    // Backup
    if (path === "/cluster/backup" && m === "GET") return admin ? ok([...st.jobs.values()]) : deny;
    if (path === "/cluster/backup" && m === "POST") {
      const id = f.get("id") ?? `backup-${st.jobs.size + 1}`;
      record(st.jobs, "id", id, { type: "vzdump", digest: dg("j2") });
      return ok(null);
    }
    if (path === "/cluster/backup-info/not-backed-up") return admin ? ok(st.uncovered) : deny;
    const inc = path.match(/^\/cluster\/backup\/([\w-]+)\/included_volumes$/);
    if (inc) return ok({ children: [{ id: 100, name: "web", type: "qemu", children: [{ id: "vm-100-disk-0", name: "scsi0", included: 1 }, { id: "vm-100-disk-1", name: "scsi1", included: 0, reason: "backup=0" }] }] });
    const jb = path.match(/^\/cluster\/backup\/([\w-]+)$/);
    if (jb) {
      if (!st.jobs.has(jb[1])) return fail(500, "no such job");
      if (m === "GET") return ok(st.jobs.get(jb[1]));
      if (m === "DELETE") return st.jobs.delete(jb[1]), ok(null);
      if (f.get("digest") && f.get("digest") !== st.jobs.get(jb[1])!.digest) return fail(500, "digest mismatch");
      record(st.jobs, "id", jb[1]);
      return ok(null);
    }
    const ct = path.match(/^\/nodes\/pve\/storage\/([\w.-]+)\/content$/);
    if (ct) return ok(st.backups.filter((b) => String(b.volid).startsWith(`${ct[1]}:`) && (!q.get("vmid") || String(b.vmid) === q.get("vmid"))));
    const cv = path.match(/^\/nodes\/pve\/storage\/([\w.-]+)\/content\/(.+)$/);
    if (cv) {
      const volid = decodeURIComponent(cv[2]);
      const b = st.backups.find((x) => x.volid === volid);
      if (!b) return fail(500, "volume does not exist");
      if (m === "PUT") {
        if (f.has("notes")) b.notes = f.get("notes");
        if (f.has("protected")) b.protected = f.get("protected") === "1" ? 1 : 0;
        return ok(null);
      }
      if (m === "DELETE") {
        if (b.protected === 1) return fail(500, "cannot remove protected volume");
        st.backups = st.backups.filter((x) => x !== b);
        return ok(task(user, "imgdel"));
      }
    }
    if (path === "/nodes/pve/vzdump/extractconfig") return ok("boot: order=scsi0\ncores: 2\nname: web\n");
    const pr = path.match(/^\/nodes\/pve\/storage\/([\w.-]+)\/prunebackups$/);
    if (pr) {
      if (m === "GET") return ok([{ volid: "pbs:backup/vm/100/2026-01-02T01:00:00Z", vmid: 100, type: "qemu", ctime: 1_790_000_000, mark: "remove" }]);
      return ok(task(user, "prunebackups"));
    }
    const fr = path.match(/^\/nodes\/pve\/storage\/([\w.-]+)\/file-restore\/list$/);
    if (fr) {
      const p = Buffer.from(q.get("filepath") ?? "", "base64").toString();
      return ok(p === "/" ? [{ filepath: Buffer.from("/etc").toString("base64"), text: "etc", type: "d", leaf: 0 }, { filepath: Buffer.from("/hosts").toString("base64"), text: "hosts", type: "f", size: 120, mtime: 1_700_000_000, leaf: 1 }] : []);
    }
    if ((path === "/nodes/pve/qemu" || path === "/nodes/pve/lxc") && m === "POST") return st.restores.push({ path, body: req.body ?? "" }), ok(task(user, "qmrestore"));

    // SDN
    const coll = (name: "zones" | "ipams" | "dns" | "controllers", key: string, pathBase: string) => {
      if (path === pathBase) {
        if (m === "GET") return ok([...st[name].values()]);
        record(st[name], key, f.get(key)!);
        return ok(null);
      }
      const one = path.match(new RegExp(`^${pathBase}/([\\w-]+)$`));
      if (one) {
        if (!st[name].has(one[1])) return fail(500, "no such object");
        if (m === "GET") return ok(st[name].get(one[1]));
        if (m === "DELETE") return st[name].delete(one[1]), ok(null);
        record(st[name], key, one[1]);
        return ok(null);
      }
      return null;
    };
    for (const r of [coll("zones", "zone", "/cluster/sdn/zones"), coll("ipams", "ipam", "/cluster/sdn/ipams"), coll("dns", "dns", "/cluster/sdn/dns"), coll("controllers", "controller", "/cluster/sdn/controllers")]) if (r) return r;
    if (path === "/cluster/sdn/vnets") {
      if (m === "GET") return ok([...st.vnets.values()]);
      record(st.vnets, "vnet", f.get("vnet")!);
      return ok(null);
    }
    const vn = path.match(/^\/cluster\/sdn\/vnets\/([\w-]+)$/);
    if (vn) return m === "DELETE" ? (st.vnets.delete(vn[1]), ok(null)) : (record(st.vnets, "vnet", vn[1]), ok(null));
    const sn = path.match(/^\/cluster\/sdn\/vnets\/([\w-]+)\/subnets(?:\/([\w.:-]+))?$/);
    if (sn) {
      const list = st.subnets.get(sn[1]) ?? [];
      if (m === "GET") return ok(list);
      if (m === "POST") return st.subnets.set(sn[1], [...list, { subnet: `lab-${f.get("subnet")!.replace("/", "-")}`, cidr: f.get("subnet"), gateway: f.get("gateway") }]), ok(null);
      if (m === "DELETE") return st.subnets.set(sn[1], list.filter((s) => s.subnet !== sn[2])), ok(null);
      return ok(null);
    }
    if (path === "/cluster/sdn" && m === "PUT") return st.sdnApplied++, ok(task(user, "reloadnetworkall"));
    if (path === "/cluster/sdn/rollback") return st.sdnRolledBack++, ok(null);
    if (path === "/cluster/sdn/dry-run") return ok("+ vnet web\n+ zone lab\n");
    if (path === "/cluster/sdn/ipams/pve/status") return ok([{ ip: "10.0.0.5", vnet: "web", zone: "lab", mac: "BC:24:11:00:00:01", hostname: "ct", vmid: 101 }]);
    const ips = path.match(/^\/cluster\/sdn\/vnets\/([\w-]+)\/ips$/);
    if (ips) return (st as any).ipCalls = [...((st as any).ipCalls ?? []), { m, body: req.body }], ok(null);
    if (path === "/cluster/sdn/vnets/web/firewall/options") {
      if (m === "GET") return ok(st.fwOptions);
      for (const [k, v] of f.entries()) if (k !== "digest" && k !== "delete") st.fwOptions[k] = v;
      return ok(null);
    }
    if (path === "/cluster/sdn/vnets/web/firewall/rules") return ok([{ pos: 0, type: "forward", action: "DROP", enable: 1, source: "10.0.0.0/24", comment: "no lateral" }]);

    // Mappings
    const mp = path.match(/^\/cluster\/mapping\/(pci|usb|dir)(?:\/([\w-]+))?$/);
    if (mp) {
      const store = st.mappings[mp[1] as "pci"];
      if (!mp[2]) {
        if (m === "GET") return admin || true ? ok([...store.values()].map((x) => ({ ...x, checks: x.id === "gpu0" ? [{ severity: "warning", message: "IOMMU group shared" }] : [] }))) : deny;
        record(store, "id", f.get("id")!, { map: f.getAll("map") });
        return ok(null);
      }
      if (!store.has(mp[2])) return fail(500, "no such mapping");
      if (m === "DELETE") return store.delete(mp[2]), ok(null);
      if (f.get("digest") && f.get("digest") !== store.get(mp[2])!.digest) return fail(500, "digest mismatch");
      record(store, "id", mp[2], { map: f.getAll("map").length ? f.getAll("map") : store.get(mp[2])!.map });
      return ok(null);
    }
    return base.transport(req);
  };

  return { ...base, transport, calls, dc: st };
}
