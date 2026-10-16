import type { ClusterResource, NodeStatus, RrdCf, RrdPoint, RrdTimeframe } from "@papercliped-engine/proxmox-client";
import { nodeHeaders } from "../lib/selectedNode.ts";

/**
 * The ePaperclip host service's API, as the console sees it. The service signs users in with their Proxmox account
 * and acts as them, so every answer here is already limited to what that user may see and do. When the console is
 * served without the service (vite dev or preview), it runs on demo data instead.
 */

export interface LiveUser {
  username: string; // user@realm
  name: string;
  realm: string;
  node: string;
}

export interface Realm {
  realm: string;
  type: string;
  comment: string | null;
  default: boolean;
}

export interface LiveHost {
  node: string;
  version: string;
  status: NodeStatus | null; // null when the user lacks Sys.Audit on the node
  resources: ClusterResource[];
  storage: { storage: string; plugintype: string | null; content: string; status: string; used: number; total: number; shared: boolean }[];
}

export interface MachineOptions {
  nextid: number;
  templates: { volid: string; name: string; size: number | null }[];
  isos: { volid: string; name: string; size: number | null }[];
  storages: { storage: string; type: string; avail: number | null }[];
  vmStorages: { storage: string; type: string; avail: number | null }[];
  pools: string[];
}

export type ContentKind = "iso" | "vztmpl" | "backup" | "images" | "rootdir" | "snippets" | "import";

export interface StorageItem {
  volid: string;
  content: ContentKind;
  format: string | null;
  size: number | null;
  ctime: number | null;
  vmid: number | null;
  notes: string | null;
  protected: boolean;
}

export interface CatalogTemplate {
  template: string;
  headline: string | null;
  description: string | null;
  os: string | null;
  version: string | null;
  section: string | null;
  infopage: string | null;
}

export interface TaskEntry {
  upid: string;
  type: string;
  id: string | null;
  user: string;
  status: string | null; // null while running
  start: number;
  end: number | null;
}

export interface TaskDetail {
  status: string; // running | stopped
  exitstatus: string | null;
  log: string[];
}

export interface VmSpec {
  name: string;
  iso: string | null;
  ostype: "l26" | "win11" | "other";
  cores: number;
  memoryMb: number;
  diskGb: number;
  storage: string;
  pool?: string;
  start?: boolean;
}

export interface BackupJob {
  id: string;
  schedule: string | null;
  storage: string | null;
  all: boolean;
  vmids: number[];
  pool: string | null;
  mode: "snapshot" | "suspend" | "stop" | string;
  compress: string | null;
  enabled: boolean;
  keepLast: number | null;
  comment: string | null;
  nextRun: number | null;
}

export interface BackupJobSpec {
  schedule: string;
  storage: string;
  all: boolean;
  vmids: number[];
  mode: "snapshot" | "suspend" | "stop";
  keepLast: number;
  enabled: boolean;
  comment?: string;
}

export interface BackupRun {
  all: boolean;
  vmids: number[];
  storage: string;
  mode: "snapshot" | "suspend" | "stop";
  notes?: string;
}

export interface RestoreSpec {
  from: string; // storage holding the backup
  volid: string;
  storage: string; // where the restored disks go
  replace: boolean; // overwrite the original machine instead of creating a new one
  start?: boolean;
}

export interface Disk {
  key: string;
  storage: string | null;
  volume: string;
  sizeGb: number | null;
  mount: string | null;
}

export interface Nic {
  key: string;
  model: string | null;
  name: string | null;
  mac: string | null;
  bridge: string | null;
  tag: number | null;
  firewall: boolean;
  ip: string | null;
  gw: string | null;
  rate: number | null;
}

export interface GuestHardware {
  type: "lxc" | "qemu";
  name: string | null;
  cores: number;
  sockets: number;
  memoryMb: number;
  swapMb: number | null;
  balloonMb: number | null;
  onboot: boolean;
  description: string;
  tags: string[];
  ostype: string | null;
  disks: Disk[];
  nics: Nic[];
  cdrom: string | null;
  pending: string[];
  protection: boolean;
  startup: Startup;
  boot: string[] | null;
  bootDevices: string[];
  agent: boolean | null;
  status: string;
  template: boolean;
}

export interface Startup {
  order: number | null;
  up: number | null;
  down: number | null;
}

