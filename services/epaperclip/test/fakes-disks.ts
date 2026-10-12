import { createHash } from "node:crypto";
import type { Transport } from "@papercliped-engine/proxmox-client";

/**
 * A Proxmox for the disk work, layered over the shared fake (which keeps sign-in, tickets and permissions): physical
 * disks, LVM / LVM-Thin / ZFS / directory storage on them, storage definitions with digests, scan results, and two
 * machines (VM 200, container 201) whose configuration changes like the real thing: unused disks, pending changes,
 * digests that refuse stale writes, and tasks. Every request is logged so tests can assert on what reached Proxmox.
 */
export interface DiskCall {
  method: string;
  path: string;
  params: Record<string, string>;
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex");
const ok = (data: unknown) => ({ status: 200, body: JSON.stringify({ data }) });
const fail = (status: number, message: string) => ({ status, body: JSON.stringify({ message: `${message}\n` }) });

export function fakeDisks(base: Transport) {
  const calls: DiskCall[] = [];
  const secretsSeen: string[] = [];
  let upid = 0;
  const task = (what: string) => `UPID:pve:${String(++upid).padStart(8, "0")}:00000001:00000001:${what}:x:sam@pve:`;

  const disks = [
    { devpath: "/dev/sda", size: 128e9, type: "ssd", model: "Boot SSD", serial: "BOOT123", vendor: "ACME", used: "partitions", gpt: true, mounted: false, health: "PASSED", wearout: 91, wwn: "0x1" },
    { devpath: "/dev/sda1", parent: "/dev/sda", size: 1e9, used: "EFI", gpt: true, mounted: true },
    { devpath: "/dev/sdb", size: 4e12, type: "hdd", model: "Data HDD", serial: "DATA1", vendor: "ACME", used: "unused", gpt: false, mounted: false, health: "PASSED", wearout: "N/A", rpm: 7200 },
    { devpath: "/dev/sdc", size: 4e12, type: "hdd", model: "Data HDD", serial: "DATA2", vendor: "ACME", used: "unused", gpt: false, mounted: false, health: "PASSED", wearout: "N/A", rpm: 7200 },
    { devpath: "/dev/sdd", size: 2e12, type: "hdd", model: "Old HDD", serial: "OLD1", vendor: "ACME", used: "LVM", gpt: true, mounted: false, health: "FAILED", wearout: "N/A", rpm: 5400 },
    { devpath: "/dev/nvme0n1", size: 1e12, type: "nvme", model: "Fast NVMe", serial: "NV1", vendor: "ACME", used: "unused", gpt: true, mounted: false, health: "PASSED", wearout: 3 },
  ] as Record<string, unknown>[];

  const lvm = [{ name: "vg0", size: 2e12, free: 1e12, leaf: false, children: [{ name: "/dev/sdd", size: 2e12, free: 1e12, leaf: true }] }];
  const lvmthin = [{ lv: "data", vg: "vg0", lv_size: 1e12, used: 1e11, metadata_size: 1e9, metadata_used: 1e7 }];
  const zfs: Record<string, unknown>[] = [{ name: "tank", size: 4e12, alloc: 1e12, free: 3e12, frag: 2, dedup: 1, health: "ONLINE" }];
  const directory: Record<string, unknown>[] = [];

  const storages = new Map<string, Record<string, unknown>>([
    ["local", { storage: "local", type: "dir", path: "/var/lib/vz", content: "iso,vztmpl,backup" }],
    ["nas", { storage: "nas", type: "cifs", server: "10.0.0.5", share: "pve", username: "svc", password: "hunter2-secret", content: "backup,iso", "prune-backups": "keep-last=3,keep-daily=7" }],
    ["pbs1", { storage: "pbs1", type: "pbs", server: "10.0.0.6", datastore: "main", username: "backup@pbs", password: "pbs-secret", fingerprint: "AA:BB:CC", content: "backup" }],
    ["local-lvm", { storage: "local-lvm", type: "lvmthin", vgname: "vg0", thinpool: "data", content: "images,rootdir" }],
  ]);
  const storageDigest = () => sha(JSON.stringify([...storages]));

  const guests = new Map<number, { type: "qemu" | "lxc"; name: string; status: string; cfg: Record<string, string | number>; pending: Record<string, string | null> }>([
    [200, { type: "qemu", name: "vm-lab", status: "stopped", pending: {}, cfg: { name: "vm-lab", scsi0: "local-lvm:vm-200-disk-0,iothread=1,size=32G", ide2: "local:iso/debian.iso,media=cdrom,size=600M", unused0: "local-lvm:vm-200-disk-9", net0: "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0" } }],
    [201, { type: "lxc", name: "ct-web", status: "running", pending: {}, cfg: { hostname: "ct-web", rootfs: "local-lvm:vm-201-disk-0,size=8G", mp0: "local-lvm:vm-201-disk-1,mp=/data,backup=1,size=20G" } }],
    [202, { type: "qemu", name: "vm-other", status: "stopped", pending: {}, cfg: { name: "vm-other", scsi0: "local-lvm:vm-202-disk-0,size=8G" } }],
  ]);
  const digestOf = (id: number) => sha(JSON.stringify(guests.get(id)!.cfg));
  const iso = [{ volid: "local:iso/debian.iso", content: "iso", size: 600e6, ctime: 1 }, { volid: "local:iso/alpine.iso", content: "iso", size: 100e6, ctime: 2 }];
  const jobs = [{ id: "backup-1", storage: "nas", type: "vzdump" }];
  const volAttrs = new Map<string, Record<string, string>>();

  const transport: Transport = async (req) => {
    const u = new URL(req.url);
    const path = u.pathname.replace("/api2/json", "");
    const form = new URLSearchParams(req.body ?? "");
    const params: Record<string, string> = Object.fromEntries([...u.searchParams, ...form]);
    const mine = /^\/(nodes\/pve\/(disks|scan)|storage|nodes\/pve\/(qemu|lxc)\/\d+|nodes\/pve\/storage\/[^/]+\/content|cluster\/resources|cluster\/backup)/.test(path);
    if (!mine) return base(req);
    // Who is asking: the shared fake knows the tickets; an administrator has Sys.Modify on "/".
    const perm = await base({ ...req, method: "GET", url: `${u.origin}/api2/json/access/permissions?path=/`, body: undefined });
    if (perm.status === 401) return perm;
    const admin = (JSON.parse(perm.body).data?.["/"]?.["Sys.Modify"] ?? 0) === 1;
    calls.push({ method: req.method, path, params });
    for (const k of ["password", "keyring", "encryption-key"]) if (params[k]) secretsSeen.push(params[k]);
    const deny = fail(403, "Permission check failed (user lacks the privilege)");
    const write = req.method !== "GET";
    if (write && !admin) return deny;

    if (path === "/cluster/resources") {
      if (params.type === "storage") return ok([...storages.values()].map((s) => ({ type: "storage", node: "pve", storage: s.storage, plugintype: s.type, content: s.content, status: "available", disk: 1, maxdisk: 10 })));
      return ok([...guests].map(([vmid, g]) => ({ id: `${g.type}/${vmid}`, type: g.type, vmid, node: "pve", name: g.name, status: g.status })));
    }
    if (path === "/cluster/backup") return ok(jobs);

    // ---- Physical disks
    if (path === "/nodes/pve/disks/list") return ok(disks.filter((d) => params["include-partitions"] === "1" || !d.parent));
    if (path === "/nodes/pve/disks/smart") {
      const d = disks.find((x) => x.devpath === params.disk);
      if (!d) return fail(500, "no such device");
      return ok({ health: d.health, type: "ata", attributes: [{ id: 5, name: "Reallocated_Sector_Ct", value: 100, worst: 100, threshold: 10, raw: "0", flags: "-O--CK", normalized: 100 }] });
    }
    const mark = (dev: string, used: string) => {
      const d = disks.find((x) => x.devpath === dev)!;
      d.used = used;
    };
    const assertUnused = (dev: string) => {
      const d = disks.find((x) => x.devpath === dev);
      if (!d) return fail(500, `disk '${dev}' not found`);
      if (d.used !== "unused" && d.used !== "partitions") return fail(500, `disk/partition '${dev}' has a holder`);
      return null;
    };
    if (path === "/nodes/pve/disks/initgpt" && req.method === "POST") {
      const bad = assertUnused(params.disk);
      if (bad) return bad;
      disks.find((d) => d.devpath === params.disk)!.gpt = true;
      return ok(task("diskinit"));
    }
    if (path === "/nodes/pve/disks/wipedisk" && req.method === "PUT") {
      const bad = assertUnused(params.disk);
      if (bad) return bad;
      const d = disks.find((x) => x.devpath === params.disk)!;
      d.gpt = false;
      d.used = "unused";
      return ok(task("wipedisk"));
    }
    if (path === "/nodes/pve/disks/lvm" && req.method === "GET") return ok({ leaf: false, children: lvm });
    if (path === "/nodes/pve/disks/lvmthin" && req.method === "GET") return ok(lvmthin);
    if (path === "/nodes/pve/disks/zfs" && req.method === "GET") return ok(zfs);
    if (path === "/nodes/pve/disks/directory" && req.method === "GET") return ok(directory);
    const zdetail = path.match(/^\/nodes\/pve\/disks\/zfs\/([^/]+)$/);
    if (zdetail && req.method === "GET") return zfs.some((z) => z.name === zdetail[1]) ? ok({ name: zdetail[1], state: "ONLINE", scan: "none requested", errors: "No known data errors", children: [{ name: zdetail[1], state: "ONLINE", read: 0, write: 0, cksum: 0, msg: "", children: [{ name: "mirror-0", state: "ONLINE", read: 0, write: 0, cksum: 0, msg: "", children: [{ name: "sdb", state: "ONLINE", read: 0, write: 0, cksum: 0, msg: "", leaf: 1 }, { name: "sdc", state: "ONLINE", read: 0, write: 0, cksum: 0, msg: "", leaf: 1 }] }] }] }) : fail(500, "no such pool");
    const mk = path.match(/^\/nodes\/pve\/disks\/(directory|lvm|lvmthin|zfs)$/);
    if (mk && req.method === "POST") {
      const devs = (params.device ?? params.devices).split(",");
      for (const dev of devs) {
        const bad = assertUnused(dev);
        if (bad) return bad;
      }
      for (const dev of devs) mark(dev, mk[1] === "zfs" ? "ZFS" : mk[1] === "directory" ? "mounted" : "LVM");
      if (mk[1] === "directory") directory.push({ device: params.device, path: `/mnt/pve/${params.name}`, type: params.filesystem ?? "ext4", options: "defaults", unitfile: "x" });
      if (mk[1] === "zfs") zfs.push({ name: params.name, size: 1, alloc: 0, free: 1, frag: 0, dedup: 1, health: "ONLINE" });
      if (params.add_storage === "1") storages.set(params.name, { storage: params.name, type: mk[1] === "directory" ? "dir" : mk[1] === "zfs" ? "zfspool" : mk[1], content: "images,rootdir", ...(mk[1] === "zfs" ? { pool: params.name } : {}) });
      return ok(task(`disk${mk[1]}`));
    }
    const rmDisk = path.match(/^\/nodes\/pve\/disks\/(directory|lvm|lvmthin|zfs)\/([^/]+)$/);
    if (rmDisk && req.method === "DELETE") {
      if (rmDisk[1] === "zfs" && rmDisk[2] === "tank") return fail(500, "pool 'tank' is busy");
      return ok(task(`diskrm${rmDisk[1]}`));
    }

    // ---- Scans
    const scan = path.match(/^\/nodes\/pve\/scan\/(\w+)$/);
    if (scan) {
      if (scan[1] === "nfs") return ok([{ path: "/export/pve", options: "*" }]);
      if (scan[1] === "cifs") return ok([{ share: "pve", description: "PVE share" }]);
      if (scan[1] === "pbs") return params.password === "wrong" ? fail(500, "authentication failed") : ok([{ store: "main", comment: "Main" }]);
      if (scan[1] === "iscsi") return ok([{ target: "iqn.2003-01.org.example:disk1", portal: params.portal }]);
      if (scan[1] === "lvm") return ok([{ vg: "vg0" }]);
      if (scan[1] === "lvmthin") return ok([{ lv: "data" }]);
      if (scan[1] === "zfs") return ok([{ pool: "tank" }]);
    }

    // ---- Storage definitions
    if (path === "/storage" && req.method === "GET") return ok([...storages.values()].map((s) => ({ ...s, digest: storageDigest() })));
    if (path === "/storage" && req.method === "POST") {
      if (storages.has(params.storage)) return fail(400, `storage ID '${params.storage}' already defined`);
      const { storage, type, ...rest } = params;
      storages.set(storage, { storage, type, ...rest });
      return ok({ storage, type });
    }
    const st = path.match(/^\/storage\/([^/]+)$/);
    if (st) {
      const cur = storages.get(st[1]);
      if (!cur) return fail(500, `storage '${st[1]}' does not exist`);
      if (req.method === "GET") return ok({ ...cur, digest: storageDigest() });
      if (req.method === "PUT") {
        if (params.digest !== storageDigest()) return fail(400, "detected modified configuration - file changed by other user! Try again.");
        const { digest: _d, delete: del, ...rest } = params;
        const next = { ...cur, ...rest };
        for (const k of (del ?? "").split(",").filter(Boolean)) delete next[k];
        storages.set(st[1], next);
        return ok(null);
      }
      if (req.method === "DELETE") {
        storages.delete(st[1]);
        return ok(null);
      }
    }
    const content = path.match(/^\/nodes\/pve\/storage\/([^/]+)\/content(?:\/(.+))?$/);
    if (content) {
      if (content[2] && req.method === "PUT") {
        volAttrs.set(decodeURIComponent(content[2]), params);
        return ok(null);
      }
      if (req.method === "GET") {
        if (content[1] === "local-lvm") return ok([{ volid: "local-lvm:vm-200-disk-0", content: "images", vmid: 200, size: 32e9 }, { volid: "local-lvm:vm-201-disk-0", content: "rootdir", vmid: 201, size: 8e9 }]);
        if (content[1] === "nas") return ok([]);
        return ok(params.content === "iso" ? iso : iso);
      }
    }

    // ---- Machines
    const g = path.match(/^\/nodes\/pve\/(qemu|lxc)\/(\d+)\/(config|pending|move_disk|move_volume|unlink|resize)$/);
    if (g) {
      const id = Number(g[2]);
      const m = guests.get(id);
      if (!m || m.type !== g[1]) return fail(500, "Configuration file does not exist");
      const checkDigest = (d?: string) => (d && d !== digestOf(id) ? fail(400, "detected modified configuration - file changed by other user! Try again.") : null);
      if (g[3] === "config" && req.method === "GET") return ok({ ...m.cfg, digest: digestOf(id) });
      if (g[3] === "pending") return ok(Object.entries(m.pending).map(([key, value]) => (value === null ? { key, delete: 1, value: m.cfg[key] } : { key, pending: value, value: m.cfg[key] })));
      if (g[3] === "config" && req.method === "PUT") {
        const stale = checkDigest(params.digest);
        if (stale) return stale;
        const { digest: _d, delete: del, ...rest } = params;
        for (const k of (del ?? "").split(",").filter(Boolean)) {
          const v = m.cfg[k];
          if (/^unused/.test(k)) delete m.cfg[k]; // destroys the volume
          else if (/^(scsi|virtio|sata|ide|mp)\d+$/.test(k) && v !== undefined && !String(v).includes("media=cdrom")) {
            const free = Array.from({ length: 30 }, (_, i) => `unused${i}`).find((x) => !(x in m.cfg))!;
            m.cfg[free] = String(v).split(",")[0];
            delete m.cfg[k];
          } else delete m.cfg[k];
        }
        for (const [k, v] of Object.entries(rest)) {
          if (/^(scsi|virtio|sata|ide)\d+$/.test(k) && m.status === "running" && g[1] === "qemu") {
            m.pending[k] = v;
            continue;
          }
          const first = v.split(",")[0];
          // Attaching a detached volume removes its unused entry, as Proxmox does.
          for (const [uk, uv] of Object.entries(m.cfg)) if (/^unused/.test(uk) && uv === first) delete m.cfg[uk];
          if (/^(scsi|virtio|sata|ide|mp)\d+$/.test(k) && /^[\w-]+:\d+(,|$)/.test(v)) {
            const [store, size] = first.split(":");
            m.cfg[k] = v.replace(first, `${store}:vm-${id}-disk-${Object.keys(m.cfg).length + 3},size=${size}G`).replace(/,size=\d+G(,|$)/, (x) => x);
          } else m.cfg[k] = v;
        }
        return ok(null);
      }
      if (g[3] === "unlink") {
        const ids = (params.idlist ?? "").split(",");
        for (const k of ids) delete m.cfg[k];
        return ok(null);
      }
      if (g[3] === "move_disk" || g[3] === "move_volume") {
        const stale = checkDigest(params.digest);
        if (stale) return stale;
        const key = params.disk ?? params.volume;
        if (!(key in m.cfg)) return fail(500, `volume '${key}' does not exist`);
        if (params["target-vmid"]) {
          const t = guests.get(Number(params["target-vmid"]));
          if (!t) return fail(500, "target does not exist");
          const tk = params["target-disk"] ?? params["target-volume"] ?? "scsi5";
          t.cfg[tk] = String(m.cfg[key]);
          delete m.cfg[key];
        } else {
          const rest = String(m.cfg[key]).split(",").slice(1).join(",");
          const old = String(m.cfg[key]).split(",")[0];
          m.cfg[key] = `${params.storage}:${old.split(":")[1]}${rest ? `,${rest}` : ""}`;
          if (params.delete !== "1") m.cfg.unused5 = old;
        }
        return ok(task("qmmove"));
      }
      if (g[3] === "resize") return ok(task("resize"));
    }
    return fail(501, `fake: ${req.method} ${path} not implemented`);
  };

  return { transport, calls, secretsSeen, disks, storages, guests, digestOf, volAttrs, zfs, directory };
}
