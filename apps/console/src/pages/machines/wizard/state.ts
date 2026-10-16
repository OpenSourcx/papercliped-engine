import { osDefaults, type CtWizardSpec, type DiskBus, type IpV4, type IpV6, type OsType, type VmWizardSpec } from "@papercliped-engine/proxmox-client/wizard-schema";
import type { DiskStorageOption, WizardOptions } from "../../../data/engine/wizard.ts";

/**
 * The wizards' form state (strings while typing) and how it becomes the request the host checks. The checks
 * themselves are the shared schema's: the form never decides what is valid.
 */

export type Kind = "lxc" | "qemu";

export const SIZES: Record<Kind, { id: string; label: string; cores: number; memoryMb: number; diskGb: number; hint: string }[]> = {
  lxc: [
    { id: "small", label: "Small", cores: 1, memoryMb: 1024, diskGb: 8, hint: "Scripts, bots, a small service" },
    { id: "medium", label: "Medium", cores: 2, memoryMb: 4096, diskGb: 32, hint: "Web apps, databases, builds" },
    { id: "large", label: "Large", cores: 4, memoryMb: 8192, diskGb: 64, hint: "Heavier workloads" },
  ],
  qemu: [
    { id: "small", label: "Small", cores: 2, memoryMb: 2048, diskGb: 32, hint: "A light Linux server" },
    { id: "medium", label: "Medium", cores: 4, memoryMb: 8192, diskGb: 64, hint: "Windows, desktops, builds" },
    { id: "large", label: "Large", cores: 8, memoryMb: 16384, diskGb: 128, hint: "Heavier workloads" },
  ],
};

export interface DiskForm {
  id: number;
  bus: DiskBus;
  storage: string;
  sizeGb: string;
  format: string;
  cache: string;
  discard: boolean;
  ssd: boolean;
  iothread: boolean;
  backup: boolean;
  /** An image on an import storage to create the disk from; empty makes a new empty disk. */
  importFrom: string;
}
export interface VmNicForm {
  id: number;
  model: string;
  bridge: string;
  vlan: string;
  mac: string;
  firewall: boolean;
  disconnected: boolean;
  rate: string;
  mtu: string;
  queues: string;
}
export interface IpForm {
  v4: IpV4["mode"];
  v4cidr: string;
  v4gw: string;
  v6: IpV6["mode"];
  v6cidr: string;
  v6gw: string;
}
export interface CtNicForm extends IpForm {
  id: number;
  name: string;
  bridge: string;
  vlan: string;
  mac: string;
  firewall: boolean;
  disconnected: boolean;
  rate: string;
  mtu: string;
}
export interface PciForm {
  id: number;
  source: "device" | "mapping";
  device: string;
  mapping: string;
  pcie: boolean;
  primaryGpu: boolean;
  romBar: boolean;
}
export interface UsbForm {
  id: number;
  source: "host" | "mapping" | "spice";
  host: string;
  mapping: string;
  usb3: boolean;
}

export interface GeneralForm {
  name: string;
  vmid: string;
  pool: string;
  start: boolean;
  onboot: boolean;
  order: string;
  up: string;
  down: string;
  tags: string;
  description: string;
}

export interface VmForm extends GeneralForm {
  media: "iso" | "cdrom" | "none";
  iso: string;
  ostype: OsType;
  bios: "seabios" | "ovmf";
  machine: string;
  scsihw: string;
  agent: boolean;
  vgaType: string;
  vgaMemory: string;
  efi: boolean;
  efiStorage: string;
  preEnrolled: boolean;
  tpm: boolean;
  tpmStorage: string;
  tpmVersion: "v1.2" | "v2.0";
  disks: DiskForm[];
  sockets: string;
  cores: string;
  cpuType: string;
  vcpus: string;
  cpuLimit: string;
  cpuUnits: string;
  numa: boolean;
  memoryMb: string;
  balloon: boolean;
  balloonMin: string;
  shares: string;
  nics: VmNicForm[];
  ci: boolean;
  ciStorage: string;
  ciType: string;
  ciUser: string;
  ciPassword: string;
  ciKeys: string;
  ciUpgrade: boolean;
  ciNameserver: string;
  ciSearch: string;
  ciIp: IpForm[];
  pci: PciForm[];
  usb: UsbForm[];
  serial: string;
  audio: boolean;
  audioDevice: string;
  audioDriver: string;
}

