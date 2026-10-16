import type { Transport } from "@papercliped-engine/proxmox-client";

/**
 * A Proxmox for the creation wizards, layered over the shared fake (which keeps sign-in, tickets and permissions):
 * storages with content types, ISOs and templates, bridges and an SDN vnet, CPU models, PCI and USB devices and
 * mappings, resource groups, and POST /nodes/pve/qemu and /lxc that check every parameter the way Proxmox's API
 * description does (known names, enums, ranges, property-string keys), so a request the wizard builds wrongly fails
 * here as it would on a real host. Created machines are recorded. Nothing here is a real Proxmox; see docs/WIZARDS.md
 * for what could not be checked against one.
 */
export interface WizardCall {
  method: string;
  path: string;
  params: Record<string, string>;
}

const ok = (data: unknown) => ({ status: 200, body: JSON.stringify({ data }) });
const fail = (status: number, message: string) => ({ status, body: JSON.stringify({ message: `${message}\n` }) });

const TAKEN = new Set([100, 101, 200, 201]);

/** "a=1,b=2" -> { a: "1", b: "2" }; a bare first token is returned under "_". */
export function props(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  s.split(",").forEach((part, i) => {
    const eq = part.indexOf("=");
    if (eq < 0) {
      if (i === 0) out._ = part;
      else out[part] = "1";
    } else out[part.slice(0, eq)] = part.slice(eq + 1);
  });
  return out;
}

const bool01 = (v: string) => v === "0" || v === "1";
const inList = (v: string, l: string[]) => l.includes(v);
const NET_MODELS = ["virtio", "e1000", "e1000e", "e1000-82540em", "e1000-82544gc", "e1000-82545em", "i82551", "i82557b", "i82559er", "ne2k_isa", "ne2k_pci", "pcnet", "rtl8139", "vmxnet3"];
const OSTYPES = ["other", "wxp", "w2k", "w2k3", "w2k8", "wvista", "win7", "win8", "win10", "win11", "l24", "l26", "solaris"];

function checkKeys(p: Record<string, string>, props_: string[], extra: RegExp[]): string | null {
  for (const k of Object.keys(p)) if (!props_.includes(k) && !extra.some((r) => r.test(k))) return `property is not defined in schema and the schema does not allow additional properties: ${k}`;
  return null;
}

