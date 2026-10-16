import { call, enc, qs, type Schema, type Values } from "./nodeApi.ts";

/**
 * The host service's hardware, backup, SDN, mapping and bulk-action endpoints (services/epaperclip/src/features/
 * nodeHardware.ts, dcBackup.ts, dcSdn.ts, dcMapping.ts). Every call is made as the signed-in person.
 */

const nodeBody = <T extends object>(node: string | null | undefined, b: T) => (node ? { node, ...b } : b);
const withNode = (path: string, node?: string | null, extra: Record<string, string | number | boolean | undefined | null> = {}) => `${path}${qs({ node: node ?? undefined, ...extra })}`;

// ---- Hardware
export interface PciDevice { id: string; class: string | null; vendor: string | null; vendorName: string | null; device: string | null; deviceName: string | null; subsystemVendor: string | null; subsystemDevice: string | null; subsystemVendorName: string | null; subsystemDeviceName: string | null; iommuGroup: number | null; mdev: boolean }
export interface UsbDevice { busnum: number | null; devnum: number | null; port: number | null; level: number | null; vendid: string | null; prodid: string | null; manufacturer: string | null; product: string | null; serial: string | null; speed: string | null; usbpath: string | null; class: number | null }
export interface HardwareInfo {
  node: string;
  statusDenied: boolean;
  cpu: { model: string | null; sockets: number | null; cores: number | null; threads: number | null; mhz: number | null; flags: string | null; hvm: boolean | null; usage: number | null; load: number[] | null; ioWait: number | null } | null;
  memory: { total: number | null; used: number | null; free: number | null; available: number | null; buffers: number | null; cached: number | null } | null;
  swap: { total: number | null; used: number | null; free: number | null } | null;
  rootfs: { total: number | null; used: number | null; free: number | null } | null;
  ksm: { shared: number | null } | null;
  boot: { mode: string | null; secureboot: boolean | null } | null;
  kernel: string | null;
  kernelRelease: string | null;
  machine: string | null;
  pveVersion: string | null;
  uptime: number | null;
  pci: PciDevice[] | null;
  pciDenied: boolean;
  usb: UsbDevice[] | null;
  usbDenied: boolean;
  description: string;
}
export interface PackageVersion { package: string; version: string; oldVersion: string | null; state: string | null; title: string | null; running: string | null; manager: string | null }
export interface ResourceRow { id: string; type: "node" | "qemu" | "lxc" | "storage" | "pool" | "sdn"; node: string | null; vmid: number | null; name: string | null; status: string | null; template: boolean; pool: string | null; tags: string[]; cpu: number | null; maxcpu: number | null; mem: number | null; maxmem: number | null; disk: number | null; maxdisk: number | null; uptime: number | null; lock: string | null; hastate: string | null }
export interface ResourceTotals { nodes: { online: number; total: number }; cpu: { used: number; total: number }; memory: { used: number; total: number }; storage: { used: number; total: number }; guests: { running: number; stopped: number; templates: number; vms: number; containers: number } }

export type BulkAction = "startall" | "stopall" | "suspendall" | "migrateall";

// ---- Backup
export interface BackupJob { id: string; values: Values; nextRun: number | null; type: string; digest: string | null }
export interface BackupArchive { volid: string; vmid: number | null; type: "qemu" | "lxc" | null; format: string | null; size: number | null; ctime: number | null; notes: string | null; protected: boolean; verified: string | null }
export interface PrunePlanRow { volid: string; vmid: number | null; type: string; ctime: number | null; mark: string }
export interface RestoreOptions { storage: string; volid: string; target?: string; vmid?: number; replace?: boolean; unique?: boolean; start?: boolean; bwlimit?: number; pool?: string; liveRestore?: boolean }
export interface FileEntry { name: string; path: string; type: string; size: number | null; mtime: number | null; leaf: boolean }

// ---- SDN
export interface SdnObject { id: string; type: string; state: string | null; digest: string | null; values: Values; secretsSet: string[] }
export interface SdnSubnet { id: string; cidr: string; gateway: string | null; snat: boolean; dhcpRange: string[]; dhcpDns: string | null; dnszoneprefix: string | null; state: string | null; digest: string | null }
export interface SdnVnet { vnet: string; zone: string | null; tag: number | null; alias: string | null; vlanaware: boolean; isolatePorts: boolean; state: string | null; digest: string | null; subnets: SdnSubnet[] }
export type SdnKind = "zones" | "ipams" | "dns" | "controllers";
export interface SdnOverview {
  zones: SdnObject[]; vnets: SdnVnet[]; ipams: SdnObject[]; dns: SdnObject[]; controllers: SdnObject[];
  pending: number; denied: boolean; error: string | null;
  types: Record<SdnKind, Record<string, { label: string; schema: Schema; required: string[] }>>;
  vnetSchema: Schema; subnetSchema: Schema; firewallSchema: Schema;
}

