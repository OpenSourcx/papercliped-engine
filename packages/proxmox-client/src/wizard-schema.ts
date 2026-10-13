/**
 * The Create virtual machine and Create container wizards: the request shapes, the strict checks and the exact
 * Proxmox parameters they become. Shared by the host service (which checks every request before it reaches Proxmox) and
 * the console (which runs the same checks in the demo and for live hints), so the two can never disagree.
 *
 * Every field, enum and range here was checked against the API viewer (apidoc.js) for
 * POST /nodes/{node}/qemu and POST /nodes/{node}/lxc. Unknown fields are refused. Secrets (a root password, a
 * cloud-init password) are only ever written to Proxmox; `maskSecrets` hides them for any preview.
 */

export class WizardError extends Error {
  readonly field: string;
  constructor(message: string, field = "") {
    super(message);
    this.field = field;
  }
}

export type Params = Record<string, string | number | boolean | undefined>;
export interface Built {
  vmid: number | null;
  params: Params;
  warnings: string[];
}

/** What the host knows about the node, passed in so the checks can be exact. All optional: absent means "not checked". */
export interface WizardContext {
  /** Storage ids that can hold VM disks (content "images") or container disks ("rootdir"). */
  diskStorages?: Record<string, { type: string }>;
  bridges?: string[];
  cpuModels?: string[];
  pools?: string[];
}

// ---- Vocabulary (apidoc enums)

export const OS_TYPES = ["l26", "l24", "win11", "win10", "win8", "win7", "w2k8", "wvista", "wxp", "w2k3", "w2k", "solaris", "other"] as const;
export type OsType = (typeof OS_TYPES)[number];
export const OS_GROUPS: { group: "Linux" | "Windows" | "Other"; items: { value: OsType; label: string }[] }[] = [
  { group: "Linux", items: [{ value: "l26", label: "Linux 6.x - 2.6 kernel" }, { value: "l24", label: "Linux 2.4 kernel" }] },
  {
    group: "Windows",
    items: [
      { value: "win11", label: "Windows 11, Server 2022 and 2025" },
      { value: "win10", label: "Windows 10, Server 2016 and 2019" },
      { value: "win8", label: "Windows 8, Server 2012 and 2012 R2" },
      { value: "win7", label: "Windows 7, Server 2008 R2" },
      { value: "w2k8", label: "Windows Vista, Server 2008" },
      { value: "wvista", label: "Windows Vista" },
      { value: "wxp", label: "Windows XP" },
      { value: "w2k3", label: "Windows Server 2003" },
      { value: "w2k", label: "Windows 2000" },
    ],
  },
  { group: "Other", items: [{ value: "solaris", label: "Solaris kernel" }, { value: "other", label: "Other" }] },
];
export const isWindows = (o: string) => ["win11", "win10", "win8", "win7", "w2k8", "wvista", "wxp", "w2k3", "w2k"].includes(o);

export const BIOS = ["seabios", "ovmf"] as const;
export const SCSI_CONTROLLERS = ["virtio-scsi-single", "virtio-scsi-pci", "lsi", "lsi53c810", "megasas", "pvscsi"] as const;
export const DISK_BUSES = ["scsi", "virtio", "sata", "ide"] as const;
export type DiskBus = (typeof DISK_BUSES)[number];
export const BUS_MAX: Record<DiskBus, number> = { ide: 4, sata: 6, scsi: 31, virtio: 16 };
export const CACHE_MODES = ["none", "directsync", "writethrough", "writeback", "unsafe"] as const;
export const DISK_FORMATS = ["raw", "qcow2", "vmdk"] as const;
export const NIC_MODELS = ["virtio", "e1000", "e1000e", "e1000-82540em", "e1000-82544gc", "e1000-82545em", "i82551", "i82557b", "i82559er", "ne2k_isa", "ne2k_pci", "pcnet", "rtl8139", "vmxnet3"] as const;
export const VGA_TYPES = ["std", "cirrus", "vmware", "qxl", "qxl2", "qxl3", "qxl4", "virtio", "virtio-gl", "serial0", "serial1", "serial2", "serial3", "none"] as const;
export const AUDIO_DEVICES = ["ich9-intel-hda", "intel-hda", "AC97"] as const;
export const AUDIO_DRIVERS = ["spice", "none"] as const;
export const CPU_TYPES = ["x86-64-v2-AES", "x86-64-v2", "x86-64-v3", "x86-64-v4", "host", "kvm64", "qemu64", "max", "Skylake-Server", "Cascadelake-Server", "Icelake-Server", "Haswell", "Broadwell", "EPYC", "EPYC-Rome", "EPYC-Milan", "EPYC-Genoa"] as const;
export const CPU_TYPE_HINTS: Record<string, string> = {
  "x86-64-v2-AES": "A safe default: modern features, and the machine can move between hosts",
  host: "The host's own CPU: fastest, but the machine can only run on similar hardware",
  kvm64: "Very compatible, but hides newer CPU features",
  max: "Everything the emulator offers",
};
/** Storage types that keep disks as files and so can choose a format. Others (LVM, ZFS, Ceph) are always raw. */
export const FILE_STORAGE = ["dir", "nfs", "cifs", "glusterfs", "cephfs", "btrfs"];
export const storageFormats = (type: string): string[] => (FILE_STORAGE.includes(type) ? ["raw", "qcow2", "vmdk"] : ["raw"]);

// ---- Spec types

export interface Startup {
  order?: number;
  up?: number;
  down?: number;
}
export interface IpV4 {
  mode: "none" | "dhcp" | "static" | "manual";
  cidr?: string;
  gw?: string;
}
export interface IpV6 {
  mode: "none" | "auto" | "dhcp" | "static" | "manual";
  cidr?: string;
  gw?: string;
}

