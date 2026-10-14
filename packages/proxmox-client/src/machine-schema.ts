/**
 * Settings a machine's page changes beyond the basics: processor details, memory extras, machine type and SCSI
 * controller, small devices (random number generator, watchdog, shared folders, parallel ports), the VM and container
 * options Proxmox shows under Options. Shared by the host service (which checks every request before it reaches
 * Proxmox) and the console (which runs the same checks in the demo), so the two can never disagree.
 *
 * Every key, enum and range was checked against the API viewer (apidoc.js) for `PUT /nodes/{node}/qemu/{vmid}/config`
 * and `PUT /nodes/{node}/lxc/{vmid}/config`. A `plan*` function takes the machine's current configuration and a
 * request body, and returns the exact change (`set` and `delete`) or throws a MachineError with a sentence a person
 * can act on. Keys inside a property string that we don't manage are kept.
 */

export class MachineError extends Error {
  readonly field: string;
  constructor(message: string, field = "") {
    super(message);
    this.field = field;
  }
}
export const bad = (m: string, field = ""): never => {
  throw new MachineError(m, field);
};

export type Cfg = Record<string, string | number>;
export type Json = Record<string, unknown>;

/** What a request turns into: keys to write (already property strings), keys to delete, and notes for the person. */
export interface Change {
  set: Record<string, string>;
  delete: string[];
  warnings: string[];
}
export const emptyChange = (): Change => ({ set: {}, delete: [], warnings: [] });

/** Applies a change to a configuration, as Proxmox would (used by the demo). */
export function applyChange(cfg: Cfg, c: Change): void {
  for (const k of c.delete) delete cfg[k];
  for (const [k, v] of Object.entries(c.set)) cfg[k] = v;
}

// ---- Property strings

export type Props = [string, string | null][];

export function parseProps(raw: string): Props {
  return raw
    .split(",")
    .filter(Boolean)
    .map((part): [string, string | null] => {
      const i = part.indexOf("=");
      return i < 0 ? [part, null] : [part.slice(0, i), part.slice(i + 1)];
    });
}
export const serializeProps = (p: Props): string => p.map(([k, v]) => (v === null ? k : `${k}=${v}`)).join(",");
export const getProp = (p: Props, key: string): string | undefined => p.find(([k]) => k === key)?.[1] ?? undefined;
/** Sets (string) or removes (null) keys, keeping the order of the ones that stay. */
export function setProps(p: Props, changes: Record<string, string | null | undefined>): Props {
  let out = p.map(([k, v]): [string, string | null] => [k, k in changes && changes[k] !== undefined && changes[k] !== null ? changes[k]! : v]);
  out = out.filter(([k]) => !(k in changes) || changes[k] !== null);
  for (const [k, v] of Object.entries(changes)) if (v !== null && v !== undefined && !out.some(([x]) => x === k)) out.push([k, v]);
  return out;
}
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const present = (v: unknown) => v !== undefined && v !== null && v !== "";
const flag = (v: boolean) => (v ? "1" : "0");

function boolean(v: unknown, label: string): boolean {
  return typeof v === "boolean" ? v : bad(`${label} is on or off`);
}
function whole(v: unknown, lo: number, hi: number, label: string): number {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi ? n : bad(`${label} must be a whole number from ${lo} to ${hi}`);
}
/** The first value of a property string that has no key (Proxmox's "default key"), or the value of that key. */
function lead(p: Props, key: string): string | undefined {
  return getProp(p, key) ?? (p[0] && p[0][1] === null ? p[0][0] : undefined);
}
function onlyKnown(b: Json, allowed: string[]) {
  for (const k of Object.keys(b)) if (!allowed.includes(k) && k !== "digest") bad(`Unknown field “${k}”`, k);
}

// ---- Vocabulary (apidoc enums)

export const SCSI_HW = ["virtio-scsi-single", "virtio-scsi-pci", "lsi", "lsi53c810", "megasas", "pvscsi"] as const;
export const SCSI_HW_LABEL: Record<string, string> = {
  "virtio-scsi-single": "VirtIO SCSI single (best for most; one controller per disk)",
  "virtio-scsi-pci": "VirtIO SCSI",
  lsi: "LSI 53C895A (the Proxmox default for old machines)",
  lsi53c810: "LSI 53C810",
  megasas: "MegaRAID SAS 8708EM2",
  pvscsi: "VMware PVSCSI",
};
export const HUGEPAGES = ["any", "2", "1024"] as const;
export const RNG_SOURCES = ["/dev/urandom", "/dev/random", "/dev/hwrng"] as const;
export const WATCHDOG_MODELS = ["i6300esb", "ib700"] as const;
export const WATCHDOG_ACTIONS = ["reset", "shutdown", "poweroff", "pause", "debug", "none"] as const;
export const NUMA_POLICIES = ["preferred", "bind", "interleave"] as const;
export const VIRTIOFS_CACHE = ["auto", "always", "metadata", "never"] as const;
export const VIOMMU = ["intel", "virtio"] as const;
export const KEYBOARDS = ["de", "de-ch", "da", "en-gb", "en-us", "es", "fi", "fr", "fr-be", "fr-ca", "fr-ch", "hu", "is", "it", "ja", "lt", "mk", "nl", "no", "pl", "pt", "pt-br", "sv", "sl", "tr"] as const;
export const HOTPLUG = ["disk", "network", "usb", "memory", "cpu"] as const;
export const AGENT_TYPES = ["virtio", "isa"] as const;
export const VIDEO_STREAMING = ["off", "all", "filter"] as const;
export const CT_CMODES = ["tty", "console", "shell"] as const;
export const CT_ARCHES = ["amd64", "i386", "arm64", "armhf", "riscv32", "riscv64"] as const;
export const CT_OSTYPES = ["debian", "devuan", "ubuntu", "centos", "fedora", "opensuse", "archlinux", "alpine", "gentoo", "nixos", "unmanaged"] as const;