// ---- Mappings
export interface MappingEntry { node: string; path: string; id: string; subsystemId: string; iommugroup: number | null; description: string }
export interface Mapping { id: string; description: string; mdev: boolean; liveMigration: boolean; digest: string | null; map: MappingEntry[]; checks: { severity: "warning" | "error"; message: string }[] }
export type MappingKind = "pci" | "usb" | "dir";
export interface MappingBody { id?: string; description?: string; mdev?: boolean; liveMigration?: boolean; map: Partial<MappingEntry>[]; digest?: string | null }

export const dcApi = {
  hardware: (node?: string | null) => call<HardwareInfo>("GET", withNode("/api/node/hardware", node)),
  mdev: (node: string | null | undefined, pci: string) => call<{ types: { type: string; available: number | null; description: string | null; name: string | null }[] }>("GET", withNode("/api/node/hardware/mdev", node, { pci })),
  versions: (node?: string | null) => call<{ node: string; packages: PackageVersion[]; running: string | null; manager: string | null }>("GET", withNode("/api/node/versions", node)),
  report: (node?: string | null) => call<{ node: string; report: string; truncated: boolean }>("GET", withNode("/api/node/report", node)),
  nodeConfig: (node?: string | null) => call<{ node: string; values: Values; digest: string | null; schema: Schema }>("GET", withNode("/api/node/config", node)),
  saveNodeConfig: (node: string | null | undefined, values: Values, digest: string | null) => call<{ ok: true }>("PUT", "/api/node/config", nodeBody(node, { values, digest: digest ?? undefined })),
  metricsExport: (p: { local?: boolean; history?: boolean }) => call<{ count: number; truncated: boolean; metrics: { id: string; metric: string; timestamp: number | null; type: string | null; value: number | null }[] }>("GET", `/api/node/metrics-export${qs({ local: p.local ? 1 : undefined, history: p.history ? 1 : undefined })}`),
  schedule: (schedule: string, count = 6) => call<{ runs: { at: number }[] }>("GET", `/api/node/schedule${qs({ schedule, count })}`),
  resources: () => call<{ totals: ResourceTotals; rows: ResourceRow[]; pools: { pool: string; comment: string | null }[] }>("GET", "/api/node/resources"),
  bulk: (action: BulkAction, node: string | null | undefined, b: { vms?: number[]; confirm?: string; target?: string; withLocalDisks?: boolean; force?: boolean; forceStop?: boolean; timeout?: number; maxWorkers?: number }) => call<{ task: string }>("POST", `/api/node/bulk/${action}`, nodeBody(node, b)),

  backupJobs: () => call<{ jobs: BackupJob[]; denied: boolean; uncovered: { vmid: number; name: string | null; type: "qemu" | "lxc" }[]; uncoveredDenied: boolean; storages: string[]; pools: string[]; schema: Schema }>("GET", "/api/node/backup/jobs"),
  jobVolumes: (id: string) => call<{ guests: { vmid: number; name: string | null; type: string; volumes: { id: string; name: string | null; included: boolean; reason: string | null }[] }[] }>("GET", `/api/node/backup/jobs/${enc(id)}/volumes`),
  createJob: (id: string | undefined, values: Values) => call<{ ok: true }>("POST", "/api/node/backup/jobs", { id, values }),
  updateJob: (id: string, values: Values, digest: string | null) => call<{ ok: true }>("PUT", `/api/node/backup/jobs/${enc(id)}`, { values, digest: digest ?? undefined }),
  deleteJob: (id: string) => call<{ ok: true }>("DELETE", `/api/node/backup/jobs/${enc(id)}`, { confirm: id }),
  archives: (storage: string, node?: string | null) => call<{ node: string; storage: string; archives: BackupArchive[] }>("GET", withNode("/api/node/backup/archives", node, { storage })),
  setArchive: (node: string | null | undefined, storage: string, volid: string, b: { protected?: boolean; notes?: string }) => call<{ ok: true }>("PUT", "/api/node/backup/archives", nodeBody(node, { storage, volid, ...b })),
  archiveConfig: (node: string | null | undefined, storage: string, volid: string) => call<{ config: string }>("GET", withNode("/api/node/backup/archives/config", node, { storage, volid })),
  deleteArchive: (node: string | null | undefined, storage: string, volid: string, confirm: string) => call<{ task: string | null }>("DELETE", "/api/node/backup/archives", nodeBody(node, { storage, volid, confirm })),
  prunePreview: (node: string | null | undefined, b: { storage: string; vmid?: number; type?: string; retention?: Values }) => call<{ plan: PrunePlanRow[] }>("POST", "/api/node/backup/prune", nodeBody(node, { ...b, dryRun: true })),
  prune: (node: string | null | undefined, b: { storage: string; vmid?: number; type?: string; retention?: Values; confirm: string }) => call<{ task: string }>("POST", "/api/node/backup/prune", nodeBody(node, { ...b, dryRun: false })),
  restore: (node: string | null | undefined, b: RestoreOptions) => call<{ vmid: number; task: string }>("POST", "/api/node/backup/restore", nodeBody(node, b)),
  files: (node: string | null | undefined, storage: string, volid: string, path: string) => call<{ path: string; entries: FileEntry[] }>("GET", withNode("/api/node/backup/files", node, { storage, volid, path })),

  sdn: () => call<SdnOverview>("GET", "/api/node/sdn"),
  sdnPreview: (node?: string | null) => call<{ node: string; denied: boolean; error: string | null; preview: string | null }>("GET", withNode("/api/node/sdn/preview", node)),
  sdnApply: () => call<{ task: string }>("POST", "/api/node/sdn/apply", {}),
  sdnRollback: () => call<{ ok: true }>("POST", "/api/node/sdn/rollback", { confirm: "rollback" }),
  sdnCreate: (kind: SdnKind, id: string, type: string, values: Values) => call<{ ok: true }>("POST", `/api/node/sdn/${kind}`, { id, type, values }),
  sdnUpdate: (kind: SdnKind, id: string, values: Values, digest: string | null) => call<{ ok: true }>("PUT", `/api/node/sdn/${kind}/${enc(id)}`, { values, digest: digest ?? undefined }),
  sdnDelete: (kind: SdnKind, id: string) => call<{ ok: true }>("DELETE", `/api/node/sdn/${kind}/${enc(id)}`, { confirm: id }),
  vnetCreate: (id: string, values: Values) => call<{ ok: true }>("POST", "/api/node/sdn/vnets", { id, values }),
  vnetUpdate: (id: string, values: Values, digest: string | null) => call<{ ok: true }>("PUT", `/api/node/sdn/vnets/${enc(id)}`, { values, digest: digest ?? undefined }),
  vnetDelete: (id: string) => call<{ ok: true }>("DELETE", `/api/node/sdn/vnets/${enc(id)}`, { confirm: id }),
  subnetCreate: (vnet: string, cidr: string, values: Values) => call<{ ok: true }>("POST", `/api/node/sdn/vnets/${enc(vnet)}/subnets`, { cidr, values }),
  subnetUpdate: (vnet: string, id: string, values: Values, digest: string | null) => call<{ ok: true }>("PUT", `/api/node/sdn/vnets/${enc(vnet)}/subnets/${enc(id)}`, { values, digest: digest ?? undefined }),
  subnetDelete: (vnet: string, id: string) => call<{ ok: true }>("DELETE", `/api/node/sdn/vnets/${enc(vnet)}/subnets/${enc(id)}`, { confirm: id }),
  ipamStatus: (ipam: string) => call<{ entries: { ip: string; vnet: string | null; zone: string | null; subnet: string | null; mac: string | null; hostname: string | null; vmid: number | null; gateway: boolean }[] }>("GET", `/api/node/sdn/ipams/${enc(ipam)}/status`),
  vnetIp: (vnet: string, b: { zone: string; ip: string; mac?: string; vmid?: number; action?: "create" | "update" | "delete" }) => call<{ ok: true }>("POST", `/api/node/sdn/vnets/${enc(vnet)}/ips`, b),
  vnetFirewall: (vnet: string) => call<{ values: Values; digest: string | null; denied: boolean; schema: Schema; rules: { pos: number | null; type: string; action: string; enable: boolean; source: string | null; dest: string | null; proto: string | null; dport: string | null; sport: string | null; macro: string | null; comment: string | null }[] }>("GET", `/api/node/sdn/vnets/${enc(vnet)}/firewall`),
  saveVnetFirewall: (vnet: string, values: Values, digest: string | null) => call<{ ok: true }>("PUT", `/api/node/sdn/vnets/${enc(vnet)}/firewall`, { values, digest: digest ?? undefined }),
  sdnStatus: (node?: string | null) => call<{ node: string; denied: boolean; error: string | null; zones: { zone: string; status: string | null; vnets: { vnet: string; status: string | null; statusmsg: string | null }[] }[] }>("GET", withNode("/api/node/sdn/status", node)),
  macVrf: (node: string | null | undefined, vnet: string) => call<{ entries: { ip: string | null; mac: string | null; nexthop: string | null }[] }>("GET", withNode(`/api/node/sdn/vnets/${enc(vnet)}/mac-vrf`, node)),

  mappings: () => call<{ pci: Mapping[]; usb: Mapping[]; dir: Mapping[]; denied: boolean; checkedNode: string }>("GET", "/api/node/mappings"),
  createMapping: (kind: MappingKind, b: MappingBody & { id: string }) => call<{ ok: true }>("POST", `/api/node/mappings/${kind}`, b),
  updateMapping: (kind: MappingKind, id: string, b: MappingBody) => call<{ ok: true }>("PUT", `/api/node/mappings/${kind}/${enc(id)}`, b),
  deleteMapping: (kind: MappingKind, id: string) => call<{ ok: true }>("DELETE", `/api/node/mappings/${kind}/${enc(id)}`, { confirm: id }),
};
