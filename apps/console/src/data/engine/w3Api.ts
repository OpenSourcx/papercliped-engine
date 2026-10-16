import { call, enc, qs } from "./nodeApi.ts";

/**
 * The host service's storage depth, backup, disk health and extra cluster endpoints
 * (services/epaperclip/src/features/{storageTools,backupTools,diskHealth,clusterCephWrite,clusterExtra,clusterSdn}.ts).
 * Every call is made as the signed-in person.
 */

const get = <T,>(path: string) => call<T>("GET", path);

// ---- Storage

export interface UsageType { content: string; label: string; count: number; bytes: number }
export interface StorageUsage {
  node: string;
  storage: string;
  type: string | null;
  active: boolean | null;
  shared: boolean;
  total: number | null;
  used: number | null;
  avail: number | null;
  percent: number | null;
  byType: UsageType[];
  other: number | null;
  byGuest: { vmid: number; count: number; bytes: number }[];
  largest: { volid: string; content: string; size: number; vmid: number | null }[];
  denied: { status: boolean; content: boolean };
}
export interface PruneKeep { keepAll?: boolean; keepLast?: number; keepHourly?: number; keepDaily?: number; keepWeekly?: number; keepMonthly?: number; keepYearly?: number }
export interface PrunePreview {
  node: string;
  storage: string;
  using: string;
  retention: (PruneKeep & Record<string, unknown>) | null;
  items: { volid: string; vmid: number | null; type: string | null; ctime: number | null; mark: string; size: number | null }[];
  counts: { keep: number; remove: number; protected: number; renamed: number };
  bytesToFree: number;
  note: string;
}
export interface VolumeInfo { node: string; volid: string; path: string | null; format: string | null; size: number | null; used: number | null; notes: string | null; protected: boolean; owner: { vmid: number; type: string | null } | null; verify: { algorithm: string; command: string }[] }
export interface SnippetsInfo { node: string; storage: string; enabled: boolean | null; directory: string | null; files: { volid: string; name: string; size: number | null; ctime: number | null }[]; guide: { title: string; command: string; note: string }[]; reason: string }
export interface IsoSource { id: string; name: string; page: string; files: string; checksums: string }

export const storageToolsApi = {
  usage: (id: string, node?: string | null) => get<StorageUsage>(`/api/storage-tools/${enc(id)}/usage${qs({ node })}`),
  rrd: (id: string, timeframe: string) => get<{ points: { time: number; used: number | null; total: number | null }[] }>(`/api/storage-tools/${enc(id)}/rrd${qs({ timeframe })}`),
  prunePreview: (id: string, keep: PruneKeep, vmid?: number) => get<PrunePreview>(`/api/storage-tools/${enc(id)}/prune${qs({ ...keep, vmid })}`),
  prune: (id: string, keep: PruneKeep, vmid?: number) => call<{ task: string | null }>("POST", `/api/storage-tools/${enc(id)}/prune`, { ...keep, vmid, confirm: id }),
  volume: (id: string, volid: string) => get<VolumeInfo>(`/api/storage-tools/${enc(id)}/volume${qs({ volid })}`),
  snippets: (id: string) => get<SnippetsInfo>(`/api/storage-tools/${enc(id)}/snippets`),
  allocate: (id: string, b: { vmid: number; name: string; sizeGiB: number; format?: string }) => call<{ volid: string }>("POST", `/api/storage-tools/${enc(id)}/allocate`, b),
  copy: (id: string, b: { volume: string; target: string; targetNode?: string; confirm: string }) => call<{ task: string | null }>("POST", `/api/storage-tools/${enc(id)}/copy`, { ...b, acknowledgeExperimental: true }),
  downloadImport: (id: string, b: { url: string; filename: string; checksum?: string; algorithm?: string }) => call<{ task: string }>("POST", `/api/storage-tools/${enc(id)}/download-import`, b),
  importMetadata: (id: string, volume: string) => get<{ createArgs: Record<string, unknown>; warnings: unknown[]; disks: Record<string, unknown>; net: Record<string, unknown> }>(`/api/storage-tools/${enc(id)}/import-metadata${qs({ volume })}`),
  importDisk: (id: string, b: { vmid: number; volume: string; bus: string; targetStorage: string; format?: string }) => call<{ key: string; task: string | null }>("POST", `/api/storage-tools/${enc(id)}/import-disk`, b),
  urlMetadata: (url: string) => get<{ url: string; filename: string | null; size: number | null; mimetype: string | null; suggestedContent: string | null }>(`/api/storage-tools/url-metadata${qs({ url })}`),
  isoSources: () => get<{ sources: IsoSource[]; note: string }>("/api/storage-tools/iso-sources"),
};

// ---- Backups