export interface VmDiskSpec {
  bus: DiskBus;
  storage: string;
  sizeGb: number;
  format?: (typeof DISK_FORMATS)[number];
  cache?: (typeof CACHE_MODES)[number];
  discard?: boolean;
  ssd?: boolean;
  iothread?: boolean;
  backup?: boolean;
}
export interface VmNicSpec {
  model: (typeof NIC_MODELS)[number];
  bridge: string;
  vlan?: number;
  mac?: string;
  firewall?: boolean;
  disconnected?: boolean;
  rateMbps?: number;
  mtu?: number;
  queues?: number;
}
export interface PciSpec {
  device?: string;
  mapping?: string;
  pcie?: boolean;
  primaryGpu?: boolean;
  romBar?: boolean;
}
export interface UsbSpec {
  host?: string;
  mapping?: string;
  spice?: boolean;
  usb3?: boolean;
}
export interface VmWizardSpec {
  general: { name: string; vmid?: number; pool?: string; start?: boolean; onboot?: boolean; startup?: Startup; tags?: string[]; description?: string };
  os: { media: "iso" | "cdrom" | "none"; iso?: string; ostype: OsType };
  system: { vga?: { type: (typeof VGA_TYPES)[number]; memory?: number }; machine?: string; bios?: (typeof BIOS)[number]; scsihw?: (typeof SCSI_CONTROLLERS)[number]; agent?: boolean; efi?: { storage: string; preEnrolledKeys?: boolean }; tpm?: { storage: string; version: "v1.2" | "v2.0" } };
  disks: VmDiskSpec[];
  cpu: { sockets?: number; cores: number; type?: string; vcpus?: number; limit?: number; units?: number; numa?: boolean };
  memory: { mb: number; balloonMinMb?: number; shares?: number };
  network: VmNicSpec[];
  cloudInit?: { storage: string; type?: "nocloud" | "configdrive2" | "opennebula"; user?: string; password?: string; sshKeys?: string; upgrade?: boolean; nameserver?: string[]; searchdomain?: string; ip?: { ipv4?: IpV4; ipv6?: IpV6 }[] };
  hardware?: { pci?: PciSpec[]; usb?: UsbSpec[]; serial?: number; audio?: { device: (typeof AUDIO_DEVICES)[number]; driver?: (typeof AUDIO_DRIVERS)[number] } };
}

export interface CtNicSpec {
  name?: string;
  bridge: string;
  vlan?: number;
  mac?: string;
  firewall?: boolean;
  disconnected?: boolean;
  ipv4?: IpV4;
  ipv6?: IpV6;
  rateMbps?: number;
  mtu?: number;
}
export interface CtWizardSpec {
  general: { hostname: string; vmid?: number; pool?: string; start?: boolean; onboot?: boolean; startup?: Startup; tags?: string[]; unprivileged?: boolean; description?: string; password?: string; sshKeys?: string };
  template: string;
  disk: { storage: string; sizeGb: number };
  cpu: { cores: number; limit?: number; units?: number };
  memory: { mb: number; swapMb: number };
  network: CtNicSpec[];
  dns?: { nameserver?: string[]; searchdomain?: string };
  features?: { nesting?: boolean; keyctl?: boolean; fuse?: boolean };
}

// ---- Small checkers

type Json = Record<string, unknown>;
const bad = (msg: string, field = ""): never => {
  throw new WizardError(msg, field);
};
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** An object with only the allowed keys; any other key is refused so a typo can't silently do nothing. */
function obj(v: unknown, allowed: readonly string[], field: string, required = true): Json {
  if (v === undefined || v === null) return required ? bad(`${field} is missing`, field) : {};
  if (!isObj(v)) return bad(`${field} must be an object`, field);
  for (const k of Object.keys(v)) if (!allowed.includes(k)) bad(`Unknown field ${field}.${k}`, `${field}.${k}`);
  return v;
}
function arr(v: unknown, max: number, field: string, min = 0): unknown[] {
  if (v === undefined || v === null) return min === 0 ? [] : bad(`${field} is missing`, field);
  if (!Array.isArray(v) || v.length > max) return bad(`${field} can hold at most ${max}`, field);
  if (v.length < min) return bad(`${field} needs at least ${min}`, field);
  return v;
}
const present = (v: unknown) => v !== undefined && v !== null && v !== "";
function int(v: unknown, lo: number, hi: number, what: string, field: string): number {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : bad(`${what} must be a whole number from ${lo} to ${hi}`, field);
}
function optInt(v: unknown, lo: number, hi: number, what: string, field: string): number | undefined {
  return present(v) ? int(v, lo, hi, what, field) : undefined;
}
function num(v: unknown, lo: number, hi: number, what: string, field: string): number {
  return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : bad(`${what} must be a number from ${lo} to ${hi}`, field);
}
function flag(v: unknown, field: string, dflt = false): boolean {
  if (v === undefined || v === null) return dflt;
  return typeof v === "boolean" ? v : bad(`${field} must be true or false`, field);
}
function oneOf<T extends string>(v: unknown, list: readonly T[], what: string, field: string, dflt?: T): T {
  if ((v === undefined || v === null || v === "") && dflt !== undefined) return dflt;
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : bad(`${what} isn't one Proxmox offers`, field);
}
function text(v: unknown, re: RegExp, max: number, msg: string, field: string): string {
  return typeof v === "string" && v.length <= max && re.test(v) ? v : bad(msg, field);
}

