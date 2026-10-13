import { ApiError } from "../api.ts";
import type { Backend } from "../backend.ts";
import type { AclEntry, ActResult, GuestAddresses, GuestApi, GuestDevices, GuestNic, GuestPermissions, HostDevices, ItemName } from "./guestApi.ts";

/**
 * The demo's machine details: the same calls as the host service, answered in this browser, following the same rules
 * (digests, typed confirmations, strict values) so the demo teaches the real behaviour. Cores, memory, notes and tags
 * are kept by the demo backend (the rest of the console reads them from there); everything else lives here.
 */

const fail = (status: number, code: string, message: string): never => {
  throw new ApiError(status, code, message);
};
const bad = (m: string) => fail(400, "bad_request", m);
const wait = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(structuredClone(v)), 40));
const newDigest = () => Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

interface State {
  digest: string;
  nics: GuestNic[];
  dns: NonNullable<GuestDevices["dns"]> | null;
  features: GuestDevices["features"];
  resources: { cpulimit: number | null; cpuunits: number | null };
  vm: GuestDevices["vm"];
  acl: AclEntry[];
}

const states = new WeakMap<Backend, Map<number, State>>();
const MAC = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const CIDR4 = (v: string) => IPV4.test(v.split("/")[0]) && /^\d{1,2}$/.test(v.split("/")[1] ?? "x") && Number(v.split("/")[1]) <= 32;
const ROLES = ["Administrator", "NoAccess", "PVEAuditor", "PVEVMAdmin", "PVEVMUser"];