/** Plain-words names for CPU flags people commonly look for, so Spectre/Meltdown mitigations are findable. */
export const CPU_FLAG_HINTS: Record<string, string> = {
  "pcid": "Process-context IDs: makes the Meltdown fix much cheaper",
  "spec-ctrl": "Spectre v1/v2 protection (indirect branch controls)",
  "ssbd": "Spectre v4 protection (speculative store bypass)",
  "ibpb": "Spectre v2 protection (indirect branch predictor barrier)",
  "virt-ssbd": "Spectre v4 protection on AMD",
  "amd-ssbd": "Spectre v4 protection on AMD",
  "amd-no-ssb": "AMD: not affected by Spectre v4",
  "md-clear": "MDS / Zombieload protection",
  "hv-tlbflush": "Windows: faster TLB flushes",
  "hv-evmcs": "Windows: nested virtualization speedup (Intel)",
  "aes": "Hardware AES encryption",
};

// ---- Reading

export interface NumaNode {
  key: string;
  cpus: string;
  hostnodes: string | null;
  memory: number | null;
  policy: string | null;
}
export interface VirtiofsShare {
  key: string;
  dirid: string;
  cache: string;
  directIo: boolean;
  exposeAcl: boolean;
  exposeXattr: boolean;
}
export interface MachineSettings {
  type: "qemu" | "lxc";
  vm: {
    cpu: { type: string | null; flags: { name: string; mode: "+" | "-" }[]; hidden: boolean; physBits: string | null; vcpus: number | null; affinity: string | null; numa: boolean; sockets: number; cores: number; other: string[] };
    numaNodes: NumaNode[];
    memory: { memory: number; balloon: number | null; shares: number | null; hugepages: string | null; keephugepages: boolean };
    machine: { type: string | null; viommu: string | null; awBits: number | null; enableS3: boolean; enableS4: boolean };
    scsihw: string;
    rng: { source: string; maxBytes: number | null; period: number | null } | null;
    watchdog: { model: string; action: string | null } | null;
    virtiofs: VirtiofsShare[];
    parallel: { key: string; path: string }[];
    options: {
      tablet: boolean;
      acpi: boolean;
      kvm: boolean;
      freeze: boolean;
      localtime: boolean | null;
      startdate: string | null;
      hotplug: string[] | null;
      keyboard: string | null;
      tdf: boolean;
      vmstatestorage: string | null;
      agent: { enabled: boolean; freezeFs: boolean; fstrimClonedDisks: boolean; type: string };
      spice: { folderSharing: boolean; videoStreaming: string };
      smbios: { manufacturer: string; product: string; version: string; serial: string; sku: string; family: string; uuid: string };
      args: string | null;
      allowKsm: boolean;
    };
  } | null;
  ct: { cmode: string; tty: number; console: boolean; hookscript: string | null; timezone: string | null; arch: string; ostype: string | null; debug: boolean; unprivileged: boolean; entrypoint: string | null } | null;
}

const num = (v: unknown): number | null => (present(v) && /^-?\d+(\.\d+)?$/.test(String(v)) ? Number(v) : null);
const b64 = (v: string | undefined): string => {
  if (!v) return "";
  try {
    return typeof atob === "function" ? decodeURIComponent(escape(atob(v))) : Buffer.from(v, "base64").toString("utf8");
  } catch {
    return "";
  }
};

