import { call, enc, qs } from "./nodeApi.ts";

/**
 * The host service's cluster endpoints (services/epaperclip/src/features/cluster*.ts): create and join, nodes, high
 * availability, replication, migration, backups across nodes and Ceph. Every call is made as the signed-in person.
 */

export interface ClusterMember { name: string; nodeid: number | null; ip: string | null; online: boolean; local: boolean; votes: number | null; links: { n: number; address: string }[]; level: string | null; guests: { running: number; total: number } }
export interface ClusterOverview {
  clustered: boolean;
  name: string | null;
  quorate: boolean;
  configVersion: number | null;
  local: string;
  pveVersion: string | null;
  pveMajor: number | null;
  nodes: ClusterMember[];
  onlineCount: number;
  votes: number;
  totem: Record<string, unknown> | null;
  qdevice: { configured: boolean; text: string | null } | null;
  joinApiVersion: number | null;
  guestsHere: { running: number; total: number };
  denied: { status: boolean; config: boolean };
  canChange: boolean;
}
export interface JoinInfo { info: string; ipAddress: string; fingerprint: string; node: string; peerLinks: Record<string, string> }
export interface LinkInput { address: string; priority?: number }
export interface RemovalGuide { node: string; online: boolean; local: boolean; guests: { vmid: number; name: string; type: string }[]; haResources: string[]; replicationJobs: string[]; steps: string[] }

export interface HaResource { sid: string; type: string; vmid: number | null; name: string | null; node: string | null; state: string; group: string | null; maxRestart: number | null; maxRelocate: number | null; failback: boolean | null; autoRebalance: boolean | null; comment: string; digest: string | null; current: string | null; status: string | null }
export interface HaNode { node: string; priority?: number }
export interface HaGroup { group: string; nodes: HaNode[]; restricted: boolean; nofailback: boolean; comment: string; digest: string | null }
export interface HaRule { rule: string; type: "node-affinity" | "resource-affinity" | string; resources: string[]; nodes: HaNode[]; strict: boolean | null; affinity: string | null; comment: string; disabled: boolean; digest: string | null; state: string | null }
export interface HaInfo {
  pveVersion: string | null;
  pveMajor: number | null;
  mode: "rules" | "groups";
  rulesSupported: boolean;
  groupsSupported: boolean;
  denied: boolean;
  available: boolean;
  resources: HaResource[];
  groups: HaGroup[];
  rules: HaRule[];
  status: { quorate: boolean | null; quorumText: string | null; master: { node: string; status: string; timestamp: number | null } | null; lrms: { node: string; status: string; mode: string | null; timestamp: number | null }[]; armedState: string | null; resourceMode: string | null; managerNode: string | null };
  fencing: { mode: string; armed: string | null; canArm: boolean };
  nodes: { node: string; online: boolean }[];
}
export interface HaResourceInput { sid?: string; state?: string; group?: string | null; maxRestart?: number | null; maxRelocate?: number | null; failback?: boolean | null; autoRebalance?: boolean | null; comment?: string | null; digest?: string | null }
export interface HaRuleInput { rule?: string; type?: string; resources?: string[]; nodes?: HaNode[]; strict?: boolean; affinity?: string; comment?: string | null; disable?: boolean; digest?: string | null }

export interface ReplJob { id: string; guest: number; guestName: string | null; guestType: string | null; jobnum: number; source: string; target: string; schedule: string; rate: number | null; comment: string; disabled: boolean; digest: string | null; lastSync: number | null; lastTry: number | null; nextSync: number | null; duration: number | null; failCount: number; error: string | null; syncing: boolean; state: "ok" | "error" | "syncing" | "pending" | "disabled" | "removing" }
export interface ReplList { jobs: ReplJob[]; denied: boolean; guests: { vmid: number; name: string; node: string; type: string }[]; nodes: { node: string; online: boolean }[]; statusUnavailable: string[] }

export interface MigrateCheck {
  vmid: number;
  name: string;
  type: "qemu" | "lxc";
  node: string;
  status: string;
  running: boolean;
  template: boolean;
  locked: string | null;
  targets: { node: string; online: boolean; allowed: boolean; reasons: string[] }[];
  localDisks: { volid: string; size: number | null; cdrom: boolean; unused: boolean }[];
  localResources: string[];
  mappedResources: { id: string; liveMigration: boolean }[];
  dependentHa: string[];
  conntrack: boolean;
  ha: { sid: string; state: string } | null;
  modes: { online: boolean; offline: boolean; localDisks: boolean; restart: boolean };
}
export interface MigrateInput { target: string; online?: boolean; restart?: boolean; withLocalDisks?: boolean; targetStorage?: string; bwlimit?: number; force?: boolean; confirm?: string; migrationType?: string; migrationNetwork?: string; withConntrackState?: boolean }
export type MigrateResult = { queued: false; task: string; node: string } | { queued: true; ha: string; how: string; node: string };