const STORAGE_RE = /^[A-Za-z][\w.-]{0,63}$/;
const POOL_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;
const BRIDGE_RE = /^[A-Za-z][\w.-]{0,14}$/;
const LABEL = "(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)";
const DNS_NAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
const TAG_RE = /^[a-z0-9_][a-z0-9_\-+.]{0,63}$/i;
const MAC_RE = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/;
const SSH_KEY = /^(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+(?: [^\n\r]{0,200})?$/;

export function dnsName(v: unknown, what: string, field: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length >= 1 && s.length <= 253 && DNS_NAME.test(s) ? s : bad(`${what} can use letters, digits, hyphens and dots, and each part can't start or end with a hyphen`, field);
}

export function ipv4(s: string): boolean {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return !!m && m.slice(1).every((o) => Number(o) <= 255 && String(Number(o)) === o);
}
export function ipv6(s: string): boolean {
  if (!/^[0-9A-Fa-f:.]+$/.test(s) || s.includes(":::")) return false;
  let rest = s;
  const tail = s.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    if (!ipv4(tail[1])) return false;
    rest = s.slice(0, s.length - tail[1].length) + ":0:0";
  }
  const dbl = rest.split("::");
  if (dbl.length > 2) return false;
  const groups = (p: string) => (p === "" ? [] : p.split(":"));
  const all = [...groups(dbl[0]), ...(dbl[1] !== undefined ? groups(dbl[1]) : [])];
  if (!all.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g))) return false;
  return dbl.length === 2 ? all.length < 8 : all.length === 8;
}
function cidr(s: unknown, v6: boolean, what: string, field: string): string {
  const str = typeof s === "string" ? s.trim() : "";
  const [addr, len, more] = str.split("/");
  const n = Number(len);
  const ok = more === undefined && addr !== undefined && /^\d{1,3}$/.test(len ?? "") && (v6 ? ipv6(addr) && n >= 1 && n <= 128 : ipv4(addr) && n >= 1 && n <= 32);
  if (!ok) bad(`${what} needs an address with its prefix length, like ${v6 ? "2001:db8::10/64" : "192.168.1.50/24"}`, field);
  if (!v6) {
    const first = Number(addr.split(".")[0]);
    if (first === 0 || first === 127 || first >= 224) bad(`${what} isn't an address a machine can use`, field);
  }
  return str;
}
function addr(s: unknown, v6: boolean, what: string, field: string): string {
  const str = typeof s === "string" ? s.trim() : "";
  return (v6 ? ipv6(str) : ipv4(str)) ? str : bad(`${what} needs a ${v6 ? "IPv6" : "IPv4"} address`, field);
}
const ipv4Net = (cidrText: string) => {
  const [a, l] = cidrText.split("/");
  const n = a.split(".").reduce((x, o) => x * 256 + Number(o), 0);
  const bits = Number(l);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (n & mask) >>> 0;
};
const inSubnet = (gw: string, c: string) => ipv4Net(`${gw}/${c.split("/")[1]}`) === ipv4Net(c);

function startup(v: unknown, field: string): string | undefined {
  if (!present(v)) return undefined;
  const o = obj(v, ["order", "up", "down"], field);
  const p = prop([["order", optInt(o.order, 0, 9999, "Start order", `${field}.order`)], ["up", optInt(o.up, 0, 86400, "Start delay", `${field}.up`)], ["down", optInt(o.down, 0, 86400, "Shutdown timeout", `${field}.down`)]]);
  return p || undefined;
}
function tags(v: unknown, field: string): string | undefined {
  const l = arr(v, 32, field);
  if (!l.length) return undefined;
  const seen = new Set<string>();
  for (const t of l) {
    const s = text(t, TAG_RE, 64, "A tag can use letters, digits and _ - + .", field).toLowerCase();
    seen.add(s);
  }
  return [...seen].join(";");
}
function optDescription(v: unknown, field: string): string | undefined {
  if (!present(v)) return undefined;
  return typeof v === "string" && v.length <= 4096 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v) ? v : bad("The note is too long or has control characters", field);
}
function vmidOf(v: unknown, field: string): number | undefined {
  return optInt(v, 100, 999_999_999, "The machine number", field);
}
function poolOf(v: unknown, ctx: WizardContext, field: string): string | undefined {
  if (!present(v)) return undefined;
  const p = text(v, POOL_RE, 64, "Unknown resource group", field);
  if (ctx.pools && !ctx.pools.includes(p)) bad(`There's no resource group called ${p}`, field);
  return p;
}
function sshKeys(v: unknown, field: string): string | undefined {
  if (!present(v)) return undefined;
  if (typeof v !== "string" || v.length > 16384) return bad("That doesn't look like an SSH public key", field);
  const lines = v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || lines.length > 32 || !lines.every((l) => SSH_KEY.test(l))) return bad("That doesn't look like an SSH public key. Paste one key per line, starting with ssh-ed25519 or ssh-rsa", field);
  return lines.join("\n");
}
function password(v: unknown, field: string): string | undefined {
  if (!present(v)) return undefined;
  return typeof v === "string" && v.length >= 8 && v.length <= 128 && !/[\r\n]/.test(v) ? v : bad("The password needs 8 to 128 characters on one line", field);
}
function nameservers(v: unknown, field: string): string | undefined {
  const l = arr(v, 3, field);
  if (!l.length) return undefined;
  return l.map((x, i) => {
    const s = typeof x === "string" ? x.trim() : "";
    return ipv4(s) || ipv6(s) ? s : bad("A DNS server needs an IP address", `${field}.${i}`);
  }).join(" ");
}
function checkBridge(b: string, ctx: WizardContext, field: string) {
  if (ctx.bridges && ctx.bridges.length && !ctx.bridges.includes(b)) bad(`There's no network bridge called ${b} on this device`, field);
}
function diskStorage(s: string, ctx: WizardContext, field: string) {
  if (ctx.diskStorages && !(s in ctx.diskStorages)) bad(`${s} can't hold disks for this kind of machine`, field);
}

const prop = (pairs: [string, string | number | undefined | false][]): string => pairs.filter(([, v]) => v !== undefined && v !== false).map(([k, v]) => `${k}=${v}`).join(",");

// ---- Virtual machine

export const VM_KEYS = ["general", "os", "system", "disks", "cpu", "memory", "network", "cloudInit", "hardware"] as const;

