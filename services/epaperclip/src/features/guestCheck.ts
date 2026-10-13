import { isIP, isIPv4, isIPv6 } from "node:net";
import { getProp, parseProps, serializeProps, setProps, type Props } from "../hardware.ts";
import { CheckError } from "./disksCheck.ts";

/**
 * Strict validation and device strings for the machine page: network devices (VM and container), container DNS and
 * features, resources, notes and tags, display / serial / audio / EFI / TPM, and access entries. Every limit below comes
 * from Proxmox's API viewer data (the `PUT .../config` parameter formats), not from guesses. Functions throw CheckError
 * with a sentence a person can act on.
 */

export { CheckError };
const bad = (m: string): never => {
  throw new CheckError(m);
};

type Json = Record<string, unknown>;
const present = (v: unknown) => v !== undefined && v !== null && v !== "";

function bool(v: unknown, label: string): boolean | undefined {
  return v === undefined || v === null ? undefined : typeof v === "boolean" ? v : bad(`${label} is on or off`);
}

function int(v: unknown, lo: number, hi: number, label: string): number {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : bad(`${label} must be a whole number from ${lo} to ${hi}`);
}

// ---- Network devices

/** Network card models Proxmox accepts for a VM (the `model` enum of `net[n]`). */
export const QEMU_NIC_MODELS = ["virtio", "e1000", "e1000-82540em", "e1000-82544gc", "e1000-82545em", "e1000e", "i82551", "i82557b", "i82559er", "ne2k_isa", "ne2k_pci", "pcnet", "rtl8139", "vmxnet3"] as const;

export const BRIDGE_RE = /^[A-Za-z0-9][\w.-]{0,14}$/;
const MAC_RE = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/;
const IFACE_NAME_RE = /^[A-Za-z][\w.-]{0,14}$/;

export function isMac(v: string): boolean {
  return MAC_RE.test(v);
}

/** A MAC address a person typed: six pairs, and the multicast bit off (Proxmox refuses group addresses). */
function mac(v: unknown): string | null {
  if (!present(v)) return null;
  if (typeof v !== "string" || !MAC_RE.test(v)) return bad("A MAC address looks like BC:24:11:AA:BB:CC");
  if (parseInt(v.slice(0, 2), 16) & 1) return bad("That MAC address is a group address. The first pair must be even, like BC or 02");
  return v.toUpperCase();
}

function tag(v: unknown): number | null {
  return present(v) ? int(typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v, 1, 4094, "The VLAN tag") : null;
}

/** "10;20-30" for VMs, "10;20" for containers. Ranges only for VMs; every id 1 to 4094. */
function trunks(v: unknown, ranges: boolean): string | null {
  if (!present(v)) return null;
  const parts = (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[;,\s]+/) : bad("VLAN trunks are a list of ids")).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length > 64) bad("That is too many trunk entries");
  for (const p of parts) {
    const m = p.match(ranges ? /^(\d{1,4})(?:-(\d{1,4}))?$/ : /^(\d{1,4})$/);
    if (!m) return bad(ranges ? `"${p}" isn't a VLAN id or range like 20-30` : `"${p}" isn't a VLAN id`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 4094 || a > b) bad("VLAN ids go from 1 to 4094");
  }
  return parts.join(";");
}

function rate(v: unknown): number | null {
  if (!present(v) || v === 0) return null;
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1_000_000 ? v : bad("The rate limit is a positive number of MB/s, or empty for no limit");
}

export interface VmNicSpec {
  model: string;
  bridge: string;
  mac: string | null;
  tag: number | null;
  trunks: string | null;
  firewall: boolean;
  linkDown: boolean;
  rate: number | null;
  mtu: number | null;
  queues: number | null;
}

export function vmNic(b: Json): VmNicSpec {
  const model = b.model === undefined ? "virtio" : typeof b.model === "string" && (QEMU_NIC_MODELS as readonly string[]).includes(b.model) ? b.model : bad("Unknown network card model");
  const bridge = typeof b.bridge === "string" && BRIDGE_RE.test(b.bridge) ? b.bridge : bad("Pick a bridge");
  const mtu = present(b.mtu) ? int(b.mtu, 1, 65520, "The MTU") : null;
  const queues = present(b.queues) && b.queues !== 0 ? int(b.queues, 1, 64, "Queues") : null;
  if ((mtu !== null || queues !== null) && model !== "virtio") bad("MTU and queues only apply to the VirtIO model");
  return { model, bridge, mac: mac(b.mac), tag: tag(b.tag), trunks: trunks(b.trunks, true), firewall: bool(b.firewall, "Firewall") ?? false, linkDown: bool(b.linkDown, "Disconnected") ?? false, rate: rate(b.rate), mtu, queues };
}

