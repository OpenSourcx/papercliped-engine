import { useMemo } from "react";
import { readPassthrough, type PassthroughItem, checkAgentAction, checkBulk, checkClone, checkDelete, checkPower, checkSnapshotDescription, planCloudInit, planCloudInitDrive, planMapping, planPassthrough, planCustomCpu, readCloudInit, spiceFile, type CloudInitView, type MappingEntry } from "@papercliped-engine/proxmox-client/machine-extra";
import { MachineError, applyChange, planCpu, planCtOptions, planDevice, planMachine, planMemoryExtras, planNuma, planVmOptions, readSettings, type Cfg, type DeviceKind, type MachineSettings } from "@papercliped-engine/proxmox-client/machine-schema";
import { ApiError, SIGNED_OUT } from "../api.ts";
import type { Backend } from "../backend.ts";
import { useEngine } from "../store.tsx";

/**
 * The machine page's extra settings (processor, memory, machine type, small devices, options), host devices, Cloud-Init,
 * power options, snapshots, clone and delete options, the guest agent, SPICE and monitor, host hardware, capabilities,
 * resource mappings, custom CPU models and bulk actions. Live, these calls go to the host service, which acts as the
 * signed-in person; in the demo the same calls run in this browser with the same shared checks (machine-schema,
 * machine-extra), so the demo teaches the real behaviour.
 */

export type SettingsView = MachineSettings & { passthrough: PassthroughItem[]; status: string; name: string; template: boolean; digest: string | null; locked: string | null; isAdmin: boolean; pendingKeys: string[] };
export type Saved = { ok: true; pending: boolean; warnings: string[]; key?: string | null };
export type SettingsGroup = "cpu" | "numa" | "memory" | "machine" | "vmoptions" | "ctoptions" | DeviceKind;

export interface Choices {
  cpuModels: { name: string; vendor: string | null; custom: boolean }[];
  cpuFlags: { name: string; description: string }[];
  machines: { id: string; type: string | null; version: string | null }[];
  dirMappings: { id: string; description: string }[];
  storages: string[];
}

export interface HostDeviceList {
  root: boolean;
  pci: { id: string; vendor: string | null; device: string | null; class: string | null; iommuGroup: number; mdev: boolean }[];
  usb: { id: string; port: string; name: string; speed: string | null }[];
  mappings: { pci: { id: string; description: string; entries: number; mdev: boolean }[]; usb: { id: string; description: string; entries: number; mdev: boolean }[] };
  notes: { pci: string | null; usb: string | null; dev: string | null };
  explainer: string | null;
  machine: "qemu" | "lxc";
}

export interface PendingList {
  running: boolean;
  items: { key: string; current: string | null; pending: string | null; remove: boolean }[];
}

export interface CloudInitState {
  view: CloudInitView;
  digest: string | null;
  locked: string | null;
  status: string;
  template: boolean;
  storages: string[];
  snippets: string[];
  changed: { key: string; pending: string | null; remove: boolean }[];
  isAdmin: boolean;
}

export interface CloneChoices {
  type: "qemu" | "lxc";
  name: string;
  template: boolean;
  nextid: number | null;
  nodes: string[];
  pools: string[];
  snapshots: string[];
  storages: { storage: string; type: string }[];
  canLink: boolean;
  cloudInit: boolean;
  nets: number;
}

export interface CloneResult {
  vmid: number;
  task: string;
  applied: boolean | null;
  steps: { step: string; ok: boolean; message: string }[];
  note?: string;
}

export interface AgentResult {
  ok?: boolean;
  message?: string;
  result?: unknown;
  finished?: boolean;
  exitcode?: number | null;
  out?: string;
  err?: string;
  content?: string;
  truncated?: boolean;
  file?: string;
}

export interface PciRow {
  id: string;
  vendor: string | null;
  device: string | null;
  vendorId: string | null;
  deviceId: string | null;
  subsystem: string | null;
  class: string | null;
  iommuGroup: number;
  mdev: boolean;
  mappings: string[];
}
export interface UsbRow {
  id: string;
  bus: number;
  port: string;
  level: number;
  name: string;
  serial: string | null;
  speed: string | null;
  hub: boolean;
}
export interface Capabilities {
  node: string;
  cpu: { name: string; vendor: string | null; custom: boolean }[];
  flags: { name: string; description: string; supported: boolean | null }[];
  machines: { id: string; type: string | null; version: string | null; changes: string | null }[];
  migration: { cpu: string | null; hasDirtyBitmaps: boolean } | null;
}
export type MappingKind = "pci" | "usb" | "dir";
export interface MappingRow {
  id: string;
  description: string;
  mdev: boolean;
  map: MappingEntry[];
  checks: { severity: string; message: string }[];
  digest: string | null;
}
export interface MappingList {
  kind: MappingKind;
  visible: boolean;
  canModify: boolean;
  nodes: string[];
  mappings: MappingRow[];
}
export interface CpuModelRow {
  cputype: string;
  reportedModel: string;
  flags: string | null;
  hidden: boolean;
  hvVendorId: string | null;
  physBits: string | null;
  digest: string | null;
}

