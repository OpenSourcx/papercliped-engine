/**
 * Reading and writing Proxmox guest configuration safely. Proxmox stores devices as comma lists
 * ("virtio=BC:24:11:AA:BB:CC,bridge=vmbr0,firewall=1"); edits must keep every key we don't touch (the MAC address
 * above all, or the guest gets a new network identity), so values are parsed into ordered pairs, changed, and
 * written back.
 */

export type Props = [string, string | null][]; // [key, value]; a bare word like "virtio" has value null

export function parseProps(raw: string): Props {
  return raw.split(",").filter(Boolean).map((part): [string, string | null] => {
    const i = part.indexOf("=");
    return i < 0 ? [part, null] : [part.slice(0, i), part.slice(i + 1)];
  });
}

export function serializeProps(p: Props): string {
  return p.map(([k, v]) => (v === null ? k : `${k}=${v}`)).join(",");
}

export const getProp = (p: Props, key: string) => p.find(([k]) => k === key)?.[1] ?? undefined;

/** Sets or removes keys, keeping the order of the ones that stay. */
export function setProps(p: Props, changes: Record<string, string | null | undefined>): Props {
  let out = p.map(([k, v]): [string, string | null] => [k, k in changes && changes[k] !== undefined && changes[k] !== null ? changes[k]! : v]);
  out = out.filter(([k]) => !(k in changes) || changes[k] !== null);
  for (const [k, v] of Object.entries(changes)) if (v !== null && v !== undefined && !out.some(([x]) => x === k)) out.push([k, v]);
  return out;
}

/** "32G" -> 32, "512M" -> 0.5, "1T" -> 1024 (binary units, as Proxmox writes them). */
export function sizeGb(size: string | undefined): number | null {
  const m = size?.match(/^(\d+(?:\.\d+)?)([KMGT]?)$/i);
  if (!m) return null;
  const f: Record<string, number> = { K: 1 / 1024 ** 2, M: 1 / 1024, G: 1, T: 1024, "": 1 / 1024 ** 3 };
  return Math.round(Number(m[1]) * f[m[2].toUpperCase()] * 100) / 100;
}

const QEMU_MODELS = ["virtio", "e1000", "e1000e", "rtl8139", "vmxnet3"];

export interface Disk {
  key: string; // scsi0, sata0, virtio1, rootfs, mp0 ...
  storage: string | null;
  volume: string;
  sizeGb: number | null;
  mount: string | null; // containers: "/" for rootfs, mp=... for mount points
}

export interface Nic {
  key: string; // net0 ...
  model: string | null; // VMs: virtio, e1000e ...
  name: string | null; // containers: eth0 ...
  mac: string | null;
  bridge: string | null;
  tag: number | null;
  firewall: boolean;
  ip: string | null; // containers: dhcp, manual or a CIDR
  gw: string | null;
  rate: number | null; // MB/s
}

export interface GuestHardware {
  type: "lxc" | "qemu";
  name: string | null;
  cores: number;
  sockets: number;
  memoryMb: number;
  swapMb: number | null; // containers only
  balloonMb: number | null; // VMs only
  onboot: boolean;
  description: string;
  tags: string[];
  ostype: string | null;
  disks: Disk[];
  nics: Nic[];
  cdrom: string | null; // VMs: what's in the virtual CD drive
  pending: string[]; // keys Proxmox will apply on next start
  protection: boolean; // Proxmox refuses to delete or overwrite a protected machine
  startup: Startup;
  boot: string[] | null; // VMs: devices in boot order
  bootDevices: string[]; // VMs: devices that can be booted from
  agent: boolean | null; // VMs: QEMU guest agent
}

export interface Startup {
  order: number | null;
  up: number | null; // seconds to wait after starting before the next one
  down: number | null; // seconds to wait for shutdown before the next one
}

export function parseStartup(raw: unknown): Startup {
  const p = parseProps(String(raw ?? ""));
  const n = (k: string) => (getProp(p, k) !== undefined && /^\d+$/.test(getProp(p, k)!) ? Number(getProp(p, k)) : null);
  return { order: n("order"), up: n("up"), down: n("down") };
}