const modelOf = (p: Props) => p.find(([k]) => (QEMU_NIC_MODELS as readonly string[]).includes(k));

/** The device string for a new or edited VM network card. Keeps the MAC address (and any key we don't manage) unless a new MAC is given. */
export function vmNicString(spec: VmNicSpec, existing?: string): string {
  let p: Props = existing ? parseProps(existing) : [];
  const old = modelOf(p);
  if (!old) p = [[spec.model, spec.mac], ...p];
  else p = p.map(([k, v]): [string, string | null] => (k === old[0] ? [spec.model, spec.mac ?? v] : [k, v]));
  // Proxmox also writes the address as macaddr=; a leftover one would fight the model=MAC form.
  p = p.filter(([k]) => k !== "macaddr");
  const first = p.findIndex(([k]) => k === spec.model);
  if (first > 0) p = [p[first], ...p.filter((_, i) => i !== first)]; // the model keeps the first place Proxmox expects
  return serializeProps(
    setProps(p, {
      bridge: spec.bridge,
      firewall: spec.firewall ? "1" : null,
      link_down: spec.linkDown ? "1" : null,
      tag: spec.tag ? String(spec.tag) : null,
      trunks: spec.trunks,
      rate: spec.rate ? String(spec.rate) : null,
      mtu: spec.mtu ? String(spec.mtu) : null,
      queues: spec.queues ? String(spec.queues) : null,
    }),
  );
}

export interface CtNicSpec {
  name: string;
  bridge: string;
  mac: string | null;
  tag: number | null;
  trunks: string | null;
  firewall: boolean;
  linkDown: boolean;
  rate: number | null;
  mtu: number | null;
  ip: string | null; // dhcp, manual or a CIDR; null leaves it unset
  gw: string | null;
  ip6: string | null; // auto, dhcp, manual or a CIDR
  gw6: string | null;
}

export const isCidr4 = (v: string) => {
  const [ip, bits, extra] = v.split("/");
  return extra === undefined && isIPv4(ip ?? "") && /^\d{1,2}$/.test(bits ?? "") && Number(bits) <= 32;
};
export const isCidr6 = (v: string) => {
  const [ip, bits, extra] = v.split("/");
  return extra === undefined && isIPv6(ip ?? "") && /^\d{1,3}$/.test(bits ?? "") && Number(bits) <= 128;
};

export function ctNic(b: Json, takenNames: string[] = []): CtNicSpec {
  const name = typeof b.name === "string" && IFACE_NAME_RE.test(b.name) ? b.name : bad("The device name is 1 to 15 letters, digits, - _ or ., starting with a letter (eth0, for example)");
  if (takenNames.includes(name)) bad(`Another network device in this container is already called ${name}`);
  const bridge = typeof b.bridge === "string" && BRIDGE_RE.test(b.bridge) ? b.bridge : bad("Pick a bridge");
  const ip = !present(b.ip) ? null : typeof b.ip === "string" && (b.ip === "dhcp" || b.ip === "manual" || isCidr4(b.ip)) ? b.ip : bad("Use DHCP, none, or an address like 192.168.1.50/24");
  const gw = !present(b.gw) ? null : typeof b.gw === "string" && isIPv4(b.gw) ? b.gw : bad("The gateway should be an IPv4 address like 192.168.1.1");
  if (gw && (!ip || ip === "dhcp" || ip === "manual")) bad("A gateway goes with a static address");
  const ip6 = !present(b.ip6) ? null : typeof b.ip6 === "string" && (["auto", "dhcp", "manual"].includes(b.ip6) || isCidr6(b.ip6)) ? b.ip6 : bad("Use automatic, DHCP, none, or an IPv6 address like fd00::50/64");
  const gw6 = !present(b.gw6) ? null : typeof b.gw6 === "string" && isIPv6(b.gw6) ? b.gw6 : bad("The IPv6 gateway should be an IPv6 address");
  if (gw6 && (!ip6 || !ip6.includes("/"))) bad("An IPv6 gateway goes with a static IPv6 address");
  const mtu = present(b.mtu) ? int(b.mtu, 64, 65535, "The MTU") : null;
  return { name, bridge, mac: mac(b.mac), tag: tag(b.tag), trunks: trunks(b.trunks, false), firewall: bool(b.firewall, "Firewall") ?? false, linkDown: bool(b.linkDown, "Disconnected") ?? false, rate: rate(b.rate), mtu, ip, gw, ip6, gw6 };
}