export function buildVm(raw: unknown, vmid: number | null, ctx: WizardContext = {}): Built {
  const warnings: string[] = [];
  const s = obj(raw, VM_KEYS, "spec");
  const g = obj(s.general, ["name", "vmid", "pool", "start", "onboot", "startup", "tags", "description"], "general");
  const name = dnsName(g.name, "The name", "general.name");
  const wantVmid = vmidOf(g.vmid, "general.vmid");
  const os = obj(s.os, ["media", "iso", "ostype"], "os");
  const ostype = oneOf(os.ostype, OS_TYPES, "That operating system", "os.ostype");
  const media = oneOf(os.media, ["iso", "cdrom", "none"] as const, "That install media", "os.media");
  let iso: string | undefined;
  if (media === "iso") iso = text(os.iso, /^[A-Za-z][\w.-]*:iso\/[\w][\w.+-]*$/, 300, "Pick an ISO image", "os.iso");
  else if (present(os.iso)) bad("An ISO image is only used with the ISO choice", "os.iso");

  const sys = obj(s.system, ["vga", "machine", "bios", "scsihw", "agent", "efi", "tpm"], "system", false);
  const bios = oneOf(sys.bios, BIOS, "That BIOS", "system.bios", "seabios");
  const machine = present(sys.machine) ? text(sys.machine, /^(?:pc|q35|pc-i440fx-\d{1,2}\.\d{1,2}|pc-q35-\d{1,2}\.\d{1,2})$/, 24, "The machine type is pc, q35 or a versioned one like pc-q35-9.0", "system.machine") : "pc";
  const q35 = machine === "q35" || machine.startsWith("pc-q35-");
  const scsihw = oneOf(sys.scsihw, SCSI_CONTROLLERS, "That SCSI controller", "system.scsihw", "virtio-scsi-single");
  const agent = flag(sys.agent, "system.agent", true);
  let vga: string | undefined;
  if (present(sys.vga)) {
    const v = obj(sys.vga, ["type", "memory"], "system.vga");
    const type = oneOf(v.type, VGA_TYPES, "That graphic card", "system.vga.type");
    const mem = optInt(v.memory, 4, 512, "Video memory", "system.vga.memory");
    if (mem !== undefined && (type.startsWith("serial") || type === "none")) bad("This graphic card has no video memory to set", "system.vga.memory");
    vga = type === "std" && mem === undefined ? undefined : prop([["type", type], ["memory", mem]]);
  }
  let efidisk0: string | undefined;
  if (present(sys.efi)) {
    if (bios !== "ovmf") bad("An EFI disk goes with the UEFI (OVMF) BIOS", "system.efi");
    const e = obj(sys.efi, ["storage", "preEnrolledKeys"], "system.efi");
    const st = text(e.storage, STORAGE_RE, 64, "Pick a storage for the EFI disk", "system.efi.storage");
    diskStorage(st, ctx, "system.efi.storage");
    efidisk0 = `${st}:1,efitype=4m,pre-enrolled-keys=${flag(e.preEnrolledKeys, "system.efi.preEnrolledKeys", true) ? 1 : 0}`;
  } else if (bios === "ovmf") warnings.push("No EFI disk: UEFI settings and boot entries won't be remembered between restarts.");
  let tpmstate0: string | undefined;
  if (present(sys.tpm)) {
    const t = obj(sys.tpm, ["storage", "version"], "system.tpm");
    const st = text(t.storage, STORAGE_RE, 64, "Pick a storage for the TPM state", "system.tpm.storage");
    diskStorage(st, ctx, "system.tpm.storage");
    tpmstate0 = `${st}:1,version=${oneOf(t.version, ["v1.2", "v2.0"] as const, "That TPM version", "system.tpm.version", "v2.0")}`;
  }
  if (ostype === "win11" && (bios !== "ovmf" || !tpmstate0)) warnings.push("Windows 11 needs UEFI and a TPM 2.0 to install.");

  // CPU and memory
  const c = obj(s.cpu, ["sockets", "cores", "type", "vcpus", "limit", "units", "numa"], "cpu");
  const sockets = optInt(c.sockets, 1, 4, "Sockets", "cpu.sockets") ?? 1;
  const cores = int(c.cores, 1, 512, "Cores", "cpu.cores");
  if (sockets * cores > 512) bad("Sockets times cores can't be more than 512", "cpu.cores");
  const cpuType = present(c.type) ? text(c.type, /^[A-Za-z0-9][\w.-]{0,63}$/, 64, "That CPU type isn't one Proxmox offers", "cpu.type") : "x86-64-v2-AES";
  if (ctx.cpuModels && !(CPU_TYPES as readonly string[]).includes(cpuType) && !ctx.cpuModels.includes(cpuType) && !ctx.cpuModels.includes(cpuType.replace(/^custom-/, ""))) bad("That CPU type isn't one Proxmox offers", "cpu.type");
  const vcpus = optInt(c.vcpus, 1, sockets * cores, "Active CPUs", "cpu.vcpus");
  const limit = present(c.limit) ? num(c.limit, 0, 128, "The CPU limit", "cpu.limit") : undefined;
  const units = optInt(c.units, 1, 10000, "CPU weight", "cpu.units");
  const numa = flag(c.numa, "cpu.numa");
  const m = obj(s.memory, ["mb", "balloonMinMb", "shares"], "memory");
  const memory = int(m.mb, 16, 4_194_304, "Memory", "memory.mb");
  const balloon = optInt(m.balloonMinMb, 16, memory, "Minimum memory", "memory.balloonMinMb");
  const shares = optInt(m.shares, 0, 50000, "Memory shares", "memory.shares");
  if (shares !== undefined && balloon === undefined) bad("Memory shares only apply when ballooning is on", "memory.shares");

  // Disks
  const used = new Set<string>();
  const reserve = (k: string) => {
    if (used.has(k)) bad(`The ${k} slot is taken twice`, "disks");
    used.add(k);
  };
  if (media !== "none") reserve("ide2");
  const disks = arr(s.disks, 31, "disks");
  const keys: string[] = [];
  const out: Params = {};
  const nextIdx: Record<DiskBus, number> = { ide: 0, sata: 0, scsi: 0, virtio: 0 };
  const diskSpecs = disks.map((d, i) => {
    const f = `disks.${i}`;
    const o = obj(d, ["bus", "storage", "sizeGb", "format", "cache", "discard", "ssd", "iothread", "backup"], f);
    const bus = oneOf(o.bus, DISK_BUSES, "That bus", `${f}.bus`);
    const storage = text(o.storage, STORAGE_RE, 64, "Pick a storage for the disk", `${f}.storage`);
    diskStorage(storage, ctx, `${f}.storage`);
    const size = int(o.sizeGb, 1, 131072, "Disk size", `${f}.sizeGb`);
    const format = present(o.format) ? oneOf(o.format, DISK_FORMATS, "That format", `${f}.format`) : undefined;
    const type = ctx.diskStorages?.[storage]?.type;
    if (format && format !== "raw" && type && !FILE_STORAGE.includes(type)) bad(`${storage} keeps raw disks only`, `${f}.format`);
    const cache = present(o.cache) ? oneOf(o.cache, CACHE_MODES, "That cache mode", `${f}.cache`) : undefined;
    const discard = flag(o.discard, `${f}.discard`);
    const ssd = flag(o.ssd, `${f}.ssd`);
    const iothread = flag(o.iothread, `${f}.iothread`);
    const backup = flag(o.backup, `${f}.backup`, true);
    if (ssd && bus === "virtio") bad("SSD emulation isn't available on a VirtIO block disk", `${f}.ssd`);
    if (iothread && !(bus === "virtio" || (bus === "scsi" && scsihw === "virtio-scsi-single"))) bad("An IO thread needs a VirtIO block disk, or a SCSI disk with the VirtIO SCSI single controller", `${f}.iothread`);
    return { bus, storage, size, format, cache, discard, ssd, iothread, backup };
  });
  for (const d of diskSpecs) {
    let idx = nextIdx[d.bus];
    while (used.has(`${d.bus}${idx}`)) idx++;
    if (idx >= BUS_MAX[d.bus]) bad(`A ${d.bus.toUpperCase()} bus holds at most ${BUS_MAX[d.bus]} disks`, "disks");
    nextIdx[d.bus] = idx + 1;
    const key = `${d.bus}${idx}`;
    reserve(key);
    keys.push(key);
    const opts = prop([["format", d.format], ["cache", d.cache && d.cache !== "none" ? d.cache : undefined], ["discard", d.discard ? "on" : undefined], ["ssd", d.ssd ? 1 : undefined], ["iothread", d.iothread ? 1 : undefined], ["backup", d.backup ? undefined : 0]]);
    out[key] = `${d.storage}:${d.size}${opts ? "," + opts : ""}`;
  }
  if (media === "iso") out.ide2 = `${iso},media=cdrom`;
  else if (media === "cdrom") out.ide2 = "cdrom,media=cdrom";
  if (bus0(diskSpecs, "ide") && media !== "none" && q35) warnings.push("On the q35 machine type IDE disks are limited; SATA or SCSI is the safer choice.");

  // Cloud-init
  const nics = arr(s.network, 32, "network");
  if (s.cloudInit !== undefined && s.cloudInit !== null) {
    const ci = obj(s.cloudInit, ["storage", "type", "user", "password", "sshKeys", "upgrade", "nameserver", "searchdomain", "ip"], "cloudInit");
    const st = text(ci.storage, STORAGE_RE, 64, "Pick a storage for the cloud-init drive", "cloudInit.storage");
    diskStorage(st, ctx, "cloudInit.storage");
    const slot = ["ide0", "sata5", "scsi30"].find((k) => !used.has(k));
    if (!slot) bad("There's no free slot for the cloud-init drive", "cloudInit");
    out[slot!] = `${st}:cloudinit`;
    used.add(slot!);
    if (present(ci.type)) out.citype = oneOf(ci.type, ["nocloud", "configdrive2", "opennebula"] as const, "That cloud-init type", "cloudInit.type");
    if (present(ci.user)) out.ciuser = text(ci.user, /^[a-z_][a-z0-9_-]{0,31}$/, 32, "The user name uses lowercase letters, digits, _ and -", "cloudInit.user");
    const pw = password(ci.password, "cloudInit.password");
    if (pw) out.cipassword = pw;
    const keys2 = sshKeys(ci.sshKeys, "cloudInit.sshKeys");
    // Proxmox stores the keys url-encoded.
    if (keys2) out.sshkeys = encodeURIComponent(keys2);
    if (ci.upgrade !== undefined && flag(ci.upgrade, "cloudInit.upgrade", true) === false) out.ciupgrade = false;
    const ns = nameservers(ci.nameserver, "cloudInit.nameserver");
    if (ns) out.nameserver = ns;
    if (present(ci.searchdomain)) out.searchdomain = dnsName(ci.searchdomain, "The search domain", "cloudInit.searchdomain");
    const ips = arr(ci.ip, nics.length, "cloudInit.ip");
    ips.forEach((p, i) => {
      const o = obj(p, ["ipv4", "ipv6"], `cloudInit.ip.${i}`, false);
      const cfg = ipConfig(o.ipv4, o.ipv6, `cloudInit.ip.${i}`, true);
      if (cfg) out[`ipconfig${i}`] = cfg;
    });
    if (!pw && !keys2 && !present(ci.user)) warnings.push("Cloud-init has no user, password or SSH key, so you may not be able to sign in.");
  }

  // Network
  const nicLines = nics.map((n, i) => {
    const f = `network.${i}`;
    const o = obj(n, ["model", "bridge", "vlan", "mac", "firewall", "disconnected", "rateMbps", "mtu", "queues"], f);
    const model = oneOf(o.model, NIC_MODELS, "That network card", `${f}.model`);
    const bridge = text(o.bridge, BRIDGE_RE, 15, "Pick a network bridge", `${f}.bridge`);
    checkBridge(bridge, ctx, `${f}.bridge`);
    const vlan = optInt(o.vlan, 1, 4094, "The VLAN tag", `${f}.vlan`);
    const mac = present(o.mac) ? text(o.mac, MAC_RE, 17, "A MAC address looks like BC:24:11:AA:BB:CC", `${f}.mac`).toUpperCase() : undefined;
    if (mac && (parseInt(mac.slice(0, 2), 16) & 1) === 1) bad("A MAC address can't be a multicast address (the first byte must be even)", `${f}.mac`);
    const rate = present(o.rateMbps) ? num(o.rateMbps, 0.01, 1_000_000, "The rate limit", `${f}.rateMbps`) : undefined;
    const mtu = present(o.mtu) ? (o.mtu === 1 ? 1 : int(o.mtu, 576, 65520, "The MTU", `${f}.mtu`)) : undefined;
    if (mtu !== undefined && model !== "virtio") bad("Only VirtIO network cards can set an MTU", `${f}.mtu`);
    const queues = optInt(o.queues, 1, 64, "Queues", `${f}.queues`);
    if (queues !== undefined && model !== "virtio") bad("Only VirtIO network cards support multiqueue", `${f}.queues`);
    return prop([["model", model], ["macaddr", mac], ["bridge", bridge], ["firewall", flag(o.firewall, `${f}.firewall`) ? 1 : undefined], ["link_down", flag(o.disconnected, `${f}.disconnected`) ? 1 : undefined], ["mtu", mtu], ["queues", queues], ["rate", rate], ["tag", vlan]]);
  });
  nicLines.forEach((l, i) => (out[`net${i}`] = l));
  if (!nicLines.length) warnings.push("No network device: the machine won't be reachable over the network.");

  // Hardware
  const hw = obj(s.hardware, ["pci", "usb", "serial", "audio"], "hardware", false);
  const pcis = arr(hw.pci, 16, "hardware.pci");
  pcis.forEach((p, i) => {
    const f = `hardware.pci.${i}`;
    const o = obj(p, ["device", "mapping", "pcie", "primaryGpu", "romBar"], f);
    const dev = present(o.device), map = present(o.mapping);
    if (dev === map) bad("Pick a device or a saved mapping for each PCI entry", f);
    const pcie = flag(o.pcie, `${f}.pcie`);
    if (pcie && !q35) bad("PCIe passthrough needs the q35 machine type", `${f}.pcie`);
    const rom = o.romBar === undefined ? undefined : flag(o.romBar, `${f}.romBar`);
    const id = dev ? text(o.device, /^(?:[0-9a-fA-F]{4}:)?[0-9a-fA-F]{2}:[0-9a-fA-F]{2}(?:\.[0-7])?$/, 16, "That doesn't look like a PCI address", `${f}.device`) : text(o.mapping, /^[A-Za-z][\w-]{0,63}$/, 64, "Unknown PCI mapping", `${f}.mapping`);
    out[`hostpci${i}`] = prop([[dev ? "host" : "mapping", id], ["pcie", pcie ? 1 : undefined], ["x-vga", flag(o.primaryGpu, `${f}.primaryGpu`) ? 1 : undefined], ["rombar", rom === false ? 0 : undefined]]);
  });
  if (pcis.length && balloon !== undefined) warnings.push("PCI passthrough doesn't work with memory ballooning; Proxmox will keep the memory fixed.");
  if (pcis.length && bios !== "ovmf") warnings.push("GPU and most PCIe passthrough works best with UEFI (OVMF).");
  const usbs = arr(hw.usb, 5, "hardware.usb");
  usbs.forEach((u, i) => {
    const f = `hardware.usb.${i}`;
    const o = obj(u, ["host", "mapping", "spice", "usb3"], f);
    const kinds = [present(o.host), present(o.mapping), o.spice === true].filter(Boolean).length;
    if (kinds !== 1) bad("Pick a USB device, a saved mapping or SPICE redirection for each USB entry", f);
    const head = o.spice === true ? "spice" : present(o.host) ? `host=${text(o.host, /^(?:[0-9a-fA-F]{4}:[0-9a-fA-F]{4}|\d{1,3}-\d{1,3}(?:\.\d{1,3})*)$/, 24, "That doesn't look like a USB device", `${f}.host`)}` : `mapping=${text(o.mapping, /^[A-Za-z][\w-]{0,63}$/, 64, "Unknown USB mapping", `${f}.mapping`)}`;
    out[`usb${i}`] = head + (flag(o.usb3, `${f}.usb3`) ? ",usb3=1" : "");
  });
  const serial = optInt(hw.serial, 0, 4, "Serial ports", "hardware.serial") ?? 0;
  for (let i = 0; i < serial; i++) out[`serial${i}`] = "socket";
  if (present(hw.audio)) {
    const a = obj(hw.audio, ["device", "driver"], "hardware.audio");
    out.audio0 = prop([["device", oneOf(a.device, AUDIO_DEVICES, "That audio device", "hardware.audio.device")], ["driver", oneOf(a.driver, AUDIO_DRIVERS, "That audio driver", "hardware.audio.driver", "spice")]]);
  }

  // Boot order: the first disk, then the install media, then the network.
  const order = [keys[0], media !== "none" ? "ide2" : undefined, nicLines.length ? "net0" : undefined].filter(Boolean);
  const params: Params = {
    ...(wantVmid !== undefined ? { vmid: wantVmid } : vmid !== null ? { vmid } : {}),
    name,
    ostype,
    pool: poolOf(g.pool, ctx, "general.pool"),
    start: flag(g.start, "general.start", true),
    onboot: flag(g.onboot, "general.onboot"),
    startup: startup(g.startup, "general.startup"),
    tags: tags(g.tags, "general.tags"),
    description: optDescription(g.description, "general.description"),
    bios: bios === "seabios" ? undefined : bios,
    machine: machine === "pc" ? undefined : machine,
    scsihw,
    agent: agent ? "enabled=1" : "enabled=0",
    vga,
    sockets,
    cores,
    cpu: cpuType,
    vcpus: vcpus !== undefined && vcpus !== sockets * cores ? vcpus : undefined,
    cpulimit: limit,
    cpuunits: units,
    numa,
    memory,
    balloon: balloon !== undefined ? balloon : 0,
    shares,
    ...out,
    efidisk0,
    tpmstate0,
    boot: order.length ? `order=${order.join(";")}` : undefined,
  };
  return { vmid: typeof params.vmid === "number" ? params.vmid : null, params, warnings };
}