type Body = Record<string, unknown>;

export interface MachineApi {
  settings(vmid: number): Promise<SettingsView>;
  choices(vmid: number): Promise<Choices>;
  save(vmid: number, group: SettingsGroup, body: Body): Promise<Saved>;
  hostDevices(vmid: number): Promise<HostDeviceList>;
  saveHostDevice(vmid: number, body: Body): Promise<Saved>;
  pending(vmid: number): Promise<PendingList>;
  revert(vmid: number, digest: string, keys: string[]): Promise<Saved>;
  cloudInit(vmid: number): Promise<CloudInitState>;
  saveCloudInit(vmid: number, body: Body): Promise<Saved>;
  removeCloudInitDrive(vmid: number, body: Body): Promise<Saved>;
  regenerateCloudInit(vmid: number): Promise<{ ok: true }>;
  dumpCloudInit(vmid: number, type: "user" | "network" | "meta"): Promise<{ type: string; text: string }>;
  status(vmid: number, body: Body): Promise<{ task: string }>;
  snapshotConfig(vmid: number, name: string): Promise<{ name: string; description: string; vmstate: string | null; time: number | null; settings: Record<string, string> }>;
  describeSnapshot(vmid: number, name: string, description: string): Promise<{ ok: true }>;
  restoreSnapshot(vmid: number, name: string, body: { confirm: string; start: boolean }): Promise<{ task: string }>;
  cloneChoices(vmid: number): Promise<CloneChoices>;
  clone(vmid: number, body: Body): Promise<CloneResult>;
  remove(vmid: number, body: Body): Promise<{ task: string }>;
  spice(vmid: number, proxy: string | null): Promise<{ filename: string; file: string }>;
  monitor(vmid: number, command: string): Promise<{ command: string; output: string }>;
  agentRead(vmid: number, what: string): Promise<{ what: string; result: unknown }>;
  agent(vmid: number, body: Body): Promise<AgentResult>;
  pciDevices(all: boolean): Promise<{ node: string; note: string | null; devices: PciRow[] }>;
  mdevTypes(id: string): Promise<{ id: string; types: { type: string; name: string | null; description: string; available: number }[] }>;
  usbDevices(): Promise<{ node: string; note: string | null; devices: UsbRow[] }>;
  capabilities(): Promise<Capabilities>;
  mappings(kind: MappingKind): Promise<MappingList>;
  saveMapping(kind: MappingKind, id: string | null, body: Body): Promise<{ ok: true }>;
  deleteMapping(kind: MappingKind, id: string, confirm: string): Promise<{ ok: true }>;
  cpuModels(): Promise<{ visible: boolean; canModify: boolean; models: CpuModelRow[] }>;
  saveCpuModel(name: string | null, body: Body): Promise<{ ok: true }>;
  deleteCpuModel(name: string, confirm: string): Promise<{ ok: true }>;
  bulk(scope: "guests" | "node", body: Body): Promise<{ task: string }>;
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method, credentials: "same-origin", headers: method === "POST" ? { "Content-Type": "application/json", "X-EPC-Request": "1" } : { Accept: "application/json" }, body: method === "POST" ? JSON.stringify(body ?? {}) : undefined });
  } catch {
    throw new ApiError(0, "offline", "Can't reach this device");
  }
  if (!(res.headers.get("content-type") ?? "").startsWith("application/json")) throw new ApiError(res.status, "no_service", "The host service isn't running");
  const data = (await res.json()) as T & { error?: string; code?: string };
  if (!res.ok) {
    const err = new ApiError(res.status, data.code ?? "error", data.error ?? `Request failed (${res.status})`);
    if (res.status === 401 && err.code === "signed_out") window.dispatchEvent(new Event(SIGNED_OUT));
    throw err;
  }
  return data;
}

const g = (vmid: number, tail: string) => `/api/guests/${vmid}/${tail}`;
const enc = encodeURIComponent;