export interface MountForm {
  id: number;
  path: string;
  kind: "volume" | "host";
  storage: string;
  sizeGb: string;
  hostPath: string;
  readOnly: boolean;
  backup: boolean;
}
export interface DeviceForm {
  id: number;
  path: string;
  mode: string;
  gid: string;
  denyWrite: boolean;
}

export interface CtForm extends GeneralForm {
  password: string;
  sshKeys: string;
  unprivileged: boolean;
  template: string;
  storage: string;
  sizeGb: string;
  cores: string;
  cpuLimit: string;
  cpuUnits: string;
  memoryMb: string;
  swapMb: string;
  nics: CtNicForm[];
  nameserver: string;
  searchdomain: string;
  nesting: boolean;
  keyctl: boolean;
  fuse: boolean;
  mounts: MountForm[];
  devices: DeviceForm[];
}

let seq = 1;
export const nextKey = () => seq++;

const general = (name: string): GeneralForm => ({ name, vmid: "", pool: "", start: true, onboot: false, order: "", up: "", down: "", tags: "", description: "" });
export const emptyIp = (): IpForm => ({ v4: "dhcp", v4cidr: "", v4gw: "", v6: "none", v6cidr: "", v6gw: "" });

export function defaultDisk(o: WizardOptions | null, bus: DiskBus, sizeGb: number, flags: Partial<DiskForm> = {}): DiskForm {
  return { id: nextKey(), bus, storage: o?.vmStorages[0]?.storage ?? "", sizeGb: String(sizeGb), format: "", cache: "", discard: false, ssd: false, iothread: false, backup: true, importFrom: "", ...flags };
}

export function defaultVm(o: WizardOptions | null, name: string, sizeId: string): VmForm {
  const size = SIZES.qemu.find((s) => s.id === sizeId) ?? SIZES.qemu[0];
  const d = osDefaults("l26");
  const store = o?.vmStorages[0]?.storage ?? "";
  return {
    ...general(name),
    media: "iso",
    iso: o?.isos[0]?.volid ?? "",
    ostype: "l26",
    bios: d.bios,
    machine: d.machine,
    scsihw: d.scsihw,
    agent: true,
    vgaType: "std",
    vgaMemory: "",
    efi: true,
    efiStorage: store,
    preEnrolled: true,
    tpm: false,
    tpmStorage: store,
    tpmVersion: "v2.0",
    disks: [defaultDisk(o, d.bus, size.diskGb, { iothread: d.iothread, discard: d.discard })],
    sockets: "1",
    cores: String(size.cores),
    cpuType: "x86-64-v2-AES",
    vcpus: "",
    cpuLimit: "",
    cpuUnits: "",
    numa: false,
    memoryMb: String(size.memoryMb),
    balloon: false,
    balloonMin: "",
    shares: "",
    nics: [defaultVmNic(o, d.nic)],
    ci: false,
    ciStorage: store,
    ciType: "",
    ciUser: "",
    ciPassword: "",
    ciKeys: "",
    ciUpgrade: true,
    ciNameserver: "",
    ciSearch: "",
    ciIp: [],
    pci: [],
    usb: [],
    serial: "0",
    audio: false,
    audioDevice: "ich9-intel-hda",
    audioDriver: "spice",
  };
}

export const defaultVmNic = (o: WizardOptions | null, model = "virtio"): VmNicForm => ({ id: nextKey(), model, bridge: o?.bridges[0]?.id ?? "vmbr0", vlan: "", mac: "", firewall: true, disconnected: false, rate: "", mtu: "", queues: "" });
export const defaultCtNic = (o: WizardOptions | null, index = 0): CtNicForm => ({ id: nextKey(), name: `eth${index}`, bridge: o?.bridges[0]?.id ?? "vmbr0", vlan: "", mac: "", firewall: true, disconnected: false, rate: "", mtu: "", ...emptyIp() });

export function defaultCt(o: WizardOptions | null, name: string, sizeId: string, template: string): CtForm {
  const size = SIZES.lxc.find((s) => s.id === sizeId) ?? SIZES.lxc[0];
  return {
    ...general(name),
    password: "",
    sshKeys: "",
    unprivileged: true,
    template,
    storage: o?.ctStorages[0]?.storage ?? "",
    sizeGb: String(size.diskGb),
    cores: String(size.cores),
    cpuLimit: "",
    cpuUnits: "",
    memoryMb: String(size.memoryMb),
    swapMb: "512",
    nics: [defaultCtNic(o)],
    nameserver: "",
    searchdomain: "",
    nesting: true,
    keyctl: false,
    fuse: false,
    mounts: [],
    devices: [],
  };
}