const bus0 = (d: { bus: string }[], bus: string) => d.some((x) => x.bus === bus);

function ipConfig(v4: unknown, v6: unknown, field: string, cloudInit: boolean): string | undefined {
  const parts: [string, string | undefined][] = [];
  if (present(v4)) {
    const o = obj(v4, ["mode", "cidr", "gw"], `${field}.ipv4`);
    const mode = oneOf(o.mode, cloudInit ? (["none", "dhcp", "static"] as const) : (["none", "dhcp", "static", "manual"] as const), "That IPv4 setting", `${field}.ipv4.mode`);
    if (mode === "dhcp" || mode === "manual") {
      if (present(o.cidr) || present(o.gw)) bad("An address and gateway go with a static setting", `${field}.ipv4`);
      parts.push(["ip", mode]);
    } else if (mode === "static") {
      const c = cidr(o.cidr, false, "The IPv4 address", `${field}.ipv4.cidr`);
      parts.push(["ip", c]);
      if (present(o.gw)) {
        const gw = addr(o.gw, false, "The IPv4 gateway", `${field}.ipv4.gw`);
        if (!inSubnet(gw, c)) bad("The IPv4 gateway has to be inside the address's network", `${field}.ipv4.gw`);
        parts.push(["gw", gw]);
      }
    } else if (present(o.cidr) || present(o.gw)) bad("Turn the IPv4 setting to static to give an address", `${field}.ipv4`);
  }
  if (present(v6)) {
    const o = obj(v6, ["mode", "cidr", "gw"], `${field}.ipv6`);
    const mode = oneOf(o.mode, cloudInit ? (["none", "auto", "dhcp", "static"] as const) : (["none", "auto", "dhcp", "static", "manual"] as const), "That IPv6 setting", `${field}.ipv6.mode`);
    if (mode === "auto" || mode === "dhcp" || mode === "manual") {
      if (present(o.cidr) || present(o.gw)) bad("An address and gateway go with a static setting", `${field}.ipv6`);
      parts.push(["ip6", mode]);
    } else if (mode === "static") {
      parts.push(["ip6", cidr(o.cidr, true, "The IPv6 address", `${field}.ipv6.cidr`)]);
      if (present(o.gw)) parts.push(["gw6", addr(o.gw, true, "The IPv6 gateway", `${field}.ipv6.gw`)]);
    } else if (present(o.cidr) || present(o.gw)) bad("Turn the IPv6 setting to static to give an address", `${field}.ipv6`);
  }
  return parts.length ? parts.map(([k, x]) => `${k}=${x}`).join(",") : undefined;
}