export const liveMachineApi: MachineApi = {
  settings: (v) => request("GET", g(v, "settings")),
  choices: (v) => request("GET", g(v, "settings/choices")),
  save: (v, group, b) => request("POST", g(v, `settings/${group}`), b),
  hostDevices: (v) => request("GET", g(v, "host-devices")),
  saveHostDevice: (v, b) => request("POST", g(v, "host-devices"), b),
  pending: (v) => request("GET", g(v, "pending")),
  revert: (v, digest, keys) => request("POST", g(v, "pending/revert"), { digest, keys }),
  cloudInit: (v) => request("GET", g(v, "cloudinit")),
  saveCloudInit: (v, b) => request("POST", g(v, "cloudinit"), b),
  removeCloudInitDrive: (v, b) => request("POST", g(v, "cloudinit/drive/remove"), b),
  regenerateCloudInit: (v) => request("POST", g(v, "cloudinit/regenerate"), {}),
  dumpCloudInit: (v, type) => request("GET", g(v, `cloudinit/dump?type=${type}`)),
  status: (v, b) => request("POST", g(v, "status"), b),
  snapshotConfig: (v, n) => request("GET", g(v, `snapshots/${enc(n)}/config`)),
  describeSnapshot: (v, n, description) => request("POST", g(v, `snapshots/${enc(n)}/describe`), { description }),
  restoreSnapshot: (v, n, b) => request("POST", g(v, `snapshots/${enc(n)}/restore`), b),
  cloneChoices: (v) => request("GET", g(v, "clone-options")),
  clone: (v, b) => request("POST", g(v, "clone-options"), b),
  remove: (v, b) => request("POST", g(v, "delete"), b),
  spice: (v, proxy) => request("POST", g(v, "spice"), proxy ? { proxy } : {}),
  monitor: (v, command) => request("POST", g(v, "monitor"), { command }),
  agentRead: (v, what) => request("GET", g(v, `agent/${what}`)),
  agent: (v, b) => request("POST", g(v, "agent"), b),
  pciDevices: (all) => request("GET", `/api/hardware/pci${all ? "?all=1" : ""}`),
  mdevTypes: (id) => request("GET", `/api/hardware/pci/mdev?id=${enc(id)}`),
  usbDevices: () => request("GET", "/api/hardware/usb"),
  capabilities: () => request("GET", "/api/capabilities/qemu"),
  mappings: (k) => request("GET", `/api/mappings/${k}`),
  saveMapping: (k, id, b) => request("POST", id ? `/api/mappings/${k}/${enc(id)}` : `/api/mappings/${k}`, b),
  deleteMapping: (k, id, confirm) => request("POST", `/api/mappings/${k}/${enc(id)}/delete`, { confirm }),
  cpuModels: () => request("GET", "/api/cpu-models"),
  saveCpuModel: (name, b) => request("POST", name ? `/api/cpu-models/${enc(name)}` : "/api/cpu-models", b),
  deleteCpuModel: (name, confirm) => request("POST", `/api/cpu-models/${enc(name)}/delete`, { confirm }),
  bulk: (scope, b) => request("POST", `/api/bulk/${scope}`, b),
};

// ---- The demo: the same calls, answered here, with the same shared checks.

const wait = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(structuredClone(v)), 40));
const newDigest = () => Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
const fail = (status: number, code: string, message: string): never => {
  throw new ApiError(status, code, message);
};
/** Shared checks throw MachineError; the console shows it as a refused request. */
function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof MachineError) return fail(400, "bad_request", e.message);
    throw e;
  }
}

interface Demo {
  cfg: Cfg;
  digest: string;
  pending: Record<string, string | null>;
  ciPending: Record<string, string | null>;
  snaps: Record<string, string>;
}
const demos = new WeakMap<Backend, Map<number, Demo>>();
const mappingStore = new WeakMap<Backend, Record<MappingKind, MappingRow[]>>();
const cpuStore = new WeakMap<Backend, CpuModelRow[]>();

