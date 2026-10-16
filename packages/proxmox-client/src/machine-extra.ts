/**
 * More shared checks for the machine page: handing host devices to a machine (PCI, USB, container devices), resource
 * mappings, Cloud-Init, clone options, power options, delete options and guest agent actions. Same rules as
 * machine-schema.ts: every key and range comes from the API viewer (apidoc.js), nothing is sent unchecked, and a
 * refusal is a sentence a person can act on. Secrets (a Cloud-Init password) are only ever written to Proxmox.
 */
import { MachineError, bad, emptyChange, getProp, parseProps, readSettings, type Cfg, type Change, type Json, type Props } from "./machine-schema.ts";

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const present = (v: unknown) => v !== undefined && v !== null && v !== "";
const asBool = (v: unknown, label: string): boolean => (typeof v === "boolean" ? v : bad(`${label} is on or off`));
function whole(v: unknown, lo: number, hi: number, label: string): number {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi ? n : bad(`${label} must be a whole number from ${lo} to ${hi}`);
}
function only(b: Json, allowed: string[]) {
  for (const k of Object.keys(b)) if (!allowed.includes(k) && k !== "digest") bad(`Unknown field “${k}”`, k);
}

export const MAX_HOSTPCI = 16;
export const MAX_USB = 14;
export const MAX_CT_DEV = 32;

// ---- Host devices for a machine

export interface PassthroughContext {
  /** The signed-in account is root@pam, the only one Proxmox lets hand raw host devices to a machine. */
  root: boolean;
  /** Mapping ids this account may use, when it could be read. */
  pciMappings?: string[];
  usbMappings?: string[];
}

export const RAW_DEVICE_EXPLAINER =
  "Proxmox lets only root@pam hand a raw host device to a machine. Everyone else uses a saved mapping: an administrator creates it under Datacenter, Resource mappings, and gives you the Mapping.Use permission on it.";

const PCI_ID = /^(?:[0-9a-fA-F]{4,}:)?[0-9a-fA-F]{2}:[0-9a-fA-F]{2}(?:\.[0-7])?$/;
const USB_HOST = /^(?:(?:0x)?[0-9A-Fa-f]{4}:(?:0x)?[0-9A-Fa-f]{4}|\d+-\d+(?:\.\d+)*)$/;
const HEX_ID = /^(?:0x)?[0-9a-fA-F]{1,4}$/;
const MAPPING_ID = /^[A-Za-z][\w-]{1,63}$/;
const free = (cfg: Cfg, prefix: string, max: number) => Array.from({ length: max }, (_, i) => `${prefix}${i}`).find((k) => !(k in cfg));
const isQ35 = (cfg: Cfg) => {
  const t = getProp(parseProps(str(cfg.machine)), "type") ?? (() => {
    const p = parseProps(str(cfg.machine));
    return p[0] && p[0][1] === null ? p[0][0] : "";
  })();
  return t === "q35" || t.startsWith("pc-q35");
};