export interface BackupJobFull {
  id: string;
  enabled: boolean;
  schedule: string | null;
  storage: string | null;
  node: string | null;
  mode: string;
  compress: string | null;
  selection: "all" | "vmids" | "pool";
  vmids: number[];
  exclude: number[];
  pool: string | null;
  comment: string;
  notesTemplate: string | null;
  notificationMode: string | null;
  fleecing: { enabled: boolean; storage: string | null };
  bwlimit: number | null;
  performance: { maxWorkers: number | null; pbsEntriesMax: number | null };
  zstd: number | null;
  ionice: number | null;
  repeatMissed: boolean;
  protected: boolean;
  stdexcludes: boolean;
  excludePath: string[];
  pbsChangeDetectionMode: string | null;
  stopwait: number | null;
  prune: (PruneKeep & Record<string, unknown>) | null;
  nextRun: number | null;
  digest: string | null;
}
export type BackupJobInput = Partial<Omit<BackupJobFull, "nextRun" | "prune" | "performance" | "fleecing">> & { prune?: PruneKeep | null; performance?: { maxWorkers?: number | null; pbsEntriesMax?: number | null }; fleecing?: { enabled: boolean; storage?: string | null } };

export interface RestoreInput { from: string; volid: string; mode?: "new" | "replace"; vmid?: number; storage?: string; unique?: boolean; start?: boolean; bwlimit?: number; liveRestore?: boolean; pool?: string; confirm?: string }

export const backupToolsApi = {
  jobs: () => get<{ jobs: BackupJobFull[]; nodes: string[]; pools: string[]; storages: string[] }>("/api/backup-tools/jobs"),
  createJob: (b: BackupJobInput) => call<{ ok: true }>("POST", "/api/backup-tools/jobs", b),
  saveJob: (id: string, b: BackupJobInput & { digest: string }) => call<{ ok: true }>("PUT", `/api/backup-tools/jobs/${enc(id)}`, b),
  deleteJob: (id: string) => call<{ ok: true }>("DELETE", `/api/backup-tools/jobs/${enc(id)}`, { confirm: id }),
  volumes: (id: string) => get<{ job: string; guests: { id: string | number | null; name: string | null; type: string | null; volumes: { id: string; name: string; included: boolean; reason: string | null }[] }[] }>(`/api/backup-tools/jobs/${enc(id)}/volumes`),
  notBackedUp: () => get<{ guests: { vmid: number; name: string; type: string; node: string | null }[] }>("/api/backup-tools/not-backed-up"),
  config: (storage: string, volume: string) => get<{ volume: string; owner: { vmid: number; type: string | null } | null; config: string }>(`/api/backup-tools/config${qs({ storage, volume })}`),
  files: (storage: string, volume: string, path = "/") => get<{ volume: string; path: string; entries: { name: string; path: string | null; type: string | null; leaf: boolean; size: number | null; mtime: number | null }[] }>(`/api/backup-tools/files${qs({ storage, volume, path })}`),
  restore: (b: RestoreInput) => call<{ vmid: number; task: string }>("POST", "/api/backup-tools/restore", b),
};

// ---- Disk health

export type Level = "ok" | "warning" | "critical";
export interface HealthAlert { level: "warning" | "critical"; kind: string; subject: string; message: string }
export interface SmartFacts { temperature: number | null; powerOnHours: number | null; reallocated: number | null; pending: number | null; percentUsed: number | null; spare: number | null }
export interface DiskHealth {
  node: string;
  level: Level;
  alerts: HealthAlert[];
  thresholds: { wearWarn: number; wearCrit: number; usageWarn: number; usageCrit: number };
  disks: { devpath: string; type: string; model: string | null; serial: string | null; sizeBytes: number; usedBy: string | null; health: string | null; wearoutPct: number | null; level: Level; facts: SmartFacts | null }[];
  pools: { name: string; health: string; sizeBytes: number; allocBytes: number; freeBytes: number; fragmentation: number | null; percentUsed: number | null; level: Level }[];
  thin: { name: string; sizeBytes: number; percentUsed: number | null; metadataPercent: number | null; level: Level }[];
  storages: { storage: string; type: string; shared: boolean; total: number; used: number; percentUsed: number; level: Level }[];
  inactive: string[];
  denied: { disks: boolean; pools: boolean; storages: boolean };
}
export interface ZfsStep { title: string; command: string | null; note: string | null; risk: "none" | "low" | "high" }
export interface ZfsPool {
  node: string;
  name: string;
  state: string;
  status: string | null;
  action: string | null;
  scan: string | null;
  errors: string | null;
  tree: unknown[];
  disks: string[];
  storages: string[];
  volumes: { storage: string; dataset: string; volid: string; kind: "zvol" | "dataset"; sizeBytes: number | null; vmid: number | null; format: string | null }[];
  actions: string[];
}

