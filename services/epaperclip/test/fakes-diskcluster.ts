import { createHash } from "node:crypto";
import type { Transport } from "@papercliped-engine/proxmox-client";
import { fakeCluster } from "./fakes-cluster.ts";
import { fakeDisks } from "./fakes-disks.ts";
import { fakePve } from "./fakes.ts";

/**
 * The Proxmox for storage depth, backups, disk health, Ceph writes, remote migration, the quorum device and routed SDN.
 * It sits in front of the cluster fake (three nodes, HA, replication, Ceph reads) which sits in front of the disk fake
 * (disks, LVM, ZFS, storage definitions, two machines), and answers only the endpoints those do not have. sam@pve is an
 * administrator; lee@pve may read and change nothing (403 on writes). Every request that reaches it is logged.
 */

const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ status: 200, body: JSON.stringify({ data, ...extra }) });
const fail = (status: number, message: string) => ({ status, body: JSON.stringify({ message: `${message}\n` }) });
const deny = fail(403, "Permission check failed");
const sha = (s: string) => createHash("sha1").update(s).digest("hex");

export const PEER_TOKEN_SECRET = "11111111-2222-3333-4444-555555555555";

export interface W3Options {
  /** A Proxmox without fabrics, prefix lists and route maps (older than 9). */
  noFabrics?: boolean;
  /** Whether Ceph is installed (default true). */
  ceph?: boolean;
  /** Make remote migration fail with a message that repeats the request, secret included. */
  leakyRemoteMigrate?: boolean;
}

export interface W3Call {
  method: string;
  path: string;
  params: Record<string, string>;
  body: string;
  user: string;
}