/** Adds, changes or removes one host device on a machine: `hostpciN`, `usbN` (VM) or `devN` (container). */
export function planPassthrough(type: "qemu" | "lxc", cfg: Cfg, b: Json, ctx: PassthroughContext): Change {
  const c = emptyChange();
  const kind = b.kind;
  if (b.action !== "add" && b.action !== "set" && b.action !== "remove") bad("Choose what to do");
  if (type === "lxc") {
    if (kind !== "dev") bad("Containers get host devices as device nodes");
  } else if (kind !== "pci" && kind !== "usb") bad("Choose a PCI or USB device");
  const prefix = kind === "pci" ? "hostpci" : kind === "usb" ? "usb" : "dev";
  const max = kind === "pci" ? MAX_HOSTPCI : kind === "usb" ? MAX_USB : MAX_CT_DEV;
  const key = typeof b.key === "string" && new RegExp(`^${prefix}\\d{1,2}$`).test(b.key) && Number(b.key.slice(prefix.length)) < max ? b.key : b.key === undefined || b.key === null ? free(cfg, prefix, max) : bad("Unknown device slot", "key");
  if (!key) return bad(`All ${max} device slots are in use`);
  if (b.action === "remove") {
    if (!(key in cfg)) bad("That device isn't on this machine", "key");
    c.delete.push(key);
    return c;
  }
  if (b.action === "set" && !(key in cfg)) bad("That device isn't on this machine", "key");
  if (b.action === "add" && key in cfg) bad("That slot is already used", "key");

  if (kind === "dev") {
    only(b, ["kind", "action", "key", "path", "mode", "uid", "gid", "denyWrite"]);
    // Proxmox: only root@pam may add device passthrough to a container.
    if (!ctx.root) bad("Proxmox lets only root@pam pass a host device through to a container. Ask an administrator to add it.");
    const path = typeof b.path === "string" && /^\/dev\/[A-Za-z0-9_./-]{1,100}$/.test(b.path) && !b.path.includes("..") && !b.path.endsWith("/") ? b.path : bad("A device path looks like /dev/dri/renderD128", "path");
    const parts = [`path=${path}`];
    if (present(b.mode)) parts.push(`mode=${typeof b.mode === "string" && /^0[0-7]{3}$/.test(b.mode) ? b.mode : bad("The access mode is octal, like 0660", "mode")}`);
    if (present(b.uid)) parts.push(`uid=${whole(b.uid, 0, 4_294_967_295, "The user ID")}`);
    if (present(b.gid)) parts.push(`gid=${whole(b.gid, 0, 4_294_967_295, "The group ID")}`);
    if (b.denyWrite !== undefined && asBool(b.denyWrite, "Read only")) parts.push("deny-write=1");
    const dup = Object.entries(cfg).find(([k, v]) => /^dev\d+$/.test(k) && k !== key && getProp(parseProps(str(v)), "path") === path);
    if (dup) bad(`${path} is already passed through as ${dup[0]}`, "path");
    c.set[key] = parts.join(",");
    c.warnings.push("The device is passed through when the container next starts.");
    return c;
  }

  if (kind === "pci") {
    only(b, ["kind", "action", "key", "source", "host", "mapping", "pcie", "xVga", "rombar", "romfile", "mdev", "legacyIgd", "vendorId", "deviceId", "subVendorId", "subDeviceId"]);
    const source = b.source === "raw" || b.source === "mapping" ? b.source : bad("Choose a saved mapping or a device on the host", "source");
    const parts: string[] = [];
    const rootOnly: string[] = [];
    if (source === "mapping") {
      const m = typeof b.mapping === "string" && MAPPING_ID.test(b.mapping) ? b.mapping : bad("Pick a saved mapping", "mapping");
      if (ctx.pciMappings && !ctx.pciMappings.includes(m)) bad(`There is no PCI mapping called ${m}, or your account can't use it`, "mapping");
      parts.push(`mapping=${m}`);
      if (present(b.mdev)) parts.push(`mdev=${typeof b.mdev === "string" && /^[\w.-]{1,64}$/.test(b.mdev) ? b.mdev : bad("A mediated device type looks like nvidia-63", "mdev")}`);
    } else {
      if (!ctx.root) bad(RAW_DEVICE_EXPLAINER, "source");
      const hosts = (Array.isArray(b.host) ? b.host : [b.host]).map((h) => (typeof h === "string" && PCI_ID.test(h.trim()) ? h.trim() : bad("A PCI device looks like 0000:01:00.0", "host")));
      if (!hosts.length || hosts.length > 8) bad("Pick 1 to 8 PCI devices", "host");
      if (new Set(hosts).size !== hosts.length) bad("List each PCI device once", "host");
      for (const [k, v] of Object.entries(cfg)) {
        if (!/^hostpci\d+$/.test(k) || k === key) continue;
        const other = (getProp(parseProps(str(v)), "host") ?? parseProps(str(v))[0]?.[0] ?? "").split(";");
        const clash = hosts.find((h) => other.includes(h));
        if (clash) bad(`${clash} is already passed through as ${k}`, "host");
      }
      parts.push(`host=${hosts.join(";")}`);
      if (present(b.mdev)) parts.push(`mdev=${typeof b.mdev === "string" && /^[\w.-]{1,64}$/.test(b.mdev) ? b.mdev : bad("A mediated device type looks like nvidia-63", "mdev")}`);
    }
    if (b.pcie !== undefined && asBool(b.pcie, "PCI Express")) {
      if (!isQ35(cfg)) bad("PCI Express needs the q35 machine type. Change the machine type first (Hardware, Machine).", "pcie");
      parts.push("pcie=1");
    }
    if (b.xVga !== undefined && asBool(b.xVga, "Primary GPU")) {
      parts.push("x-vga=1");
      if (str(cfg.bios) !== "ovmf") c.warnings.push("A GPU that is the primary display usually needs UEFI (OVMF). Change the BIOS in Firmware and devices.");
      if (!parts.includes("pcie=1")) c.warnings.push("Most modern GPUs work best with PCI Express turned on.");
    }
    if (b.rombar !== undefined && !asBool(b.rombar, "ROM-BAR")) parts.push("rombar=0");
    if (present(b.romfile)) {
      rootOnly.push("romfile");
      parts.push(`romfile=${typeof b.romfile === "string" && /^[\w.-]{1,128}\.(rom|bin)$/.test(b.romfile) ? b.romfile : bad("A ROM file name looks like card.rom (in /usr/share/kvm)", "romfile")}`);
    }
    if (b.legacyIgd !== undefined && asBool(b.legacyIgd, "Legacy IGD")) {
      rootOnly.push("legacy-igd");
      parts.push("legacy-igd=1");
    }
    for (const [field, key2] of [["vendorId", "vendor-id"], ["deviceId", "device-id"], ["subVendorId", "sub-vendor-id"], ["subDeviceId", "sub-device-id"]] as const) {
      if (!present(b[field])) continue;
      rootOnly.push(key2);
      parts.push(`${key2}=${typeof b[field] === "string" && HEX_ID.test(b[field] as string) ? b[field] : bad("An ID is a hex number like 0x10de", field)}`);
    }
    if (rootOnly.length && !ctx.root) bad(`Only root@pam may set ${rootOnly.join(", ")}.`);
    const balloon = Number(cfg.balloon ?? 0);
    if (balloon > 0) c.warnings.push("Memory ballooning doesn't work together with PCI passthrough. Set the minimum memory to 0 in Processor and memory.");
    c.warnings.push("A VM with a host device passed through can't be live-migrated or snapshotted with its memory. It takes effect when the VM next starts.");
    c.set[key] = parts.join(",");
    return c;
  }

  // usb
  only(b, ["kind", "action", "key", "source", "host", "mapping", "usb3"]);
  const source = b.source === "host" || b.source === "port" || b.source === "mapping" || b.source === "spice" ? b.source : bad("Choose a device, a port, a mapping or SPICE", "source");
  let first: string;
  if (source === "spice") first = "host=spice";
  else if (source === "mapping") {
    const m = typeof b.mapping === "string" && MAPPING_ID.test(b.mapping) ? b.mapping : bad("Pick a saved mapping", "mapping");
    if (ctx.usbMappings && !ctx.usbMappings.includes(m)) bad(`There is no USB mapping called ${m}, or your account can't use it`, "mapping");
    first = `mapping=${m}`;
  } else {
    if (!ctx.root) bad(RAW_DEVICE_EXPLAINER, "source");
    const h = typeof b.host === "string" && USB_HOST.test(b.host.trim()) ? b.host.trim() : bad(source === "port" ? "A USB port looks like 1-2.3" : "A USB device looks like 1234:abcd", "host");
    if (source === "host" && !/^(?:0x)?[0-9A-Fa-f]{4}:/.test(h)) bad("A USB device looks like 1234:abcd", "host");
    if (source === "port" && !/^\d+-/.test(h)) bad("A USB port looks like 1-2.3", "host");
    for (const [k, v] of Object.entries(cfg)) if (/^usb\d+$/.test(k) && k !== key && getProp(parseProps(str(v)), "host") === h) bad(`${h} is already passed through as ${k}`, "host");
    first = `host=${h}`;
  }
  const parts = [first];
  if (b.usb3 !== undefined && asBool(b.usb3, "USB 3") && source !== "spice") parts.push("usb3=1");
  c.set[key] = parts.join(",");
  if (source !== "spice") c.warnings.push("The device is attached when the VM next starts. A VM with a host USB device passed through can't be live-migrated.");
  return c;
}