export function readSettings(type: "qemu" | "lxc", cfg: Cfg): MachineSettings {
  if (type === "lxc") {
    return {
      type,
      vm: null,
      ct: {
        cmode: str(cfg.cmode) || "tty",
        tty: num(cfg.tty) ?? 2,
        console: !present(cfg.console) || str(cfg.console) === "1",
        hookscript: str(cfg.hookscript) || null,
        timezone: str(cfg.timezone) || null,
        arch: str(cfg.arch) || "amd64",
        ostype: str(cfg.ostype) || null,
        debug: str(cfg.debug) === "1",
        unprivileged: str(cfg.unprivileged) === "1",
        entrypoint: str(cfg.entrypoint) || null,
      },
    };
  }
  const cpuP = parseProps(str(cfg.cpu));
  const flagsRaw = getProp(cpuP, "flags") ?? "";
  const cpuType = getProp(cpuP, "cputype") ?? (cpuP[0] && cpuP[0][1] === null ? cpuP[0][0] : null);
  const mach = parseProps(str(cfg.machine));
  const mem = parseProps(str(cfg.memory));
  const memory = num(getProp(mem, "current") ?? (mem[0] && mem[0][1] === null ? mem[0][0] : undefined)) ?? 512;
  const rng = parseProps(str(cfg.rng0));
  const wd = parseProps(str(cfg.watchdog));
  const agent = parseProps(str(cfg.agent));
  const spice = parseProps(str(cfg.spice_enhancements));
  const smb = parseProps(str(cfg.smbios1));
  const base64 = getProp(smb, "base64") === "1";
  const smbVal = (k: string) => {
    const v = getProp(smb, k);
    return v ? (base64 ? b64(v) : v) : "";
  };
  const bool = (k: string, d: boolean) => (present(cfg[k]) ? str(cfg[k]) === "1" : d);
  const keyed = (re: RegExp) => Object.keys(cfg).filter((k) => re.test(k)).sort((a, b) => Number(a.replace(/\D+/g, "")) - Number(b.replace(/\D+/g, "")));
  const known = ["cputype", "flags", "hidden", "phys-bits"];
  return {
    type,
    ct: null,
    vm: {
      cpu: {
        type: cpuType,
        flags: flagsRaw.split(";").filter(Boolean).map((f) => ({ name: f.slice(1), mode: (f[0] === "-" ? "-" : "+") as "+" | "-" })),
        hidden: getProp(cpuP, "hidden") === "1",
        physBits: getProp(cpuP, "phys-bits") ?? null,
        vcpus: num(cfg.vcpus),
        affinity: str(cfg.affinity) || null,
        numa: str(cfg.numa) === "1",
        sockets: num(cfg.sockets) ?? 1,
        cores: num(cfg.cores) ?? 1,
        other: cpuP.filter(([k, v]) => !known.includes(k) && !(v === null && k === cpuType)).map(([k, v]) => (v === null ? k : `${k}=${v}`)),
      },
      numaNodes: keyed(/^numa\d+$/).map((key) => {
        const p = parseProps(str(cfg[key]));
        return { key, cpus: getProp(p, "cpus") ?? "", hostnodes: getProp(p, "hostnodes") ?? null, memory: num(getProp(p, "memory")), policy: getProp(p, "policy") ?? null };
      }),
      memory: { memory, balloon: num(cfg.balloon), shares: num(cfg.shares), hugepages: str(cfg.hugepages) || null, keephugepages: str(cfg.keephugepages) === "1" },
      machine: { type: lead(mach, "type") ?? null, viommu: getProp(mach, "viommu") ?? null, awBits: num(getProp(mach, "aw-bits")), enableS3: getProp(mach, "enable-s3") === "1", enableS4: getProp(mach, "enable-s4") === "1" },
      scsihw: str(cfg.scsihw) || "lsi",
      rng: present(cfg.rng0) ? { source: lead(rng, "source") ?? "/dev/urandom", maxBytes: num(getProp(rng, "max_bytes")), period: num(getProp(rng, "period")) } : null,
      watchdog: present(cfg.watchdog) ? { model: lead(wd, "model") ?? "i6300esb", action: getProp(wd, "action") ?? null } : null,
      virtiofs: keyed(/^virtiofs\d+$/).map((key) => {
        const p = parseProps(str(cfg[key]));
        return { key, dirid: lead(p, "dirid") ?? "", cache: getProp(p, "cache") ?? "auto", directIo: getProp(p, "direct-io") === "1", exposeAcl: getProp(p, "expose-acl") === "1", exposeXattr: getProp(p, "expose-xattr") === "1" };
      }),
      parallel: keyed(/^parallel\d+$/).map((key) => ({ key, path: str(cfg[key]) })),
      options: {
        tablet: bool("tablet", true),
        acpi: bool("acpi", true),
        kvm: bool("kvm", true),
        freeze: bool("freeze", false),
        localtime: present(cfg.localtime) ? str(cfg.localtime) === "1" : null,
        startdate: str(cfg.startdate) || null,
        hotplug: present(cfg.hotplug) ? (str(cfg.hotplug) === "0" ? [] : str(cfg.hotplug).split(",").filter(Boolean)) : null,
        keyboard: str(cfg.keyboard) || null,
        tdf: bool("tdf", false),
        vmstatestorage: str(cfg.vmstatestorage) || null,
        agent: { enabled: lead(agent, "enabled") === "1", freezeFs: getProp(agent, "freeze-fs") !== "0", fstrimClonedDisks: getProp(agent, "fstrim_cloned_disks") === "1", type: getProp(agent, "type") ?? "virtio" },
        spice: { folderSharing: getProp(spice, "foldersharing") === "1", videoStreaming: getProp(spice, "videostreaming") ?? "off" },
        smbios: { manufacturer: smbVal("manufacturer"), product: smbVal("product"), version: smbVal("version"), serial: smbVal("serial"), sku: smbVal("sku"), family: smbVal("family"), uuid: getProp(smb, "uuid") ?? "" },
        args: str(cfg.args) || null,
        allowKsm: bool("allow-ksm", true),
      },
    },
  };
}

// ---- Planning changes

export interface PlanContext {
  /** CPU model names the node reports, when it could be read. Absent means not checked. */
  cpuModels?: string[];
  /** Flag names the node reports. */
  cpuFlags?: string[];
  /** Storage ids that exist, when known. */
  storages?: string[];
  /** The signed-in account may use root-only settings (serial or random sources from the host, extra QEMU arguments). */
  admin?: boolean;
  /** Directory mapping ids the account may use, when known. */
  dirMappings?: string[];
}

const CPUTYPE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const FLAG_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const CPUSET_RE = /^\d{1,4}(-\d{1,4})?(,\d{1,4}(-\d{1,4})?)*$/;
const STORAGE_RE = /^[A-Za-z0-9][\w.-]{0,39}$/;
const CONFIGID_RE = /^[A-Za-z][\w-]{1,63}$/;

function writeOrDelete(c: Change, key: string, value: string | null) {
  if (value === null || value === "") c.delete.push(key);
  else c.set[key] = value;
}