export function startupString(s: Startup): string | null {
  const parts = [s.order !== null ? `order=${s.order}` : null, s.up !== null ? `up=${s.up}` : null, s.down !== null ? `down=${s.down}` : null].filter(Boolean);
  return parts.length ? parts.join(",") : null;
}

/** "order=scsi0;ide2;net0" -> ["scsi0","ide2","net0"] */
export function parseBoot(raw: unknown): string[] | null {
  const order = getProp(parseProps(String(raw ?? "")), "order");
  return order ? order.split(";").filter(Boolean) : null;
}

export const OS_TYPES_QEMU = ["l26", "l24", "win11", "win10", "win8", "win7", "w2k22", "w2k19", "w2k16", "solaris", "other"];

const num = (v: unknown, d: number) => (v === undefined || v === null || v === "" ? d : Number(v));

export function normalizeConfig(type: "lxc" | "qemu", cfg: Record<string, string | number>, pending: string[] = []): GuestHardware {
  const disks: Disk[] = [];
  const nics: Nic[] = [];
  let cdrom: string | null = null;
  for (const [key, value] of Object.entries(cfg)) {
    const raw = String(value);
    const isDisk = type === "lxc" ? key === "rootfs" || /^mp\d+$/.test(key) : /^(scsi|sata|virtio|ide)\d+$/.test(key);
    if (isDisk) {
      const p = parseProps(raw);
      if (type === "qemu" && getProp(p, "media") === "cdrom") {
        cdrom = p[0]?.[0] === "none" ? null : p[0]?.[0] ?? null;
        continue;
      }
      const volume = p[0]?.[0] ?? raw;
      disks.push({ key, storage: volume.includes(":") ? volume.split(":")[0] : null, volume, sizeGb: sizeGb(getProp(p, "size") ?? undefined), mount: key === "rootfs" ? "/" : getProp(p, "mp") ?? null });
    }
    if (/^net\d+$/.test(key)) {
      const p = parseProps(raw);
      const model = type === "qemu" ? p.find(([k]) => QEMU_MODELS.includes(k))?.[0] ?? null : null;
      const tag = getProp(p, "tag");
      const rate = getProp(p, "rate");
      nics.push({
        key,
        model,
        name: type === "lxc" ? getProp(p, "name") ?? null : null,
        mac: (type === "qemu" ? (model ? getProp(p, model) : undefined) : getProp(p, "hwaddr")) ?? null,
        bridge: getProp(p, "bridge") ?? null,
        tag: tag ? Number(tag) : null,
        firewall: getProp(p, "firewall") === "1",
        ip: type === "lxc" ? getProp(p, "ip") ?? null : null,
        gw: type === "lxc" ? getProp(p, "gw") ?? null : null,
        rate: rate ? Number(rate) : null,
      });
    }
  }
  const order = (k: string) => (k === "rootfs" ? -1 : Number(k.match(/\d+$/)?.[0] ?? 0) + (k.startsWith("mp") ? 1000 : 0));
  disks.sort((a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key));
  nics.sort((a, b) => order(a.key) - order(b.key));
  return {
    type,
    name: String(cfg[type === "lxc" ? "hostname" : "name"] ?? "") || null,
    cores: num(cfg.cores, 1),
    sockets: type === "qemu" ? num(cfg.sockets, 1) : 1,
    memoryMb: num(cfg.memory, 512),
    swapMb: type === "lxc" ? num(cfg.swap, 512) : null,
    balloonMb: type === "qemu" && cfg.balloon !== undefined ? Number(cfg.balloon) : null,
    onboot: String(cfg.onboot ?? "0") === "1",
    description: String(cfg.description ?? ""),
    tags: String(cfg.tags ?? "").split(/[;,\s]+/).filter(Boolean),
    ostype: cfg.ostype ? String(cfg.ostype) : null,
    disks,
    nics,
    cdrom,
    pending,
    protection: String(cfg.protection ?? "0") === "1",
    startup: parseStartup(cfg.startup),
    boot: type === "qemu" ? parseBoot(cfg.boot) : null,
    bootDevices: type === "qemu" ? Object.keys(cfg).filter((k) => /^(scsi|sata|virtio|ide)\d+$/.test(k) || /^net\d+$/.test(k)).sort() : [],
    agent: type === "qemu" ? (cfg.agent === undefined ? null : getProp(parseProps(String(cfg.agent)), "enabled") === "1" || String(cfg.agent) === "1" || parseProps(String(cfg.agent))[0]?.[0] === "1") : null,
  };
}