// ---- Resource mappings (Datacenter, Resource mappings)

export interface MappingEntry {
  node: string;
  path: string;
  id: string;
  iommugroup: number | null;
  subsystemId: string | null;
  description: string | null;
}

const NODE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const VENDOR_DEVICE = /^[0-9A-Fa-f]{4}:[0-9A-Fa-f]{4}$/;
const PCI_PATHS = /^(?:[a-f0-9]{4,}:[a-f0-9]{2}:[a-f0-9]{2}(?:\.[a-f0-9])?;)*[a-f0-9]{4,}:[a-f0-9]{2}:[a-f0-9]{2}(?:\.[a-f0-9])?$/;
const USB_PATH = /^\d+-\d+(?:\.\d+)*$/;
const DIR_PATH = /^\/[^,\0\\]*$/;

export function parseMapEntry(raw: string): MappingEntry {
  const p: Props = parseProps(raw);
  const n = getProp(p, "iommugroup");
  return { node: getProp(p, "node") ?? "", path: getProp(p, "path") ?? "", id: getProp(p, "id") ?? "", iommugroup: n && /^-?\d+$/.test(n) ? Number(n) : null, subsystemId: getProp(p, "subsystem-id") ?? null, description: getProp(p, "description") ?? null };
}

export interface MappingBody {
  id: string;
  description: string | null;
  mdev: boolean;
  map: string[];
}

/** Checks a mapping (PCI, USB or directory) and returns its Proxmox parameters. `id` is required when creating. */
export function planMapping(kind: "pci" | "usb" | "dir", b: Json, creating: boolean): { id: string; params: Record<string, string | boolean | string[] | undefined>; clearDescription: boolean } {
  only(b, ["id", "description", "mdev", "map"]);
  const id = typeof b.id === "string" && MAPPING_ID.test(b.id) ? b.id : bad("A mapping name has 2 to 64 letters, digits, _ or -, starting with a letter", "id");
  void creating;
  let description: string | undefined;
  if (present(b.description)) description = typeof b.description === "string" && b.description.length <= 4096 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(b.description) ? b.description : bad("The description is too long", "description");
  const entries = Array.isArray(b.map) ? b.map : bad("Add at least one device for a node", "map");
  if (!entries.length || entries.length > 64) bad("A mapping lists 1 to 64 devices", "map");
  const lines: string[] = [];
  const perNode = new Set<string>();
  entries.forEach((e, i) => {
    const o = (typeof e === "object" && e !== null ? e : bad("A device entry is a group of fields", "map")) as Json;
    only(o, ["node", "path", "id", "iommugroup", "subsystemId", "description"]);
    const node = typeof o.node === "string" && NODE_RE.test(o.node) ? o.node : bad("Each device is on a node", `map.${i}.node`);
    const path = str(o.path);
    const parts = [`node=${node}`];
    if (kind === "pci") {
      if (!PCI_PATHS.test(path)) bad("A PCI path looks like 0000:01:00.0, or several joined with ;", `map.${i}.path`);
      const did = typeof o.id === "string" && VENDOR_DEVICE.test(o.id) ? o.id.toLowerCase() : bad("The vendor and device ID looks like 10de:2484", `map.${i}.id`);
      parts.push(`path=${path}`, `id=${did}`);
      if (present(o.iommugroup)) parts.push(`iommugroup=${whole(o.iommugroup, -1, 65535, "The IOMMU group")}`);
      if (present(o.subsystemId)) parts.push(`subsystem-id=${typeof o.subsystemId === "string" && VENDOR_DEVICE.test(o.subsystemId) ? o.subsystemId.toLowerCase() : bad("The subsystem ID looks like 1458:4000", `map.${i}.subsystemId`)}`);
    } else if (kind === "usb") {
      const did = typeof o.id === "string" && VENDOR_DEVICE.test(o.id) ? o.id.toLowerCase() : bad("The vendor and device ID looks like 1050:0407", `map.${i}.id`);
      parts.push(`id=${did}`);
      if (present(path)) parts.push(`path=${USB_PATH.test(path) ? path : bad("A USB port looks like 1-2.3", `map.${i}.path`)}`);
    } else {
      if (!DIR_PATH.test(path) || path.split("/").includes("..") || path.length > 4000) bad("A directory is an absolute path like /srv/share", `map.${i}.path`);
      parts.push(`path=${path}`);
    }
    if (present(o.description)) {
      if (typeof o.description !== "string" || o.description.length > 4096 || /[,\n\r]/.test(o.description)) bad("A device note can't have commas or line breaks", `map.${i}.description`);
      if (kind !== "dir") parts.push(`description=${o.description}`);
    }
    // PCI and USB mappings may list several devices for one node (alternatives); directory mappings take one path per node.
    if (kind === "dir") {
      if (perNode.has(node)) bad(`${node} is listed twice`, `map.${i}.node`);
      perNode.add(node);
    }
    lines.push(parts.join(","));
  });
  const params: Record<string, string | boolean | string[] | undefined> = { id, map: lines };
  if (description !== undefined) params.description = description;
  if (kind === "pci" && b.mdev !== undefined) params.mdev = asBool(b.mdev, "Mediated devices");
  return { id, params, clearDescription: !present(b.description) };
}