const DEMO_PCI: PciRow[] = [
  { id: "0000:01:00.0", vendor: "NVIDIA Corporation", device: "GA104 [GeForce RTX 3070]", vendorId: "0x10de", deviceId: "0x2484", subsystem: null, class: "0x030000", iommuGroup: 14, mdev: false, mappings: [] },
  { id: "0000:01:00.1", vendor: "NVIDIA Corporation", device: "GA104 High Definition Audio", vendorId: "0x10de", deviceId: "0x228b", subsystem: null, class: "0x040300", iommuGroup: 14, mdev: false, mappings: [] },
  { id: "0000:03:00.0", vendor: "Intel Corporation", device: "Ethernet Controller X550", vendorId: "0x8086", deviceId: "0x1563", subsystem: null, class: "0x020000", iommuGroup: 20, mdev: false, mappings: [] },
];
const DEMO_USB: UsbRow[] = [
  { id: "1050:0407", bus: 1, port: "1-2", level: 1, name: "Yubico YubiKey", serial: null, speed: "12", hub: false },
  { id: "0781:5583", bus: 2, port: "2-1", level: 1, name: "SanDisk Ultra Fit", serial: null, speed: "5000", hub: false },
];
const DEMO_FLAGS = ["aes", "pcid", "spec-ctrl", "ssbd", "ibpb", "md-clear", "virt-ssbd", "amd-ssbd", "hv-tlbflush", "hv-evmcs"].map((name) => ({ name, description: name === "aes" ? "Hardware AES encryption" : name === "spec-ctrl" ? "Spectre v1/v2 protection (indirect branch controls)" : name === "pcid" ? "Process-context IDs: makes the Meltdown fix much cheaper" : "", supported: true }));
const DEMO_CPUS = ["host", "kvm64", "x86-64-v2-AES", "x86-64-v3", "Skylake-Server", "Cascadelake-Server", "EPYC"].map((name) => ({ name, vendor: null, custom: false }));
const DEMO_MACHINES = [{ id: "pc-i440fx-9.0", type: "i440fx", version: "9.0", changes: null }, { id: "pc-q35-9.0", type: "q35", version: "9.0", changes: null }, { id: "pc-q35-8.1", type: "q35", version: "8.1", changes: null }];

