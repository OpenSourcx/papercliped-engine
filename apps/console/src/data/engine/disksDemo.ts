import { buildStorageParams, parseBwlimit, parsePrune, storageDef, planZfs } from "@papercliped-engine/proxmox-client/storage-schema";
import { ApiError } from "../api.ts";
import type { DisksApi, DiskStorageKind, GuestDisk, GuestDisks, PhysDisk, StorageDef, StorageUsage, ZfsDetail } from "./disks.ts";

/**
 * The demo's disks, storage and machine disks: the same calls as the host service, answered in this browser. It follows
 * the same rules (typed confirmations, digests, refusing disks in use) so the demo teaches the real behaviour.
 */

const GB = 1e9;
const disk = (name: string, type: string, size: number, model: string, over: Partial<PhysDisk> = {}): PhysDisk => ({
  devpath: `/dev/${name}`, name, type, sizeBytes: size, model, vendor: "ACME", serial: `SN-${name.toUpperCase()}`, wwn: null, usedBy: null, mounted: false, gpt: false, health: "PASSED", wearoutPct: null, rpm: null, parent: null, inUseReason: null, ...over,
});

let disks: PhysDisk[];
let lvm: { name: string; size: number; free: number }[];
let thin: { lv: string; vg: string; lv_size: number; used: number }[];
let zfs: { name: string; size: number; alloc: number; free: number; frag: number; health: string }[];
let dirs: { device: string; path: string; type: string }[];
let defs: StorageDef[];
let guests: Map<number, GuestDisks>;
let seq = 0;

function reset() {
  disks = [
    disk("sda", "ssd", 256 * GB, "Boot SSD", { usedBy: "partitions", gpt: true, wearoutPct: 8, inUseReason: "It holds the boot loader" }),
    disk("sdb", "hdd", 4000 * GB, "Data HDD", { rpm: 7200 }),
    disk("sdc", "hdd", 4000 * GB, "Data HDD", { rpm: 7200 }),
    disk("nvme0n1", "nvme", 1000 * GB, "Fast NVMe", { gpt: true, wearoutPct: 3 }),
    disk("sdd", "hdd", 2000 * GB, "Old HDD", { usedBy: "LVM", gpt: true, rpm: 5400, health: "FAILED", inUseReason: "It is part of an LVM volume group. Remove the volume group first (LVM tab)" }),
  ];
  lvm = [{ name: "pve", size: 2000 * GB, free: 400 * GB }];
  thin = [{ lv: "data", vg: "pve", lv_size: 1500 * GB, used: 300 * GB }];
  zfs = [];
  dirs = [];
  const base = { nodes: [], enabled: true, secretsSet: [], digest: "d".repeat(40), bwlimit: null };
  defs = [
    { ...base, id: "local", type: "dir", content: ["iso", "vztmpl", "backup"], shared: false, prune: parsePrune("keep-last=3"), config: { path: "/var/lib/vz" } },
    { ...base, id: "local-lvm", type: "lvmthin", content: ["images", "rootdir"], shared: false, prune: null, config: { vgname: "pve", thinpool: "data" } },
    { ...base, id: "nas", type: "cifs", content: ["backup", "iso"], shared: true, prune: parsePrune("keep-last=7,keep-weekly=4"), secretsSet: ["password"], config: { server: "nas.lan", share: "proxmox", username: "backup" } },
  ];
  guests = new Map();
}
reset();
export const resetDisksDemo = reset;

const wait = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(structuredClone(v)), 40));
const fail = (status: number, code: string, message: string): never => {
  throw new ApiError(status, code, message);
};
const find = (devpath: string) => disks.find((d) => d.devpath === devpath) ?? fail(404, "not_found", "That disk isn't on this device");
const newDigest = () => String(++seq).padStart(40, "a");
const typed = (confirm: unknown, ...ok: string[]) => {
  if (typeof confirm !== "string" || !ok.includes(confirm)) fail(409, "confirm", `Type ${ok[0]} to confirm.`);
};

function markDisks(devs: string[], usedBy: string) {
  for (const dev of devs) {
    const d = find(dev);
    if (d.inUseReason || d.usedBy) fail(409, "in_use", `${d.name} is in use.`);
  }
  for (const dev of devs) {
    const d = find(dev);
    d.usedBy = usedBy;
    d.inUseReason = `It is part of ${usedBy}`;
  }
}