/** Processor details: CPU type, flags (including the Spectre and Meltdown mitigations), hidden hypervisor, active CPUs, affinity, NUMA. */
export function planCpu(cfg: Cfg, b: Json, ctx: PlanContext = {}): Change {
  onlyKnown(b, ["type", "flags", "hidden", "physBits", "vcpus", "affinity", "numa"]);
  const c = emptyChange();
  const p0 = parseProps(str(cfg.cpu));
  const changes: Record<string, string | null> = {};
  let touchedCpu = false;
  let typeNow = getProp(p0, "cputype") ?? (p0[0] && p0[0][1] === null ? p0[0][0] : undefined);
  if (b.type !== undefined) {
    touchedCpu = true;
    if (b.type === null || b.type === "") {
      typeNow = undefined;
    } else {
      const t = typeof b.type === "string" && CPUTYPE_RE.test(b.type) ? b.type : bad("The CPU type is a name like x86-64-v2-AES or host", "type");
      if (ctx.cpuModels && ctx.cpuModels.length && !ctx.cpuModels.includes(t) && !ctx.cpuModels.includes(t.replace(/^custom-/, ""))) bad(`This device doesn't list a CPU type called ${t}`, "type");
      typeNow = t;
    }
  }
  if (b.flags !== undefined) {
    touchedCpu = true;
    const list = Array.isArray(b.flags) ? b.flags : bad("Flags are a list", "flags");
    if (list.length > 40) bad("That is too many CPU flags", "flags");
    const seen = new Set<string>();
    const parts = list.map((f: unknown) => {
      const o = f as { name?: unknown; mode?: unknown };
      const name = typeof o?.name === "string" && FLAG_RE.test(o.name) ? o.name : bad("A CPU flag is a short name like spec-ctrl", "flags");
      if (o.mode !== "+" && o.mode !== "-") bad(`Turn ${name} on or off`, "flags");
      if (seen.has(name)) bad(`${name} is listed twice`, "flags");
      seen.add(name);
      if (ctx.cpuFlags && ctx.cpuFlags.length && !ctx.cpuFlags.includes(name)) bad(`This device doesn't know a CPU flag called ${name}`, "flags");
      return `${o.mode}${name}`;
    });
    changes.flags = parts.length ? parts.join(";") : null;
  }
  if (b.hidden !== undefined) {
    touchedCpu = true;
    changes.hidden = boolean(b.hidden, "Hide the hypervisor") ? "1" : null;
  }
  if (b.physBits !== undefined) {
    touchedCpu = true;
    if (b.physBits === null || b.physBits === "") changes["phys-bits"] = null;
    else changes["phys-bits"] = b.physBits === "host" ? "host" : String(whole(b.physBits, 8, 64, "Physical address bits"));
  }
  if (touchedCpu) {
    // Rebuild: the type first (a bare word, as Proxmox writes it), then the other keys in their old order.
    let rest = p0.filter(([k, v]) => k !== "cputype" && v !== null);
    rest = setProps(rest, changes);
    const out: Props = typeNow ? [[typeNow, null], ...rest] : rest;
    writeOrDelete(c, "cpu", serializeProps(out));
  }
  if (b.vcpus !== undefined) {
    if (b.vcpus === null || b.vcpus === 0) c.delete.push("vcpus");
    else {
      const max = (num(cfg.sockets) ?? 1) * (num(cfg.cores) ?? 1);
      c.set.vcpus = String(whole(b.vcpus, 1, max, `Active CPUs (the VM has ${max})`));
    }
  }
  if (b.affinity !== undefined) {
    if (b.affinity === null || b.affinity === "") c.delete.push("affinity");
    else c.set.affinity = typeof b.affinity === "string" && CPUSET_RE.test(b.affinity.trim()) ? b.affinity.trim() : bad("CPU affinity is a list like 0-3,8", "affinity");
  }
  if (b.numa !== undefined) {
    if (boolean(b.numa, "NUMA")) c.set.numa = "1";
    else c.delete.push("numa");
  }
  if (!Object.keys(c.set).length && !c.delete.length) bad("Nothing to change");
  if (b.hidden === true) c.warnings.push("Hiding the hypervisor helps some GPU drivers start; it can also stop Windows from using its paravirtual features.");
  return c;
}

/** Virtual NUMA nodes (numa0 .. numa7). */
export function planNuma(cfg: Cfg, b: Json): Change {
  onlyKnown(b, ["action", "key", "cpus", "hostnodes", "memory", "policy"]);
  const c = emptyChange();
  const key = typeof b.key === "string" && /^numa[0-7]$/.test(b.key) ? b.key : b.key === undefined ? [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `numa${i}`).find((k) => !(k in cfg)) : bad("NUMA nodes are numa0 to numa7", "key");
  if (!key) return bad("All eight NUMA nodes are in use");
  if (b.action === "remove") {
    if (!(key in cfg)) bad("That NUMA node isn't on this machine");
    c.delete.push(key);
    return c;
  }
  if (b.action !== "set" && b.action !== "add") bad("Choose what to do");
  const range = /^\d+(-\d+)?(;\d+(-\d+)?)*$/;
  const cpus = typeof b.cpus === "string" && range.test(b.cpus) ? b.cpus : bad("Virtual CPUs look like 0-3 or 0;2;4-5", "cpus");
  const parts = [`cpus=${cpus}`];
  if (present(b.hostnodes)) parts.push(`hostnodes=${typeof b.hostnodes === "string" && range.test(b.hostnodes) ? b.hostnodes : bad("Host nodes look like 0 or 0-1", "hostnodes")}`);
  if (present(b.memory)) parts.push(`memory=${whole(b.memory, 1, 4_194_304, "NUMA memory (MiB)")}`);
  if (present(b.policy)) parts.push(`policy=${typeof b.policy === "string" && (NUMA_POLICIES as readonly string[]).includes(b.policy) ? b.policy : bad("Policy is preferred, bind or interleave", "policy")}`);
  if (str(cfg.numa) !== "1") c.set.numa = "1";
  c.set[key] = parts.join(",");
  return c;
}