export function demoMachineApi(backend: Backend): MachineApi {
  if (!demos.has(backend)) demos.set(backend, new Map());
  const all = demos.get(backend)!;
  if (!mappingStore.has(backend)) mappingStore.set(backend, { pci: [{ id: "gpu0", description: "Render GPU", mdev: false, map: [{ node: "pve", path: "0000:01:00.0", id: "10de:2484", iommugroup: 14, subsystemId: null, description: null }], checks: [], digest: newDigest() }], usb: [], dir: [{ id: "docs", description: "Shared documents", mdev: false, map: [{ node: "pve", path: "/srv/docs", id: "", iommugroup: null, subsystemId: null, description: null }], checks: [], digest: newDigest() }] });
  if (!cpuStore.has(backend)) cpuStore.set(backend, []);
  const maps = mappingStore.get(backend)!;
  const models = cpuStore.get(backend)!;

  async function demo(vmid: number): Promise<Demo> {
    const have = all.get(vmid);
    if (have) return have;
    const hw = await backend.hardware(vmid);
    const vm = hw.type === "qemu";
    const cfg: Cfg = vm
      ? { name: hw.name ?? String(vmid), cores: hw.cores, sockets: hw.sockets, memory: hw.memoryMb, bios: hw.ostype === "win11" ? "ovmf" : "seabios", machine: hw.ostype === "win11" ? "q35" : "pc", agent: hw.agent ? "enabled=1" : "0", net0: "virtio=BC:24:11:AA:BB:01,bridge=vmbr0", ...(hw.balloonMb ? { balloon: hw.balloonMb } : {}) }
      : { hostname: hw.name ?? String(vmid), cores: hw.cores, memory: hw.memoryMb, swap: hw.swapMb ?? 512, arch: "amd64", unprivileged: 1, net0: "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:01,ip=dhcp" };
    const d: Demo = { cfg, digest: newDigest(), pending: {}, ciPending: {}, snaps: {} };
    all.set(vmid, d);
    return d;
  }
  const guard409 = async (vmid: number, digest: unknown) => {
    const d = await demo(vmid);
    if (typeof digest !== "string" || !/^[0-9a-f]{40}$/.test(digest)) fail(400, "bad_request", "This page is out of date. Reload and try again");
    if (digest !== d.digest) fail(409, "stale", "This machine changed since the page loaded. Reload and try again.");
    return d;
  };
  const stripDigest = (b: Body) => {
    const x = { ...b };
    delete x.digest;
    return x;
  };
  const commit = async (vmid: number, d: Demo, change: { set: Record<string, string>; delete: string[]; warnings: string[] }, running?: boolean): Promise<Saved> => {
    const hw = await backend.hardware(vmid);
    const isRunning = running ?? hw.status === "running";
    applyChange(d.cfg, change);
    if (isRunning) for (const k of Object.keys(change.set)) d.pending[k] = change.set[k];
    if (isRunning) for (const k of change.delete) d.pending[k] = null;
    d.digest = newDigest();
    return { ok: true, pending: isRunning, warnings: change.warnings, key: Object.keys(change.set)[0] ?? null };
  };
  const ciKeys = /^(cipassword|ciuser|sshkeys|cicustom|ipconfig\d+|nameserver|searchdomain|ciupgrade|citype)$/;

  return {
    async settings(vmid) {
      const d = await demo(vmid);
      const hw = await backend.hardware(vmid);
      return wait({ ...readSettings(hw.type, d.cfg), passthrough: readPassthrough(hw.type, d.cfg), status: hw.status, name: hw.name ?? String(vmid), template: hw.template, digest: d.digest, locked: null, isAdmin: true, pendingKeys: hw.status === "running" ? Object.keys(d.pending) : [] });
    },
    async choices() {
      return wait({ cpuModels: DEMO_CPUS, cpuFlags: DEMO_FLAGS, machines: DEMO_MACHINES.map(({ id, type, version }) => ({ id, type, version })), dirMappings: maps.dir.map((m) => ({ id: m.id, description: m.description })), storages: ["local", "local-lvm"] });
    },
    async save(vmid, group, b) {
      const d = await guard409(vmid, b.digest);
      const body = stripDigest(b);
      const ctx = { admin: true, cpuModels: DEMO_CPUS.map((c) => c.name), cpuFlags: DEMO_FLAGS.map((f) => f.name), dirMappings: maps.dir.map((m) => m.id), storages: ["local", "local-lvm"] };
      const change = guard(() => (group === "cpu" ? planCpu(d.cfg, body, ctx) : group === "numa" ? planNuma(d.cfg, body) : group === "memory" ? planMemoryExtras(d.cfg, body) : group === "machine" ? planMachine(d.cfg, body) : group === "vmoptions" ? planVmOptions(d.cfg, body, ctx) : group === "ctoptions" ? planCtOptions(d.cfg, body, ctx) : planDevice(d.cfg, group, body, ctx)));
      return wait(await commit(vmid, d, change));
    },
    async hostDevices(vmid) {
      const hw = await backend.hardware(vmid);
      const vm = hw.type === "qemu";
      return wait({
        root: false,
        pci: vm ? DEMO_PCI.map((p) => ({ id: p.id, vendor: p.vendor, device: p.device, class: p.class, iommuGroup: p.iommuGroup, mdev: p.mdev })) : [],
        usb: vm ? DEMO_USB.map((u) => ({ id: u.id, port: u.port, name: u.name, speed: u.speed })) : [],
        mappings: { pci: vm ? maps.pci.map((m) => ({ id: m.id, description: m.description, entries: m.map.length, mdev: m.mdev })) : [], usb: vm ? maps.usb.map((m) => ({ id: m.id, description: m.description, entries: m.map.length, mdev: m.mdev })) : [] },
        notes: { pci: null, usb: null, dev: null },
        explainer: "Proxmox lets only root@pam hand a raw host device to a machine. You can use a saved mapping instead: an administrator creates it under Datacenter, Resource mappings, and gives your account the Mapping.Use permission on it.",
        machine: hw.type,
      });
    },
    async saveHostDevice(vmid, b) {
      const d = await guard409(vmid, b.digest);
      const hw = await backend.hardware(vmid);
      const change = guard(() => planPassthrough(hw.type, d.cfg, stripDigest(b), { root: false, pciMappings: maps.pci.map((m) => m.id), usbMappings: maps.usb.map((m) => m.id) }));
      return wait(await commit(vmid, d, change));
    },
    async pending(vmid) {
      const d = await demo(vmid);
      const hw = await backend.hardware(vmid);
      return wait({ running: hw.status === "running", items: Object.entries(d.pending).map(([key, v]) => ({ key, current: null, pending: v, remove: v === null })) });
    },
    async revert(vmid, digest, keys) {
      const d = await guard409(vmid, digest);
      for (const k of keys) delete d.pending[k];
      d.digest = newDigest();
      return wait({ ok: true as const, pending: true, warnings: [] });
    },
    async cloudInit(vmid) {
      const d = await demo(vmid);
      const hw = await backend.hardware(vmid);
      if (hw.type !== "qemu") fail(400, "bad_request", "Cloud-Init is for virtual machines");
      return wait({ view: readCloudInit(d.cfg), digest: d.digest, locked: null, status: hw.status, template: hw.template, storages: ["local-lvm"], snippets: ["local:snippets/user.yaml", "local:snippets/network.yaml"], changed: Object.entries(d.ciPending).map(([key, v]) => ({ key, pending: key === "cipassword" ? null : v, remove: v === null })), isAdmin: true });
    },
    async saveCloudInit(vmid, b) {
      const d = await guard409(vmid, b.digest);
      const change = guard(() => planCloudInit(d.cfg, stripDigest(b), { storages: ["local-lvm"] }));
      for (const [k, v] of Object.entries(change.set)) if (ciKeys.test(k)) d.ciPending[k] = v;
      for (const k of change.delete) if (ciKeys.test(k)) d.ciPending[k] = null;
      return wait(await commit(vmid, d, change));
    },
    async removeCloudInitDrive(vmid, b) {
      const d = await guard409(vmid, b.digest);
      return wait(await commit(vmid, d, guard(() => planCloudInitDrive(d.cfg, stripDigest(b)))));
    },
    async regenerateCloudInit(vmid) {
      const d = await demo(vmid);
      d.ciPending = {};
      return wait({ ok: true as const });
    },
    async dumpCloudInit(vmid, type) {
      const d = await demo(vmid);
      const v = readCloudInit(d.cfg);
      const text = type === "user" ? `#cloud-config\nhostname: ${d.cfg.name}\nmanage_etc_hosts: true\nuser: ${v.user ?? "root"}\nchpasswd:\n  expire: False\n${v.sshKeys ? `ssh_authorized_keys:\n${v.sshKeys.split("\n").map((k) => `  - ${k}`).join("\n")}\n` : ""}package_upgrade: ${v.upgrade}\n` : type === "network" ? `version: 1\nconfig:\n  - type: physical\n    name: eth0\n    subnets:\n      - type: ${v.ipconfig[0]?.ip && v.ipconfig[0].ip !== "dhcp" ? `static\n        address: ${v.ipconfig[0].ip}` : "dhcp"}\n` : `instance-id: demo-${vmid}\nlocal-hostname: ${d.cfg.name}\n`;
      return wait({ type, text });
    },
    async status(vmid, b) {
      const hw = await backend.hardware(vmid);
      guard(() => checkPower(hw.type, b));
      return wait({ task: "demo" });
    },
    async snapshotConfig(vmid, name) {
      const d = await demo(vmid);
      const snaps = await backend.snapshots(vmid);
      const s = snaps.snapshots.find((x) => x.name === name);
      if (!s) fail(404, "not_found", "No such snapshot");
      return wait({ name, description: d.snaps[name] ?? s!.description, vmstate: s!.vmstate ? `local-lvm:vm-${vmid}-state-${name}` : null, time: s!.time, settings: { cores: String(d.cfg.cores), memory: String(d.cfg.memory) } });
    },
    async describeSnapshot(vmid, name, description) {
      const d = await demo(vmid);
      d.snaps[name] = guard(() => checkSnapshotDescription({ description }));
      return wait({ ok: true as const });
    },
    async restoreSnapshot(vmid, name, b) {
      if (b.confirm !== name) fail(409, "confirm", `Type ${name} to confirm.`);
      const r = await backend.rollbackSnapshot(vmid, name);
      return wait(r);
    },
    async cloneChoices(vmid) {
      const hw = await backend.hardware(vmid);
      const snaps = await backend.snapshots(vmid);
      const o = await backend.machineOptions();
      return wait({ type: hw.type, name: hw.name ?? String(vmid), template: hw.template, nextid: null, nodes: ["pve"], pools: [], snapshots: snaps.snapshots.map((s) => s.name), storages: (hw.type === "qemu" ? o.vmStorages : o.storages).map((s) => ({ storage: s.storage, type: "dir" })), canLink: hw.template, cloudInit: hw.type === "qemu", nets: hw.nics.length });
    },
    async clone(vmid, b) {
      const hw = await backend.hardware(vmid);
      const o = guard(() => checkClone(hw.type, hw.template, b));
      if (o.cloudInit) guard(() => planCloudInit({ ide2: "local-lvm:cloudinit", net0: "virtio=BC:24:11:AA:BB:01,bridge=vmbr0" }, o.cloudInit!, {}));
      const r = await backend.clone(vmid, o.name ?? `${hw.name ?? "machine"}-copy`, o.full ? o.storage : null, !o.full);
      return wait({ vmid: r.vmid, task: r.task, applied: null, steps: [], note: o.cloudInit ? "The demo copies the machine; Cloud-Init values are applied on a real device." : undefined });
    },
    async remove(vmid, b) {
      const o = guard(() => checkDelete(b));
      const hw = await backend.hardware(vmid);
      if (o.confirm !== hw.name) fail(409, "confirm", `Type the machine's name (${hw.name}) to confirm.`);
      const r = await backend.destroyMachine(vmid, o.confirm);
      return wait({ task: r.task ?? "demo" });
    },
    async spice(vmid, proxy) {
      const hw = await backend.hardware(vmid);
      if (hw.type !== "qemu") fail(400, "bad_request", "Containers use the text console");
      return wait({ filename: `${hw.name ?? vmid}-${vmid}.vv`, file: spiceFile({ type: "spice", host: proxy ?? "pve", "tls-port": 61000, password: "demo-ticket", "delete-this-file": 1 }) });
    },
    async monitor(vmid, command) {
      const hw = await backend.hardware(vmid);
      if (hw.type !== "qemu") fail(400, "bad_request", "Only VMs have a QEMU monitor");
      if (!command.trim() || /[\r\n]/.test(command)) fail(400, "bad_request", "A monitor command is one line, for example info status");
      return wait({ command, output: command.trim() === "info status" ? "VM status: running\r\n" : command.trim() === "info version" ? "9.0.2 (pve-qemu-kvm_9.0.2-4)\r\n" : `unknown command: '${command.trim()}'\r\n` });
    },
    async agentRead(vmid, what) {
      const hw = await backend.hardware(vmid);
      if (hw.type !== "qemu") fail(400, "bad_request", "The guest agent is for virtual machines");
      if (hw.status !== "running") fail(409, "not_running", "Start the VM to talk to its guest agent");
      const r: Record<string, unknown> = {
        info: { version: "8.2.0", supported_commands: [{ name: "guest-ping", enabled: true }, { name: "guest-exec", enabled: true }, { name: "guest-file-read", enabled: true }] },
        osinfo: { name: "Ubuntu", "pretty-name": "Ubuntu 24.04 LTS", version: "24.04", "kernel-release": "6.8.0-45-generic", machine: "x86_64" },
        fsinfo: [{ name: "sda1", mountpoint: "/", type: "ext4", "used-bytes": 3.2e9, "total-bytes": 32e9 }],
        users: [{ user: "ubuntu", "login-time": Date.now() / 1000 - 3600 }],
        time: Date.now() * 1e6,
        timezone: { zone: "UTC", offset: 0 },
        vcpus: [{ "logical-id": 0, online: true, "can-offline": false }, { "logical-id": 1, online: true, "can-offline": true }],
        "memory-blocks": [],
        "host-name": { "host-name": hw.name },
      };
      return wait({ what, result: r[what] ?? null });
    },
    async agent(vmid, b) {
      const hw = await backend.hardware(vmid);
      if (hw.type !== "qemu") fail(400, "bad_request", "The guest agent is for virtual machines");
      if (hw.status !== "running") fail(409, "not_running", "Start the VM to talk to its guest agent");
      const req = guard(() => checkAgentAction(b));
      if (req.action === "ping") return wait({ ok: true, message: "The guest agent answered." });
      if (req.action === "fstrim") return wait({ ok: true, message: "Unused space was handed back to the storage." });
      if (req.action === "freeze") {
        if (b.confirm !== "freeze") fail(409, "confirm", "Type freeze to confirm. The machine's file systems stop writing until you thaw them.");
        return wait({ ok: true, message: "File systems frozen. Thaw them when you are done." });
      }
      if (req.action === "thaw") return wait({ ok: true, message: "File systems thawed." });
      if (req.action === "freeze-status") return wait({ ok: true, message: "File systems are thawed." });
      if (req.action === "set-password") return wait({ ok: true, message: `Password changed for ${req.user}.` });
      if (req.action === "read-file") return wait({ ok: true, file: req.file, content: 'NAME="Ubuntu"\nVERSION_ID="24.04"\n', truncated: false });
      if (b.confirm !== "run") fail(409, "confirm", "Type run to confirm. The command runs inside the machine as the agent's user (usually root).");
      return wait({ ok: true, finished: true, exitcode: 0, out: `ran ${req.command!.join(" ")}\n`, err: "" });
    },
    async pciDevices(allDevices) {
      return wait({ node: "pve", note: null, devices: DEMO_PCI.map((d) => ({ ...d, mappings: maps.pci.filter((m) => m.map.some((e) => e.path === d.id)).map((m) => m.id) })).concat(allDevices ? [{ id: "0000:00:00.0", vendor: "Intel Corporation", device: "Host bridge", vendorId: "0x8086", deviceId: "0x3e0f", subsystem: null, class: "0x060000", iommuGroup: 0, mdev: false, mappings: [] }] : []) });
    },
    async mdevTypes(id) {
      return wait({ id, types: [] });
    },
    async usbDevices() {
      return wait({ node: "pve", note: null, devices: DEMO_USB });
    },
    async capabilities() {
      return wait({ node: "pve", cpu: [...DEMO_CPUS, ...models.map((m) => ({ name: `custom-${m.cputype}`, vendor: null, custom: true }))], flags: DEMO_FLAGS, machines: DEMO_MACHINES, migration: { cpu: "Skylake-Server", hasDirtyBitmaps: true } });
    },
    async mappings(kind) {
      return wait({ kind, visible: true, canModify: true, nodes: ["pve"], mappings: maps[kind] });
    },
    async saveMapping(kind, id, b) {
      const body = { ...b, id: id ?? b.id };
      delete (body as Body).digest;
      const plan = guard(() => planMapping(kind, body, id === null));
      const list = maps[kind];
      if (!id && list.some((m) => m.id === plan.id)) fail(409, "exists", `A mapping called ${plan.id} already exists`);
      const row: MappingRow = { id: plan.id, description: String(plan.params.description ?? ""), mdev: plan.params.mdev === true, map: (plan.params.map as string[]).map((line) => parseLine(line)), checks: [], digest: newDigest() };
      const i = list.findIndex((m) => m.id === plan.id);
      if (i >= 0) list[i] = row;
      else list.push(row);
      return wait({ ok: true as const });
    },
    async deleteMapping(kind, id, confirm) {
      if (confirm !== id) fail(409, "confirm", `Type ${id} to confirm.`);
      maps[kind] = maps[kind].filter((m) => m.id !== id);
      mappingStore.get(backend)![kind] = maps[kind];
      return wait({ ok: true as const });
    },
    async cpuModels() {
      return wait({ visible: true, canModify: true, models });
    },
    async saveCpuModel(name, b) {
      const p = guard(() => planCustomCpu(name ? { ...b, cputype: name } : b, name === null));
      const row: CpuModelRow = { cputype: p.cputype, reportedModel: String(p.params["reported-model"] ?? models.find((m) => m.cputype === p.cputype)?.reportedModel ?? ""), flags: typeof p.params.flags === "string" ? p.params.flags : null, hidden: p.params.hidden === true, hvVendorId: typeof p.params["hv-vendor-id"] === "string" ? p.params["hv-vendor-id"] : null, physBits: typeof p.params["phys-bits"] === "string" ? p.params["phys-bits"] : null, digest: newDigest() };
      const i = models.findIndex((m) => m.cputype === p.cputype);
      if (i >= 0) models[i] = row;
      else models.push(row);
      return wait({ ok: true as const });
    },
    async deleteCpuModel(name, confirm) {
      if (confirm !== name) fail(409, "confirm", `Type ${name} to confirm.`);
      const i = models.findIndex((m) => m.cputype === name);
      if (i >= 0) models.splice(i, 1);
      return wait({ ok: true as const });
    },
    async bulk(_scope, b) {
      const req = guard(() => checkBulk(b));
      if (req.action !== "start" && b.confirm !== String(req.vms.length)) fail(409, "confirm", `Type ${req.vms.length} to confirm acting on ${req.vms.length} machine${req.vms.length === 1 ? "" : "s"}.`);
      return wait({ task: "demo" });
    },
  };
}

function parseLine(line: string): MappingEntry {
  const o: Record<string, string> = {};
  for (const part of line.split(",")) {
    const i = part.indexOf("=");
    if (i > 0) o[part.slice(0, i)] = part.slice(i + 1);
  }
  return { node: o.node ?? "", path: o.path ?? "", id: o.id ?? "", iommugroup: o.iommugroup ? Number(o.iommugroup) : null, subsystemId: o["subsystem-id"] ?? null, description: o.description ?? null };
}

/** Live against the host service, or the in-browser stand-in in the demo. */
export function useMachineApi(): MachineApi {
  const { live, backend } = useEngine();
  return useMemo(() => (live ? liveMachineApi : demoMachineApi(backend)), [live, backend]);
}
