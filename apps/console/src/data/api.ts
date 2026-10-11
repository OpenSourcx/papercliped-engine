import type { ClusterResource, NodeStatus, RrdCf, RrdPoint, RrdTimeframe } from "@papercliped-engine/proxmox-client";

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
      headers: method === "POST" ? { "Content-Type": "application/json", "X-EPC-Request": "1" } : { Accept: "application/json" },
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

export const api = {
  realms: () => request<{ realms: Realm[] }>("GET", "/api/realms").then((r) => r.realms),
  login: (username: string, password: string, realm: string) => request<{ user: { username: string } } | { needTfa: true; challenge: string }>("POST", "/api/login", { username, password, realm }),
  tfa: (challenge: string, code: string, kind: "totp" | "recovery") => request<{ user: { username: string } }>("POST", "/api/login/tfa", { challenge, code, kind }),
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
  upload: uploadFile,
  tasks: (limit = 50) => request<{ tasks: TaskEntry[] }>("GET", `/api/tasks?limit=${limit}`).then((r) => r.tasks),
  task: (upid: string) => request<TaskDetail>("GET", `/api/tasks/${enc(upid)}`),
  createVm: (spec: VmSpec) => request<{ vmid: number; task: string }>("POST", "/api/vms", spec),
  backupJobs: () => request<{ jobs: BackupJob[] }>("GET", "/api/backups/jobs").then((r) => r.jobs),
  saveBackupJob: (id: string | null, spec: BackupJobSpec) => request<{ ok: true }>("POST", id ? `/api/backups/jobs/${enc(id)}` : "/api/backups/jobs", spec),
  toggleBackupJob: (id: string, enabled: boolean) => request<{ ok: true }>("POST", `/api/backups/jobs/${enc(id)}`, { enabled }),
  deleteBackupJob: (id: string) => request<{ ok: true }>("POST", `/api/backups/jobs/${enc(id)}/delete`),
  runBackup: (r: BackupRun) => request<{ task: string }>("POST", "/api/backups/run", r),
  restore: (r: RestoreSpec) => request<{ vmid: number; task: string }>("POST", "/api/backups/restore", r),
  power: (vmid: number, action: "start" | "shutdown" | "stop" | "reboot") => request<{ task: string }>("POST", `/api/guests/${vmid}/power`, { action }),
};