/** Memory extras: CPU shares for memory ballooning, huge pages. (Minimum memory is in the resources card.) */
export function planMemoryExtras(cfg: Cfg, b: Json): Change {
  onlyKnown(b, ["shares", "hugepages", "keephugepages"]);
  const c = emptyChange();
  if (b.shares !== undefined) {
    if (b.shares === null) c.delete.push("shares");
    else c.set.shares = String(whole(b.shares, 0, 50000, "Memory shares"));
  }
  const hp = b.hugepages !== undefined ? b.hugepages : undefined;
  if (hp !== undefined) {
    if (hp === null || hp === "") {
      c.delete.push("hugepages", "keephugepages");
    } else {
      c.set.hugepages = typeof hp === "string" && (HUGEPAGES as readonly string[]).includes(hp) ? hp : bad("Huge pages are any, 2 (2 MiB) or 1024 (1 GiB)", "hugepages");
      c.warnings.push("Huge pages reserve memory on the device when the VM starts and stop memory ballooning. The device needs enough free huge pages.");
    }
  }
  if (b.keephugepages !== undefined) {
    if (boolean(b.keephugepages, "Keep huge pages") ) {
      if (!(c.set.hugepages ?? str(cfg.hugepages))) bad("Keeping huge pages needs huge pages turned on", "keephugepages");
      c.set.keephugepages = "1";
    } else c.delete.push("keephugepages");
  }
  if (!Object.keys(c.set).length && !c.delete.length) bad("Nothing to change");
  return c;
}

const MACHINE_TYPE_RE = /^(pc|q35|pc-i440fx-\d+(\.\d+)+(\+pve\d+)?(\.pxe)?|pc-q35-\d+(\.\d+)+(\+pve\d+)?(\.pxe)?|virt(-\d+(\.\d+)+)?(\+pve\d+)?)$/;

/** Machine type (i440fx or q35 and a version), virtual IOMMU, ACPI sleep states; and the SCSI controller. */
export function planMachine(cfg: Cfg, b: Json): Change {
  onlyKnown(b, ["type", "viommu", "awBits", "enableS3", "enableS4", "scsihw"]);
  const c = emptyChange();
  const cur = readSettings("qemu", cfg).vm!.machine;
  if (["type", "viommu", "awBits", "enableS3", "enableS4"].some((k) => b[k] !== undefined)) {
    const type = b.type === undefined ? cur.type : b.type === null || b.type === "" || b.type === "default" ? null : typeof b.type === "string" && MACHINE_TYPE_RE.test(b.type) ? b.type : bad("The machine type is pc, q35 or a version like pc-q35-9.0", "type");
    const viommu = b.viommu === undefined ? cur.viommu : b.viommu === null || b.viommu === "" ? null : typeof b.viommu === "string" && (VIOMMU as readonly string[]).includes(b.viommu) ? b.viommu : bad("Virtual IOMMU is Intel or VirtIO", "viommu");
    const aw = b.awBits === undefined ? cur.awBits : b.awBits === null ? null : whole(b.awBits, 32, 64, "Address width bits");
    const s3 = b.enableS3 === undefined ? cur.enableS3 : boolean(b.enableS3, "Sleep to RAM");
    const s4 = b.enableS4 === undefined ? cur.enableS4 : boolean(b.enableS4, "Hibernate");
    const isQ35 = !!type && (type === "q35" || type.startsWith("pc-q35"));
    if (viommu && !isQ35) bad("A virtual IOMMU needs the q35 machine type", "viommu");
    if (aw !== null && viommu !== "intel") bad("Address width bits only apply to the Intel virtual IOMMU", "awBits");
    const parts = type ? [type] : [];
    const rest: string[] = [];
    if (viommu) rest.push(`viommu=${viommu}`);
    if (aw !== null) rest.push(`aw-bits=${aw}`);
    if (s3) rest.push("enable-s3=1");
    if (s4) rest.push("enable-s4=1");
    const all = [...parts, ...rest];
    if (all.length === 0) c.delete.push("machine");
    else c.set.machine = all.join(",");
    if (type !== cur.type) c.warnings.push("Changing the machine type changes the virtual hardware layout. Windows may ask to re-activate, and network names inside Linux can change. Take a snapshot first.");
  }
  if (b.scsihw !== undefined) {
    if (b.scsihw === null || b.scsihw === "") c.delete.push("scsihw");
    else c.set.scsihw = typeof b.scsihw === "string" && (SCSI_HW as readonly string[]).includes(b.scsihw) ? b.scsihw : bad("Pick a SCSI controller from the list", "scsihw");
  }
  if (!Object.keys(c.set).length && !c.delete.length) bad("Nothing to change");
  return c;
}

export type DeviceKind = "rng" | "watchdog" | "virtiofs" | "parallel";
const FREE_FS = (cfg: Cfg) => Array.from({ length: 10 }, (_, i) => `virtiofs${i}`).find((k) => !(k in cfg));