export function ctNicString(spec: CtNicSpec, existing?: string): string {
  const p: Props = existing ? parseProps(existing) : [];
  return serializeProps(
    setProps(p, {
      name: spec.name,
      bridge: spec.bridge,
      hwaddr: spec.mac ?? undefined, // an empty box keeps the address the container has
      firewall: spec.firewall ? "1" : null,
      link_down: spec.linkDown ? "1" : null,
      tag: spec.tag ? String(spec.tag) : null,
      trunks: spec.trunks,
      rate: spec.rate ? String(spec.rate) : null,
      mtu: spec.mtu ? String(spec.mtu) : null,
      ip: spec.ip,
      gw: spec.gw,
      ip6: spec.ip6,
      gw6: spec.gw6,
      type: getProp(p, "type") ?? "veth",
    }),
  );
}

export const NIC_KEY_RE = /^net(\d|[12]\d|3[01])$/;

export function nextNetKey(cfg: Json): string {
  for (let i = 0; i < 32; i++) if (!(`net${i}` in cfg)) return `net${i}`;
  return bad("This machine already has 32 network devices");
}

/** Reads a net[n] value into the shape the console shows. */
export function readNic(type: "qemu" | "lxc", key: string, raw: string) {
  const p = parseProps(raw);
  const n = (k: string) => (getProp(p, k) !== undefined && /^\d+(\.\d+)?$/.test(getProp(p, k)!) ? Number(getProp(p, k)) : null);
  const model = type === "qemu" ? modelOf(p)?.[0] ?? null : null;
  return {
    key,
    model,
    name: type === "lxc" ? getProp(p, "name") ?? null : null,
    mac: (type === "qemu" ? (model ? getProp(p, model) : undefined) ?? getProp(p, "macaddr") : getProp(p, "hwaddr")) ?? null,
    bridge: getProp(p, "bridge") ?? null,
    tag: n("tag"),
    trunks: getProp(p, "trunks") ?? null,
    firewall: getProp(p, "firewall") === "1",
    linkDown: getProp(p, "link_down") === "1",
    rate: n("rate"),
    mtu: n("mtu"),
    queues: type === "qemu" ? n("queues") : null,
    ip: type === "lxc" ? getProp(p, "ip") ?? null : null,
    gw: type === "lxc" ? getProp(p, "gw") ?? null : null,
    ip6: type === "lxc" ? getProp(p, "ip6") ?? null : null,
    gw6: type === "lxc" ? getProp(p, "gw6") ?? null : null,
  };
}

// ---- Container DNS and features

const DNS_NAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const LL_RE = /^(fe80:[0-9A-Fa-f:]*)%[A-Za-z][\w.-]{0,14}$/;

const list = (v: unknown, label: string): string[] => (v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x.trim() : bad(`${label} is a list of text`))) : typeof v === "string" ? v.split(/[\s,;]+/) : bad(`${label} is a list`)).filter(Boolean);

export interface DnsSpec {
  nameserver: string[];
  searchdomain: string[];
}

/** An empty result means "use the host's settings", which Proxmox wants as a delete. */
export function ctDns(b: Json): DnsSpec {
  const nameserver = list(b.nameserver, "DNS servers");
  const searchdomain = list(b.searchdomain, "Search domains");
  if (nameserver.length > 3) bad("Linux reads up to 3 DNS servers");
  if (searchdomain.length > 6) bad("Linux reads up to 6 search domains");
  for (const s of nameserver) if (!(isIP(s) || LL_RE.test(s))) bad(`"${s}" isn't an IP address`);
  for (const d of searchdomain) if (!DNS_NAME.test(d)) bad(`"${d}" isn't a domain name`);
  if (new Set(nameserver).size !== nameserver.length) bad("Each DNS server can be listed once");
  return { nameserver, searchdomain };
}

export interface FeaturesSpec {
  nesting: boolean;
  keyctl: boolean;
  fuse: boolean;
  mknod: boolean;
  forceRwSys: boolean;
  mount: string[];
}

const FS_TYPE_RE = /^[a-z][a-z0-9_]{1,15}$/;