export const diskHealthApi = {
  summary: () => get<DiskHealth>("/api/disk-health"),
  saveThresholds: (t: DiskHealth["thresholds"]) => call<{ thresholds: DiskHealth["thresholds"] }>("PUT", "/api/disk-health/settings", t),
  history: (disk: string) => get<{ samples: { t: number; wear: number | null; health: string | null; temperature: number | null; hours: number | null; reallocated: number | null; pending: number | null }[]; note: string }>(`/api/disk-health/history${qs({ disk })}`),
  zfs: (name: string) => get<ZfsPool>(`/api/disk-health/zfs/${enc(name)}`),
  zfsGuide: (name: string, action: string, o: { device?: string; newDevice?: string; importName?: string } = {}) => get<{ steps: ZfsStep[]; cautions: string[] }>(`/api/disk-health/zfs/${enc(name)}/guide${qs({ action, ...o })}`),
};

// ---- Cluster additions

export interface Step { title: string; where: string; command: string | null; note: string | null }
export interface ResourceRow { id: string; type: string; node: string | null; name: string | null; vmid: number | null; status: string | null; storage: string | null; shared: boolean; pool: string | null; template: boolean; cpu: number | null; maxcpu: number | null; mem: number | null; maxmem: number | null; disk: number | null; maxdisk: number | null; uptime: number | null; hastate: string | null; tags: string[]; content: string[]; plugintype: string | null; lock: string | null }
export interface ResourceSummary { nodes: { total: number; online: number }; cpu: { cores: number; usedCores: number }; memory: { used: number; total: number }; storage: { used: number; total: number }; guests: { vms: { running: number; total: number }; containers: { running: number; total: number }; templates: number } }
export interface RemoteMigrateInfo { vmid: number; name: string; type: "qemu" | "lxc"; node: string; running: boolean; bridges: string[]; storages: string[]; blockers: string[]; experimental: boolean }
export interface RemoteMigrateInput { host: string; port?: number; fingerprint: string; tokenId: string; tokenSecret: string; targetStorage: string; targetBridge: string; targetVmid?: number; online?: boolean; restart?: boolean; delete?: boolean; bwlimit?: number; confirm: string; confirmDelete?: string }
export interface CephSetup { node: string; installed: boolean; releases: { name: string; version: string | null; installable: boolean | null }[]; denied: boolean; installCommand: string; initCommand: string }
export interface CrushInfo { node: string; denied: boolean; error: string | null; text: string | null; summary: { rules: { name: string; type: string | null; steps: string[] }[]; buckets: number; devices: number; tunables: string[] } | null }

type Row = Record<string, unknown>;
export interface SdnOverview {
  controllers: Row[];
  evpnZones: Row[];
  fabrics: Row[];
  fabricNodes: Row[];
  prefixLists: Row[];
  routeMaps: Row[];
  supported: { controllers: boolean; fabrics: boolean; prefixLists: boolean; routeMaps: boolean };
  denied: boolean;
  controllerTypes: string[];
  protocols: string[];
  matchKeys: string[];
  setKeys: string[];
  redistributeSources: Record<string, string[]>;
}