/** Small VM devices: random number generator, watchdog, shared folders (VirtIO-FS), parallel ports. */
export function planDevice(cfg: Cfg, kind: DeviceKind, b: Json, ctx: PlanContext = {}): Change {
  const c = emptyChange();
  const action = b.action;
  if (action !== "set" && action !== "add" && action !== "remove") bad("Choose what to do");
  if (kind === "rng") {
    onlyKnown(b, ["action", "source", "maxBytes", "period"]);
    if (action === "remove") return (c.delete.push("rng0"), c);
    const source = b.source === undefined ? "/dev/urandom" : typeof b.source === "string" && (RNG_SOURCES as readonly string[]).includes(b.source) ? b.source : bad("The source is /dev/urandom, /dev/random or /dev/hwrng", "source");
    if (source !== "/dev/urandom" && ctx.admin === false) bad("Only Proxmox administrators may use /dev/random or /dev/hwrng. /dev/urandom is the safe choice.", "source");
    const parts = [`source=${source}`];
    if (present(b.maxBytes)) parts.push(`max_bytes=${whole(b.maxBytes, 0, 1_000_000_000, "Maximum bytes per period")}`);
    if (present(b.period)) parts.push(`period=${whole(b.period, 1, 3_600_000, "The period (ms)")}`);
    c.set.rng0 = parts.join(",");
    return c;
  }
  if (kind === "watchdog") {
    onlyKnown(b, ["action", "model", "watchdogAction"]);
    if (action === "remove") return (c.delete.push("watchdog"), c);
    const model = b.model === undefined ? "i6300esb" : typeof b.model === "string" && (WATCHDOG_MODELS as readonly string[]).includes(b.model) ? b.model : bad("The watchdog model is i6300esb or ib700", "model");
    const parts = [`model=${model}`];
    if (present(b.watchdogAction)) parts.push(`action=${typeof b.watchdogAction === "string" && (WATCHDOG_ACTIONS as readonly string[]).includes(b.watchdogAction) ? b.watchdogAction : bad("Pick what the watchdog does from the list", "watchdogAction")}`);
    c.set.watchdog = parts.join(",");
    c.warnings.push("A watchdog only helps when the guest runs a watchdog service that pings it; otherwise it restarts the VM on its own.");
    return c;
  }
  if (kind === "virtiofs") {
    onlyKnown(b, ["action", "key", "dirid", "cache", "directIo", "exposeAcl", "exposeXattr"]);
    const key = typeof b.key === "string" && /^virtiofs\d$/.test(b.key) ? b.key : b.key === undefined ? FREE_FS(cfg) : bad("Shared folders are virtiofs0 to virtiofs9", "key");
    if (!key) return bad("All ten shared folder slots are in use");
    if (action === "remove") {
      if (!(key in cfg)) bad("That shared folder isn't on this machine");
      return (c.delete.push(key), c);
    }
    const dirid = typeof b.dirid === "string" && CONFIGID_RE.test(b.dirid) ? b.dirid : bad("Pick a directory mapping for the shared folder", "dirid");
    if (ctx.dirMappings && !ctx.dirMappings.includes(dirid)) bad(`There is no directory mapping called ${dirid}`, "dirid");
    const parts = [`dirid=${dirid}`];
    if (present(b.cache) && b.cache !== "auto") parts.push(`cache=${typeof b.cache === "string" && (VIRTIOFS_CACHE as readonly string[]).includes(b.cache) ? b.cache : bad("Cache is auto, always, metadata or never", "cache")}`);
    if (b.directIo !== undefined && boolean(b.directIo, "Direct I/O")) parts.push("direct-io=1");
    if (b.exposeAcl !== undefined && boolean(b.exposeAcl, "ACLs")) parts.push("expose-acl=1");
    if (b.exposeXattr !== undefined && boolean(b.exposeXattr, "Extended attributes")) parts.push("expose-xattr=1");
    c.set[key] = parts.join(",");
    if (str(cfg.memory) && str(cfg.numa) !== "1") c.warnings.push("VirtIO-FS needs the VM's memory to be shared, which Proxmox sets up when the VM starts. Turn NUMA on if the VM refuses to start.");
    return c;
  }
  // parallel
  onlyKnown(b, ["action", "key", "path"]);
  const key = typeof b.key === "string" && /^parallel[0-2]$/.test(b.key) ? b.key : b.key === undefined ? [0, 1, 2].map((i) => `parallel${i}`).find((k) => !(k in cfg)) : bad("Parallel ports are parallel0 to parallel2", "key");
  if (!key) return bad("All three parallel ports are in use");
  if (action === "remove") {
    if (!(key in cfg)) bad("That parallel port isn't on this machine");
    return (c.delete.push(key), c);
  }
  if (ctx.admin === false) bad("Only Proxmox administrators may hand a host parallel port to a VM");
  c.set[key] = typeof b.path === "string" && /^(\/dev\/parport\d+|\/dev\/usb\/lp\d+)$/.test(b.path) ? b.path : bad("A host parallel port looks like /dev/parport0", "path");
  return c;
}

const START_RE = /^(now|\d{4}-\d{1,2}-\d{1,2}(T\d{1,2}:\d{1,2}:\d{1,2})?)$/;
const SMBIOS_FIELDS = ["manufacturer", "product", "version", "serial", "sku", "family"] as const;
const UUID_RE = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
const toB64 = (s: string) => (typeof btoa === "function" ? btoa(unescape(encodeURIComponent(s))) : Buffer.from(s, "utf8").toString("base64"));