export interface HardwareChange {
  cores?: number;
  sockets?: number;
  memoryMb?: number;
  swapMb?: number;
  onboot?: boolean;
  description?: string;
  tags?: string[];
  name?: string;
  protection?: boolean;
  startup?: Startup;
  boot?: string[];
  agent?: boolean;
  ostype?: string;
}

export interface NicSpec {
  key: string | null; // null adds a new device
  bridge: string;
  model?: string;
  tag?: number | null;
  firewall: boolean;
  ip?: string;
  gw?: string | null;
  rate?: number | null;
}

export interface SnapshotInfo {
  name: string;
  description: string;
  time: number | null;
  parent: string | null;
  vmstate: boolean;
}

export interface NetIface {
  iface: string;
  type: string; // bridge | eth | bond | vlan | ...
  active: boolean;
  autostart: boolean;
  cidr: string | null;
  gateway: string | null;
  ports: string[];
  vlanAware: boolean;
  slaves: string[];
  bondMode: string | null;
  vlanRaw: string | null;
  vlanId: number | null;
  comments: string | null;
  method: string | null;
}

export interface IfaceSpec {
  type: "bridge" | "vlan" | "bond";
  iface: string;
  cidr: string | null;
  gateway: string | null;
  autostart: boolean;
  comments: string | null;
  ports: string[];
  vlanAware: boolean;
  slaves: string[];
  bondMode: string | null;
  vlanRaw: string | null;
  vlanId: number | null;
}

export interface FwRule {
  pos: number;
  type: "in" | "out" | "group";
  action: string;
  enable: boolean;
  macro: string | null;
  proto: string | null;
  dport: string | null;
  sport: string | null;
  source: string | null;
  dest: string | null;
  iface: string | null;
  log: string | null;
  comment: string | null;
}

export type FwRuleSpec = Omit<FwRule, "pos">;

export interface SdnSubnet {
  id: string;
  cidr: string;
  gateway: string | null;
  snat: boolean;
  dhcpRange: string[];
  state: string | null;
}

export interface SdnState {
  zones: { zone: string; type: string; bridge: string | null; dhcp: string | null; state: string | null }[];
  vnets: { vnet: string; zone: string; tag: number | null; alias: string | null; state: string | null; subnets: SdnSubnet[] }[];
  pending: number;
}

/** The Store's signed catalog as the host service reports it. Empty and not enabled until a signing key is pinned. */
export interface MarketplaceAnswer {
  enabled: boolean;
  entries: import("@papercliped-engine/marketplace/types").Entry[];
  sequence?: number | null;
  /** Why the catalog couldn't be used, when it couldn't. */
  problem?: { code: string; message: string } | null;
}

/** The newest installer the Store found in a vendor's own checksum list. */
export type LibraryLatest = import("@papercliped-engine/os-library").Latest;

export interface UrlDownload {
  url: string;
  content: "iso" | "vztmpl";
  filename: string;
  checksum?: string;
  algorithm?: string;
  verifyCertificates?: boolean;
}