export const clusterMoreApi = {
  qdevice: () => get<{ clustered: boolean; configured: boolean; text: string | null; denied: boolean; nodes: number; evenNodes: boolean; recommendation: string }>("/api/cluster/qdevice"),
  qdeviceGuide: (action: "setup" | "remove", address?: string) => get<{ steps: Step[]; cautions: string[] }>(`/api/cluster/qdevice/guide${qs({ action, address })}`),
  corosyncGuide: (action: string, o: { address?: string; link?: number; node?: string } = {}) => get<{ steps: Step[]; cautions: string[] }>(`/api/cluster/corosync/guide${qs({ action, ...o })}`),
  resources: (type?: string) => get<{ summary: ResourceSummary; resources: ResourceRow[]; pools: string[]; generated: number }>(`/api/cluster/resources${qs({ type })}`),
  remoteInfo: (vmid: number) => get<RemoteMigrateInfo>(`/api/cluster/remote-migrate/${vmid}`),
  remoteMigrate: (vmid: number, b: RemoteMigrateInput) => call<{ task: string }>("POST", `/api/cluster/remote-migrate/${vmid}`, b),

  cephSetup: (node?: string | null) => get<CephSetup>(`/api/cluster/ceph/setup${qs({ node })}`),
  cephInit: (b: { node?: string; network?: string; clusterNetwork?: string; size?: number; minSize?: number; confirm: string }) => call<{ ok: true }>("POST", "/api/cluster/ceph/init", b),
  cephCrush: (node?: string | null) => get<CrushInfo>(`/api/cluster/ceph/crush${qs({ node })}`),
  createOsd: (b: { node?: string; dev: string; dbDev?: string; walDev?: string; encrypted?: boolean; deviceClass?: string; confirm: string }) => call<{ task: string }>("POST", "/api/cluster/ceph/osds", b),
  destroyOsd: (id: number, b: { node?: string; cleanup?: boolean; acknowledgeUnsafe?: boolean }) => call<{ task: string }>("POST", `/api/cluster/ceph/osd/${id}/destroy`, { ...b, confirm: `osd.${id}` }),
  deletePool: (name: string, b: { node?: string; acknowledgeData?: boolean; removeStorages?: boolean; force?: boolean }) => call<{ task: string }>("POST", `/api/cluster/ceph/pools/${enc(name)}/delete`, { ...b, confirm: name }),
  createDaemon: (kind: "mon" | "mgr" | "mds", b: { node?: string; id?: string; address?: string; hotStandby?: boolean }) => call<{ task: string }>("POST", `/api/cluster/ceph/${kind}`, b),
  destroyDaemon: (kind: "mon" | "mgr" | "mds", id: string, b: { node?: string; acknowledgeUnsafe?: boolean }) => call<{ task: string }>("POST", `/api/cluster/ceph/${kind}/${enc(id)}/destroy`, { ...b, confirm: `${kind}.${id}` }),
  createFs: (b: { node?: string; name: string; pgNum?: number; addStorage?: boolean }) => call<{ task: string }>("POST", "/api/cluster/ceph/fs", b),
  destroyFs: (name: string, b: { node?: string; removePools?: boolean; removeStorages?: boolean; acknowledgeData?: boolean }) => call<{ task: string }>("POST", `/api/cluster/ceph/fs/${enc(name)}/destroy`, { ...b, confirm: name }),
  cephService: (action: "start" | "stop" | "restart", service: string, b: { node?: string; acknowledgeUnsafe?: boolean } = {}) => call<{ task: string | null }>("POST", `/api/cluster/ceph/service/${action}`, { ...b, service, confirm: action === "start" ? undefined : service }),

  sdn: () => get<SdnOverview>("/api/cluster/sdn"),
  createController: (b: Row) => call<{ ok: true }>("POST", "/api/cluster/sdn/controllers", b),
  saveController: (id: string, b: Row) => call<{ ok: true }>("PUT", `/api/cluster/sdn/controllers/${enc(id)}`, b),
  deleteController: (id: string) => call<{ ok: true }>("DELETE", `/api/cluster/sdn/controllers/${enc(id)}`, { confirm: id }),
  createEvpnZone: (b: Row) => call<{ ok: true }>("POST", "/api/cluster/sdn/evpn-zones", b),
  saveEvpnZone: (id: string, b: Row) => call<{ ok: true }>("PUT", `/api/cluster/sdn/evpn-zones/${enc(id)}`, b),
  deleteEvpnZone: (id: string) => call<{ ok: true }>("DELETE", `/api/cluster/sdn/evpn-zones/${enc(id)}`, { confirm: id }),
  createFabric: (b: Row) => call<{ ok: true }>("POST", "/api/cluster/sdn/fabrics", b),
  saveFabric: (id: string, b: Row) => call<{ ok: true }>("PUT", `/api/cluster/sdn/fabrics/${enc(id)}`, b),
  deleteFabric: (id: string) => call<{ ok: true }>("DELETE", `/api/cluster/sdn/fabrics/${enc(id)}`, { confirm: id }),
  addFabricNode: (fabric: string, node: string, b: Row) => call<{ ok: true }>("POST", `/api/cluster/sdn/fabrics/${enc(fabric)}/nodes/${enc(node)}`, b),
  removeFabricNode: (fabric: string, node: string) => call<{ ok: true }>("DELETE", `/api/cluster/sdn/fabrics/${enc(fabric)}/nodes/${enc(node)}`, { confirm: node }),
  createPrefixList: (b: Row) => call<{ ok: true }>("POST", "/api/cluster/sdn/prefix-lists", b),
  deletePrefixList: (id: string) => call<{ ok: true }>("DELETE", `/api/cluster/sdn/prefix-lists/${enc(id)}`, { confirm: id }),
  addPrefixEntry: (id: string, b: Row) => call<{ ok: true }>("POST", `/api/cluster/sdn/prefix-lists/${enc(id)}/entries`, b),
  deletePrefixEntry: (id: string, seq: number) => call<{ ok: true }>("DELETE", `/api/cluster/sdn/prefix-lists/${enc(id)}/entries/${seq}`, {}),
  addRouteEntry: (id: string, b: Row) => call<{ ok: true }>("POST", `/api/cluster/sdn/route-maps/${enc(id)}/entries`, b),
  deleteRouteEntry: (id: string, order: number) => call<{ ok: true }>("DELETE", `/api/cluster/sdn/route-maps/${enc(id)}/entries/${order}`, { confirm: `${id}:${order}` }),
  applySdn: () => call<{ task: string }>("POST", "/api/sdn/apply", {}),
};