/** Re-applies an operating system's usual choices (BIOS, machine, bus, network card, drivers) to the form. */
export function applyOsDefaults(f: VmForm, os: OsType): VmForm {
  const d = osDefaults(os);
  return {
    ...f,
    ostype: os,
    bios: d.bios,
    machine: d.machine,
    scsihw: d.scsihw,
    efi: d.efi || f.efi,
    tpm: d.tpm,
    disks: f.disks.map((x, i) => (i === 0 ? { ...x, bus: d.bus, iothread: d.iothread && (d.bus === "virtio" || (d.bus === "scsi" && d.scsihw === "virtio-scsi-single")), discard: d.discard, ssd: false } : x)),
    nics: f.nics.map((x, i) => (i === 0 ? { ...x, model: d.nic } : x)),
  };
}

// ---- Form -> request

const n = (s: string): number | undefined => (s.trim() === "" ? undefined : Number(s));
const s = (v: string): string | undefined => (v.trim() === "" ? undefined : v.trim());
const list = (v: string) => v.split(/[;,\s]+/).filter(Boolean);

function generalSpec(f: GeneralForm) {
  const order = n(f.order), up = n(f.up), down = n(f.down);
  return { vmid: n(f.vmid), pool: s(f.pool), start: f.start, onboot: f.onboot, startup: order !== undefined || up !== undefined || down !== undefined ? { order, up, down } : undefined, tags: list(f.tags), description: s(f.description) };
}
const ip4 = (m: IpV4["mode"], cidr: string, gw: string): IpV4 | undefined => (m === "none" ? undefined : { mode: m, cidr: m === "static" ? cidr.trim() : undefined, gw: m === "static" ? s(gw) : undefined });
const ip6 = (m: IpV6["mode"], cidr: string, gw: string): IpV6 | undefined => (m === "none" ? undefined : { mode: m, cidr: m === "static" ? cidr.trim() : undefined, gw: m === "static" ? s(gw) : undefined });

export function vmSpec(f: VmForm): VmWizardSpec {
  const ci = f.ci;
  return {
    general: { name: f.name.trim(), ...generalSpec(f) },
    os: { media: f.media, iso: f.media === "iso" ? f.iso : undefined, ostype: f.ostype },
    system: {
      vga: f.vgaType !== "std" || f.vgaMemory.trim() ? { type: f.vgaType as never, memory: n(f.vgaMemory) } : undefined,
      machine: f.machine,
      bios: f.bios,
      scsihw: f.scsihw as never,
      agent: f.agent,
      efi: f.bios === "ovmf" && f.efi ? { storage: f.efiStorage, preEnrolledKeys: f.preEnrolled } : undefined,
      tpm: f.tpm ? { storage: f.tpmStorage, version: f.tpmVersion } : undefined,
    },
    disks: f.disks.map((d) => ({ bus: d.bus, storage: d.storage, sizeGb: d.importFrom ? undefined : (n(d.sizeGb) as number), importFrom: s(d.importFrom), format: (s(d.format) as never) ?? undefined, cache: (s(d.cache) as never) ?? undefined, discard: d.discard, ssd: d.ssd, iothread: d.iothread, backup: d.backup })),
    cpu: { sockets: n(f.sockets), cores: n(f.cores) as number, type: s(f.cpuType), vcpus: n(f.vcpus), limit: n(f.cpuLimit), units: n(f.cpuUnits), numa: f.numa },
    memory: { mb: n(f.memoryMb) as number, balloonMinMb: f.balloon ? n(f.balloonMin) : undefined, shares: f.balloon ? n(f.shares) : undefined },
    network: f.nics.map((x) => ({ model: x.model as never, bridge: x.bridge, vlan: n(x.vlan), mac: s(x.mac), firewall: x.firewall, disconnected: x.disconnected, rateMbps: n(x.rate), mtu: n(x.mtu), queues: n(x.queues) })),
    cloudInit: ci
      ? {
          storage: f.ciStorage,
          type: s(f.ciType) as never,
          user: s(f.ciUser),
          password: s(f.ciPassword),
          sshKeys: s(f.ciKeys),
          upgrade: f.ciUpgrade,
          nameserver: list(f.ciNameserver),
          searchdomain: s(f.ciSearch),
          ip: f.nics.map((_, i) => {
            const x = f.ciIp[i] ?? emptyIp();
            return { ipv4: ip4(x.v4, x.v4cidr, x.v4gw), ipv6: ip6(x.v6, x.v6cidr, x.v6gw) };
          }),
        }
      : undefined,
    hardware: {
      pci: f.pci.map((p) => ({ device: p.source === "device" ? s(p.device) : undefined, mapping: p.source === "mapping" ? s(p.mapping) : undefined, pcie: p.pcie, primaryGpu: p.primaryGpu, romBar: p.romBar ? undefined : false })),
      usb: f.usb.map((u) => ({ host: u.source === "host" ? s(u.host) : undefined, mapping: u.source === "mapping" ? s(u.mapping) : undefined, spice: u.source === "spice" ? true : undefined, usb3: u.usb3 })),
      serial: n(f.serial),
      audio: f.audio ? { device: f.audioDevice as never, driver: f.audioDriver as never } : undefined,
    },
  };
}