export function demoGuestApi(backend: Backend): GuestApi {
  if (!states.has(backend)) states.set(backend, new Map());
  const all = states.get(backend)!;

  async function state(vmid: number): Promise<State> {
    const have = all.get(vmid);
    if (have) return have;
    const hw = await backend.hardware(vmid);
    const lxc = hw.type === "lxc";
    const win = hw.ostype === "win11";
    const s: State = {
      digest: newDigest(),
      nics: hw.nics.map((n) => ({ key: n.key, model: n.model, name: n.name, mac: n.mac, bridge: n.bridge, tag: n.tag, trunks: null, firewall: n.firewall, linkDown: false, rate: n.rate, mtu: null, queues: null, ip: n.ip, gw: n.gw, ip6: lxc ? "auto" : null, gw6: null, pending: false })),
      dns: lxc ? { nameserver: [], searchdomain: [], fromHost: true } : null,
      features: lxc ? { nesting: vmid % 2 === 1, keyctl: vmid % 2 === 1, fuse: false, mknod: false, forceRwSys: false, mount: [] } : null,
      resources: { cpulimit: null, cpuunits: null },
      vm: lxc ? null : { bios: win ? "ovmf" : "seabios", display: { type: "std", memory: null, clipboard: null }, serial: [], audio: null, efi: win ? { volume: `local-lvm:vm-${vmid}-disk-1`, efitype: "4m", preEnrolledKeys: true } : null, tpm: win ? { volume: `local-lvm:vm-${vmid}-disk-2`, version: "v2.0" } : null, machine: null },
      acl: [],
    };
    all.set(vmid, s);
    return s;
  }

  const guardDigest = (s: State, digest: unknown) => {
    if (typeof digest !== "string" || !/^[0-9a-f]{40}$/.test(digest)) bad("This page is out of date. Reload and try again");
    if (digest !== s.digest) fail(409, "stale", "This machine changed since the page loaded. Reload and try again.");
  };
  const done = (s: State, pending: boolean, extra: Partial<ActResult> = {}): ActResult => {
    s.digest = newDigest();
    return { ok: true, pending, ...extra };
  };

  const bridges = async () => (await backend.network().catch(() => ({ interfaces: [] }))).interfaces.filter((i) => i.type === "bridge" || i.type === "OVSBridge").map((i) => i.iface);

  const devices = async (vmid: number): Promise<GuestDevices> => {
    const hw = await backend.hardware(vmid);
    const s = await state(vmid);
    return {
      type: hw.type,
      status: hw.status,
      name: hw.name ?? String(vmid),
      digest: s.digest,
      locked: null,
      isAdmin: true,
      pendingKeys: hw.pending,
      bridges: await bridges(),
      nics: s.nics,
      dns: s.dns,
      features: s.features,
      unprivileged: hw.type === "lxc" ? true : null,
      resources: { cores: hw.cores, sockets: hw.type === "qemu" ? hw.sockets : null, memory: hw.memoryMb, balloon: hw.balloonMb, swap: hw.swapMb, cpulimit: s.resources.cpulimit, cpuunits: s.resources.cpuunits, arch: hw.type === "lxc" ? "amd64" : null },
      notes: hw.description,
      tags: hw.tags,
      vm: s.vm,
      passthrough: [],
    };
  };

  const checkNic = (hw: Awaited<ReturnType<Backend["hardware"]>>, b: Record<string, unknown>, existing: GuestNic | undefined, others: GuestNic[]): GuestNic => {
    const lxc = hw.type === "lxc";
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
    const bridge = str(b.bridge);
    if (!bridge || !/^[A-Za-z0-9][\w.-]{0,14}$/.test(bridge)) bad("Pick a bridge");
    const tag = num(b.tag);
    if (tag !== null && (!Number.isInteger(tag) || tag < 1 || tag > 4094)) bad("The VLAN tag must be a whole number from 1 to 4094");
    const mac = str(b.mac);
    if (mac && !MAC.test(mac)) bad("A MAC address looks like BC:24:11:AA:BB:CC");
    if (mac && parseInt(mac.slice(0, 2), 16) & 1) bad("That MAC address is a group address. The first pair must be even, like BC or 02");
    const rate = num(b.rate);
    if (rate !== null && !(rate > 0)) bad("The rate limit is a positive number of MB/s, or empty for no limit");
    const mtu = num(b.mtu);
    const queues = num(b.queues);
    const model = lxc ? null : str(b.model) ?? "virtio";
    if (!lxc && (mtu !== null || queues !== null) && model !== "virtio") bad("MTU and queues only apply to the VirtIO model");
    if (mtu !== null && (!Number.isInteger(mtu) || mtu < (lxc ? 64 : 1) || mtu > (lxc ? 65535 : 65520))) bad(`The MTU must be a whole number from ${lxc ? 64 : 1} to ${lxc ? 65535 : 65520}`);
    const out: GuestNic = { key: existing?.key ?? "", model, name: null, mac: mac ?? existing?.mac ?? `BC:24:11:${Math.random().toString(16).slice(2, 8).toUpperCase().match(/../g)!.join(":")}`, bridge, tag, trunks: str(b.trunks), firewall: b.firewall === true, linkDown: b.linkDown === true, rate, mtu, queues, ip: null, gw: null, ip6: null, gw6: null, pending: hw.status === "running" };
    if (lxc) {
      const name = str(b.name);
      if (!name || !/^[A-Za-z][\w.-]{0,14}$/.test(name)) bad("The device name is 1 to 15 letters, digits, - _ or ., starting with a letter (eth0, for example)");
      if (others.some((o) => o.name === name)) bad(`Another network device in this container is already called ${name}`);
      out.name = name;
      const ip = str(b.ip);
      if (ip && ip !== "dhcp" && ip !== "manual" && !CIDR4(ip)) bad("Use DHCP, none, or an address like 192.168.1.50/24");
      const gw = str(b.gw);
      if (gw && !IPV4.test(gw)) bad("The gateway should be an IPv4 address like 192.168.1.1");
      if (gw && (!ip || ip === "dhcp" || ip === "manual")) bad("A gateway goes with a static address");
      const ip6 = str(b.ip6);
      if (ip6 && !["auto", "dhcp", "manual"].includes(ip6) && !/^[0-9a-f:]+\/\d{1,3}$/i.test(ip6)) bad("Use automatic, DHCP, none, or an IPv6 address like fd00::50/64");
      out.ip = ip;
      out.gw = gw;
      out.ip6 = ip6;
      out.gw6 = str(b.gw6);
    }
    return out;
  };

  return {
    devices: (v) => devices(v).then(wait),
    addresses: async (vmid): Promise<GuestAddresses> => {
      const hw = await backend.hardware(vmid);
      const s = await state(vmid);
      const stat = (n: GuestNic) => (n.ip && n.ip.includes("/") ? [{ ip: n.ip.split("/")[0], prefix: Number(n.ip.split("/")[1]), family: "ipv4" as const }] : []);
      if (hw.status !== "running") {
        const cfg = s.nics.filter((n) => stat(n).length).map((n) => ({ name: n.name ?? n.key, mac: n.mac, addresses: stat(n) }));
        return wait({ type: hw.type, source: cfg.length ? "config" : "none", hostname: hw.type === "lxc" ? hw.name : null, note: cfg.length ? "Stopped. These are the addresses set in the configuration." : "Start the machine to see its addresses.", interfaces: cfg });
      }
      if (hw.type === "qemu" && !hw.agent) return wait({ type: hw.type, source: "none", hostname: null, note: "Turn on the QEMU guest agent (Hardware, Options) and install it inside the machine to see its addresses here.", interfaces: [] });
      const interfaces = s.nics.map((n, i) => ({ name: hw.type === "lxc" ? n.name ?? n.key : `ens${18 + i}`, mac: n.mac, addresses: [{ ip: n.ip?.includes("/") ? n.ip.split("/")[0] : `192.168.1.${(vmid % 180) + 20 + i}`, prefix: 24, family: "ipv4" as const }, { ip: `fe80::be24:11ff:fe${(vmid % 256).toString(16).padStart(2, "0")}:${(i + 1).toString(16).padStart(4, "0")}`, prefix: 64, family: "ipv6" as const }] }));
      return wait({ type: hw.type, source: "running", hostname: hw.name, note: null, interfaces });
    },
    hostDevices: async (): Promise<HostDevices> => wait({ pci: [{ id: "0000:01:00.0", vendor: "NVIDIA Corporation", device: "GA104 [GeForce RTX 3070]", class: "0x030000", iommuGroup: 14, mdev: false }, { id: "0000:00:1f.6", vendor: "Intel Corporation", device: "Ethernet Connection I219-V", class: "0x020000", iommuGroup: 11, mdev: false }], usb: [{ id: "1050:0407", port: "1-2", name: "YubiKey OTP+FIDO+CCID", speed: "12" }], mappings: { pci: [], usb: [] }, notes: { pci: null, usb: null } }),
    permissions: async (vmid): Promise<GuestPermissions> => {
      const s = await state(vmid);
      return wait({ path: `/vms/${vmid}`, canModify: true, visible: true, entries: s.acl, inherited: [{ path: "/", type: "user", id: "owner@pve", role: "Administrator", propagate: true }], roles: ROLES, users: ["owner@pve", "root@pam", "sam@pve"], groups: ["operators"] });
    },
    grant: async (vmid, b) => {
      const s = await state(vmid);
      if (!ROLES.includes(b.role)) bad(`There is no role called ${b.role}`);
      if (b.type === "user" && !/^[^\s:/@]{1,60}@[A-Za-z][A-Za-z0-9.-]{0,31}$/.test(b.id)) bad("A user looks like name@pam or name@pve");
      if (!s.acl.some((e) => e.type === b.type && e.id === b.id && e.role === b.role)) s.acl.push({ path: `/vms/${vmid}`, type: b.type, id: b.id, role: b.role, propagate: b.propagate });
      return demoGuestApi(backend).permissions(vmid);
    },
    revoke: async (vmid, b) => {
      const s = await state(vmid);
      if (b.confirm !== b.id) fail(409, "confirm", `Type ${b.id} to confirm.`);
      s.acl = s.acl.filter((e) => !(e.type === b.type && e.id === b.id && e.role === b.role));
      return demoGuestApi(backend).permissions(vmid);
    },
    saveNic: async (vmid, b) => {
      const hw = await backend.hardware(vmid);
      const s = await state(vmid);
      guardDigest(s, b.digest);
      const key = typeof b.key === "string" ? b.key : null;
      const old = key ? s.nics.find((n) => n.key === key) : undefined;
      if (key && !old) fail(404, "not_found", "That network device isn't on this machine");
      const bridgeList = await bridges();
      const nic = checkNic(hw, b, old, s.nics.filter((n) => n.key !== key));
      if (bridgeList.length && !bridgeList.includes(nic.bridge ?? "")) fail(400, "proxmox_rejected", `bridge '${nic.bridge}' does not exist`);
      const free = key ?? `net${[...Array(32).keys()].find((i) => !s.nics.some((n) => n.key === `net${i}`))}`;
      nic.key = free;
      s.nics = old ? s.nics.map((n) => (n.key === key ? nic : n)) : [...s.nics, nic];
      return wait({ key: free, ...done(s, hw.status === "running") });
    },
    removeNic: async (vmid, key, b) => {
      const hw = await backend.hardware(vmid);
      const s = await state(vmid);
      guardDigest(s, b.digest);
      if (!s.nics.some((n) => n.key === key)) fail(404, "not_found", "That network device isn't on this machine");
      if (b.confirm !== key) fail(409, "confirm", `Type ${key} to confirm.`);
      s.nics = s.nics.filter((n) => n.key !== key);
      return wait(done(s, hw.status === "running"));
    },
    saveDns: async (vmid, b) => {
      const hw = await backend.hardware(vmid);
      const s = await state(vmid);
      guardDigest(s, b.digest);
      if (!s.dns) bad("DNS settings are for containers. VMs get theirs from Cloud-Init or from inside.");
      if (b.nameserver.length > 3) bad("Linux reads up to 3 DNS servers");
      for (const n of b.nameserver) if (!IPV4.test(n) && !/^[0-9a-f:]+(%[\w.-]+)?$/i.test(n)) bad(`"${n}" isn't an IP address`);
      for (const d of b.searchdomain) if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(d)) bad(`"${d}" isn't a domain name`);
      s.dns = { nameserver: b.nameserver, searchdomain: b.searchdomain, fromHost: !b.nameserver.length && !b.searchdomain.length };
      return wait(done(s, hw.status === "running"));
    },
    saveFeatures: async (vmid, b) => {
      const hw = await backend.hardware(vmid);
      const s = await state(vmid);
      guardDigest(s, b.digest);
      if (!s.features) bad("Features are for containers");
      const mount = Array.isArray(b.mount) ? b.mount.map(String) : [];
      for (const t of mount) if (!/^[a-z][a-z0-9_]{1,15}$/.test(t)) bad(`"${t}" isn't a file system type like nfs or cifs`);
      s.features = { nesting: b.nesting === true, keyctl: b.keyctl === true, fuse: b.fuse === true, mknod: b.mknod === true, forceRwSys: b.forceRwSys === true, mount };
      return wait(done(s, hw.status === "running"));
    },
    saveResources: async (vmid, b) => {
      const hw = await backend.hardware(vmid);
      const s = await state(vmid);
      guardDigest(s, b.digest);
      const lxc = hw.type === "lxc";
      const int = (v: unknown, lo: number, hi: number, label: string) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : bad(`${label} must be a whole number from ${lo} to ${hi}`));
      const change: Parameters<Backend["setHardware"]>[1] = {};
      if (b.cores !== undefined) change.cores = int(b.cores, 1, lxc ? 8192 : 512, "Cores");
      if (b.sockets !== undefined) change.sockets = lxc ? bad("Containers don't have sockets") : int(b.sockets, 1, 16, "Sockets");
      if (b.memory !== undefined) change.memoryMb = int(b.memory, 16, 4_194_304, "Memory (MiB)");
      if (b.swap !== undefined) change.swapMb = lxc ? int(b.swap, 0, 1_048_576, "Swap (MiB)") : bad("Only containers have swap");
      if (b.cpulimit !== undefined) s.resources.cpulimit = b.cpulimit === null ? null : typeof b.cpulimit === "number" && b.cpulimit > 0 && b.cpulimit <= (lxc ? 8192 : 128) ? b.cpulimit : bad("The CPU limit is out of range");
      if (b.cpuunits !== undefined) s.resources.cpuunits = b.cpuunits === null ? null : int(b.cpuunits, lxc ? 0 : 1, lxc ? 500000 : 262144, "CPU weight");
      if (change.memoryMb !== undefined && hw.balloonMb && hw.balloonMb > change.memoryMb) bad("The minimum memory can't be more than the memory");
      if (Object.keys(change).length) await backend.setHardware(vmid, change);
      return wait(done(s, hw.status === "running" && hw.type === "qemu"));
    },
    saveNotes: async (vmid, b) => {
      const s = await state(vmid);
      guardDigest(s, b.digest);
      const change: Parameters<Backend["setHardware"]>[1] = {};
      if (b.description !== undefined) {
        if (typeof b.description !== "string" || b.description.length > 8192) bad("Notes are limited to 8192 characters");
        change.description = b.description;
      }
      if (b.tags !== undefined) {
        const list = [...new Set(b.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
        if (list.length > 20) bad("A machine can have up to 20 tags");
        for (const t of list) if (!/^[a-z0-9_][a-z0-9_.+-]{0,63}$/.test(t)) bad(`"${t}" isn't a valid tag. Use letters, digits, _ - . and +`);
        change.tags = list;
      }
      await backend.setHardware(vmid, change);
      return wait(done(s, false));
    },
    item: async (vmid, item: ItemName, b) => {
      const hw = await backend.hardware(vmid);
      const s = await state(vmid);
      guardDigest(s, b.digest);
      if (!s.vm) bad("These are for virtual machines");
      const vm = s.vm!;
      const remove = b.action === "remove";
      const pending = hw.status === "running";
      let key: string | undefined;
      let warning: string | null = null;
      if (item === "display") {
        if (remove) vm.display = { type: "std", memory: null, clipboard: null };
        else {
          const types = ["std", "cirrus", "qxl", "qxl2", "qxl3", "qxl4", "none", "serial0", "serial1", "serial2", "serial3", "virtio", "virtio-gl", "vmware"];
          if (!types.includes(String(b.type))) bad("Pick a display type from the list");
          const mem = b.memory === undefined || b.memory === null || b.memory === "" ? null : Number(b.memory);
          if (mem !== null && (!Number.isInteger(mem) || mem < 4 || mem > 512)) bad("Video memory (MiB) must be a whole number from 4 to 512");
          vm.display = { type: String(b.type), memory: mem, clipboard: b.clipboard === "vnc" ? "vnc" : null };
        }
      } else if (item === "bios") {
        if (b.bios !== "seabios" && b.bios !== "ovmf") bad("BIOS is SeaBIOS or UEFI (OVMF)");
        vm.bios = b.bios as string;
        warning = vm.bios === "ovmf" && !vm.efi ? "UEFI needs an EFI disk to keep its settings. Add one under EFI disk." : null;
      } else if (item === "serial") {
        if (remove) {
          if (!vm.serial.some((x) => x.key === b.key)) bad("That serial port isn't on this machine");
          vm.serial = vm.serial.filter((x) => x.key !== b.key);
        } else {
          key = [0, 1, 2, 3].map((i) => `serial${i}`).find((k) => !vm.serial.some((x) => x.key === k));
          if (!key) bad("All four serial ports are taken");
          vm.serial.push({ key: key!, value: "socket" });
        }
      } else if (item === "audio") {
        if (remove) vm.audio = null;
        else {
          if (!["ich9-intel-hda", "intel-hda", "AC97"].includes(String(b.device))) bad("Pick an audio device from the list");
          vm.audio = { device: String(b.device), driver: b.driver === "spice" ? "spice" : "none" };
        }
      } else if (item === "efi") {
        if (remove) {
          if (!vm.efi) bad("This machine has no EFI disk");
          if (b.confirm !== "efidisk0") fail(409, "confirm", "Type efidisk0 to confirm.");
          vm.efi = null;
        } else {
          if (vm.efi) bad("This machine already has an EFI disk");
          const efitype = b.efitype === "2m" ? "2m" : "4m";
          if (b.preEnrolledKeys === true && efitype !== "4m") bad("Pre-enrolled keys need the 4m EFI disk type");
          vm.efi = { volume: `${String(b.storage ?? "local-lvm")}:vm-${vmid}-disk-1`, efitype, preEnrolledKeys: b.preEnrolledKeys === true };
          if (b.setBios !== false) vm.bios = "ovmf";
        }
      } else if (item === "tpm") {
        if (remove) {
          if (!vm.tpm) bad("This machine has no TPM");
          if (b.confirm !== "tpmstate0") fail(409, "confirm", "Type tpmstate0 to confirm.");
          vm.tpm = null;
        } else {
          if (vm.tpm) bad("This machine already has a TPM");
          vm.tpm = { volume: `${String(b.storage ?? "local-lvm")}:vm-${vmid}-disk-2`, version: b.version === "v1.2" ? "v1.2" : "v2.0" };
        }
      }
      return wait({ ...done(s, pending), ...(key ? { key } : {}), warning });
    },
  };
}