export interface MachineSpec {
  name: string;
  template: string;
  storage: string;
  cores: number;
  memoryMb: number;
  diskGb: number;
  pool?: string;
  password?: string;
  sshKey?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Fired when the service says the session ended, so the app can show the sign-in screen. */
export const SIGNED_OUT = "epc:signed-out";

const enc = encodeURIComponent;

/** Uploads a file with progress, streamed as the raw body so the service can pass it straight to Proxmox. */
function uploadFile(storage: string, content: "iso" | "vztmpl", file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<{ task: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/storage/${enc(storage)}/upload?content=${content}&filename=${enc(file.name)}`);
    xhr.setRequestHeader("X-EPC-Request", "1");
    for (const [k, v] of Object.entries(nodeHeaders())) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: { task?: string; error?: string; code?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // not JSON
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve({ task: data.task ?? "" });
      if (xhr.status === 401 && data.code === "signed_out") window.dispatchEvent(new Event(SIGNED_OUT));
      reject(new ApiError(xhr.status, data.code ?? "error", data.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, "offline", "The upload was interrupted"));
    xhr.onabort = () => reject(new ApiError(0, "aborted", "Upload cancelled"));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { ...nodeHeaders(), ...(method === "POST" ? { "Content-Type": "application/json", "X-EPC-Request": "1" } : { Accept: "application/json" }) },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
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

export type Probe = { mode: "live"; user: LiveUser } | { mode: "signin" } | { mode: "demo" };

/** Works out how the console is being served: by the host service (signed in or not), or on its own as a demo. */
export async function probe(): Promise<Probe> {
  try {
    const { user } = await request<{ user: LiveUser }>("GET", "/api/me");
    return { mode: "live", user };
  } catch (e) {
    if (e instanceof ApiError && e.code === "signed_out") return { mode: "signin" };
    return { mode: "demo" };
  }
}

/** The second factors a sign-in can be answered with; `webauthn` holds the options the browser needs for a security key. */
export interface TfaMethods { totp: boolean; recovery: boolean; webauthn: Record<string, unknown> | null }

export const api = {
  realms: () => request<{ realms: Realm[] }>("GET", "/api/realms").then((r) => r.realms),
  login: (username: string, password: string, realm: string) => request<{ user: { username: string } } | { needTfa: true; challenge: string; methods?: TfaMethods }>("POST", "/api/login", { username, password, realm }),
  tfa: (challenge: string, code: string, kind: "totp" | "recovery") => request<{ user: { username: string } }>("POST", "/api/login/tfa", { challenge, code, kind }),
  tfaKey: (challenge: string, response: string) => request<{ user: { username: string } }>("POST", "/api/login/tfa", { challenge, kind: "webauthn", response }),
  openidStart: (realm: string) => request<{ url: string }>("POST", "/api/login/openid/start", { realm }),
  openidFinish: (code: string, state: string) => request<{ user: { username: string } }>("POST", "/api/login/openid/finish", { code, state }),
  banner: () => request<{ text: string }>("GET", "/api/login/banner").then((r) => r.text, () => ""),
  logout: () => request<{ ok: true }>("POST", "/api/logout"),
  me: () => request<{ user: LiveUser }>("GET", "/api/me").then((r) => r.user),
  host: () => request<LiveHost>("GET", "/api/host"),
  stats: (target: { kind: "node" } | { kind: "guest"; vmid: number }, timeframe: RrdTimeframe, cf: RrdCf) =>
    request<{ points: RrdPoint[] }>("GET", `/api/stats/${target.kind === "node" ? "node" : `guests/${target.vmid}`}?timeframe=${timeframe}&cf=${cf}`).then((r) => r.points),
  machineOptions: () => request<MachineOptions>("GET", "/api/machines/options"),
  createMachine: (spec: MachineSpec) => request<{ vmid: number; task: string }>("POST", "/api/machines", spec),
  content: (storage: string, kind?: ContentKind) => request<{ items: StorageItem[] }>("GET", `/api/storage/${enc(storage)}/content${kind ? `?content=${kind}` : ""}`).then((r) => r.items),
  deleteVolume: (storage: string, volid: string) => request<{ task: string | null }>("POST", `/api/storage/${enc(storage)}/delete`, { volid }),
  catalog: () => request<{ templates: CatalogTemplate[] }>("GET", "/api/templates/catalog").then((r) => r.templates),
  downloadTemplate: (storage: string, template: string) => request<{ task: string }>("POST", "/api/templates/download", { storage, template }),
  downloadUrl: (storage: string, d: UrlDownload) => request<{ task: string }>("POST", `/api/storage/${enc(storage)}/download-url`, d),
  marketplace: () => request<MarketplaceAnswer>("GET", "/api/marketplace"),
  libraryLatest: (id: string) => request<LibraryLatest>("GET", `/api/library/${enc(id)}/latest`),
  upload: uploadFile,
  tasks: (limit = 50, vmid?: number) => request<{ tasks: TaskEntry[] }>("GET", `/api/tasks?limit=${limit}${vmid !== undefined ? `&vmid=${vmid}` : ""}`).then((r) => r.tasks),
  destroyMachine: (vmid: number, confirm: string) => request<{ task: string | null }>("POST", `/api/guests/${vmid}/destroy`, { confirm }),
  convertToTemplate: (vmid: number, confirm: string) => request<{ task: string | null }>("POST", `/api/guests/${vmid}/template`, { confirm }),
  task: (upid: string) => request<TaskDetail>("GET", `/api/tasks/${enc(upid)}`),
  createVm: (spec: VmSpec) => request<{ vmid: number; task: string }>("POST", "/api/vms", spec),
  backupJobs: () => request<{ jobs: BackupJob[] }>("GET", "/api/backups/jobs").then((r) => r.jobs),
  saveBackupJob: (id: string | null, spec: BackupJobSpec) => request<{ ok: true }>("POST", id ? `/api/backups/jobs/${enc(id)}` : "/api/backups/jobs", spec),
  toggleBackupJob: (id: string, enabled: boolean) => request<{ ok: true }>("POST", `/api/backups/jobs/${enc(id)}`, { enabled }),
  deleteBackupJob: (id: string) => request<{ ok: true }>("POST", `/api/backups/jobs/${enc(id)}/delete`),
  /** Machines on several nodes are backed up by their own node (one task each); the first task is the one followed. */
  runBackup: async (r: BackupRun): Promise<{ task: string }> => {
    try {
      const out = await request<{ tasks: { task: string }[] }>("POST", "/api/cluster/backup/run", r);
      if (out.tasks[0]) return { task: out.tasks[0].task };
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
    }
    return request<{ task: string }>("POST", "/api/backups/run", r);
  },
  restore: (r: RestoreSpec) => request<{ vmid: number; task: string }>("POST", "/api/backups/restore", r),
  hardware: (vmid: number) => request<GuestHardware>("GET", `/api/guests/${vmid}/config`),
  setHardware: (vmid: number, c: HardwareChange) => request<{ ok: true }>("POST", `/api/guests/${vmid}/config`, c),
  resizeDisk: (vmid: number, disk: string, growGb: number) => request<{ task: string | null }>("POST", `/api/guests/${vmid}/resize`, { disk, growGb }),
  saveNic: (vmid: number, n: NicSpec) => request<{ ok: true }>("POST", `/api/guests/${vmid}/nets`, n),
  deleteNic: (vmid: number, key: string) => request<{ ok: true }>("POST", `/api/guests/${vmid}/nets/${enc(key)}/delete`),
  snapshots: (vmid: number) => request<{ snapshots: SnapshotInfo[]; current: string | null }>("GET", `/api/guests/${vmid}/snapshots`),
  takeSnapshot: (vmid: number, name: string, description: string, vmstate: boolean) => request<{ task: string }>("POST", `/api/guests/${vmid}/snapshots`, { name, description, vmstate }),
  rollbackSnapshot: (vmid: number, name: string) => request<{ task: string }>("POST", `/api/guests/${vmid}/snapshots/${enc(name)}/rollback`),
  deleteSnapshot: (vmid: number, name: string) => request<{ task: string }>("POST", `/api/guests/${vmid}/snapshots/${enc(name)}/delete`),
  clone: (vmid: number, name: string, storage: string | null, linked: boolean) => request<{ vmid: number; task: string; full: boolean }>("POST", `/api/guests/${vmid}/clone`, { name, storage, linked }),
  screen: (vmid: number) => request<{ id: string; password: string }>("POST", `/api/guests/${vmid}/vnc`),
  network: () => request<{ interfaces: NetIface[]; changes: string | null }>("GET", "/api/network"),
  saveIface: (existing: string | null, spec: IfaceSpec) => request<{ ok: true }>("POST", existing ? `/api/network/${enc(existing)}` : "/api/network", spec),
  deleteIface: (iface: string, confirm?: string) => request<{ ok: true }>("POST", `/api/network/${enc(iface)}/delete`, { confirm }),
  applyNetwork: () => request<{ task: string }>("POST", "/api/network/apply"),
  revertNetwork: () => request<{ ok: true }>("POST", "/api/network/revert"),
  firewallGet: <T,>(scope: string, res: string, sub?: string) => request<T>("GET", `/api/firewall/${enc(scope)}/${res}${sub ? `/${enc(sub)}` : ""}`),
  firewallPost: (scope: string, path: string, body: unknown = {}) => request<{ ok: true }>("POST", `/api/firewall/${enc(scope)}/${path}`, body),
  dns: () => request<{ search: string; servers: string[] }>("GET", "/api/network/dns"),
  setDns: (search: string, servers: string[]) => request<{ ok: true }>("POST", "/api/network/dns", { search, servers }),
  hosts: () => request<{ data: string; digest: string | null }>("GET", "/api/network/hosts"),
  setHosts: (data: string, digest: string | null) => request<{ ok: true }>("POST", "/api/network/hosts", { data, digest }),
  sdn: () => request<SdnState>("GET", "/api/sdn"),
  sdnPost: (path: string, body: unknown = {}) => request<{ ok?: true; task?: string }>("POST", `/api/sdn/${path}`, body),
  power: (vmid: number, action: "start" | "shutdown" | "stop" | "reboot" | "reset") => request<{ task: string }>("POST", `/api/guests/${vmid}/power`, { action }),
};