// ---- Cloud-Init

const SSH_KEY = /^(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+(?: [^\n\r]{0,200})?$/;
const CI_USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
const CI_VOLUME = /^[A-Za-z0-9][\w.-]{0,39}:(?:snippets\/)?[\w.-]{1,128}$/;
const DNS_LABEL = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
export const CI_TYPES = ["nocloud", "configdrive2", "opennebula"] as const;

const v4 = (s: string) => {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return !!m && m.slice(1).every((o) => Number(o) <= 255 && String(Number(o)) === o);
};
const v6 = (s: string) => {
  if (!/^[0-9A-Fa-f:.]+$/.test(s) || s.includes(":::")) return false;
  const dbl = s.split("::");
  if (dbl.length > 2) return false;
  const groups = (p: string) => (p === "" ? [] : p.split(":"));
  const all = [...groups(dbl[0]), ...(dbl[1] !== undefined ? groups(dbl[1]) : [])];
  if (!all.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g))) return false;
  return dbl.length === 2 ? all.length < 8 : all.length === 8;
};
const cidr = (s: string, six: boolean) => {
  const [a, l, more] = s.split("/");
  return more === undefined && /^\d{1,3}$/.test(l ?? "") && (six ? v6(a ?? "") && Number(l) >= 1 && Number(l) <= 128 : v4(a ?? "") && Number(l) >= 1 && Number(l) <= 32);
};

export interface CloudInitView {
  drive: { key: string; volume: string } | null;
  user: string | null;
  hasPassword: boolean;
  sshKeys: string;
  type: string | null;
  upgrade: boolean;
  nameserver: string[];
  searchdomain: string | null;
  ipconfig: { key: string; net: string; ip: string | null; gw: string | null; ip6: string | null; gw6: string | null }[];
  custom: { user: string | null; network: string | null; meta: string | null; vendor: string | null };
}

export function readCloudInit(cfg: Cfg): CloudInitView {
  const driveKey = Object.keys(cfg).find((k) => /^(ide|sata|scsi|virtio)\d+$/.test(k) && /cloudinit/.test(str(cfg[k]).split(",")[0]));
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const nics = Object.keys(cfg).filter((k) => /^net\d+$/.test(k)).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
  const custom = parseProps(str(cfg.cicustom));
  return {
    drive: driveKey ? { key: driveKey, volume: str(cfg[driveKey]).split(",")[0] } : null,
    user: str(cfg.ciuser) || null,
    hasPassword: present(cfg.cipassword),
    sshKeys: decode(str(cfg.sshkeys)).trim(),
    type: str(cfg.citype) || null,
    upgrade: !present(cfg.ciupgrade) || str(cfg.ciupgrade) === "1",
    nameserver: str(cfg.nameserver).split(/\s+/).filter(Boolean),
    searchdomain: str(cfg.searchdomain) || null,
    ipconfig: nics.map((net) => {
      const key = `ipconfig${net.slice(3)}`;
      const p = parseProps(str(cfg[key]));
      return { key, net, ip: getProp(p, "ip") ?? null, gw: getProp(p, "gw") ?? null, ip6: getProp(p, "ip6") ?? null, gw6: getProp(p, "gw6") ?? null };
    }),
    custom: { user: getProp(custom, "user") ?? null, network: getProp(custom, "network") ?? null, meta: getProp(custom, "meta") ?? null, vendor: getProp(custom, "vendor") ?? null },
  };
}

/** One network device's Cloud-Init address, as `ipconfigN`. Empty fields mean "leave that family unset". */
export function ipconfigString(o: Json, field: string): string | null {
  only(o, ["ip", "gw", "ip6", "gw6"]);
  const parts: string[] = [];
  const ip = str(o.ip).trim();
  const gw = str(o.gw).trim();
  const ip6 = str(o.ip6).trim();
  const gw6 = str(o.gw6).trim();
  if (ip) {
    if (ip !== "dhcp" && !cidr(ip, false)) bad("An IPv4 address needs its prefix, like 192.168.1.50/24, or DHCP", `${field}.ip`);
    parts.push(`ip=${ip}`);
  }
  if (gw) {
    if (!v4(gw) || ip === "" || ip === "dhcp") bad("A gateway is an IPv4 address and goes with a static address", `${field}.gw`);
    parts.push(`gw=${gw}`);
  }
  if (ip6) {
    if (!["dhcp", "auto"].includes(ip6) && !cidr(ip6, true)) bad("An IPv6 address needs its prefix, like fd00::50/64, or auto or DHCP", `${field}.ip6`);
    parts.push(`ip6=${ip6}`);
  }
  if (gw6) {
    if (!v6(gw6) || !cidr(ip6, true)) bad("An IPv6 gateway is an IPv6 address and goes with a static IPv6 address", `${field}.gw6`);
    parts.push(`gw6=${gw6}`);
  }
  return parts.length ? parts.join(",") : null;
}

const DRIVE_SLOTS = ["ide0", "ide2", "sata5", "scsi30"];

/**
 * Cloud-Init for an existing VM. Fields left out stay as they are; `null` clears one. The password is write-only:
 * `password` sets it, `clearPassword: true` removes it, and it is never read back. SSH keys are stored URL-encoded.
 */