const IFACE_RE = /^[a-z][\w.-]{0,14}$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export const isIpv4 = (v: string) => IPV4.test(v);
export function isCidr4(v: string) {
  const [ip, bits, extra] = v.split("/");
  return extra === undefined && IPV4.test(ip ?? "") && /^\d{1,2}$/.test(bits ?? "") && Number(bits) <= 32;
}
export const isIfaceName = (v: string) => IFACE_RE.test(v);

export interface NicSpec {
  bridge: string;
  model?: string; // VMs
  tag?: number | null;
  firewall: boolean;
  ip?: "dhcp" | "manual" | string; // containers: dhcp, manual or CIDR
  gw?: string | null;
  rate?: number | null;
}

/** Validates a network device edit; throws an Error with a user-facing message. */
export function checkNic(type: "lxc" | "qemu", n: Record<string, unknown>): NicSpec {
  const bad = (m: string): never => {
    throw new Error(m);
  };
  const bridge = typeof n.bridge === "string" && /^[\w.-]{1,15}$/.test(n.bridge) ? n.bridge : bad("Pick a bridge");
  const tag = n.tag === null || n.tag === undefined || n.tag === "" ? null : Number.isInteger(n.tag) && (n.tag as number) >= 1 && (n.tag as number) <= 4094 ? (n.tag as number) : bad("VLAN tags go from 1 to 4094");
  const rate = n.rate === null || n.rate === undefined || n.rate === "" ? null : typeof n.rate === "number" && n.rate > 0 && n.rate <= 100_000 ? n.rate : bad("Rate limit must be a positive number of MB/s");
  const out: NicSpec = { bridge, tag, firewall: n.firewall !== false, rate };
  if (type === "qemu") out.model = n.model === undefined ? "virtio" : QEMU_MODELS.includes(String(n.model)) ? String(n.model) : bad("Unknown network card model");
  if (type === "lxc") {
    const ip = n.ip === undefined ? "dhcp" : String(n.ip);
    if (ip !== "dhcp" && ip !== "manual" && !isCidr4(ip)) bad("Use DHCP or an address like 192.168.1.50/24");
    out.ip = ip;
    out.gw = n.gw === null || n.gw === undefined || n.gw === "" ? null : typeof n.gw === "string" && isIpv4(n.gw) ? n.gw : bad("The gateway should be an IPv4 address");
    if (out.gw && (ip === "dhcp" || ip === "manual")) out.gw = null;
  }
  return out;
}

/** Builds the device string for a new or edited NIC, keeping the MAC address and anything else already set. */
export function nicString(type: "lxc" | "qemu", key: string, spec: NicSpec, existing?: string): string {
  let p = existing ? parseProps(existing) : [];
  if (type === "qemu") {
    const model = p.find(([k]) => QEMU_MODELS.includes(k));
    if (!model) p = [[spec.model ?? "virtio", null], ...p];
    else if (spec.model && model[0] !== spec.model) p = p.map(([k, v]): [string, string | null] => (k === model[0] ? [spec.model!, v] : [k, v])); // keep the MAC under the new model
  } else if (!getProp(p, "name")) {
    p = [["name", `eth${key.replace("net", "")}`], ...p];
  }
  p = setProps(p, {
    bridge: spec.bridge,
    firewall: spec.firewall ? "1" : null,
    tag: spec.tag ? String(spec.tag) : null,
    rate: spec.rate ? String(spec.rate) : null,
    ...(type === "lxc" ? { ip: spec.ip ?? "dhcp", gw: spec.gw ?? null, type: getProp(p, "type") ?? "veth" } : {}),
  });
  return serializeProps(p);
}