export function ctFeatures(b: Json): FeaturesSpec {
  const mount = list(b.mount, "Mount types").map((t) => (FS_TYPE_RE.test(t) ? t : bad(`"${t}" isn't a file system type like nfs or cifs`)));
  if (mount.length > 8 || new Set(mount).size !== mount.length) bad("List each mount type once, up to 8");
  return { nesting: bool(b.nesting, "Nesting") ?? false, keyctl: bool(b.keyctl, "keyctl") ?? false, fuse: bool(b.fuse, "FUSE") ?? false, mknod: bool(b.mknod, "mknod") ?? false, forceRwSys: bool(b.forceRwSys, "Writable /sys") ?? false, mount };
}

/** The `features` value, keeping keys we don't manage. Null means no feature is on, so the key is deleted. */
export function featuresString(spec: FeaturesSpec, existing?: string): string | null {
  const p = setProps(existing ? parseProps(existing) : [], {
    nesting: spec.nesting ? "1" : null,
    keyctl: spec.keyctl ? "1" : null,
    fuse: spec.fuse ? "1" : null,
    mknod: spec.mknod ? "1" : null,
    force_rw_sys: spec.forceRwSys ? "1" : null,
    mount: spec.mount.length ? spec.mount.join(";") : null,
  });
  return p.length ? serializeProps(p) : null;
}

export function readFeatures(raw: unknown): FeaturesSpec {
  const p = parseProps(String(raw ?? ""));
  const on = (k: string) => getProp(p, k) === "1";
  return { nesting: on("nesting"), keyctl: on("keyctl"), fuse: on("fuse"), mknod: on("mknod"), forceRwSys: on("force_rw_sys"), mount: (getProp(p, "mount") ?? "").split(/[;\s]+/).filter(Boolean) };
}

// ---- Resources

/** Proxmox writes a VM's memory as `2048` or, in newer versions, `current=2048`. */
export function memoryOf(raw: unknown, fallback = 512): number {
  const p = parseProps(String(raw ?? ""));
  const v = getProp(p, "current") ?? (p[0] && p[0][1] === null ? p[0][0] : undefined);
  return v && /^\d+$/.test(v) ? Number(v) : fallback;
}

export interface ResourceChanges {
  params: Record<string, string | number>;
  delete: string[];
}

/** Processor and memory limits for a VM or container, as config parameters. A null limit deletes the setting. */
export function resources(type: "qemu" | "lxc", memoryNow: number, b: Json): ResourceChanges {
  const params: Record<string, string | number> = {};
  const del: string[] = [];
  const num = (v: unknown, lo: number, hi: number, label: string) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : bad(`${label} must be from ${lo} to ${hi}`));
  if (b.cores !== undefined) params.cores = int(b.cores, 1, type === "qemu" ? 512 : 8192, "Cores");
  if (b.sockets !== undefined) {
    if (type !== "qemu") bad("Containers don't have sockets");
    params.sockets = int(b.sockets, 1, 16, "Sockets");
  }
  if (b.memory !== undefined) params.memory = int(b.memory, 16, 4_194_304, "Memory (MiB)");
  if (b.swap !== undefined) {
    if (type !== "lxc") bad("Only containers have swap");
    params.swap = int(b.swap, 0, 1_048_576, "Swap (MiB)");
  }
  if (b.balloon !== undefined) {
    if (type !== "qemu") bad("Only VMs have a balloon");
    if (b.balloon === null) del.push("balloon");
    else {
      params.balloon = int(b.balloon, 0, 4_194_304, "The minimum memory (MiB)");
      const memory = Number(params.memory ?? memoryNow);
      if ((params.balloon as number) > 0 && (params.balloon as number) > memory) bad("The minimum memory can't be more than the memory");
    }
  }
  if (b.cpulimit !== undefined) {
    if (b.cpulimit === null || b.cpulimit === 0) del.push("cpulimit");
    else params.cpulimit = num(b.cpulimit, 0.01, type === "qemu" ? 128 : 8192, "The CPU limit");
  }
  if (b.cpuunits !== undefined) {
    if (b.cpuunits === null) del.push("cpuunits");
    else params.cpuunits = int(b.cpuunits, type === "qemu" ? 1 : 0, type === "qemu" ? 262144 : 500000, "CPU weight");
  }
  if (!Object.keys(params).length && !del.length) bad("Nothing to change");
  return { params, delete: del };
}

// ---- Notes and tags

export const TAG_RE = /^[a-z0-9_][a-z0-9_.+-]{0,63}$/;