export function planCloudInit(cfg: Cfg, b: Json, ctx: { storages?: string[] } = {}): Change {
  only(b, ["user", "password", "clearPassword", "sshKeys", "type", "upgrade", "nameserver", "searchdomain", "ipconfig", "custom", "drive"]);
  const c = emptyChange();
  const view = readCloudInit(cfg);
  if (b.drive !== undefined) {
    const d = (typeof b.drive === "object" && b.drive !== null ? b.drive : bad("Choose a storage for the drive", "drive")) as Json;
    only(d, ["storage"]);
    if (view.drive) bad("This VM already has a Cloud-Init drive", "drive");
    const storage = typeof d.storage === "string" && /^[A-Za-z0-9][\w.-]{0,39}$/.test(d.storage) ? d.storage : bad("Choose a storage for the Cloud-Init drive", "drive");
    if (ctx.storages && !ctx.storages.includes(storage)) bad(`${storage} can't hold VM disks`, "drive");
    const slot = DRIVE_SLOTS.find((k) => !(k in cfg));
    if (!slot) bad("There's no free slot for the Cloud-Init drive");
    c.set[slot!] = `${storage}:cloudinit`;
  }
  const text = (field: string, v: unknown, re: RegExp, msg: string, key: string) => {
    if (v === null || v === "") c.delete.push(key);
    else c.set[key] = typeof v === "string" && re.test(v.trim()) ? v.trim() : bad(msg, field);
  };
  if (b.user !== undefined) text("user", b.user, CI_USER, "The user name uses letters, digits, _ . and -, up to 32 characters", "ciuser");
  if (b.password !== undefined && b.password !== null && b.password !== "") {
    if (typeof b.password !== "string" || b.password.length < 8 || b.password.length > 128 || /[\r\n]/.test(b.password)) bad("The password needs 8 to 128 characters on one line", "password");
    c.set.cipassword = String(b.password);
  } else if (b.clearPassword === true) c.delete.push("cipassword");
  if (b.sshKeys !== undefined) {
    if (b.sshKeys === null || str(b.sshKeys).trim() === "") c.delete.push("sshkeys");
    else {
      const raw = typeof b.sshKeys === "string" && b.sshKeys.length <= 16384 ? b.sshKeys : bad("That doesn't look like an SSH public key", "sshKeys");
      const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!lines.length || lines.length > 32 || !lines.every((l) => SSH_KEY.test(l))) bad("That doesn't look like an SSH public key. Paste one key per line, starting with ssh-ed25519 or ssh-rsa", "sshKeys");
      c.set.sshkeys = encodeURIComponent(lines.join("\n"));
    }
  }
  if (b.type !== undefined) {
    if (b.type === null) c.delete.push("citype");
    else c.set.citype = typeof b.type === "string" && (CI_TYPES as readonly string[]).includes(b.type) ? b.type : bad("The Cloud-Init type is nocloud, configdrive2 or opennebula", "type");
  }
  if (b.upgrade !== undefined) c.set.ciupgrade = asBool(b.upgrade, "Upgrade packages on first boot") ? "1" : "0";
  if (b.nameserver !== undefined) {
    const l = b.nameserver === null ? [] : Array.isArray(b.nameserver) ? b.nameserver : bad("DNS servers are a list", "nameserver");
    if (l.length > 3) bad("Use up to 3 DNS servers", "nameserver");
    const ips = l.map((x) => (typeof x === "string" && (v4(x.trim()) || v6(x.trim())) ? x.trim() : bad("A DNS server needs an IP address", "nameserver")));
    if (ips.length) c.set.nameserver = ips.join(" ");
    else c.delete.push("nameserver");
  }
  if (b.searchdomain !== undefined) text("searchdomain", b.searchdomain, DNS_LABEL, "The search domain looks like example.lan", "searchdomain");
  if (b.ipconfig !== undefined) {
    const o = (typeof b.ipconfig === "object" && b.ipconfig !== null ? b.ipconfig : bad("Addresses are per network device", "ipconfig")) as Json;
    for (const [k, v] of Object.entries(o)) {
      if (!/^ipconfig\d{1,2}$/.test(k)) bad("Addresses belong to a network device (ipconfig0, ipconfig1 ...)", "ipconfig");
      if (v !== null && !(`net${k.slice(8)}` in cfg)) bad(`This VM has no network device net${k.slice(8)}`, "ipconfig");
      const s = v === null ? null : ipconfigString((v as Json) ?? {}, k);
      if (s) c.set[k] = s;
      else c.delete.push(k);
    }
  }
  if (b.custom !== undefined) {
    const o = (typeof b.custom === "object" && b.custom !== null ? b.custom : bad("Custom files are a group", "custom")) as Json;
    only(o, ["user", "network", "meta", "vendor"]);
    const p = parseProps(str(cfg.cicustom));
    const next: Record<string, string | null> = {};
    for (const k of ["user", "network", "meta", "vendor"] as const) {
      if (o[k] === undefined) continue;
      if (o[k] === null || o[k] === "") next[k] = null;
      else next[k] = typeof o[k] === "string" && CI_VOLUME.test(o[k] as string) ? (o[k] as string) : bad("A custom file is a snippet, like local:snippets/user.yaml", `custom.${k}`);
    }
    const merged = p.filter(([k]) => !(k in next)).concat(Object.entries(next).filter(([, v]) => v !== null).map(([k, v]): [string, string | null] => [k, v]));
    const s = merged.map(([k, v]) => (v === null ? k : `${k}=${v}`)).join(",");
    if (s) c.set.cicustom = s;
    else c.delete.push("cicustom");
    c.warnings.push("A custom file replaces what Proxmox generates for that part, so the matching fields above are ignored by the guest.");
  }
  if (!Object.keys(c.set).length && !c.delete.length) bad("Nothing to change");
  const hasUser = (c.set.ciuser ?? view.user) || (c.set.cipassword !== undefined || (view.hasPassword && !c.delete.includes("cipassword"))) || (c.set.sshkeys ?? view.sshKeys);
  if (!hasUser) c.warnings.push("Cloud-Init has no user, password or SSH key, so you may not be able to sign in.");
  return c;
}