export interface CephInfo {
  node: string;
  installed: boolean;
  denied: boolean;
  reason?: string;
  status?: { health: string; checks: { code: string; severity: string; message: string; muted: boolean }[]; fsid: string | null; monitors: { total: number | null; quorum: string[] }; osds: { total: number | null; up: number | null; in: number | null }; pgs: { total: number | null; states: { state: string; count: number }[] }; usage: { used: number | null; available: number | null; total: number | null }; io: { readBytes: number | null; writeBytes: number | null; readOps: number | null; writeOps: number | null } };
  monitors?: { name: string; host: string | null; addr: string | null; rank: number | null; quorum: boolean | null; state: string | null; version: string | null }[];
  managers?: { name: string; host: string | null; addr: string | null; state: string | null; version: string | null }[];
  metadataServers?: { name: string; host: string | null; addr: string | null; state: string | null; standbyReplay: boolean; rank: number | null }[];
  osds?: { id: number; name: string; host: string | null; status: string; in: boolean | null; deviceClass: string | null; used: number | null; total: number | null; percentUsed: number | null; pgs: number | null; commitLatencyMs: number | null; applyLatencyMs: number | null; version: string | null }[];
  pools?: { name: string; size: number | null; minSize: number | null; pgNum: number | null; autoscale: string | null; crushRule: string | null; application: string | null; used: number | null; percentUsed: number | null; type: string | null; targetSizeRatio: number | null }[];
  filesystems?: { name: string; metadataPool: string | null; dataPool: string | null }[];
  flags?: { name: string; description: string; value: boolean }[];
  mutes?: string[];
}

const j = <T,>(path: string) => call<T>("GET", path);

