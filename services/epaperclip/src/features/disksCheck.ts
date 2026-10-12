import { getProp, parseProps, serializeProps, setProps, sizeGb, type Props } from "../hardware.ts";
import { STORAGE_ID_RE, RAID_LEVELS, ZFS_COMPRESSION, planZfs, parseDraidConfig } from "@papercliped-engine/proxmox-client/storage-schema";

/** Strict validation for disk, storage and drive input. Every function throws CheckError with a user-facing message. */
export class CheckError extends Error {}
const bad = (m: string): never => {
  throw new CheckError(m);
};

export const DEVICE_RE = /^\/dev\/(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9/_-]{0,60}$/;

export function device(v: unknown): string {
  return typeof v === "string" && DEVICE_RE.test(v) ? v : bad("Pick a disk from the list");
}

/** The name a person types to confirm: "sdb" or "/dev/sdb". */
export function matchesDevice(confirm: unknown, dev: string): boolean {
  return typeof confirm === "string" && (confirm === dev || confirm === dev.replace(/^\/dev\//, ""));
}

export function storageName(v: unknown, label = "Name"): string {
  return typeof v === "string" && STORAGE_ID_RE.test(v) ? v : bad(`${label}: 2 to 40 characters, lowercase letters, digits, - _ and ., starting with a letter`);
}

/** Disk states Proxmox itself refuses to wipe or initialize, caught before the request so the message is ours and kind. */
export function diskInUse(d: { used?: string; mounted?: boolean }): string | null {
  const u = (d.used ?? "").toLowerCase();
  if (d.mounted) return "It is mounted";
  if (u === "mounted") return "It is mounted";
  if (u.includes("bios boot") || u === "efi") return "It holds the boot loader";
  if (u.includes("lvm")) return "It is part of an LVM volume group. Remove the volume group first (LVM tab)";
  if (u.includes("zfs")) return "It is part of a ZFS pool. Destroy the pool first (ZFS tab)";
  if (u.includes("device mapper")) return "It is in use by the device mapper";
  if (u.includes("ceph")) return "It is used by Ceph";
  return null;
}

export interface ZfsSpec {
  name: string;
  devices: string[];
  raidlevel: string;
  ashift: number;
  compression: string;
  draidConfig: string | null;
  addStorage: boolean;
}

export function zfsSpec(b: Record<string, unknown>, sizes?: Map<string, number>): ZfsSpec {
  const name = storageName(b.name);
  const devices = Array.isArray(b.devices) ? b.devices.map(device) : bad("Pick the disks for the pool");
  if (new Set(devices).size !== devices.length) bad("Each disk can be used once");
  if (devices.length > 64) bad("That is too many disks for one pool");
  const raidlevel = typeof b.raidlevel === "string" && RAID_LEVELS.some((l) => l.value === b.raidlevel) ? b.raidlevel : bad("Pick a RAID level");
  const ashift = b.ashift === undefined || b.ashift === null ? 12 : Number.isInteger(b.ashift) && (b.ashift as number) >= 9 && (b.ashift as number) <= 16 ? (b.ashift as number) : bad("Sector size exponent (ashift) goes from 9 to 16");
  const compression: string = b.compression === undefined ? "on" : (ZFS_COMPRESSION as readonly string[]).includes(String(b.compression)) ? String(b.compression) : bad("Unknown compression");
  const draidConfig: string | null = typeof b.draidConfig === "string" && b.draidConfig ? (parseDraidConfig(b.draidConfig) ? b.draidConfig : bad("dRAID layout looks like data=4,spares=1")) : null;
  if (raidlevel.startsWith("draid") && !draidConfig) bad("dRAID needs a layout such as data=4,spares=1");
  const plan = planZfs(raidlevel, devices.map((d) => sizes?.get(d) ?? 1), draidConfig);
  if (!plan.ok) bad(plan.message);
  return { name, devices, raidlevel, ashift, compression, draidConfig, addStorage: b.addStorage === true };
}

export const DISK_BUSES = ["scsi", "virtio", "sata", "ide"] as const;
export const BUS_MAX: Record<string, number> = { scsi: 30, virtio: 15, sata: 5, ide: 3 };
const CACHE = ["none", "writethrough", "writeback", "unsafe", "directsync"];
const AIO = ["native", "threads", "io_uring"];
const FORMATS = ["raw", "qcow2", "vmdk"];

export const DRIVE_KEY_RE = /^(scsi\d{1,2}|virtio\d{1,2}|sata\d|ide\d)$/;
export const MP_KEY_RE = /^mp\d{1,2}$/;
export const DIGEST_RE = /^[0-9a-f]{40}$/;

export function digest(v: unknown): string {
  return typeof v === "string" && DIGEST_RE.test(v) ? v : bad("This page is out of date. Reload and try again");
}

export function driveKey(v: unknown): string {
  if (typeof v !== "string" || !DRIVE_KEY_RE.test(v)) return bad("Unknown disk");
  const m = v.match(/^([a-z]+)(\d+)$/)!;
  return Number(m[2]) <= (BUS_MAX[m[1]] ?? -1) ? v : bad("Unknown disk");
}

export function freeKey(cfg: Record<string, unknown>, bus: string): string {
  if (!(bus in BUS_MAX)) return bad("Pick SCSI, VirtIO, SATA or IDE");
  for (let i = 0; i <= BUS_MAX[bus]; i++) if (!(`${bus}${i}` in cfg)) return `${bus}${i}`;
  return bad(`All ${bus.toUpperCase()} slots are taken`);
}

const bool = (v: unknown, label: string): boolean | undefined => (v === undefined || v === null ? undefined : typeof v === "boolean" ? v : bad(`${label} is on or off`));
const limit = (v: unknown, label: string, max = 1e7): number | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null || v === "" || v === 0) return null;
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= max ? v : bad(`${label} must be a positive number`);
};