/** The qemu create schema, from apidoc: names, enums and the property-string keys of the formats we send. */
export function checkQemu(p: Record<string, string>): string | null {
  const names = ["vmid", "name", "ostype", "pool", "start", "onboot", "startup", "tags", "description", "bios", "machine", "scsihw", "agent", "vga", "sockets", "cores", "cpu", "vcpus", "cpulimit", "cpuunits", "numa", "memory", "balloon", "shares", "boot", "efidisk0", "tpmstate0", "citype", "ciuser", "cipassword", "sshkeys", "ciupgrade", "nameserver", "searchdomain", "audio0"];
  const unknown = checkKeys(p, names, [/^(scsi|virtio|sata|ide)\d+$/, /^net\d+$/, /^ipconfig\d+$/, /^hostpci\d+$/, /^usb\d+$/, /^serial\d$/]);
  if (unknown) return unknown;
  if (!p.vmid || !/^\d+$/.test(p.vmid) || Number(p.vmid) < 100) return "vmid: value must be at least 100";
  if (p.ostype && !inList(p.ostype, OSTYPES)) return "ostype: value is not a valid enum value";
  if (p.bios && !inList(p.bios, ["seabios", "ovmf"])) return "bios: value is not a valid enum value";
  if (p.machine && !/^(pc|q35|pc-i440fx-\d+\.\d+|pc-q35-\d+\.\d+)$/.test(p.machine)) return "machine: invalid format";
  if (p.scsihw && !inList(p.scsihw, ["lsi", "lsi53c810", "virtio-scsi-pci", "virtio-scsi-single", "megasas", "pvscsi"])) return "scsihw: value is not a valid enum value";
  if (p.name && !/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(p.name)) return "name: invalid format - value does not look like a valid DNS name";
  if (p.tags && !p.tags.split(";").every((t) => /^[a-z0-9_][a-z0-9_\-+.]*$/i.test(t))) return "tags: invalid format";
  if (p.startup && !Object.keys(props(p.startup)).every((k) => ["order", "up", "down"].includes(k))) return "startup: invalid format";
  for (const k of ["start", "onboot", "numa"]) if (p[k] !== undefined && !bool01(p[k])) return `${k}: type check ('boolean') failed`;
  for (const [k, lo, hi] of [["sockets", 1, 4], ["cores", 1, 512], ["memory", 16, 4194304], ["cpuunits", 1, 10000]] as const) if (p[k] !== undefined && !(Number(p[k]) >= lo && Number(p[k]) <= hi)) return `${k}: value must be between ${lo} and ${hi}`;
  if (p.cpulimit !== undefined && !(Number(p.cpulimit) >= 0 && Number(p.cpulimit) <= 128)) return "cpulimit: value must be between 0 and 128";
  if (p.vcpus !== undefined && Number(p.vcpus) > Number(p.sockets ?? 1) * Number(p.cores ?? 1)) return "vcpus: value must be at most sockets * cores";
  if (p.balloon !== undefined && Number(p.balloon) > Number(p.memory)) return "balloon: must not exceed memory";
  if (p.agent && !Object.keys(props(p.agent)).every((k) => ["_", "enabled", "fstrim_cloned_disks", "type"].includes(k))) return "agent: invalid format";
  if (p.vga) {
    const v = props(p.vga);
    if (!inList(v.type ?? v._, ["cirrus", "none", "qxl", "qxl2", "qxl3", "qxl4", "serial0", "serial1", "serial2", "serial3", "std", "virtio", "virtio-gl", "vmware"])) return "vga: invalid type";
    if (Object.keys(v).some((k) => !["_", "type", "memory", "clipboard"].includes(k))) return "vga: invalid format";
  }
  for (const [k, v] of Object.entries(p)) {
    if (/^(scsi|virtio|sata|ide)(\d+)$/.test(k)) {
      const [, bus, idx] = k.match(/^(scsi|virtio|sata|ide)(\d+)$/)!;
      if (Number(idx) >= { scsi: 31, virtio: 16, sata: 6, ide: 4 }[bus]!) return `${k}: property is not defined in schema`;
      const d = props(v);
      const allowed = ["_", "format", "cache", "discard", "ssd", "iothread", "backup", "media", "size", "aio", "replicate", "serial", "ro", "snapshot", "trans", "wwn", "mbps", "iops", "queues", "secs", "heads", "cyls", "bps", "rerror", "werror", "product", "vendor", "scsiblock", "shared", "import-from", "detect_zeroes", "mbps_rd", "mbps_wr"];
      const bad = Object.keys(d).find((x) => !allowed.includes(x));
      if (bad) return `${k}: unexpected property '${bad}'`;
      if (d.cache && !inList(d.cache, ["none", "directsync", "writethrough", "writeback", "unsafe"])) return `${k}: invalid cache mode`;
      if (d.discard && !inList(d.discard, ["ignore", "on"])) return `${k}: invalid discard`;
      if (d.format && !inList(d.format, ["raw", "qcow2", "vmdk"])) return `${k}: invalid format`;
      if (d.ssd && bus === "virtio") return `${k}: ssd is not supported on virtio`;
      if (d.iothread && !(bus === "virtio" || (bus === "scsi" && p.scsihw === "virtio-scsi-single"))) return `${k}: iothread needs virtio or virtio-scsi-single`;
      if (!d._ || (d.media !== "cdrom" && !/^[\w.-]+:(\d+|cloudinit)$/.test(d._)) ) return `${k}: invalid disk specification '${d._}'`;
    }
    if (/^net\d+$/.test(k)) {
      const n = props(v);
      const model = n.model ?? Object.keys(n).find((x) => NET_MODELS.includes(x));
      if (!model || !NET_MODELS.includes(model)) return `${k}: invalid network model`;
      const allowed = ["_", "model", "macaddr", "bridge", "firewall", "link_down", "mtu", "queues", "rate", "tag", "trunks", ...NET_MODELS];
      const bad = Object.keys(n).find((x) => !allowed.includes(x));
      if (bad) return `${k}: unexpected property '${bad}'`;
      if (n.macaddr && !/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i.test(n.macaddr)) return `${k}: invalid macaddr`;
      if (n.tag && !(Number(n.tag) >= 1 && Number(n.tag) <= 4094)) return `${k}: tag out of range`;
      if (n.mtu && model !== "virtio") return `${k}: mtu is only for virtio`;
      if (n.queues && model !== "virtio") return `${k}: queues is only for virtio`;
    }
    if (/^ipconfig\d+$/.test(k)) {
      const bad = Object.keys(props(v)).find((x) => !["ip", "gw", "ip6", "gw6"].includes(x));
      if (bad) return `${k}: unexpected property '${bad}'`;
      const i = props(v);
      if (i.ip && i.ip !== "dhcp" && !/^[\d.]+\/\d+$/.test(i.ip)) return `${k}: invalid ip`;
      if (i.ip6 && !["auto", "dhcp"].includes(i.ip6) && !/^[0-9a-f:.]+\/\d+$/i.test(i.ip6)) return `${k}: invalid ip6`;
    }
    if (/^hostpci\d+$/.test(k)) {
      const h = props(v);
      if (!h.host && !h.mapping) return `${k}: either 'host' or 'mapping' must be set`;
      if (h.pcie && !/q35/.test(p.machine ?? "")) return `${k}: q35 machine model is not enabled`;
    }
    if (/^usb\d+$/.test(k) && !/^(spice|host=[0-9a-f:.-]+|mapping=[\w-]+)(,usb3=1)?$/i.test(v)) return `${k}: invalid usb specification`;
    if (/^serial\d$/.test(k) && v !== "socket") return `${k}: only socket is allowed`;
  }
  if (p.efidisk0 && p.bios !== "ovmf") return "efidisk0: requires bios=ovmf";
  if (p.audio0) {
    const a = props(p.audio0);
    if (!inList(a.device, ["ich9-intel-hda", "intel-hda", "AC97"]) || (a.driver && !inList(a.driver, ["spice", "none"]))) return "audio0: invalid format";
  }
  if (p.ciupgrade !== undefined && !bool01(p.ciupgrade)) return "ciupgrade: type check ('boolean') failed";
  if (p.sshkeys !== undefined && decodeURIComponent(p.sshkeys) === p.sshkeys && /\s/.test(p.sshkeys)) return "sshkeys: value must be url-encoded";
  return null;
}