/** The VM's Options panel beyond the basics: tablet, ACPI, KVM, freeze, local time, start date, hotplug, keyboard, SMBIOS, guest agent details, SPICE, extra arguments. */
export function planVmOptions(cfg: Cfg, b: Json, ctx: PlanContext = {}): Change {
  onlyKnown(b, ["tablet", "acpi", "kvm", "freeze", "localtime", "startdate", "hotplug", "keyboard", "tdf", "vmstatestorage", "agent", "spice", "smbios", "args", "allowKsm"]);
  const c = emptyChange();
  const cur = readSettings("qemu", cfg).vm!.options;
  // Booleans whose default is on are written as 0 when off and removed when on; the others the reverse.
  const dfltOn = (key: string, field: string, label: string) => {
    if (b[field] === undefined) return;
    if (boolean(b[field], label)) c.delete.push(key);
    else c.set[key] = "0";
  };
  const dfltOff = (key: string, field: string, label: string) => {
    if (b[field] === undefined) return;
    if (boolean(b[field], label)) c.set[key] = "1";
    else c.delete.push(key);
  };
  dfltOn("tablet", "tablet", "USB tablet");
  dfltOn("acpi", "acpi", "ACPI");
  dfltOn("kvm", "kvm", "KVM hardware virtualization");
  dfltOn("allow-ksm", "allowKsm", "Kernel same-page merging");
  dfltOff("freeze", "freeze", "Freeze CPU at start");
  dfltOff("tdf", "tdf", "Time drift fix");
  if (b.localtime !== undefined) {
    if (b.localtime === null) c.delete.push("localtime");
    else c.set.localtime = flag(boolean(b.localtime, "Local time"));
  }
  if (b.startdate !== undefined) {
    if (b.startdate === null || b.startdate === "" || b.startdate === "now") c.delete.push("startdate");
    else c.set.startdate = typeof b.startdate === "string" && START_RE.test(b.startdate) ? b.startdate : bad("The start date is now, 2026-01-31 or 2026-01-31T12:00:00", "startdate");
  }
  if (b.hotplug !== undefined) {
    if (b.hotplug === null) c.delete.push("hotplug");
    else {
      const l = Array.isArray(b.hotplug) ? b.hotplug : bad("Hotplug is a list", "hotplug");
      const items = l.map((x) => (typeof x === "string" && (HOTPLUG as readonly string[]).includes(x) ? x : bad("Hotplug can be disk, network, usb, memory or cpu", "hotplug")));
      if (new Set(items).size !== items.length) bad("List each hotplug item once", "hotplug");
      c.set.hotplug = items.length ? HOTPLUG.filter((x) => items.includes(x)).join(",") : "0";
      if (items.includes("memory") && str(cfg.numa) !== "1") c.warnings.push("Memory hotplug needs NUMA turned on.");
    }
  }
  if (b.keyboard !== undefined) {
    if (b.keyboard === null || b.keyboard === "") c.delete.push("keyboard");
    else c.set.keyboard = typeof b.keyboard === "string" && (KEYBOARDS as readonly string[]).includes(b.keyboard) ? b.keyboard : bad("Pick a keyboard layout from the list", "keyboard");
  }
  if (b.vmstatestorage !== undefined) {
    if (b.vmstatestorage === null || b.vmstatestorage === "") c.delete.push("vmstatestorage");
    else {
      const s = typeof b.vmstatestorage === "string" && STORAGE_RE.test(b.vmstatestorage) ? b.vmstatestorage : bad("Pick a storage for the VM state", "vmstatestorage");
      if (ctx.storages && !ctx.storages.includes(s)) bad(`There is no storage called ${s}`, "vmstatestorage");
      c.set.vmstatestorage = s;
    }
  }
  if (b.agent !== undefined) {
    const a = b.agent as Json;
    if (typeof a !== "object" || a === null) bad("Guest agent options are a group");
    onlyKnown(a, ["enabled", "freezeFs", "fstrimClonedDisks", "type"]);
    const enabled = a.enabled === undefined ? cur.agent.enabled : boolean(a.enabled, "Guest agent");
    const freezeFs = a.freezeFs === undefined ? cur.agent.freezeFs : boolean(a.freezeFs, "Freeze the file systems for backups");
    const trim = a.fstrimClonedDisks === undefined ? cur.agent.fstrimClonedDisks : boolean(a.fstrimClonedDisks, "Trim cloned disks");
    const type = a.type === undefined ? cur.agent.type : typeof a.type === "string" && (AGENT_TYPES as readonly string[]).includes(a.type) ? a.type : bad("The agent channel is VirtIO or ISA serial", "agent");
    const parts = [`enabled=${flag(enabled)}`];
    if (!freezeFs) parts.push("freeze-fs=0");
    if (trim) parts.push("fstrim_cloned_disks=1");
    if (type !== "virtio") parts.push(`type=${type}`);
    // Keep keys we don't manage.
    for (const [k, v] of parseProps(str(cfg.agent))) if (!["enabled", "freeze-fs", "fstrim_cloned_disks", "type"].includes(k) && !(v === null && k === "1") && !(v === null && k === "0")) parts.push(v === null ? k : `${k}=${v}`);
    c.set.agent = parts.join(",");
  }
  if (b.spice !== undefined) {
    const s = b.spice as Json;
    if (typeof s !== "object" || s === null) bad("SPICE options are a group");
    onlyKnown(s, ["folderSharing", "videoStreaming"]);
    const folder = s.folderSharing === undefined ? cur.spice.folderSharing : boolean(s.folderSharing, "Folder sharing");
    const vs = s.videoStreaming === undefined ? cur.spice.videoStreaming : typeof s.videoStreaming === "string" && (VIDEO_STREAMING as readonly string[]).includes(s.videoStreaming) ? s.videoStreaming : bad("Video streaming is off, all or filter", "spice");
    const parts = [folder ? "foldersharing=1" : "", vs !== "off" ? `videostreaming=${vs}` : ""].filter(Boolean);
    writeOrDelete(c, "spice_enhancements", parts.join(","));
  }
  if (b.smbios !== undefined) {
    const s = b.smbios as Json;
    if (typeof s !== "object" || s === null) bad("SMBIOS settings are a group");
    onlyKnown(s, [...SMBIOS_FIELDS, "uuid"]);
    const now = cur.smbios;
    const parts: string[] = [];
    let any = false;
    for (const f of SMBIOS_FIELDS) {
      const v = s[f] === undefined ? now[f] : typeof s[f] === "string" ? (s[f] as string) : bad(`${f} is text`, "smbios");
      if (v.length > 256 || /[\r\n\u0000]/.test(v)) bad(`${f} is one line of up to 256 characters`, "smbios");
      if (v) {
        parts.push(`${f}=${toB64(v)}`);
        any = true;
      }
    }
    const uuid = s.uuid === undefined ? now.uuid : typeof s.uuid === "string" ? s.uuid : bad("The UUID is text", "smbios");
    if (uuid && !UUID_RE.test(uuid)) bad("The UUID looks like 1b4e28ba-2fa1-11d2-883f-b9a761bde3fb", "smbios");
    if (uuid) {
      parts.unshift(`uuid=${uuid}`);
      any = true;
    }
    if (any) parts.push("base64=1");
    writeOrDelete(c, "smbios1", parts.join(","));
  }
  if (b.args !== undefined) {
    if (b.args === null || b.args === "") c.delete.push("args");
    else {
      if (ctx.admin === false) bad("Only Proxmox administrators may set extra QEMU arguments", "args");
      c.set.args = typeof b.args === "string" && b.args.length <= 2048 && !/[\r\n\u0000]/.test(b.args) ? b.args : bad("Extra arguments are one line of up to 2048 characters", "args");
      c.warnings.push("Extra QEMU arguments are passed to QEMU as typed. A wrong one stops the VM from starting.");
    }
  }
  if (!Object.keys(c.set).length && !c.delete.length) bad("Nothing to change");
  return c;
}