/** Editable options of a VM disk, as device-string changes (null removes the key). */
export function vmDiskChanges(bus: string, b: Record<string, unknown>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (b.cache !== undefined) out.cache = b.cache === null || b.cache === "" || b.cache === "default" ? null : CACHE.includes(String(b.cache)) ? String(b.cache) : bad("Unknown cache mode");
  if (b.aio !== undefined) out.aio = b.aio === null || b.aio === "" || b.aio === "default" ? null : AIO.includes(String(b.aio)) ? String(b.aio) : bad("Unknown async IO mode");
  const discard = bool(b.discard, "Discard");
  if (discard !== undefined) out.discard = discard ? "on" : null;
  const ssd = bool(b.ssd, "SSD emulation");
  if (ssd !== undefined) {
    if (ssd && bus === "virtio") bad("VirtIO disks can't emulate an SSD; use SCSI or SATA");
    out.ssd = ssd ? "1" : null;
  }
  const iothread = bool(b.iothread, "IO thread");
  if (iothread !== undefined) {
    if (iothread && bus !== "virtio" && bus !== "scsi") bad("IO threads work with VirtIO and SCSI disks only");
    out.iothread = iothread ? "1" : null;
  }
  const backup = bool(b.backup, "Backup");
  if (backup !== undefined) out.backup = backup ? null : "0";
  const ro = bool(b.ro, "Read only");
  if (ro !== undefined) out.ro = ro ? "1" : null;
  const repl = bool(b.replicate, "Replicate");
  if (repl !== undefined) out.replicate = repl ? null : "0";
  const lim = (key: string, label: string, max?: number) => {
    const v = limit(b[key], label, max);
    if (v !== undefined) out[key] = v === null ? null : String(v);
  };
  lim("mbps_rd", "Read limit (MB/s)", 1e6);
  lim("mbps_wr", "Write limit (MB/s)", 1e6);
  lim("iops_rd", "Read limit (IOPS)");
  lim("iops_wr", "Write limit (IOPS)");
  return out;
}