/** The lowest free netN key. */
export function nextNicKey(cfg: Record<string, unknown>): string {
  for (let i = 0; i < 32; i++) if (!(`net${i}` in cfg)) return `net${i}`;
  throw new Error("This machine already has 32 network devices");
}

export interface IfaceSpec {
  type: "bridge" | "vlan" | "bond";
  iface: string;
  cidr: string | null;
  gateway: string | null;
  autostart: boolean;
  comments: string | null;
  ports: string[]; // bridge ports
  vlanAware: boolean;
  slaves: string[]; // bond members
  bondMode: string | null;
  vlanRaw: string | null;
  vlanId: number | null;
}

const BOND_MODES = ["balance-rr", "active-backup", "balance-xor", "broadcast", "802.3ad", "balance-tlb", "balance-alb"];

/** Validates a host network interface definition; throws an Error with a user-facing message. */
export function checkIface(b: Record<string, unknown>, creating: boolean): IfaceSpec {
  const bad = (m: string): never => {
    throw new Error(m);
  };
  const type = b.type === "bridge" || b.type === "vlan" || b.type === "bond" ? b.type : bad("Pick bridge, VLAN or bond");
  const iface = typeof b.iface === "string" ? b.iface : "";
  if (creating) {
    if (type === "bridge" && !/^vmbr\d{1,4}$/.test(iface)) bad("Bridges are named vmbr0, vmbr1, …");
    if (type === "bond" && !/^bond\d{1,4}$/.test(iface)) bad("Bonds are named bond0, bond1, …");
    if (type === "vlan" && !/^([a-z][\w-]{0,10}\.\d{1,4}|vlan\d{1,4})$/i.test(iface)) bad("VLANs are named like vmbr0.20 or vlan20");
  } else if (!isIfaceName(iface)) bad("Unknown interface");
  const list = (v: unknown) => (typeof v === "string" ? v.split(/[\s,]+/).filter(Boolean) : Array.isArray(v) ? v.map(String) : []);
  const ports = list(b.ports);
  const slaves = list(b.slaves);
  for (const p of [...ports, ...slaves]) if (!isIfaceName(p)) bad(`"${p}" isn't an interface name`);
  const cidr = b.cidr === null || b.cidr === undefined || b.cidr === "" ? null : typeof b.cidr === "string" && isCidr4(b.cidr) ? b.cidr : bad("Use an address like 192.168.1.10/24");
  const gateway = b.gateway === null || b.gateway === undefined || b.gateway === "" ? null : typeof b.gateway === "string" && isIpv4(b.gateway) ? b.gateway : bad("The gateway should be an IPv4 address");
  if (gateway && !cidr) bad("A gateway needs an address on the same interface");
  const comments = b.comments === null || b.comments === undefined || b.comments === "" ? null : typeof b.comments === "string" && b.comments.length <= 200 && !/[\r\n]/.test(b.comments) ? b.comments : bad("Keep the comment to one line");
  const bondMode = type === "bond" ? (BOND_MODES.includes(String(b.bondMode ?? "active-backup")) ? String(b.bondMode ?? "active-backup") : bad("Unknown bond mode")) : null;
  if (type === "bond" && slaves.length === 0) bad("A bond needs at least one network card");
  let vlanRaw: string | null = null;
  let vlanId: number | null = null;
  if (type === "vlan") {
    const dotted = iface.match(/^(.+)\.(\d+)$/);
    vlanRaw = dotted ? dotted[1] : typeof b.vlanRaw === "string" && isIfaceName(b.vlanRaw) ? b.vlanRaw : bad("Pick the interface the VLAN runs on");
    vlanId = dotted ? Number(dotted[2]) : Number(b.vlanId);
    if (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094) bad("VLAN ids go from 1 to 4094");
  }
  return { type, iface, cidr, gateway, autostart: b.autostart !== false, comments, ports, vlanAware: b.vlanAware === true, slaves, bondMode, vlanRaw, vlanId };
}