// ---- Container

export const CT_KEYS = ["general", "template", "disk", "cpu", "memory", "network", "dns", "features"] as const;

export function buildCt(raw: unknown, vmid: number | null, ctx: WizardContext = {}): Built {
  const warnings: string[] = [];
  const s = obj(raw, CT_KEYS, "spec");
  const g = obj(s.general, ["hostname", "vmid", "pool", "start", "onboot", "startup", "tags", "unprivileged", "description", "password", "sshKeys"], "general");
  const hostname = dnsName(g.hostname, "The hostname", "general.hostname");
  const wantVmid = vmidOf(g.vmid, "general.vmid");
  const unprivileged = flag(g.unprivileged, "general.unprivileged", true);
  const pw = password(g.password, "general.password");
  const keys = sshKeys(g.sshKeys, "general.sshKeys");
  if (!pw && !keys) warnings.push("No password or SSH key: you'll only be able to reach the container's console as root without signing in.");
  if (!unprivileged) warnings.push("A privileged container shares more with the host. Use it only when something needs it.");
  const template = text(s.template, /^[A-Za-z][\w.-]*:vztmpl\/[\w][\w.+-]*$/, 300, "Pick a container template", "template");
  const d = obj(s.disk, ["storage", "sizeGb"], "disk");
  const storage = text(d.storage, STORAGE_RE, 64, "Pick a storage for the root disk", "disk.storage");
  diskStorage(storage, ctx, "disk.storage");
  const sizeGb = int(d.sizeGb, 1, 131072, "Disk size", "disk.sizeGb");
  const c = obj(s.cpu, ["cores", "limit", "units"], "cpu");
  const cores = int(c.cores, 1, 8192, "Cores", "cpu.cores");
  const limit = present(c.limit) ? num(c.limit, 0, 8192, "The CPU limit", "cpu.limit") : undefined;
  const units = optInt(c.units, 1, 10000, "CPU weight", "cpu.units");
  const m = obj(s.memory, ["mb", "swapMb"], "memory");
  const memory = int(m.mb, 16, 4_194_304, "Memory", "memory.mb");
  const swap = int(m.swapMb ?? 0, 0, 4_194_304, "Swap", "memory.swapMb");
  const f = obj(s.features, ["nesting", "keyctl", "fuse"], "features", false);
  const keyctl = flag(f.keyctl, "features.keyctl");
  if (keyctl && !unprivileged) bad("keyctl is only for unprivileged containers", "features.keyctl");
  const features = prop([["nesting", flag(f.nesting, "features.nesting") ? 1 : undefined], ["keyctl", keyctl ? 1 : undefined], ["fuse", flag(f.fuse, "features.fuse") ? 1 : undefined]]);

  const out: Params = {};
  const nics = arr(s.network, 32, "network");
  const taken = new Set<string>();
  nics.forEach((n, i) => {
    const fld = `network.${i}`;
    const o = obj(n, ["name", "bridge", "vlan", "mac", "firewall", "disconnected", "ipv4", "ipv6", "rateMbps", "mtu"], fld);
    const ifname = present(o.name) ? text(o.name, /^[A-Za-z][\w-]{0,14}$/, 15, "An interface name starts with a letter and has up to 15 letters, digits, _ or -", `${fld}.name`) : `eth${i}`;
    if (taken.has(ifname)) bad(`Two network devices are called ${ifname}`, `${fld}.name`);
    taken.add(ifname);
    const bridge = text(o.bridge, BRIDGE_RE, 15, "Pick a network bridge", `${fld}.bridge`);
    checkBridge(bridge, ctx, `${fld}.bridge`);
    const vlan = optInt(o.vlan, 1, 4094, "The VLAN tag", `${fld}.vlan`);
    const mac = present(o.mac) ? text(o.mac, MAC_RE, 17, "A MAC address looks like BC:24:11:AA:BB:CC", `${fld}.mac`).toUpperCase() : undefined;
    if (mac && (parseInt(mac.slice(0, 2), 16) & 1) === 1) bad("A MAC address can't be a multicast address (the first byte must be even)", `${fld}.mac`);
    const rate = present(o.rateMbps) ? num(o.rateMbps, 0.01, 1_000_000, "The rate limit", `${fld}.rateMbps`) : undefined;
    const mtu = present(o.mtu) ? (o.mtu === 1 ? 1 : int(o.mtu, 576, 65535, "The MTU", `${fld}.mtu`)) : undefined;
    const ip = ipConfig(o.ipv4, o.ipv6, fld, false);
    if (ip?.includes("gw=") && !ip.includes("ip=")) bad("A gateway needs an address", fld);
    out[`net${i}`] = prop([["name", ifname], ["bridge", bridge], ["hwaddr", mac], ["firewall", flag(o.firewall, `${fld}.firewall`) ? 1 : undefined], ["link_down", flag(o.disconnected, `${fld}.disconnected`) ? 1 : undefined], ["mtu", mtu], ["rate", rate], ["tag", vlan]]) + (ip ? "," + ip : "");
  });
  const dns = obj(s.dns, ["nameserver", "searchdomain"], "dns", false);
  const params: Params = {
    ...(wantVmid !== undefined ? { vmid: wantVmid } : vmid !== null ? { vmid } : {}),
    ostemplate: template,
    hostname,
    password: pw,
    "ssh-public-keys": keys,
    unprivileged,
    pool: poolOf(g.pool, ctx, "general.pool"),
    start: flag(g.start, "general.start", true),
    onboot: flag(g.onboot, "general.onboot"),
    startup: startup(g.startup, "general.startup"),
    tags: tags(g.tags, "general.tags"),
    description: optDescription(g.description, "general.description"),
    cores,
    cpulimit: limit,
    cpuunits: units,
    memory,
    swap,
    rootfs: `${storage}:${sizeGb}`,
    ...out,
    nameserver: nameservers(dns.nameserver, "dns.nameserver"),
    searchdomain: present(dns.searchdomain) ? dnsName(dns.searchdomain, "The search domain", "dns.searchdomain") : undefined,
    features: features || undefined,
  };
  return { vmid: typeof params.vmid === "number" ? params.vmid : null, params, warnings };
}