/** Removing the Cloud-Init drive. */
export function planCloudInitDrive(cfg: Cfg, b: Json): Change {
  only(b, ["confirm"]);
  const view = readCloudInit(cfg);
  if (!view.drive) bad("This VM has no Cloud-Init drive");
  if (b.confirm !== view.drive!.key) throw new MachineError(`Type ${view.drive!.key} to confirm.`, "confirm");
  const c = emptyChange();
  c.delete.push(view.drive!.key);
  return c;
}

export const CLOUDINIT_KEYS = ["ciuser", "cipassword", "sshkeys", "citype", "ciupgrade", "nameserver", "searchdomain", "cicustom"];

// ---- Clone

export interface CloneOptions {
  newid: number | null;
  name: string | null;
  target: string | null;
  storage: string | null;
  format: "raw" | "qcow2" | "vmdk" | null;
  full: boolean;
  snapname: string | null;
  pool: string | null;
  bwlimit: number | null;
  description: string | null;
  cloudInit: Json | null;
  start: boolean;
  growGb: number | null;
}

const HOST_RE = /^(?=.{1,63}$)[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/;

export function checkClone(type: "qemu" | "lxc", isTemplate: boolean, b: Json): CloneOptions {
  only(b, ["newid", "name", "target", "storage", "format", "full", "snapname", "pool", "bwlimit", "description", "cloudInit", "start", "growGb"]);
  const name = present(b.name) ? (typeof b.name === "string" && DNS_LABEL.test(b.name) && b.name.length <= 63 ? b.name : bad("Use letters, digits and hyphens for the name", "name")) : null;
  if (name && !HOST_RE.test(name) && type === "lxc") bad("Use letters, digits and hyphens for the name", "name");
  const full = b.full === undefined ? !isTemplate : asBool(b.full, "Full clone");
  if (!full && !isTemplate && type === "qemu") bad("A linked clone needs a template. Convert this machine to a template first, or make a full clone.", "full");
  const storage = present(b.storage) ? (typeof b.storage === "string" && /^[A-Za-z0-9][\w.-]{0,39}$/.test(b.storage) ? b.storage : bad("Unknown storage", "storage")) : null;
  if (storage && !full) bad("A linked clone stays on the template's storage. Choose a full clone to pick another.", "storage");
  const format = present(b.format) ? (b.format === "raw" || b.format === "qcow2" || b.format === "vmdk" ? b.format : bad("The format is raw, qcow2 or vmdk", "format")) : null;
  if (format && type !== "qemu") bad("Only VM disks have a format", "format");
  if (format && !full) bad("The format only applies to a full clone", "format");
  const cloudInit = present(b.cloudInit) ? ((typeof b.cloudInit === "object" ? b.cloudInit : bad("Cloud-Init is a group", "cloudInit")) as Json) : null;
  if (cloudInit && type !== "qemu") bad("Cloud-Init is for virtual machines", "cloudInit");
  return {
    newid: present(b.newid) ? whole(b.newid, 100, 999_999_999, "The machine number") : null,
    name,
    target: present(b.target) ? (typeof b.target === "string" && NODE_RE.test(b.target) ? b.target : bad("Unknown node", "target")) : null,
    storage,
    format,
    full,
    snapname: present(b.snapname) ? (typeof b.snapname === "string" && /^[A-Za-z][\w-]{0,39}$/.test(b.snapname) ? b.snapname : bad("Unknown snapshot", "snapname")) : null,
    pool: present(b.pool) ? (typeof b.pool === "string" && /^[A-Za-z0-9][\w.-]{0,63}$/.test(b.pool) ? b.pool : bad("Unknown resource group", "pool")) : null,
    bwlimit: present(b.bwlimit) ? whole(b.bwlimit, 0, 1_000_000_000, "The bandwidth limit (KiB/s)") : null,
    description: present(b.description) ? (typeof b.description === "string" && b.description.length <= 4096 ? b.description : bad("The note is too long", "description")) : null,
    cloudInit,
    start: b.start === undefined ? false : asBool(b.start, "Start after cloning"),
    growGb: present(b.growGb) ? whole(b.growGb, 1, 65_536, "Grow the disk by (GiB)") : null,
  };
}

// ---- Power

export const POWER_ACTIONS = ["start", "shutdown", "stop", "reboot", "reset", "suspend", "hibernate", "resume"] as const;
export type PowerName = (typeof POWER_ACTIONS)[number];

export interface PowerRequest {
  action: PowerName;
  /** POST .../status/<path> */
  path: "start" | "shutdown" | "stop" | "reboot" | "reset" | "suspend" | "resume";
  params: Record<string, string | number | boolean | undefined>;
}

export function checkPower(type: "qemu" | "lxc", b: Json): PowerRequest {
  only(b, ["action", "timeout", "forceStop", "skipLock", "statestorage", "overrule"]);
  const action = typeof b.action === "string" && (POWER_ACTIONS as readonly string[]).includes(b.action) ? (b.action as PowerName) : bad("Unknown action", "action");
  const params: PowerRequest["params"] = {};
  const timeout = present(b.timeout) ? whole(b.timeout, 0, 7200, "The timeout (seconds)") : undefined;
  const skiplock = b.skipLock === undefined ? undefined : asBool(b.skipLock, "Skip the lock");
  if (skiplock) params.skiplock = true;
  if (action === "reset" && type !== "qemu") bad("Only VMs can be reset; reboot the container instead", "action");
  if ((action === "suspend" || action === "hibernate" || action === "resume") && type !== "qemu") bad("Containers can't be suspended. Shut one down, or back it up.", "action");
  if (action === "shutdown") {
    if (timeout !== undefined) params.timeout = timeout;
    if (b.forceStop !== undefined && asBool(b.forceStop, "Stop if it doesn't shut down in time")) params.forceStop = true;
    return { action, path: "shutdown", params };
  }
  if (action === "stop") {
    if (timeout !== undefined) params.timeout = timeout;
    if (b.overrule !== undefined && asBool(b.overrule, "Stop even if a shutdown is running")) params["overrule-shutdown"] = true;
    return { action, path: "stop", params };
  }
  if (action === "reboot") {
    if (timeout !== undefined) params.timeout = timeout;
    delete params.skiplock;
    return { action, path: "reboot", params };
  }
  if (action === "suspend" || action === "hibernate") {
    if (action === "hibernate") params.todisk = true;
    if (present(b.statestorage)) {
      if (action !== "hibernate") bad("A state storage only applies when hibernating", "statestorage");
      params.statestorage = typeof b.statestorage === "string" && /^[A-Za-z0-9][\w.-]{0,39}$/.test(b.statestorage) ? b.statestorage : bad("Unknown storage", "statestorage");
    }
    return { action, path: "suspend", params };
  }
  if (action === "resume") return { action, path: "resume", params };
  if (action === "reset") return { action, path: "reset", params };
  return { action, path: "start", params };
}

// ---- Delete

export interface DeleteOptions {
  confirm: string;
  purge: boolean;
  destroyUnreferenced: boolean;
  skipLock: boolean;
}

export function checkDelete(b: Json): DeleteOptions {
  only(b, ["confirm", "purge", "destroyUnreferenced", "skipLock"]);
  return {
    confirm: typeof b.confirm === "string" ? b.confirm : "",
    purge: b.purge === undefined ? true : asBool(b.purge, "Remove from backup and replication jobs"),
    destroyUnreferenced: b.destroyUnreferenced === undefined ? false : asBool(b.destroyUnreferenced, "Destroy unreferenced disks"),
    skipLock: b.skipLock === undefined ? false : asBool(b.skipLock, "Skip the lock"),
  };
}

// ---- Guest agent

export const AGENT_READS = ["info", "osinfo", "fsinfo", "users", "time", "timezone", "vcpus", "memory-blocks", "host-name"] as const;
export const AGENT_PATH: Record<string, string> = { info: "info", osinfo: "get-osinfo", fsinfo: "get-fsinfo", users: "get-users", time: "get-time", timezone: "get-timezone", vcpus: "get-vcpus", "memory-blocks": "get-memory-blocks", "host-name": "get-host-name" };
export const AGENT_ACTIONS = ["ping", "fstrim", "freeze", "thaw", "freeze-status", "set-password", "exec", "read-file"] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

export interface AgentRequest {
  action: AgentAction;
  user?: string;
  password?: string;
  command?: string[];
  input?: string;
  file?: string;
}

const AGENT_USER = /^[A-Za-z_][A-Za-z0-9_.@\\-]{0,63}$/;

/** A guest agent action. The password is write-only. `exec` and `read-file` run inside the guest, so Proxmox's Unrestricted agent privilege is required. */
export function checkAgentAction(b: Json): AgentRequest {
  only(b, ["action", "user", "password", "command", "input", "file", "confirm"]);
  const action = typeof b.action === "string" && (AGENT_ACTIONS as readonly string[]).includes(b.action) ? (b.action as AgentAction) : bad("Unknown agent action", "action");
  if (action === "set-password") {
    const user = typeof b.user === "string" && AGENT_USER.test(b.user) ? b.user : bad("Enter the user name inside the machine", "user");
    const password = typeof b.password === "string" && b.password.length >= 5 && b.password.length <= 128 && !/[\r\n]/.test(b.password) ? b.password : bad("The password needs 5 to 128 characters on one line", "password");
    return { action, user, password };
  }
  if (action === "exec") {
    const raw = typeof b.command === "string" ? b.command : bad("Enter a command", "command");
    if (!raw.trim() || raw.length > 4096 || /[\r\n\u0000]/.test(raw)) bad("A command is one line of up to 4096 characters", "command");
    // Split on spaces, honouring simple double and single quotes; no shell is involved, so no pipes or expansions.
    const parts = (raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((x) => x.replace(/^(["'])(.*)\1$/, "$2"));
    if (!parts.length || parts.length > 64) bad("Use up to 64 words in a command", "command");
    const input = present(b.input) ? (typeof b.input === "string" && b.input.length <= 65_536 ? b.input : bad("The input is too long", "input")) : undefined;
    return { action, command: parts, input };
  }
  if (action === "read-file") {
    const file = typeof b.file === "string" && b.file.length <= 1024 && /^(\/|[A-Za-z]:[\\/])[^\u0000\r\n]*$/.test(b.file) ? b.file : bad("Enter the full path of a file inside the machine, like /etc/os-release", "file");
    return { action, file };
  }
  return { action };
}

// ---- SPICE

/** The `.vv` file a SPICE viewer (virt-viewer, remote-viewer) opens, built from Proxmox's spiceproxy answer. */
export function spiceFile(p: Record<string, unknown>): string {
  const lines = ["[virt-viewer]"];
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null || typeof v === "object") continue;
    const val = String(v);
    if (/[\r\n]/.test(val) || !/^[A-Za-z][\w-]*$/.test(k)) continue;
    lines.push(`${k}=${val}`);
  }
  return `${lines.join("\n")}\n`;
}

// ---- Snapshots

export function checkSnapshotDescription(b: Json): string {
  only(b, ["description"]);
  if (typeof b.description !== "string") bad("The description is text", "description");
  const d = b.description as string;
  if (d.length > 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(d)) bad("Keep the description under 1024 characters", "description");
  return d;
}

// ---- Bulk actions

export const BULK_ACTIONS = ["start", "shutdown", "suspend", "migrate"] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

export interface BulkRequest {
  action: BulkAction;
  vms: number[];
  maxWorkers: number | null;
  timeout: number | null;
  forceStop: boolean;
  toDisk: boolean;
  target: string | null;
  online: boolean;
  withLocalDisks: boolean;
}

export function checkBulk(b: Json): BulkRequest {
  only(b, ["action", "vms", "maxWorkers", "timeout", "forceStop", "toDisk", "target", "online", "withLocalDisks", "confirm"]);
  const action = typeof b.action === "string" && (BULK_ACTIONS as readonly string[]).includes(b.action) ? (b.action as BulkAction) : bad("Choose start, shut down, suspend or migrate", "action");
  const list = Array.isArray(b.vms) ? b.vms : bad("Pick the machines", "vms");
  if (!list.length || list.length > 500) bad("Pick 1 to 500 machines", "vms");
  const vms = [...new Set(list.map((v) => whole(v, 100, 999_999_999, "A machine number")))];
  const target = present(b.target) ? (typeof b.target === "string" && NODE_RE.test(b.target) ? b.target : bad("Unknown node", "target")) : null;
  if (action === "migrate" && !target) bad("Pick the node to move them to", "target");
  return {
    action,
    vms,
    maxWorkers: present(b.maxWorkers) ? whole(b.maxWorkers, 1, 64, "Machines at once") : null,
    timeout: present(b.timeout) ? whole(b.timeout, 0, 7200, "The timeout (seconds)") : null,
    forceStop: b.forceStop === undefined ? true : asBool(b.forceStop, "Stop machines that don't shut down"),
    toDisk: b.toDisk === undefined ? false : asBool(b.toDisk, "Hibernate to disk"),
    target,
    online: b.online === undefined ? true : asBool(b.online, "Keep them running"),
    withLocalDisks: b.withLocalDisks === undefined ? true : asBool(b.withLocalDisks, "Move local disks"),
  };
}

// ---- Custom CPU models (Datacenter)

export const CPU_MODEL_REPORTED_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export interface CustomCpuModel {
  cputype: string;
  reportedModel: string;
  flags: string | null;
  hidden: boolean;
  hvVendorId: string | null;
  physBits: string | null;
}

export function planCustomCpu(b: Json, creating: boolean): { cputype: string; params: Record<string, string | boolean | undefined>; del: string[] } {
  only(b, ["cputype", "reportedModel", "flags", "hidden", "hvVendorId", "physBits"]);
  const cputype = typeof b.cputype === "string" && /^[A-Za-z][\w-]{1,63}$/.test(b.cputype) ? b.cputype.replace(/^custom-/, "") : bad("A model name has 2 to 64 letters, digits, _ or -", "cputype");
  const params: Record<string, string | boolean | undefined> = {};
  const del: string[] = [];
  if (creating || b.reportedModel !== undefined) params["reported-model"] = typeof b.reportedModel === "string" && CPU_MODEL_REPORTED_RE.test(b.reportedModel) ? b.reportedModel : bad("Pick the CPU model it is based on", "reportedModel");
  if (b.flags !== undefined) {
    if (b.flags === null || b.flags === "") del.push("flags");
    else params.flags = typeof b.flags === "string" && /^([+-][A-Za-z0-9_.-]{1,40})(;[+-][A-Za-z0-9_.-]{1,40}){0,39}$/.test(b.flags) ? b.flags : bad("Flags look like +aes;-pcid", "flags");
  }
  if (b.hidden !== undefined) params.hidden = asBool(b.hidden, "Hide the hypervisor");
  if (b.hvVendorId !== undefined) {
    if (b.hvVendorId === null || b.hvVendorId === "") del.push("hv-vendor-id");
    else params["hv-vendor-id"] = typeof b.hvVendorId === "string" && /^[\x20-\x7e]{1,12}$/.test(b.hvVendorId) && !b.hvVendorId.includes(",") ? b.hvVendorId : bad("The vendor ID is up to 12 plain characters", "hvVendorId");
  }
  if (b.physBits !== undefined) {
    if (b.physBits === null || b.physBits === "") del.push("phys-bits");
    else params["phys-bits"] = b.physBits === "host" ? "host" : String(whole(b.physBits, 8, 64, "Physical address bits"));
  }
  return { cputype, params, del };
}

export { readSettings };

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
export function readPassthrough(type: "qemu" | "lxc", cfg: Cfg): PassthroughItem[] {
  const out: PassthroughItem[] = [];
  const lead = (p: Props, k: string) => getProp(p, k) ?? (p[0] && p[0][1] === null ? p[0][0] : undefined);
  for (const [key, value] of Object.entries(cfg)) {
    const raw = str(value);
    const p = parseProps(raw);
    if (type === "qemu" && /^hostpci\d+$/.test(key)) {
      const mapping = getProp(p, "mapping");
      const options = [getProp(p, "pcie") === "1" && "PCI Express", getProp(p, "x-vga") === "1" && "Primary GPU", getProp(p, "rombar") === "0" && "ROM-BAR off", getProp(p, "mdev") && `Mediated ${getProp(p, "mdev")}`, getProp(p, "romfile") && `ROM file ${getProp(p, "romfile")}`, getProp(p, "legacy-igd") === "1" && "Legacy IGD"].filter(Boolean) as string[];
      out.push({ key, kind: "pci", target: mapping ?? lead(p, "host") ?? raw, mapped: !!mapping, options, raw });
    } else if (type === "qemu" && /^usb\d+$/.test(key)) {
      const mapping = getProp(p, "mapping");
      out.push({ key, kind: "usb", target: mapping ?? lead(p, "host") ?? raw, mapped: !!mapping, options: [getProp(p, "usb3") === "1" && "USB 3"].filter(Boolean) as string[], raw });
    } else if (type === "lxc" && /^dev\d+$/.test(key)) {
      out.push({ key, kind: "dev", target: lead(p, "path") ?? raw, mapped: false, options: [getProp(p, "mode") && `Mode ${getProp(p, "mode")}`, getProp(p, "uid") && `uid ${getProp(p, "uid")}`, getProp(p, "gid") && `gid ${getProp(p, "gid")}`, getProp(p, "deny-write") === "1" && "Read only"].filter(Boolean) as string[], raw });
    }
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key, undefined, { numeric: true }));
}