function freeDisks(devs: string[]) {
  for (const dev of devs) {
    const d = disks.find((x) => x.devpath === dev);
    if (d) {
      d.usedBy = null;
      d.inUseReason = null;
    }
  }
}

function zfsTree(name: string): ZfsDetail {
  const members = disks.filter((d) => d.usedBy === `ZFS pool ${name}`);
  const leaf = (d: PhysDisk) => ({ name: d.name, state: "ONLINE", read: 0, write: 0, cksum: 0 });
  return { name, state: "ONLINE", scan: "none requested", errors: "No known data errors", children: [{ name, state: "ONLINE", read: 0, write: 0, cksum: 0, children: members.map(leaf) }] };
}

function guestFor(vmid: number, hint?: "qemu" | "lxc"): GuestDisks {
  let g: GuestDisks | undefined = guests.get(vmid);
  if (!g) {
    const vm = hint !== "lxc";
    const base = { status: "stopped", digest: newDigest(), locked: null, isAdmin: true, pendingKeys: [] as string[], hotplug: true, unused: [] as GuestDisks["unused"] };
    g = vm
      ? { ...base, type: "qemu", disks: [{ key: "scsi0", kind: "disk", staged: false, bus: "scsi", volume: `local-lvm:vm-${vmid}-disk-0`, storage: "local-lvm", sizeGb: 32, format: "raw", media: "disk", cache: null, aio: null, discard: true, ssd: false, iothread: true, backup: true, ro: false, replicate: true }, { key: "ide2", kind: "cdrom", staged: false, bus: "ide", volume: "none", storage: null, sizeGb: null, media: "cdrom" }], unused: [] }
      : { ...base, type: "lxc", disks: [{ key: "rootfs", kind: "rootfs", staged: false, volume: `local-lvm:vm-${vmid}-disk-0`, storage: "local-lvm", sizeGb: 8, mp: "/", backup: true, acl: false, quota: false, replicate: true, ro: false, mountoptions: [] }], unused: [] };
    guests.set(vmid, g);
  }
  return g as GuestDisks;
}

const freeKey = (g: GuestDisks, bus: string, max: number) => {
  for (let i = 0; i <= max; i++) if (!g.disks.some((d) => d.key === `${bus}${i}`) && !g.unused.some((u) => u.key === `${bus}${i}`)) return `${bus}${i}`;
  return fail(400, "bad_request", "All slots are taken");
};