/** Proxmox parameters for an interface, with `delete` for fields that were cleared on an edit. */
export function ifaceParams(s: IfaceSpec, creating: boolean): Record<string, string | number | boolean | undefined> {
  const del: string[] = [];
  const p: Record<string, string | number | boolean | undefined> = { type: s.type, autostart: s.autostart };
  if (creating) p.iface = s.iface;
  if (s.cidr) p.cidr = s.cidr;
  else del.push("cidr");
  if (s.gateway) p.gateway = s.gateway;
  else del.push("gateway");
  if (s.comments) p.comments = s.comments;
  else del.push("comments");
  if (s.type === "bridge") {
    if (s.ports.length) p.bridge_ports = s.ports.join(" ");
    else del.push("bridge_ports");
    p.bridge_vlan_aware = s.vlanAware;
  }
  if (s.type === "bond") {
    p.slaves = s.slaves.join(" ");
    p.bond_mode = s.bondMode ?? "active-backup";
  }
  if (s.type === "vlan" && !/\.\d+$/.test(s.iface)) {
    p["vlan-raw-device"] = s.vlanRaw ?? undefined;
    p["vlan-id"] = s.vlanId ?? undefined;
  }
  if (!creating && del.length) p.delete = del.join(",");
  return p;
}

/** Validates the options a person can set on a machine; throws an Error with a user-facing message. */
export function checkMachineOptions(type: "lxc" | "qemu", cfg: Record<string, string | number>, b: Record<string, unknown>): Record<string, string | number | boolean | undefined> {
  const bad = (m: string): never => {
    throw new Error(m);
  };
  const out: Record<string, string | number | boolean | undefined> = {};
  if (b.protection !== undefined) out.protection = typeof b.protection === "boolean" ? b.protection : bad("Protection is on or off");
  if (b.startup !== undefined) {
    const st = b.startup as Record<string, unknown> | null;
    const num = (v: unknown, label: string) => (v === null || v === undefined || v === "" ? null : Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 3600 ? (v as number) : bad(`${label} must be between 0 and 3600 seconds`));
    const order = st && st.order !== null && st.order !== undefined && st.order !== "" ? (Number.isInteger(st.order) && (st.order as number) >= 0 && (st.order as number) <= 9999 ? (st.order as number) : bad("Order is a number from 0 to 9999")) : null;
    const value = st ? startupString({ order, up: num(st.up, "Start delay"), down: num(st.down, "Shutdown timeout") }) : null;
    // An empty value clears it; Proxmox wants that as `delete`.
    if (value === null) out.delete = [out.delete, "startup"].filter(Boolean).join(",");
    else out.startup = value;
  }
  if (b.boot !== undefined) {
    if (type !== "qemu") bad("Containers don't have a boot order");
    const list = Array.isArray(b.boot) ? b.boot.map(String) : bad("Boot order is a list of devices");
    const known = Object.keys(cfg).filter((k) => /^(scsi|sata|virtio|ide)\d+$/.test(k) || /^net\d+$/.test(k));
    if (list.length > 8 || new Set(list).size !== list.length || !list.every((k) => known.includes(k))) bad("Boot from this machine's own disks, CD drive and network cards");
    out.boot = list.length ? `order=${list.join(";")}` : undefined;
    if (!list.length) out.delete = [out.delete, "boot"].filter(Boolean).join(",");
  }
  if (b.agent !== undefined) {
    if (type !== "qemu") bad("Only VMs have a guest agent");
    out.agent = typeof b.agent === "boolean" ? (b.agent ? "1" : "0") : bad("The guest agent is on or off");
  }
  if (b.ostype !== undefined) {
    if (type !== "qemu") bad("A container's OS type is set when it's created");
    out.ostype = OS_TYPES_QEMU.includes(String(b.ostype)) ? String(b.ostype) : bad("Unknown OS type");
  }
  return out;
}