export function ctSpec(f: CtForm): CtWizardSpec {
  return {
    general: { hostname: f.name.trim(), ...generalSpec(f), unprivileged: f.unprivileged, password: s(f.password), sshKeys: s(f.sshKeys) },
    template: f.template,
    disk: { storage: f.storage, sizeGb: n(f.sizeGb) as number },
    cpu: { cores: n(f.cores) as number, limit: n(f.cpuLimit), units: n(f.cpuUnits) },
    memory: { mb: n(f.memoryMb) as number, swapMb: n(f.swapMb) as number },
    network: f.nics.map((x) => ({ name: s(x.name), bridge: x.bridge, vlan: n(x.vlan), mac: s(x.mac), firewall: x.firewall, disconnected: x.disconnected, rateMbps: n(x.rate), mtu: n(x.mtu), ipv4: ip4(x.v4, x.v4cidr, x.v4gw), ipv6: ip6(x.v6, x.v6cidr, x.v6gw) })),
    dns: { nameserver: list(f.nameserver), searchdomain: s(f.searchdomain) },
    features: { nesting: f.nesting, keyctl: f.keyctl && f.unprivileged, fuse: f.fuse },
    mounts: f.mounts.map((m) => (m.kind === "host" ? { path: m.path, hostPath: m.hostPath, readOnly: m.readOnly } : { path: m.path, storage: m.storage, sizeGb: n(m.sizeGb), readOnly: m.readOnly, backup: m.backup })),
    devices: f.devices.map((d) => ({ path: d.path, mode: s(d.mode), gid: n(d.gid), denyWrite: d.denyWrite })),
  };
}

// ---- Steps

export interface StepDef {
  id: string;
  label: string;
  /** The request sections this step owns, so an error can be sent to the step that can fix it. */
  fields: string[];
  optional?: boolean;
}
export const VM_STEPS: StepDef[] = [
  { id: "general", label: "General", fields: ["general"] },
  { id: "os", label: "OS", fields: ["os"] },
  { id: "system", label: "System", fields: ["system"] },
  { id: "disks", label: "Disks", fields: ["disks"] },
  { id: "cpu", label: "CPU", fields: ["cpu"] },
  { id: "memory", label: "Memory", fields: ["memory"] },
  { id: "network", label: "Network", fields: ["network"] },
  { id: "cloudinit", label: "Cloud-init", fields: ["cloudInit"], optional: true },
  { id: "hardware", label: "Hardware", fields: ["hardware"], optional: true },
  { id: "confirm", label: "Confirm", fields: [] },
];
export const CT_STEPS: StepDef[] = [
  { id: "general", label: "General", fields: ["general"] },
  { id: "template", label: "Template", fields: ["template"] },
  { id: "disk", label: "Disk", fields: ["disk"] },
  { id: "cpu", label: "CPU", fields: ["cpu"] },
  { id: "memory", label: "Memory", fields: ["memory"] },
  { id: "network", label: "Network", fields: ["network"] },
  { id: "extras", label: "Mounts and devices", fields: ["mounts", "devices"], optional: true },
  { id: "dns", label: "DNS and features", fields: ["dns", "features"], optional: true },
  { id: "confirm", label: "Confirm", fields: [] },
];

export const stepOfField = (steps: StepDef[], field: string): number => {
  const root = field.split(".")[0];
  const i = steps.findIndex((st) => st.fields.includes(root));
  return i < 0 ? 0 : i;
};

export const storageById = (l: DiskStorageOption[], id: string) => l.find((x) => x.storage === id);