export const clusterApi = {
  overview: () => j<ClusterOverview>("/api/cluster/overview"),
  joinInfo: () => j<JoinInfo>("/api/cluster/join-info"),
  parseJoinInfo: (text: string) => call<{ ipAddress: string; fingerprint: string; peerLinks: Record<string, string> }>("POST", "/api/cluster/join-info/parse", { text }),
  create: (b: { name: string; confirm: string; links?: LinkInput[]; nodeid?: number; votes?: number }) => call<{ task: string; node: string }>("POST", "/api/cluster/create", b),
  join: (b: { hostname: string; fingerprint: string; password: string; confirm: string; links?: LinkInput[]; nodeid?: number; votes?: number }) => call<{ task: string; node: string; signOutExpected: boolean }>("POST", "/api/cluster/join", b),
  removal: (node: string) => j<RemovalGuide>(`/api/cluster/nodes/${enc(node)}/removal`),
  removeNode: (node: string, confirm: string) => call<{ ok: true }>("POST", `/api/cluster/nodes/${enc(node)}/remove`, { confirm }),
  log: (max = 100) => j<{ entries: { time: number | null; node: string | null; user: string | null; tag: string | null; pid: number | null; priority: number | null; message: string }[] }>(`/api/cluster/log${qs({ max })}`),

  ha: () => j<HaInfo>("/api/cluster/ha"),
  haGuest: (vmid: number) => j<{ available: boolean; managed: boolean; sid: string | null; state: string | null; current: string | null; group: string | null }>(`/api/cluster/ha/guest/${vmid}`),
  addHaResource: (b: HaResourceInput) => call<{ ok: true }>("POST", "/api/cluster/ha/resources", b),
  saveHaResource: (sid: string, b: HaResourceInput) => call<{ ok: true }>("PUT", `/api/cluster/ha/resources/${enc(sid)}`, b),
  removeHaResource: (sid: string) => call<{ ok: true }>("DELETE", `/api/cluster/ha/resources/${enc(sid)}`, {}),
  moveHaResource: (sid: string, how: "migrate" | "relocate", node: string) => call<{ ok: true; queued: true }>("POST", `/api/cluster/ha/resources/${enc(sid)}/${how}`, { node }),
  addHaGroup: (b: { group: string; nodes: HaNode[]; restricted?: boolean; nofailback?: boolean; comment?: string }) => call<{ ok: true }>("POST", "/api/cluster/ha/groups", b),
  saveHaGroup: (group: string, b: { nodes?: HaNode[]; restricted?: boolean; nofailback?: boolean; comment?: string | null; digest?: string | null }) => call<{ ok: true }>("PUT", `/api/cluster/ha/groups/${enc(group)}`, b),
  removeHaGroup: (group: string) => call<{ ok: true }>("DELETE", `/api/cluster/ha/groups/${enc(group)}`, { confirm: group }),
  addHaRule: (b: HaRuleInput) => call<{ ok: true }>("POST", "/api/cluster/ha/rules", b),
  saveHaRule: (rule: string, b: HaRuleInput) => call<{ ok: true }>("PUT", `/api/cluster/ha/rules/${enc(rule)}`, b),
  removeHaRule: (rule: string) => call<{ ok: true }>("DELETE", `/api/cluster/ha/rules/${enc(rule)}`, {}),
  armHa: (b: { action: "arm" } | { action: "disarm"; resourceMode: "freeze" | "ignore"; confirm: string }) => call<{ ok: true }>("POST", "/api/cluster/ha/arm", b),

  replication: (guest?: number) => j<ReplList>(`/api/cluster/replication${qs({ guest })}`),
  createReplication: (b: { guest: number; target: string; schedule?: string; rate?: number; comment?: string; disable?: boolean }) => call<{ id: string }>("POST", "/api/cluster/replication", b),
  saveReplication: (id: string, b: { schedule?: string | null; rate?: number | null; comment?: string | null; disable?: boolean; digest?: string | null }) => call<{ ok: true }>("PUT", `/api/cluster/replication/${enc(id)}`, b),
  deleteReplication: (id: string, o: { keep?: boolean; force?: boolean } = {}) => call<{ ok: true }>("DELETE", `/api/cluster/replication/${enc(id)}`, { confirm: id, ...o }),
  runReplication: (id: string) => call<{ ok: true }>("POST", `/api/cluster/replication/${enc(id)}/run-now`, {}),
  replicationLog: (id: string, start = 0) => j<{ node: string; lines: string[]; next: number; total: number | null }>(`/api/cluster/replication/${enc(id)}/log${qs({ start: start || undefined })}`),

  migrateCheck: (vmid: number, target?: string) => j<MigrateCheck>(`/api/cluster/migrate/${vmid}${qs({ target })}`),
  migrateStorages: (vmid: number, target: string) => j<{ storages: { storage: string; type: string; shared: boolean; avail: number | null; total: number | null }[] }>(`/api/cluster/migrate/${vmid}/storages${qs({ target })}`),
  migrate: (vmid: number, b: MigrateInput) => call<MigrateResult>("POST", `/api/cluster/migrate/${vmid}`, b),
  runBackup: (b: { all?: boolean; vmids?: number[]; storage: string; mode?: string; notes?: string }) => call<{ tasks: { node: string; task: string; vmids: number[] }[] }>("POST", "/api/cluster/backup/run", b),

  ceph: (node?: string | null) => j<CephInfo>(`/api/cluster/ceph${qs({ node: node ?? undefined })}`),
  cephConfig: (node?: string | null) => j<{ node: string; config: string | null; rules: { name: string; id: number | null }[]; log: string[]; denied: boolean }>(`/api/cluster/ceph/config${qs({ node: node ?? undefined })}`),
  cephOsd: (id: number, action: "in" | "out" | "scrub", b: { node?: string; confirm?: string; deep?: boolean } = {}) => call<{ ok: true }>("POST", `/api/cluster/ceph/osd/${id}/${action}`, b),
  cephFlag: (flag: string, value: boolean, confirm?: string) => call<{ ok: true }>("PUT", "/api/cluster/ceph/flags", { flag, value, confirm }),
  cephMute: (code: string, value: boolean, ttl?: string) => call<{ ok: true }>("PUT", "/api/cluster/ceph/health-mute", { code, value, ttl }),
  createCephPool: (b: { node?: string; name: string; size?: number; minSize?: number; pgNum?: number; autoscale?: string; application?: string; addStorages?: boolean }) => call<{ task: string }>("POST", "/api/cluster/ceph/pools", b),
  saveCephPool: (name: string, b: { node?: string; size?: number; minSize?: number; autoscale?: string; targetSizeRatio?: number; confirm?: string }) => call<{ task: string | null }>("PUT", `/api/cluster/ceph/pools/${enc(name)}`, b),
};