export const demoDisksApi: DisksApi = {
  disks: () => wait(disks),
  smart: async (devpath) => {
    const d = find(devpath);
    return wait({ disk: devpath, health: d.health, type: "ata", text: null, attributes: [{ id: 5, name: "Reallocated_Sector_Ct", value: 100, worst: 100, threshold: 10, raw: d.health === "FAILED" ? "212" : "0" }, { id: 9, name: "Power_On_Hours", value: 96, worst: 96, threshold: 0, raw: "14210" }, { id: 194, name: "Temperature_Celsius", value: 34, worst: 30, threshold: 0, raw: "34" }] });
  },
  initGpt: async (devpath, confirm) => {
    const d = find(devpath);
    typed(confirm, d.name, d.devpath);
    if (d.inUseReason) fail(409, "in_use", `${d.name} can't be initialized: ${d.inUseReason}.`);
    d.gpt = true;
    return wait({ task: null });
  },
  wipe: async (devpath, confirm) => {
    const d = find(devpath);
    typed(confirm, d.name, d.devpath);
    if (d.inUseReason) fail(409, "in_use", `${d.name} can't be wiped: ${d.inUseReason}.`);
    d.gpt = false;
    return wait({ task: null });
  },
  listOnDisks: async (kind) => wait(kind === "lvm" ? lvm : kind === "lvmthin" ? thin : kind === "zfs" ? zfs : dirs) as Promise<Record<string, unknown>[]>,
  zfsDetail: async (name) => wait(zfsTree(name)),
  createOnDisk: async (kind: DiskStorageKind, b) => {
    const name = String(b.name ?? "");
    if (!/^[a-z][a-z0-9._-]{0,38}[a-z0-9]$/.test(name)) fail(400, "bad_request", "Name: 2 to 40 characters, lowercase letters, digits, - _ and .");
    if (kind === "zfs") {
      const devs = (b.devices as string[]) ?? [];
      const plan = planZfs(String(b.raidlevel), devs.map((x) => find(x).sizeBytes), (b.draidConfig as string) ?? null);
      if (!plan.ok) fail(400, "bad_request", plan.message);
      markDisks(devs, `ZFS pool ${name}`);
      zfs.push({ name, size: devs.length ? Math.min(...devs.map((x) => find(x).sizeBytes)) * devs.length : 0, alloc: 0, free: plan.ok ? plan.usableBytes : 0, frag: 0, health: "ONLINE" });
      if (b.addStorage) defs.push({ id: name, type: "zfspool", content: ["images", "rootdir"], nodes: [], enabled: true, shared: false, prune: null, bwlimit: null, config: { pool: name }, secretsSet: [], digest: newDigest() });
    } else {
      const dev = String(b.device);
      markDisks([dev], kind === "directory" ? `directory ${name}` : kind === "lvm" ? `LVM group ${name}` : `LVM-Thin pool ${name}`);
      if (kind === "directory") dirs.push({ device: dev, path: `/mnt/pve/${name}`, type: String(b.filesystem ?? "ext4") });
      if (kind === "lvm") lvm.push({ name, size: find(dev).sizeBytes, free: find(dev).sizeBytes });
      if (kind === "lvmthin") thin.push({ lv: name, vg: name, lv_size: find(dev).sizeBytes, used: 0 });
      if (b.addStorage) defs.push({ id: name, type: kind === "directory" ? "dir" : kind, content: ["images", "rootdir"], nodes: [], enabled: true, shared: false, prune: null, bwlimit: null, config: kind === "directory" ? { path: `/mnt/pve/${name}` } : kind === "lvm" ? { vgname: name } : { vgname: name, thinpool: name }, secretsSet: [], digest: newDigest() });
    }
    return wait({ task: null });
  },
  deleteOnDisk: async (kind, name, b) => {
    typed(b.confirm, name);
    const freed = disks.filter((d) => d.usedBy?.endsWith(` ${name}`)).map((d) => d.devpath);
    if (kind === "lvm") {
      lvm = lvm.filter((x) => x.name !== name);
      if (name === "pve") fail(409, "in_use", "The volume group pve holds the system and can't be removed.");
    }
    if (kind === "lvmthin") thin = thin.filter((x) => x.lv !== name);
    if (kind === "zfs") zfs = zfs.filter((x) => x.name !== name);
    if (kind === "directory") dirs = dirs.filter((x) => !x.path.endsWith(`/${name}`));
    freeDisks(freed);
    if (b.cleanupConfig) defs = defs.filter((x) => x.id !== name);
    return wait({ task: null });
  },
  storageDefs: () => wait(defs),
  storageDef: async (id) => wait(defs.find((d) => d.id === id) ?? fail(404, "not_found", "Unknown storage")),
  createStorage: async (b) => {
    const def = storageDef(String(b.type));
    if (!def) fail(400, "bad_request", "Pick a storage type from the list");
    const id = String(b.storage ?? "");
    if (!/^[a-z][a-z0-9._-]{0,38}[a-z0-9]$/.test(id)) fail(400, "bad_request", "Name: 2 to 40 characters, lowercase letters, digits, - _ and .");
    if (defs.some((d) => d.id === id)) fail(400, "proxmox_rejected", `storage ID '${id}' already defined`);
    const r = buildStorageParams(def!, b, true);
    if (r.issues.length) fail(400, "bad_request", r.issues.map((i) => i.message).join(". "));
    const config: Record<string, unknown> = {};
    const secretsSet: string[] = [];
    for (const f of def!.fields) {
      const v = r.params[f.key];
      if (v === undefined) continue;
      if (f.secret) secretsSet.push(f.key);
      else config[f.key] = v;
    }
    defs.push({ id, type: def!.type, content: String(r.params.content ?? "").split(",").filter(Boolean), nodes: String(r.params.nodes ?? "").split(",").filter(Boolean), enabled: r.params.disable !== true, shared: !!def!.alwaysShared || r.params.shared === true, prune: r.params["prune-backups"] ? parsePrune(r.params["prune-backups"]) : null, bwlimit: r.params.bwlimit ? parseBwlimit(r.params.bwlimit) : null, config, secretsSet, digest: newDigest() });
    return wait({ ok: true });
  },
  updateStorage: async (id, b) => {
    const cur = defs.find((d) => d.id === id) ?? fail(404, "not_found", "Unknown storage");
    if (b.digest !== cur.digest) fail(400, "proxmox_rejected", "detected modified configuration - file changed by other user! Try again.");
    const def = storageDef(cur.type)!;
    const r = buildStorageParams(def, b, false);
    if (r.issues.length) fail(400, "bad_request", r.issues.map((i) => i.message).join(". "));
    if (r.params.content) cur.content = String(r.params.content).split(",");
    if ("nodes" in r.params) cur.nodes = String(r.params.nodes).split(",");
    if (r.remove.includes("nodes")) cur.nodes = [];
    if (r.params.disable !== undefined) cur.enabled = r.params.disable !== true;
    if (r.params.shared !== undefined) cur.shared = r.params.shared === true;
    if (r.params["prune-backups"]) cur.prune = parsePrune(r.params["prune-backups"]);
    if (r.remove.includes("prune-backups")) cur.prune = null;
    if (r.params.bwlimit) cur.bwlimit = parseBwlimit(r.params.bwlimit);
    if (r.remove.includes("bwlimit")) cur.bwlimit = null;
    for (const f of def.fields) {
      const v = r.params[f.key];
      if (v === undefined) continue;
      if (f.secret) {
        if (!cur.secretsSet.includes(f.key)) cur.secretsSet.push(f.key);
      } else cur.config[f.key] = v;
    }
    cur.digest = newDigest();
    return wait({ ok: true });
  },
  removeStorage: async (id, b) => {
    typed(b.confirm, id);
    if (id === "local" && !b.acknowledgeInUse) fail(409, "in_use", "local is still used by 1 backup job. Confirm that you want to remove it anyway.");
    defs = defs.filter((d) => d.id !== id);
    return wait({ ok: true });
  },
  storageUsage: async (id) => wait<StorageUsage>({ counts: (id === "local-lvm" ? { images: 2, rootdir: 1 } : id === "local" ? { iso: 2 } : {}) as Record<string, number>, readable: true, guests: id === "local-lvm" ? [{ vmid: 101, name: "web", volumes: 2 }] : [], backupJobs: id === "local" ? ["backup-nightly"] : [] }),
  scan: async (kind) => {
    const out: Record<string, Record<string, string>[]> = {
      nfs: [{ path: "/export/proxmox", options: "192.168.0.0/24" }, { path: "/export/media", options: "*" }],
      cifs: [{ share: "proxmox", description: "Backups" }, { share: "iso", description: "Installers" }],
      pbs: [{ store: "main", comment: "Main datastore" }],
      iscsi: [{ target: "iqn.2003-01.org.example:disk1", portal: "192.168.0.30:3260" }],
      lvm: lvm.map((v) => ({ vg: v.name })),
      lvmthin: thin.map((t) => ({ lv: t.lv })),
      zfs: zfs.map((z) => ({ pool: z.name })),
    };
    return wait(out[kind]);
  },
  volumeAttributes: async () => wait({ ok: true }),
  guestDisks: async (vmid, hint) => wait(guestFor(vmid, hint)),
  guestAct: async (vmid, tail, b) => {
    const g = guestFor(vmid);
    if (b.digest !== g.digest) fail(409, "stale", "This machine changed since the page loaded. Reload and try again.");
    const [first, second] = tail.split("/");
    const done = <T extends object>(v: T) => {
      g.digest = newDigest();
      return wait(v);
    };
    const vm = g.type === "qemu";
    if (first === "add") {
      const bus = String(b.bus ?? "scsi");
      const key = freeKey(g, bus, 15);
      const d: GuestDisk = { key, kind: "disk", staged: false, bus, volume: `${b.storage}:vm-${vmid}-disk-${g.disks.length + 3}`, storage: String(b.storage), sizeGb: Number(b.sizeGb), format: String(b.format ?? "raw"), media: "disk", cache: (b.cache as string) ?? null, discard: b.discard === true, ssd: b.ssd === true, iothread: b.iothread === true, backup: b.backup !== false, ro: false, replicate: true };
      g.disks.push(d);
      return done({ key });
    }
    if (first === "mount") {
      const key = freeKey(g, "mp", 30);
      const bind = typeof b.bind === "string" && b.bind;
      g.disks.push({ key, kind: bind ? "bind" : "mount", staged: false, volume: bind ? String(b.bind) : `${b.storage}:subvol-${vmid}-disk-${g.disks.length}`, storage: bind ? null : String(b.storage), sizeGb: bind ? null : Number(b.sizeGb), mp: String(b.mp), backup: b.backup === true, acl: b.acl === true, quota: b.quota === true, replicate: b.replicate !== false, ro: b.ro === true, mountoptions: [] });
      return done({ key });
    }
    if (first === "cdrom") {
      const iso = b.iso === "none" ? "none" : b.iso === "physical" ? "cdrom" : String(b.iso);
      const existing = g.disks.find((d) => d.key === b.key) ?? g.disks.find((d) => d.kind === "cdrom");
      if (existing) existing.volume = iso;
      else g.disks.push({ key: "ide2", kind: "cdrom", staged: false, bus: "ide", volume: iso, storage: null, sizeGb: null, media: "cdrom" });
      return done({ key: existing?.key ?? "ide2" });
    }
    const d = g.disks.find((x) => x.key === first);
    const u = g.unused.find((x) => x.key === first);
    if (second === "edit" && d) {
      Object.assign(d, { cache: b.cache ?? d.cache, discard: b.discard ?? d.discard, ssd: b.ssd ?? d.ssd, iothread: b.iothread ?? d.iothread, backup: b.backup ?? d.backup, ro: b.ro ?? d.ro, replicate: b.replicate ?? d.replicate, acl: b.acl ?? d.acl, quota: b.quota ?? d.quota, mp: b.mp ?? d.mp });
      return done({ ok: true });
    }
    if (second === "detach" && d) {
      if (d.kind === "rootfs") fail(400, "bad_request", "The root disk can't be detached");
      g.disks = g.disks.filter((x) => x !== d);
      if (d.kind !== "cdrom") g.unused.push({ key: `unused${g.unused.length}`, volume: d.volume, name: d.volume.split(":").pop()!, storage: d.storage });
      return done({ ok: true });
    }
    if (second === "reattach" && u) {
      g.unused = g.unused.filter((x) => x !== u);
      const key = vm ? freeKey(g, String(b.bus ?? "scsi"), 15) : freeKey(g, "mp", 30);
      g.disks.push(vm ? { key, kind: "disk", staged: false, bus: String(b.bus ?? "scsi"), volume: u.volume, storage: u.storage, sizeGb: 8, media: "disk", backup: true } : { key, kind: "mount", staged: false, volume: u.volume, storage: u.storage, sizeGb: 8, mp: String(b.mp ?? "/mnt/data"), backup: true });
      return done({ key, staleUnused: false });
    }
    if (second === "destroy" && u) {
      typed(b.confirm, u.name);
      g.unused = g.unused.filter((x) => x !== u);
      return done({ ok: true });
    }
    if (second === "move" && (d || u)) {
      if (d) {
        const old = d.volume;
        d.storage = String(b.storage);
        d.volume = `${b.storage}:${old.split(":").pop()}`;
        if (b.deleteSource !== true) g.unused.push({ key: `unused${g.unused.length}`, volume: old, name: old.split(":").pop()!, storage: old.split(":")[0] });
      }
      return done({ task: "" });
    }
    if (second === "reassign" && d) {
      const to = guestFor(Number(b.targetVmid), g.type);
      g.disks = g.disks.filter((x) => x !== d);
      to.disks.push({ ...d, key: freeKey(to, d.bus ?? "mp", 30) });
      to.digest = newDigest();
      return done({ task: "" });
    }
    return fail(404, "not_found", "That disk isn't on this machine");
  },
};