export function fakeDiskCluster(opts: W3Options = {}) {
  const disks = fakeDisks(fakePve().transport);
  const cluster = fakeCluster({ ceph: opts.ceph !== false }, disks.transport);
  const calls: W3Call[] = [];
  let upid = 0;
  const task = (what: string) => `UPID:pve:${String(++upid).padStart(8, "0")}:00000001:00000001:${what}:x:sam@pve:`;

  // ---- Storage
  disks.storages.set("zfs-tank", { storage: "zfs-tank", type: "zfspool", pool: "tank", content: "images,rootdir" });
  const storageStatus: Record<string, Record<string, unknown>> = {
    local: { type: "dir", active: 1, shared: 0, total: 100e9, used: 60e9, avail: 40e9, content: "iso,vztmpl,backup" },
    nas: { type: "cifs", active: 1, shared: 1, total: 1e12, used: 970e9, avail: 30e9, content: "backup,iso" },
    "local-lvm": { type: "lvmthin", active: 1, shared: 0, total: 500e9, used: 100e9, avail: 400e9, content: "images,rootdir" },
    "zfs-tank": { type: "zfspool", active: 1, shared: 0, total: 4e12, used: 1e12, avail: 3e12, content: "images,rootdir" },
    pbs1: { type: "pbs", active: 1, shared: 1, total: 2e12, used: 5e11, avail: 15e11, content: "backup" },
  };
  const NOW = 1_760_000_000;
  const content: Record<string, Record<string, unknown>[]> = {
    local: [
      { volid: "local:iso/debian.iso", content: "iso", size: 600e6, ctime: NOW - 100 },
      { volid: "local:iso/alpine.iso", content: "iso", size: 100e6, ctime: NOW - 90 },
      { volid: "local:vztmpl/debian-12.tar.zst", content: "vztmpl", size: 120e6, ctime: NOW - 80 },
      { volid: "local:import/appliance.qcow2", content: "import", size: 2e9, ctime: NOW - 70, format: "qcow2" },
      { volid: "local:snippets/hook.sh", content: "snippets", size: 800, ctime: NOW - 60 },
      { volid: "local:backup/vzdump-qemu-200-2025_10_01-02_00_00.vma.zst", content: "backup", size: 4e9, ctime: NOW - 50, vmid: 200 },
      { volid: "local:backup/vzdump-qemu-200-2025_10_02-02_00_00.vma.zst", content: "backup", size: 4e9, ctime: NOW - 40, vmid: 200 },
      { volid: "local:backup/vzdump-qemu-200-2025_10_03-02_00_00.vma.zst", content: "backup", size: 4e9, ctime: NOW - 30, vmid: 200 },
      { volid: "local:backup/vzdump-lxc-201-2025_10_03-02_00_00.tar.zst", content: "backup", size: 1e9, ctime: NOW - 20, vmid: 201, protected: 1 },
    ],
    nas: [],
    "local-lvm": [{ volid: "local-lvm:vm-200-disk-0", content: "images", size: 32e9, vmid: 200 }, { volid: "local-lvm:vm-201-disk-0", content: "rootdir", size: 8e9, vmid: 201 }],
    "zfs-tank": [{ volid: "zfs-tank:vm-200-disk-1", content: "images", size: 10e9, vmid: 200, format: "raw" }, { volid: "zfs-tank:subvol-201-disk-0", content: "rootdir", size: 8e9, vmid: 201, format: "subvol" }],
    pbs1: [{ volid: "pbs1:backup/vm/200/2025-10-03T02:00:00Z", content: "backup", size: 3e9, ctime: NOW - 10, vmid: 200 }],
  };
  const pruneMarks = (storage: string, vmid?: string, keep?: string) => {
    const backups = (content[storage] ?? []).filter((i) => i.content === "backup" && (!vmid || String(i.vmid) === vmid));
    const keepLast = Number(/keep-last=(\d+)/.exec(keep ?? "")?.[1] ?? NaN);
    const sorted = [...backups].sort((a, b) => Number(b.ctime) - Number(a.ctime));
    return sorted.map((b, idx) => ({ volid: b.volid, vmid: b.vmid, type: String(b.volid).includes("lxc") ? "lxc" : "qemu", ctime: b.ctime, mark: b.protected ? "protected" : Number.isFinite(keepLast) && idx >= keepLast ? "remove" : "keep" }));
  };
  const pruned: string[] = [];

  // ---- Backup jobs
  const jobs = new Map<string, Record<string, unknown>>([
    ["backup-nightly", { id: "backup-nightly", type: "vzdump", schedule: "21:00", storage: "local", vmid: "200,201", mode: "snapshot", compress: "zstd", enabled: 1, "prune-backups": "keep-last=3", digest: sha("j1") }],
    ["backup-pool", { id: "backup-pool", type: "vzdump", schedule: "sat 02:00", storage: "nas", pool: "existing", mode: "stop", enabled: 1, fleecing: "enabled=1,storage=local-lvm", performance: "max-workers=4", "notes-template": "{{guestname}}", digest: sha("j2") }],
  ]);
  let jobVersion = 1;

  // ---- Machines the guests fakes do not know about
  const createdGuests: Record<string, string>[] = [];

  // ---- Ceph writes
  const ceph = { osds: [] as number[], destroyed: [] as number[], mons: ["pve", "pve2"], mgrs: ["pve"], mds: ["pve"], fs: [] as string[], pools: new Set(["vm-pool"]), services: [] as string[], inited: false, unsafe: new Set<string>() };

  // ---- SDN
  const sdn = {
    controllers: new Map<string, Record<string, unknown>>([["bgp1", { controller: "bgp1", type: "evpn", asn: 65000, peers: "10.0.0.2,10.0.0.3", digest: sha("c1") }]]),
    zones: new Map<string, Record<string, unknown>>([["evz", { zone: "evz", type: "evpn", controller: "bgp1", "vrf-vxlan": 4000, digest: sha("z1") }], ["simp", { zone: "simp", type: "simple", digest: sha("z2") }]]),
    vnets: [{ vnet: "v1", zone: "evz" }] as Record<string, unknown>[],
    fabrics: new Map<string, Record<string, unknown>>([["fab1", { id: "fab1", protocol: "openfabric", ip_prefix: "10.10.0.0/24", digest: sha("f1") }]]),
    fabricNodes: new Map<string, Record<string, unknown>>(),
    prefixLists: new Map<string, { id: string; entries: Record<string, unknown>[] }>([["pl1", { id: "pl1", entries: [{ seq: 10, action: "permit", prefix: "10.0.0.0/8", le: 24 }] }]]),
    routeMaps: new Map<string, Record<string, unknown>[]>([["rm1", [{ "route-map-id": "rm1", order: 10, action: "permit", match: ["key=vni,value=4000"] }]]]),
  };
  const bumpDigest = (o: Record<string, unknown>) => {
    o.digest = sha(JSON.stringify(o) + ++jobVersion);
  };

  const qdevice = { configured: false };
  const remote: { vmid: number; type: string; params: Record<string, string> }[] = [];

  const guestResources = () => [
    { id: "qemu/200", type: "qemu", vmid: 200, node: "pve", name: "vm-lab", status: "stopped" },
    { id: "lxc/201", type: "lxc", vmid: 201, node: "pve", name: "ct-web", status: "running" },
    { id: "qemu/202", type: "qemu", vmid: 202, node: "pve", name: "vm-other", status: "stopped" },
  ];

  const transport: Transport = async (req) => {
    const u = new URL(req.url);
    const path = u.pathname.replace("/api2/json", "");
    const m = req.method;
    const ticket = decodeURIComponent((req.headers.Cookie ?? "").replace("PVEAuthCookie=", ""));
    const user = ticket.split(":")[1] ?? "";
    if (!ticket || path === "/access/ticket") return cluster.transport(req);
    const f = new URLSearchParams(req.body ?? "");
    const p: Record<string, string> = Object.fromEntries([...u.searchParams, ...f]);
    const admin = user === "sam@pve";
    const log = () => calls.push({ method: m, path, params: p, body: req.body ?? "", user });

    const handled = (() => {
      // ---- Cluster-wide lists the other fakes lack the machines for
      if (path === "/cluster/resources" && m === "GET" && p.type === "vm") return "resources";
      if (path === "/cluster/nextid") return ok("300");
      if (path === "/pools" && m === "GET") return ok([{ poolid: "existing" }, { poolid: "web" }]);
      return null;
    })();
    if (handled === "resources") {
      const r = await cluster.transport(req);
      if (r.status !== 200) return r;
      const base = JSON.parse(r.body).data as Record<string, unknown>[];
      log();
      const have = new Set(base.map((g) => g.vmid));
      return ok([...base, ...guestResources().filter((g) => !have.has(g.vmid)), ...createdGuests.map((g) => ({ id: `${g.type}/${g.vmid}`, type: g.type, vmid: Number(g.vmid), node: "pve", name: g.name ?? `ct${g.vmid}`, status: "stopped" }))]);
    }
    if (handled) {
      log();
      return handled;
    }

    const isMine = /^\/(nodes\/[\w-]+\/(storage|query-url-metadata|vzdump|disks\/(smart|zfs)|ceph|qemu\/\d+\/(remote_migrate|config)|lxc\/\d+\/(remote_migrate|config)|qemu$|lxc$)|cluster\/(backup|backup-info|config\/qdevice|sdn))/.test(path);
    if (!isMine) return cluster.transport(req);
    log();
    if (m !== "GET" && !admin) return deny;

    // ---- Disks: richer SMART and a degraded pool
    if (path === "/nodes/pve/disks/smart") {
      const d = disks.disks.find((x) => x.devpath === p.disk);
      if (!d) return fail(500, "no such device");
      if (d.devpath === "/dev/sdb") return ok({ health: d.health, type: "ata", attributes: [{ id: 5, name: "Reallocated_Sector_Ct", raw: "12" }, { id: 197, name: "Current_Pending_Sector", raw: "0" }, { id: 9, name: "Power_On_Hours", raw: "20000" }, { id: 194, name: "Temperature_Celsius", raw: "38 (Min/Max 20/45)" }] });
      if (d.type === "nvme") return ok({ health: d.health, type: "text", text: "Temperature:                        45 Celsius\nAvailable Spare:                    8%\nPercentage Used:                    97%\nPower On Hours:                     12,345\n" });
      return ok({ health: d.health, type: "ata", attributes: [{ id: 5, name: "Reallocated_Sector_Ct", raw: "0" }, { id: 197, name: "Current_Pending_Sector", raw: "0" }, { id: 9, name: "Power_On_Hours", raw: "1000" }, { id: 194, name: "Temperature_Celsius", raw: "30" }] });
    }
    if (path === "/nodes/pve/disks/zfs" && m === "GET") return ok([...disks.zfs, { name: "rpool", size: 1e12, alloc: 9.2e11, free: 8e10, frag: 40, dedup: 1, health: "DEGRADED" }]);
    if (path === "/nodes/pve/disks/zfs/rpool") return ok({ name: "rpool", state: "DEGRADED", scan: "resilver in progress", errors: "No known data errors", children: [{ name: "rpool", state: "DEGRADED", children: [{ name: "mirror-0", state: "DEGRADED", children: [{ name: "nvme-A-part3", state: "ONLINE", leaf: 1 }, { name: "nvme-B-part3", state: "UNAVAIL", leaf: 1 }] }] }] });
    if (/^\/nodes\/pve\/disks\/zfs\/[^/]+$/.test(path) && m === "GET") return disks.transport(req);

    // ---- Storage
    if (path === "/nodes/pve/storage" && m === "GET") {
      const list = Object.entries(storageStatus).map(([storage, s]) => ({ storage, ...s }));
      return ok(list);
    }
    const sx = path.match(/^\/nodes\/pve\/storage\/([^/]+)\/(status|content|rrddata|prunebackups|import-metadata|download-url|file-restore\/list)$/);
    const sv = path.match(/^\/nodes\/pve\/storage\/([^/]+)\/content\/(.+)$/);
    if (sv) {
      const [, store] = sv;
      const vol = decodeURIComponent(sv[2]);
      const volid = vol.includes(":") ? vol : `${store}:${vol}`;
      if (m === "GET") {
        const it = (content[store] ?? []).find((i) => i.volid === volid);
        if (!it) return fail(500, `volume '${volid}' does not exist`);
        return ok({ path: `/var/lib/vz/${volid.split(":")[1]}`, format: it.format ?? "raw", size: it.size, used: it.size, notes: "", protected: it.protected ?? 0 });
      }
      if (m === "POST") {
        if (!p.target) return fail(400, "target: property is missing");
        (content[p.target.split(":")[0]] ??= []).push({ volid: p.target, content: "images", size: 1 });
        return ok(task("imgcopy"));
      }
      if (m === "PUT") return disks.transport(req);
    }
    if (sx) {
      const [, store, what] = sx;
      if (!storageStatus[store]) return fail(500, `storage '${store}' does not exist`);
      if (what === "status") return ok(storageStatus[store]);
      if (what === "content") {
        if (m === "GET") return ok((content[store] ?? []).filter((i) => !p.content || i.content === p.content));
        if (m === "POST") {
          if (!p.filename || !p.vmid || !p.size) return fail(400, "missing parameter");
          const volid = `${store}:${p.filename}`;
          (content[store] ??= []).push({ volid, content: "images", size: 1e9, vmid: Number(p.vmid) });
          return ok(volid);
        }
      }
      if (what === "rrddata") return ok([{ time: NOW - 3600, used: 5e10, total: 1e11 }, { time: NOW, used: 6e10, total: 1e11 }]);
      if (what === "prunebackups") {
        const marks = pruneMarks(store, p.vmid, p["prune-backups"] ?? (disks.storages.get(store)?.["prune-backups"] as string | undefined));
        if (m === "GET") return ok(marks);
        if (m === "DELETE") {
          for (const x of marks) if (x.mark === "remove") pruned.push(String(x.volid));
          content[store] = (content[store] ?? []).filter((i) => !pruned.includes(String(i.volid)));
          return ok(task("prunebackups"));
        }
      }
      if (what === "import-metadata") return ok({ type: "vm", source: "ova", "create-args": { cores: 2, memory: 2048 }, disks: { scsi0: "local:import/disk.vmdk" }, net: { net0: "virtio,bridge=vmbr0" }, warnings: [{ type: "guest-is-running" }] });
      if (what === "download-url") {
        if (p.checksum && p.checksum.length !== 64) return fail(400, "checksum: wrong length");
        (content[store] ??= []).push({ volid: `${store}:import/${p.filename}`, content: "import", size: 1 });
        return ok(task("download"));
      }
      if (what === "file-restore/list") {
        if (store !== "pbs1") return fail(500, "file restore is only supported for Proxmox Backup Server storages");
        const here = p.filepath === "/" ? "/" : Buffer.from(p.filepath, "base64").toString();
        if (here === "/") return ok([{ filepath: Buffer.from("/etc").toString("base64"), text: "etc", type: "d", leaf: 0 }, { filepath: Buffer.from("/hello.txt").toString("base64"), text: "hello.txt", type: "f", leaf: 1, size: 12, mtime: NOW }]);
        return ok([]);
      }
    }
    if (path === "/nodes/pve/query-url-metadata") return p.url?.includes("bad") ? fail(500, "unable to query url") : ok({ filename: "debian-13.iso", size: 700e6, mimetype: "application/x-iso9660-image" });
    if (path === "/nodes/pve/vzdump/extractconfig") return ok(`#test backup\nname: vm-lab\ncores: 2\ncipassword: $5$secret$hash\nscsi0: local-lvm:vm-200-disk-0,size=32G\n`);

    // ---- Backup jobs
    if (path === "/cluster/backup" && m === "GET") return ok([...jobs.values()]);
    if (path === "/cluster/backup" && m === "POST") {
      const id = p.id ?? `backup-${jobs.size + 7}`;
      if (jobs.has(id)) return fail(400, `job '${id}' exists`);
      const row: Record<string, unknown> = { ...p, id, type: "vzdump", digest: sha(id) };
      if (f.getAll("exclude-path").length) row["exclude-path"] = f.getAll("exclude-path");
      jobs.set(id, row);
      return ok(null);
    }
    const jb = path.match(/^\/cluster\/backup\/([\w-]+)(\/included_volumes)?$/);
    if (jb) {
      const j = jobs.get(jb[1]);
      if (!j) return fail(500, `no such job '${jb[1]}'`);
      if (jb[2]) return ok({ children: [{ id: 200, name: "vm-lab", type: "qemu", children: [{ id: "scsi0", name: "scsi0", included: 1 }, { id: "scsi1", name: "scsi1", included: 0, reason: "backup=0" }] }] });
      if (m === "PUT") {
        if (p.digest !== j.digest) return fail(400, "detected modified configuration - file changed by other user! Try again.");
        const { digest: _d, delete: del, ...rest } = p;
        for (const k of (del ?? "").split(",").filter(Boolean)) delete j[k];
        Object.assign(j, rest);
        j.digest = sha(JSON.stringify(j) + jobVersion++);
        return ok(null);
      }
      if (m === "DELETE") return jobs.delete(jb[1]), ok(null);
      if (m === "GET") return ok(j);
    }
    if (path === "/cluster/backup-info/not-backed-up") return ok([{ vmid: 202, name: "vm-other", type: "qemu" }, { vmid: 101, name: "web", type: "lxc" }]);

    // ---- Restore (a machine being created from an archive)
    if ((path === "/nodes/pve/qemu" || path === "/nodes/pve/lxc") && m === "POST") {
      createdGuests.push({ ...p, type: path.endsWith("lxc") ? "lxc" : "qemu" });
      return ok(task("qmrestore"));
    }

    // ---- Remote migration
    const rm = path.match(/^\/nodes\/pve\/(qemu|lxc)\/(\d+)\/remote_migrate$/);
    if (rm) {
      remote.push({ vmid: Number(rm[2]), type: rm[1], params: p });
      if (opts.leakyRemoteMigrate) return fail(500, `could not connect using ${p["target-endpoint"]}`);
      return ok(task("qmigrate"));
    }

    const other = path.match(/^\/nodes\/pve2\/(qemu|lxc)\/(\d+)\/config$/);
    if (other && m === "GET") return ok(other[1] === "qemu" ? { name: "app", net0: "virtio=AA:BB:CC:00:00:01,bridge=vmbr1", scsi0: "ceph:vm-103-disk-0,size=8G", digest: sha("103") } : { hostname: "cache", rootfs: "local-lvm:subvol-104-disk-0,size=4G", digest: sha("104") });

    // ---- Quorum device
    if (path === "/cluster/config/qdevice") return ok(qdevice.configured ? { Quorate: "Yes", "Qdevice": "A,V,NMW" } : {});

    // ---- Ceph writes
    const cp = path.match(/^\/nodes\/pve\/ceph(?:\/(.*))?$/);
    if (cp) {
      const rest = cp[1] ?? "";
      if (rest === "osd" && m === "GET") {
        const r = await cluster.transport(req);
        if (r.status !== 200) return r;
        const body = JSON.parse(r.body).data as { root: { children: { name: string; children: Record<string, unknown>[] }[] } };
        const host = body.root.children[0];
        for (const id of ceph.osds) if (!ceph.destroyed.includes(id)) host.children.push({ id, name: `osd.${id}`, type: "osd", status: id === 3 ? "down" : "up", in: id === 3 ? 0 : 1, host: "pve", device_class: "ssd", bytes_used: 0, total_space: 1e11, pgs: 0 });
        return ok(body);
      }
      if (rest === "osd" && m === "POST") {
        if (!p.dev) return fail(400, "dev: property is missing");
        ceph.osds.push(3);
        return ok(task("cephcreateosd"));
      }
      const od = rest.match(/^osd\/(\d+)$/);
      if (od && m === "DELETE") {
        ceph.destroyed.push(Number(od[1]));
        return ok(task("cephdestroyosd"));
      }
      if (rest === "releases") return ok([{ release: "squid", version: "19.2", installable: 1 }, { release: "reef", version: "18.2", installable: 1 }]);
      if (rest === "init" && m === "POST") {
        ceph.inited = true;
        return ok(null);
      }
      if (rest === "mds" && m === "GET") return ok(ceph.mds.map((name) => ({ name, host: "pve", state: "up:active", addr: "10.0.0.2" })));
      const dm = rest.match(/^(mon|mgr|mds)\/([\w.-]+)$/);
      if (dm && m === "POST") return (ceph[dm[1] === "mon" ? "mons" : dm[1] === "mgr" ? "mgrs" : "mds"] as string[]).push(dm[2]), ok(task(`ceph${dm[1]}create`));
      if (dm && m === "DELETE") return ok(task(`ceph${dm[1]}destroy`));
      const fs = rest.match(/^fs\/([\w.-]+)$/);
      if (fs && m === "POST") return ceph.fs.push(fs[1]), ok(task("cephfscreate"));
      if (fs && m === "DELETE") return ceph.fs = ceph.fs.filter((x) => x !== fs[1]), ok(task("cephfsdestroy"));
      const pl = rest.match(/^pool\/([\w.-]+)(?:\/(status))?$/);
      if (pl && pl[2]) return ok({ name: pl[1], bytes_used: pl[1] === "vm-pool" ? 3e9 : 0 });
      if (pl && m === "DELETE") return ceph.pools.delete(pl[1]), ok(task("cephdestroypool"));
      const sv2 = rest.match(/^(start|stop|restart)$/);
      if (sv2 && m === "POST") return ceph.services.push(`${sv2[1]} ${p.service}`), ok(task(`ceph${sv2[1]}`));
      if (rest === "crush") return ok("# begin crush map\ntunable choose_local_tries 0\ndevice 0 osd.0 class ssd\ndevice 1 osd.1 class ssd\nhost pve {\n\tid -2\n}\nroot default {\n\tid -1\n}\nrule replicated_rule {\n\tid 0\n\ttype replicated\n\tstep take default\n\tstep chooseleaf firstn 0 type host\n\tstep emit\n}\n# end crush map\n");
      if (rest === "cmd-safety") return ok(ceph.unsafe.has(`${p.service}.${p.id}`) ? { safe: 0, status: "Removing it would leave placement groups without a copy" } : { safe: 1, status: "OK" });
      return cluster.transport(req);
    }

    // ---- SDN (routed parts)
    const noFab = opts.noFabrics === true;
    if (path.startsWith("/cluster/sdn/")) {
      if (noFab && /^\/cluster\/sdn\/(fabrics|prefix-lists|route-maps)/.test(path)) return fail(501, `Method '${m} ${path}' not implemented`);
      const crud = (map: Map<string, Record<string, unknown>>, idKey: string, id: string | undefined, filterType?: string) => {
        if (!id) {
          if (m === "GET") return ok([...map.values()].filter((x) => !filterType || x.type === filterType));
          if (m === "POST") {
            const key = p[idKey];
            if (map.has(key)) return fail(400, `${idKey} '${key}' already exists`);
            const row: Record<string, unknown> = { ...p };
            if (f.getAll("redistribute").length) row.redistribute = f.getAll("redistribute");
            if (f.getAll("interfaces").length) row.interfaces = f.getAll("interfaces");
            bumpDigest(row);
            map.set(key, row);
            return ok(null);
          }
        } else {
          const row = map.get(id);
          if (!row) return fail(500, `${idKey} '${id}' does not exist`);
          if (m === "GET") return ok(row);
          if (m === "PUT") {
            if (p.digest && p.digest !== row.digest) return fail(400, "detected modified configuration - file changed by other user! Try again.");
            const { digest: _d, delete: del, ...rest } = p;
            for (const k of (del ?? "").split(",").filter(Boolean)) delete row[k];
            for (const k of f.getAll("delete")) delete row[k];
            Object.assign(row, rest);
            if (f.getAll("redistribute").length) row.redistribute = f.getAll("redistribute");
            bumpDigest(row);
            return ok(null);
          }
          if (m === "DELETE") return map.delete(id), ok(null);
        }
        return fail(501, "fake: not implemented");
      };
      let x = path.match(/^\/cluster\/sdn\/controllers(?:\/([\w-]+))?$/);
      if (x) return crud(sdn.controllers, "controller", x[1]);
      x = path.match(/^\/cluster\/sdn\/zones(?:\/([\w-]+))?$/);
      if (x) return crud(sdn.zones, "zone", x[1], p.type);
      if (path === "/cluster/sdn/vnets") return ok(sdn.vnets);
      x = path.match(/^\/cluster\/sdn\/fabrics\/fabric(?:\/([\w-]+))?$/);
      if (x) return crud(sdn.fabrics, "id", x[1]);
      if (path === "/cluster/sdn/fabrics/all") return ok({ fabrics: [...sdn.fabrics.values()], nodes: [...sdn.fabricNodes.values()] });
      x = path.match(/^\/cluster\/sdn\/fabrics\/node\/([\w-]+)(?:\/([\w-]+))?$/);
      if (x) {
        if (m === "POST") return sdn.fabricNodes.set(`${x[1]}/${p.node_id}`, { fabric_id: x[1], node_id: p.node_id, ip: p.ip, interfaces: f.getAll("interfaces") }), ok(null);
        if (m === "DELETE") return sdn.fabricNodes.delete(`${x[1]}/${x[2]}`), ok(null);
        if (m === "PUT") return sdn.fabricNodes.set(`${x[1]}/${x[2]}`, { fabric_id: x[1], node_id: x[2], ip: p.ip, interfaces: f.getAll("interfaces") }), ok(null);
      }
      if (path === "/cluster/sdn/prefix-lists" && m === "GET") return ok([...sdn.prefixLists.values()].map((l) => ({ id: l.id, entries: l.entries })));
      if (path === "/cluster/sdn/prefix-lists" && m === "POST") return sdn.prefixLists.set(p.id, { id: p.id, entries: f.getAll("entries").map((e) => Object.fromEntries(e.split(",").map((kv) => kv.split("=")))) }), ok(null);
      x = path.match(/^\/cluster\/sdn\/prefix-lists\/([\w-]+)(?:\/entries(?:\/(\d+))?)?$/);
      if (x) {
        const l = sdn.prefixLists.get(x[1]);
        if (!l) return fail(500, "no such prefix list");
        if (path.endsWith("/entries") && m === "POST") return l.entries.push({ ...p, seq: Number(p.seq) }), ok(null);
        if (x[2] && m === "DELETE") return (l.entries = l.entries.filter((e) => e.seq !== Number(x![2]))), ok(null);
        if (!path.includes("/entries") && m === "DELETE") return sdn.prefixLists.delete(x[1]), ok(null);
      }
      if (path === "/cluster/sdn/route-maps" && m === "GET") return ok([...sdn.routeMaps.keys()].map((id) => ({ "route-map-id": id })));
      if (path === "/cluster/sdn/route-maps/entries" && m === "GET") return ok([...sdn.routeMaps.values()].flat());
      if (path === "/cluster/sdn/route-maps/entries" && m === "POST") {
        const list = sdn.routeMaps.get(p["route-map-id"]) ?? [];
        list.push({ ...p, match: f.getAll("match"), set: f.getAll("set"), order: Number(p.order) });
        sdn.routeMaps.set(p["route-map-id"], list);
        return ok(null);
      }
      x = path.match(/^\/cluster\/sdn\/route-maps\/entries\/([\w-]+)(?:\/entry\/(\d+))?$/);
      if (x) {
        const list = sdn.routeMaps.get(x[1]);
        if (!list) return fail(500, "no such route map");
        if (!x[2] && m === "GET") return ok(list);
        if (x[2] && m === "PUT") return Object.assign(list.find((e) => e.order === Number(x![2])) ?? {}, p), ok(null);
        if (x[2] && m === "DELETE") {
          const left = list.filter((e) => e.order !== Number(x![2]));
          if (left.length) sdn.routeMaps.set(x[1], left);
          else sdn.routeMaps.delete(x[1]);
          return ok(null);
        }
      }
    }
    return cluster.transport(req);
  };

  return { transport, calls, disks, cluster, content, jobs, pruned, createdGuests, ceph, sdn, remote, qdevice, storageStatus };
}