export function tags(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[;,\s]+/) : bad("Tags are a list");
  const out = raw.map((t) => (typeof t === "string" ? t.trim().toLowerCase() : bad("Tags are text"))).filter(Boolean);
  if (out.length > 20) bad("A machine can have up to 20 tags");
  for (const t of out) if (!TAG_RE.test(t)) bad(`"${t}" isn't a valid tag. Use letters, digits, _ - . and +`);
  return [...new Set(out)];
}

export function description(v: unknown): string {
  if (typeof v !== "string") return bad("Notes are text");
  if (v.length > 8192) bad("Notes are limited to 8192 characters");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) bad("Notes can't contain control characters");
  return v;
}

// ---- VM display, serial, audio, EFI, TPM, BIOS

export const VGA_TYPES = ["std", "cirrus", "qxl", "qxl2", "qxl3", "qxl4", "none", "serial0", "serial1", "serial2", "serial3", "virtio", "virtio-gl", "vmware"] as const;
export const AUDIO_DEVICES = ["ich9-intel-hda", "intel-hda", "AC97"] as const;
export const AUDIO_DRIVERS = ["spice", "none"] as const;
export const SERIAL_KEY_RE = /^serial[0-3]$/;
export const STORAGE_RE = /^[A-Za-z0-9][\w.-]{0,39}$/;

export function display(b: Json): string {
  const type = typeof b.type === "string" && (VGA_TYPES as readonly string[]).includes(b.type) ? b.type : bad("Pick a display type from the list");
  const parts = [`type=${type}`];
  if (present(b.memory)) {
    if (type === "none" || type.startsWith("serial")) bad("This display type has no video memory to set");
    parts.push(`memory=${int(b.memory, 4, 512, "Video memory (MiB)")}`);
  }
  if (present(b.clipboard)) parts.push(b.clipboard === "vnc" ? "clipboard=vnc" : bad("Clipboard sharing is off or VNC"));
  return parts.join(",");
}

export function readDisplay(raw: unknown) {
  const p = parseProps(String(raw ?? ""));
  const first = p[0] && p[0][1] === null ? p[0][0] : getProp(p, "type") ?? "std";
  const mem = getProp(p, "memory");
  return { type: first, memory: mem && /^\d+$/.test(mem) ? Number(mem) : null, clipboard: getProp(p, "clipboard") ?? null };
}

export function serialValue(b: Json, canUseHostDevice: boolean): string {
  if (b.device === "socket" || b.device === undefined) return "socket";
  if (typeof b.device === "string" && /^\/dev\/tty(S|USB|ACM)\d{1,3}$/.test(b.device)) {
    if (!canUseHostDevice) bad("Only Proxmox administrators may hand a host serial port to a VM");
    return b.device;
  }
  return bad("Use a virtual serial port (socket)");
}

export function audioValue(b: Json): string {
  const device = typeof b.device === "string" && (AUDIO_DEVICES as readonly string[]).includes(b.device) ? b.device : bad("Pick an audio device from the list");
  const driver = b.driver === undefined ? "none" : typeof b.driver === "string" && (AUDIO_DRIVERS as readonly string[]).includes(b.driver) ? b.driver : bad("The audio driver is SPICE or none");
  return `device=${device},driver=${driver}`;
}

export function efiValue(b: Json): { value: string; ovmf: boolean } {
  const storage = typeof b.storage === "string" && STORAGE_RE.test(b.storage) ? b.storage : bad("Pick a storage for the EFI disk");
  const efitype = b.efitype === undefined ? "4m" : b.efitype === "4m" || b.efitype === "2m" ? b.efitype : bad("EFI disk type is 4m or 2m");
  const keys = bool(b.preEnrolledKeys, "Pre-enrolled keys") ?? false;
  if (keys && efitype !== "4m") bad("Pre-enrolled keys need the 4m EFI disk type");
  // The size is ignored by Proxmox: the default EFI variables are copied to the new volume.
  return { value: `${storage}:1,efitype=${efitype}${keys ? ",pre-enrolled-keys=1" : ""}`, ovmf: b.setBios !== false };
}

export function tpmValue(b: Json): string {
  const storage = typeof b.storage === "string" && STORAGE_RE.test(b.storage) ? b.storage : bad("Pick a storage for the TPM state");
  const version = b.version === undefined ? "v2.0" : b.version === "v2.0" || b.version === "v1.2" ? b.version : bad("TPM version is v2.0 or v1.2");
  return `${storage}:1,version=${version}`;
}