/** For previews: every secret value replaced, keys kept so the person sees that one will be set. */
export const SECRET_PARAMS = ["password", "cipassword", "ssh-public-keys", "sshkeys"];
export function maskSecrets(p: Params): Params {
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, SECRET_PARAMS.includes(k) && v !== undefined ? "(set, hidden)" : v]));
}

// ---- Defaults the console starts each OS at (the same choices Proxmox's own wizard makes, plus what installs cleanly)

export interface OsDefaults {
  bios: (typeof BIOS)[number];
  machine: "pc" | "q35";
  efi: boolean;
  tpm: boolean;
  bus: DiskBus;
  nic: (typeof NIC_MODELS)[number];
  iothread: boolean;
  discard: boolean;
  scsihw: (typeof SCSI_CONTROLLERS)[number];
  sizeGb: number;
  memoryMb: number;
  note?: string;
}
export function osDefaults(os: OsType): OsDefaults {
  if (os === "win11") return { bios: "ovmf", machine: "q35", efi: true, tpm: true, bus: "sata", nic: "e1000e", iothread: false, discard: false, scsihw: "virtio-scsi-single", sizeGb: 64, memoryMb: 8192, note: "UEFI, a TPM 2.0, SATA and e1000e, so the installer sees the disk and network without extra drivers." };
  if (isWindows(os)) return { bios: "seabios", machine: "pc", efi: false, tpm: false, bus: "sata", nic: "e1000", iothread: false, discard: false, scsihw: "virtio-scsi-single", sizeGb: 64, memoryMb: 4096, note: "SATA and an Intel network card, so the installer sees the disk and network without extra drivers." };
  if (os === "l24" || os === "solaris" || os === "other") return { bios: "seabios", machine: "pc", efi: false, tpm: false, bus: "scsi", nic: "e1000", iothread: false, discard: false, scsihw: "lsi", sizeGb: 32, memoryMb: 2048 };
  return { bios: "seabios", machine: "pc", efi: false, tpm: false, bus: "scsi", nic: "virtio", iothread: true, discard: true, scsihw: "virtio-scsi-single", sizeGb: 32, memoryMb: 2048 };
}