/** The options a person can see and edit, read from a device string. */
export function readDrive(raw: string) {
  const p = parseProps(raw);
  const f = (k: string) => getProp(p, k);
  const n = (k: string) => (f(k) !== undefined && f(k) !== "" && Number.isFinite(Number(f(k))) ? Number(f(k)) : null);
  const volume = p[0]?.[0] ?? raw;
  return {
    volume,
    storage: volume.includes(":") ? volume.split(":")[0] : null,
    sizeGb: sizeGb(f("size")),
    format: f("format") ?? null,
    media: f("media") ?? "disk",
    cache: f("cache") ?? null,
    aio: f("aio") ?? null,
    discard: f("discard") === "on",
    ssd: f("ssd") === "1",
    iothread: f("iothread") === "1",
    backup: f("backup") !== "0",
    ro: f("ro") === "1",
    replicate: f("replicate") !== "0",
    mbpsRd: n("mbps_rd"),
    mbpsWr: n("mbps_wr"),
    iopsRd: n("iops_rd"),
    iopsWr: n("iops_wr"),
  };
}

export interface NewVmDisk {
  bus: string;
  storage: string;
  sizeGb: number;
  format: string | null;
}

export function newVmDisk(b: Record<string, unknown>): NewVmDisk {
  const bus = typeof b.bus === "string" && (DISK_BUSES as readonly string[]).includes(b.bus) ? b.bus : bad("Pick SCSI, VirtIO, SATA or IDE");
  const storage = typeof b.storage === "string" && /^[\w.-]{1,64}$/.test(b.storage) ? b.storage : bad("Pick a storage for the disk");
  const size = typeof b.sizeGb === "number" && Number.isInteger(b.sizeGb) && b.sizeGb >= 1 && b.sizeGb <= 131072 ? b.sizeGb : bad("Size is a whole number of GB, 1 or more");
  const format = b.format === undefined || b.format === null || b.format === "" ? null : FORMATS.includes(String(b.format)) ? String(b.format) : bad("Format is raw, QCOW2 or VMDK");
  return { bus, storage, sizeGb: size, format };
}

export function driveString(base: string, changes: Record<string, string | null>, existing?: Props): string {
  return serializeProps(setProps(existing ?? parseProps(base), changes));
}

/* ---- Containers ---- */

const MOUNT_OPTS = ["noatime", "nodev", "nosuid", "noexec", "lazytime"];

export function mpChanges(b: Record<string, unknown>, creating: boolean): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (b.mp !== undefined || creating) {
    if (typeof b.mp !== "string" || !/^\/(?!.*(\.\.|\/\/))[\w./+@ -]{0,200}$/.test(b.mp) || b.mp === "/") bad("The path inside the container must be absolute, like /data");
    out.mp = b.mp as string;
  }
  const backup = bool(b.backup, "Backup");
  if (backup !== undefined) out.backup = backup ? "1" : null;
  const acl = bool(b.acl, "ACL");
  if (acl !== undefined) out.acl = acl ? "1" : null;
  const quota = bool(b.quota, "Quota");
  if (quota !== undefined) out.quota = quota ? "1" : null;
  const repl = bool(b.replicate, "Replicate");
  if (repl !== undefined) out.replicate = repl ? null : "0";
  const ro = bool(b.ro, "Read only");
  if (ro !== undefined) out.ro = ro ? "1" : null;
  if (b.mountoptions !== undefined) {
    const list = Array.isArray(b.mountoptions) ? b.mountoptions.map(String) : bad("Mount options are a list");
    if (!list.every((o) => MOUNT_OPTS.includes(o))) bad("Mount options: noatime, nodev, nosuid, noexec, lazytime");
    out.mountoptions = list.length ? list.join(";") : null;
  }
  return out;
}

/** A host path for a bind mount: absolute, clean, no characters that could add device options. */
export function bindPath(v: unknown): string {
  if (typeof v !== "string" || v.length > 250 || !/^\/[\w./+@-]+$/.test(v) || v.includes("..") || v.includes("//")) return bad("Use an absolute host path like /srv/shared, without spaces or ..");
  if (/^\/(proc|sys|dev|run|boot)(\/|$)/.test(v) || v === "/etc/pve" || v.startsWith("/etc/pve/")) return bad("That host path can't be mounted into a container");
  return v;
}

export const isoVolume = (v: unknown): string => (typeof v === "string" && /^[\w.-]+:iso\/[\w.+() -]+\.(iso|img)$/i.test(v) && !v.includes("..") ? v : bad("Pick an ISO image from the list"));