export function biosValue(v: unknown): "seabios" | "ovmf" {
  return v === "seabios" || v === "ovmf" ? v : bad("BIOS is SeaBIOS or UEFI (OVMF)");
}

// ---- Host devices handed to a machine (read only)

export interface PassthroughItem {
  key: string;
  kind: "pci" | "usb" | "dev";
  /** The PCI address(es), USB id or port, mapping id or device path. */
  target: string;
  mapped: boolean;
  options: string[];
  raw: string;
}

/** hostpciN, usbN (VM) and devN (container) entries as they are configured. */
export function readPassthrough(type: "qemu" | "lxc", cfg: Record<string, unknown>): PassthroughItem[] {
  const out: PassthroughItem[] = [];
  for (const [key, value] of Object.entries(cfg)) {
    const raw = String(value);
    const p = parseProps(raw);
    if (type === "qemu" && /^hostpci\d+$/.test(key)) {
      const mapping = getProp(p, "mapping");
      const host = getProp(p, "host") ?? (p[0] && p[0][1] === null ? p[0][0] : undefined);
      const options = [getProp(p, "pcie") === "1" && "PCI Express", getProp(p, "x-vga") === "1" && "Primary GPU", getProp(p, "rombar") === "0" && "ROM-BAR off", getProp(p, "mdev") && `Mediated ${getProp(p, "mdev")}`, getProp(p, "romfile") && `ROM file ${getProp(p, "romfile")}`, getProp(p, "legacy-igd") === "1" && "Legacy IGD"].filter(Boolean) as string[];
      out.push({ key, kind: "pci", target: mapping ?? host ?? raw, mapped: !!mapping, options, raw });
    } else if (type === "qemu" && /^usb\d+$/.test(key)) {
      const mapping = getProp(p, "mapping");
      const host = getProp(p, "host") ?? (p[0] && p[0][1] === null ? p[0][0] : undefined);
      out.push({ key, kind: "usb", target: mapping ?? host ?? raw, mapped: !!mapping, options: [getProp(p, "usb3") === "1" && "USB 3"].filter(Boolean) as string[], raw });
    } else if (type === "lxc" && /^dev\d+$/.test(key)) {
      const path = getProp(p, "path") ?? (p[0] && p[0][1] === null ? p[0][0] : raw);
      out.push({ key, kind: "dev", target: path, mapped: false, options: [getProp(p, "mode") && `Mode ${getProp(p, "mode")}`, getProp(p, "uid") && `uid ${getProp(p, "uid")}`, getProp(p, "gid") && `gid ${getProp(p, "gid")}`, getProp(p, "deny-write") === "1" && "Read only"].filter(Boolean) as string[], raw });
    }
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key, undefined, { numeric: true }));
}

// ---- Access entries

export const USERID_RE = /^[^\s:/@]{1,60}@[A-Za-z][A-Za-z0-9.-]{0,31}$/;
export const TOKENID_RE = /^[^\s:/@]{1,60}@[A-Za-z][A-Za-z0-9.-]{0,31}![A-Za-z][A-Za-z0-9._-]{1,63}$/;
export const GROUP_RE = /^[A-Za-z0-9][\w.-]{1,63}$/;
export const ROLE_RE = /^[A-Za-z0-9][\w.-]{1,63}$/;

export interface GrantSpec {
  type: "user" | "group" | "token";
  id: string;
  role: string;
  propagate: boolean;
}

export function grant(b: Json): GrantSpec {
  const type = b.type === "user" || b.type === "group" || b.type === "token" ? b.type : bad("Choose a user, a group or an API token");
  const id = typeof b.id === "string" ? b.id : "";
  if (type === "user" && !USERID_RE.test(id)) bad("A user looks like name@pam or name@pve");
  if (type === "token" && !TOKENID_RE.test(id)) bad("An API token looks like name@pve!token");
  if (type === "group" && !GROUP_RE.test(id)) bad("Pick a group");
  const role = typeof b.role === "string" && ROLE_RE.test(b.role) ? b.role : bad("Pick a role");
  return { type, id, role, propagate: bool(b.propagate, "Propagate") ?? true };
}

export function aclParams(path: string, g: GrantSpec, remove: boolean) {
  return { path, roles: g.role, [g.type === "user" ? "users" : g.type === "group" ? "groups" : "tokens"]: g.id, propagate: g.propagate, ...(remove ? { delete: true } : {}) };
}