/** The lxc create schema, from apidoc. */
export function checkLxc(p: Record<string, string>): string | null {
  const names = ["vmid", "ostemplate", "hostname", "password", "ssh-public-keys", "unprivileged", "pool", "start", "onboot", "startup", "tags", "description", "cores", "cpulimit", "cpuunits", "memory", "swap", "rootfs", "nameserver", "searchdomain", "features"];
  const unknown = checkKeys(p, names, [/^net\d+$/, /^mp\d+$/, /^dev\d+$/]);
  if (unknown) return unknown;
  for (const [k, v] of Object.entries(p)) {
    if (/^mp\d+$/.test(k)) {
      const m = props(v);
      if (!m.mp) return `${k}: mp is missing`;
      if (Object.keys(m).some((x) => !["_", "mp", "ro", "backup", "size", "acl", "quota", "replicate", "shared", "mountoptions", "keepattrs", "idmap"].includes(x))) return `${k}: invalid format`;
      if (!(/^[\w.-]+:\d+$/.test(m._ ?? "") || /^\//.test(m._ ?? ""))) return `${k}: invalid volume '${m._}'`;
    }
    if (/^dev\d+$/.test(k)) {
      const m = props(v);
      if (Object.keys(m).some((x) => !["_", "path", "mode", "uid", "gid", "deny-write"].includes(x))) return `${k}: invalid format`;
      if (!(m.path ?? m._)?.startsWith("/dev/")) return `${k}: invalid device path`;
    }
  }
  if (!p.vmid || Number(p.vmid) < 100) return "vmid: value must be at least 100";
  if (!p.ostemplate) return "ostemplate: property is missing and it is not optional";
  if (p.hostname && !/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(p.hostname)) return "hostname: invalid format - value does not look like a valid DNS name";
  if (p.password !== undefined && p.password.length < 5) return "password: value must be at least 5 characters long";
  for (const k of ["unprivileged", "start", "onboot"]) if (p[k] !== undefined && !bool01(p[k])) return `${k}: type check ('boolean') failed`;
  for (const [k, lo, hi] of [["cores", 1, 8192], ["memory", 16, 4194304], ["swap", 0, 4194304], ["cpuunits", 1, 10000]] as const) if (p[k] !== undefined && !(Number(p[k]) >= lo && Number(p[k]) <= hi)) return `${k}: value must be between ${lo} and ${hi}`;
  if (p.rootfs && !/^[\w.-]+:\d+(,.*)?$/.test(p.rootfs)) return "rootfs: invalid format";
  if (p.features) {
    const f = props(p.features);
    if (Object.keys(f).some((k) => !["nesting", "keyctl", "fuse", "mknod", "mount", "force_rw_sys"].includes(k))) return "features: invalid format";
    if (f.keyctl && p.unprivileged !== "1") return "features: keyctl is for unprivileged containers only";
  }
  for (const [k, v] of Object.entries(p)) {
    if (!/^net\d+$/.test(k)) continue;
    const n = props(v);
    const bad = Object.keys(n).find((x) => !["name", "bridge", "hwaddr", "firewall", "link_down", "mtu", "rate", "tag", "trunks", "type", "ip", "gw", "ip6", "gw6"].includes(x));
    if (bad) return `${k}: unexpected property '${bad}'`;
    if (!n.name) return `${k}: property 'name' is missing`;
    if (n.ip && !["dhcp", "manual"].includes(n.ip) && !/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(n.ip)) return `${k}: invalid ip`;
    if (n.ip6 && !["auto", "dhcp", "manual"].includes(n.ip6) && !/^[0-9a-f:.]+\/\d+$/i.test(n.ip6)) return `${k}: invalid ip6`;
    if (n.gw && !/^\d+\.\d+\.\d+\.\d+$/.test(n.gw)) return `${k}: invalid gw`;
    if (n.hwaddr && !/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i.test(n.hwaddr)) return `${k}: invalid hwaddr`;
  }
  if (p.nameserver && !p.nameserver.split(" ").every((x) => /^[0-9a-f:.]+$/i.test(x))) return "nameserver: invalid address list";
  return null;
}

export function fakeWizard(base: Transport, opts: { admin?: boolean } = {}) {
  const calls: WizardCall[] = [];
  const secretsSeen: string[] = [];
  const created = new Map<number, { type: "qemu" | "lxc"; params: Record<string, string> }>();
  let upid = 0;
  const task = (what: string) => `UPID:pve:${String(++upid).padStart(8, "0")}:00000001:00000001:${what}:x:sam@pve:`;
  const failures = new Set<string>();
  let hideHardware = false;

  const storages = [
    { storage: "local", type: "dir", content: "iso,vztmpl,backup,import", active: 1, enabled: 1, avail: 200e9 },
    { storage: "local-lvm", type: "lvmthin", content: "images,rootdir", active: 1, enabled: 1, avail: 400e9 },
    { storage: "tank", type: "zfspool", content: "images,rootdir", active: 1, enabled: 1, avail: 1e12 },
    { storage: "nas", type: "nfs", content: "images,iso", active: 1, enabled: 1, avail: 2e12 },
    { storage: "old", type: "dir", content: "images", active: 0, enabled: 1, avail: 0 },
  ];
  const files: Record<string, { volid: string; size: number; content: string }[]> = {
    local: [
      { volid: "local:iso/debian-12.iso", size: 650e6, content: "iso" },
      { volid: "local:iso/win11.iso", size: 5e9, content: "iso" },
      { volid: "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst", size: 120e6, content: "vztmpl" },
      { volid: "local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst", size: 130e6, content: "vztmpl" },
      { volid: "local:import/ubuntu-24.04.qcow2", size: 2e9, content: "import" },
      { volid: "local:import/appliance.ova", size: 3e9, content: "import" },
    ],
    nas: [{ volid: "nas:iso/alpine.iso", size: 100e6, content: "iso" }],
  };

  const transport: Transport = async (req) => {
    const u = new URL(req.url);
    const path = u.pathname.replace("/api2/json", "");
    const form = new URLSearchParams(req.body ?? "");
    const params: Record<string, string> = Object.fromEntries([...u.searchParams, ...form]);
    const mine = /^\/(nodes\/pve\/(storage|network|capabilities|hardware|qemu|lxc)(\/|$)|cluster\/(nextid|sdn\/vnets|mapping\/)|pools$)/.test(path) && !/^\/nodes\/pve\/(qemu|lxc)\/\d+/.test(path);
    if (!mine) return base(req);
    const perm = await base({ ...req, method: "GET", url: `${u.origin}/api2/json/access/permissions?path=/`, body: undefined });
    if (perm.status === 401) return perm;
    const admin = (JSON.parse(perm.body).data?.["/"]?.["Sys.Modify"] ?? 0) === 1;
    calls.push({ method: req.method, path, params });
    for (const k of ["password", "cipassword", "ssh-public-keys", "sshkeys"]) if (params[k]) secretsSeen.push(params[k]);

    if (path === "/nodes/pve/storage") {
      const want = params.content;
      return ok(storages.filter((s) => !want || s.content.split(",").includes(want)).map(({ content, ...s }) => ({ ...s, content })));
    }
    const sc = path.match(/^\/nodes\/pve\/storage\/([\w-]+)\/content$/);
    if (sc) return ok((files[sc[1]] ?? []).filter((f) => !params.content || f.content === params.content));
    if (path === "/nodes/pve/network") return ok([{ iface: "vmbr0", type: "bridge" }, { iface: "vmbr1", type: "bridge" }, { iface: "eth0", type: "eth" }].filter((n) => params.type !== "any_bridge" || n.type === "bridge"));
    if (path === "/cluster/sdn/vnets") return ok([{ vnet: "vnetA", zone: "z1" }]);
    if (path === "/nodes/pve/capabilities/qemu/cpu") return ok([{ name: "kvm64", vendor: "default" }, { name: "x86-64-v2-AES", vendor: "default" }, { name: "host", vendor: "default" }, { name: "custom-lab", vendor: "Intel", custom: 1 }]);
    if (path === "/nodes/pve/capabilities/qemu/machines") return ok([{ id: "pc", type: "i440fx" }, { id: "q35", type: "q35" }, { id: "pc-q35-9.0", type: "q35", version: "9.0" }, { id: "pc-i440fx-9.0", type: "i440fx", version: "9.0" }]);
    if (path === "/nodes/pve/hardware/pci") return hideHardware ? fail(403, "Permission check failed (user lacks Sys.Audit)") : ok([{ id: "0000:01:00.0", vendor_name: "NVIDIA Corporation", device_name: "GA104 [GeForce RTX 3070]", iommugroup: 14, class: "0x030000" }, { id: "0000:02:00.0", vendor_name: "Intel", device_name: "Ethernet controller", iommugroup: 15, class: "0x020000" }]);
    if (path === "/nodes/pve/hardware/usb") return hideHardware ? fail(403, "Permission check failed (user lacks Sys.Audit)") : ok([{ busnum: 1, devnum: 1, level: 0, port: 0, prodid: "0002", vendid: "1d6b", manufacturer: "Linux", product: "xHCI Host Controller" }, { busnum: 1, devnum: 4, level: 1, port: 2, prodid: "0041", vendid: "0bda", manufacturer: "Realtek", product: "Zigbee dongle" }]);
    if (path === "/cluster/mapping/pci") return ok([{ id: "gpu0", description: "Main GPU" }]);
    if (path === "/cluster/mapping/usb") return ok([{ id: "dongle", description: "Zigbee" }]);
    if (path === "/pools") return base(req);
    if (path === "/cluster/nextid") {
      if (params.vmid) {
        const id = Number(params.vmid);
        return TAKEN.has(id) || created.has(id) ? fail(400, `Parameter verification failed. vmid: VM ${id} already exists`) : ok(String(id));
      }
      let n = 300;
      while (TAKEN.has(n) || created.has(n)) n++;
      return ok(String(n));
    }
    if ((path === "/nodes/pve/qemu" || path === "/nodes/pve/lxc") && req.method === "POST") {
      if (!(admin || opts.admin)) return fail(403, "Permission check failed (/vms/" + params.vmid + ", VM.Allocate)");
      const type = path.endsWith("/qemu") ? "qemu" : "lxc";
      const problem = type === "qemu" ? checkQemu(params) : checkLxc(params);
      if (problem) return fail(400, `Parameter verification failed.\n${problem}`);
      const id = Number(params.vmid);
      if (TAKEN.has(id) || created.has(id)) return fail(500, `unable to create VM ${id}: config file already exists`);
      if (failures.has("create")) return fail(500, "unable to create: storage 'local-lvm' is full");
      if (failures.has("echo")) return fail(500, `unable to set password '${params.password ?? params.cipassword}' for the machine`);
      created.set(id, { type, params });
      return ok(task(type === "qemu" ? "qmcreate" : "vzcreate"));
    }
    return base(req);
  };

  return { transport, calls, secretsSeen, created, failures, hide: (v = true) => void (hideHardware = v) };
}