/** The container's Options panel beyond the basics: console mode, terminals, time zone, hook script, architecture, OS type, debug. */
export function planCtOptions(cfg: Cfg, b: Json, ctx: PlanContext = {}): Change {
  onlyKnown(b, ["cmode", "tty", "console", "hookscript", "timezone", "arch", "ostype", "debug"]);
  void cfg;
  const c = emptyChange();
  if (b.cmode !== undefined) {
    if (b.cmode === null) c.delete.push("cmode");
    else c.set.cmode = typeof b.cmode === "string" && (CT_CMODES as readonly string[]).includes(b.cmode) ? b.cmode : bad("Console mode is tty, console or shell", "cmode");
  }
  if (b.tty !== undefined) {
    if (b.tty === null) c.delete.push("tty");
    else c.set.tty = String(whole(b.tty, 0, 6, "Terminals"));
  }
  if (b.console !== undefined) {
    if (boolean(b.console, "Console")) c.delete.push("console");
    else c.set.console = "0";
  }
  if (b.hookscript !== undefined) {
    if (b.hookscript === null || b.hookscript === "") c.delete.push("hookscript");
    else {
      if (ctx.admin === false) bad("Only Proxmox administrators may set a hook script", "hookscript");
      c.set.hookscript = typeof b.hookscript === "string" && /^[A-Za-z0-9][\w.-]{0,39}:snippets\/[\w.-]{1,128}$/.test(b.hookscript) ? b.hookscript : bad("A hook script is a snippet, like local:snippets/hook.pl", "hookscript");
    }
  }
  if (b.timezone !== undefined) {
    if (b.timezone === null || b.timezone === "" || b.timezone === "host") c.delete.push("timezone");
    else c.set.timezone = typeof b.timezone === "string" && /^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/.test(b.timezone) && !b.timezone.includes("..") ? b.timezone : bad("A time zone looks like Europe/Berlin, or host", "timezone");
  }
  if (b.arch !== undefined) {
    c.set.arch = typeof b.arch === "string" && (CT_ARCHES as readonly string[]).includes(b.arch) ? b.arch : bad("Pick an architecture from the list", "arch");
    c.warnings.push("The architecture must match the operating system inside the container.");
  }
  if (b.ostype !== undefined) {
    if (b.ostype === null) c.delete.push("ostype");
    else c.set.ostype = typeof b.ostype === "string" && (CT_OSTYPES as readonly string[]).includes(b.ostype) ? b.ostype : bad("Pick an OS type from the list", "ostype");
  }
  if (b.debug !== undefined) {
    if (boolean(b.debug, "Debug")) c.set.debug = "1";
    else c.delete.push("debug");
  }
  if (!Object.keys(c.set).length && !c.delete.length) bad("Nothing to change");
  return c;
}
