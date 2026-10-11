import { request as httpsRequest } from "node:https";

/**
 * A minimal Proxmox VE API client: only the calls the broker needs.
 * Auth is an API token (`Authorization: PVEAPIToken=user@realm!tokenid=secret`); writes send form bodies, as the
 * Proxmox API expects. TLS is always verified; for the default self-signed setup pass the cluster CA
 * (`/etc/pve/pve-root-ca.pem`) as `caPem`. The node certificate lists the node's IPs, so hostname checks still pass.
 */

export type Transport = (req: { method: string; url: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; body: string }>;

/**
 * Two ways to authenticate:
 *  - an API token (`tokenId` + `tokenSecret`), used by the broker, and
 *  - a user's login ticket (`ticket` + `csrf`), used by ePaperclip to act as the signed-in user, so Proxmox's own
 *    permissions decide what that user can see and do (Integrated Access Control).
 */
export type ProxmoxClientOptions = {
  baseUrl: string; // e.g. https://192.168.1.200:8006
  caPem?: string;
  transport?: Transport;
} & ({ tokenId: string; tokenSecret: string; ticket?: undefined } | { ticket: string; csrf: string; tokenId?: undefined });

export interface LoginResult {
  username: string;
  ticket: string;
  csrf: string | null; // absent on a partial (two-factor) ticket
  needTfa: boolean;
}

export class ProxmoxError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface LxcStatus {
  vmid: number;
  status: string; // running | stopped
  name?: string;
  tags?: string;
}

export interface ClusterResource {
  vmid?: number;
  node?: string;
  pool?: string;
  type: string; // lxc | qemu | node | storage | ...
  status?: string;
  tags?: string;
  name?: string;
  template?: number; // 1 for templates
  mem?: number; // bytes in use
  maxmem?: number; // bytes allowed
  cpu?: number; // fraction of maxcpu in use, 0..1
  maxcpu?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  // storage entries
  storage?: string;
  plugintype?: string; // dir, lvmthin, zfspool, nfs, ...
  content?: string; // comma list: images,rootdir,vztmpl,iso,backup,snippets
  shared?: number;
}

export interface NodeStatus {
  cpu: number; // fraction 0..1
  cpuinfo?: { cpus?: number; model?: string };
  memory: { total: number; used: number; free: number };
  rootfs?: { total: number; used: number };
  uptime?: number;
  pveversion?: string;
  loadavg?: string[];
}

export type GuestType = "lxc" | "qemu";
export type RrdTimeframe = "hour" | "day" | "week" | "month" | "year";
export type RrdCf = "AVERAGE" | "MAX";

/** One sample from Proxmox's round-robin statistics. CPU is a fraction of maxcpu; net and disk are bytes per second. */
export interface RrdPoint {
  time: number; // unix seconds
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  netin?: number;
  netout?: number;
  diskread?: number;
  diskwrite?: number;
  // node series
  memused?: number;
  memtotal?: number;
  loadavg?: number;
  iowait?: number;
}
export type PowerAction = "start" | "stop" | "shutdown" | "reboot";

export interface LxcInterface {
  name: string;
  inet?: string; // 192.168.1.50/24
  hwaddr?: string;
}

export interface TaskStatus {
  status: string; // running | stopped
  exitstatus?: string; // OK, or an error message
}

function nodeTransport(caPem?: string): Transport {
  return (req) =>
    new Promise((resolve, reject) => {
      const r = httpsRequest(req.url, { method: req.method, headers: req.headers, ca: caPem, timeout: 30_000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      r.on("timeout", () => r.destroy(new Error("Proxmox API request timed out")));
      r.on("error", reject);
      if (req.body) r.write(req.body);
      r.end();
    });
}

const seg = (v: string | number) => encodeURIComponent(String(v));

function apiBase(baseUrl: string): string {
  const u = new URL(baseUrl);
  if (u.protocol !== "https:") throw new Error("Proxmox URL must use https");
  return `${u.origin}/api2/json`;
}

export class ProxmoxClient {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly writeHeaders: Record<string, string>;
  private readonly transport: Transport;

  constructor(opts: ProxmoxClientOptions) {
    this.base = apiBase(opts.baseUrl);
    if (opts.ticket !== undefined) {
      this.headers = { Cookie: `PVEAuthCookie=${encodeURIComponent(opts.ticket)}` };
      this.writeHeaders = { CSRFPreventionToken: opts.csrf };
    } else {
      this.headers = { Authorization: `PVEAPIToken=${opts.tokenId}=${opts.tokenSecret}` };
      this.writeHeaders = {};
    }
    this.transport = opts.transport ?? nodeTransport(opts.caPem);
  }

  /**
   * Signs a user in with Proxmox's own login (`POST /access/ticket`). With two-factor enabled, the first call returns
   * a partial ticket and needTfa; answer it with `tfaChallenge` set to that ticket and `password` set to the response
   * (`totp:123456` or `recovery:KEY`). Passing a still-valid ticket as `password` renews it. Wrong credentials throw a
   * ProxmoxError with status 401; Proxmox never says which part was wrong.
   */
  static async login(opts: { baseUrl: string; caPem?: string; transport?: Transport }, creds: { username: string; password: string; realm?: string; tfaChallenge?: string }): Promise<LoginResult> {
    const transport = opts.transport ?? nodeTransport(opts.caPem);
    const params: Record<string, string> = { username: creds.username, password: creds.password };
    if (creds.realm) params.realm = creds.realm;
    if (creds.tfaChallenge) params["tfa-challenge"] = creds.tfaChallenge;
    const res = await transport({
      method: "POST",
      url: `${apiBase(opts.baseUrl)}/access/ticket`,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(params).toString(),
    });
    if (res.status !== 200) throw new ProxmoxError(`Proxmox login failed (${res.status})`, res.status === 0 ? 502 : res.status);
    const data = (JSON.parse(res.body || "{}") as { data?: { username?: string; ticket?: string; CSRFPreventionToken?: string; NeedTFA?: number } }).data;
    if (!data?.ticket || !data.username) throw new ProxmoxError("Proxmox login returned no ticket", 502);
    return { username: data.username, ticket: data.ticket, csrf: data.CSRFPreventionToken ?? null, needTfa: data.NeedTFA === 1 };
  }

  /** Login realms (pam, pve, ldap, ...). Readable without signing in, for the login screen. */
  static async realms(opts: { baseUrl: string; caPem?: string; transport?: Transport }): Promise<{ realm: string; type: string; comment?: string; default?: number }[]> {
    const transport = opts.transport ?? nodeTransport(opts.caPem);
    const res = await transport({ method: "GET", url: `${apiBase(opts.baseUrl)}/access/domains`, headers: { Accept: "application/json" } });
    if (res.status !== 200) throw new ProxmoxError(`Proxmox realms failed (${res.status})`, res.status);
    return (JSON.parse(res.body || "{}") as { data?: { realm: string; type: string; comment?: string; default?: number }[] }).data ?? [];
  }

  async call<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
    const entries = Object.entries(params ?? {}).filter((e): e is [string, string | number | boolean] => e[1] !== undefined);
    const form = new URLSearchParams(entries.map(([k, v]): [string, string] => [k, typeof v === "boolean" ? (v ? "1" : "0") : String(v)])).toString();
    const withQuery = method === "GET" || method === "DELETE";
    const url = `${this.base}${path}${withQuery && form ? `?${form}` : ""}`;
    const headers: Record<string, string> = { ...this.headers, Accept: "application/json", ...(method === "GET" ? {} : this.writeHeaders) };
    let body: string | undefined;
    if (!withQuery && form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = form;
    }
    const res = await this.transport({ method, url, headers, body });
    let parsed: { data?: T; errors?: Record<string, string>; message?: string } = {};
    try {
      parsed = res.body ? JSON.parse(res.body) : {};
    } catch {
      // Proxmox puts the reason in the status line for some errors; the body may be empty or not JSON.
    }
    if (res.status < 200 || res.status >= 300) {
      const detail = parsed.errors ? Object.entries(parsed.errors).map(([k, v]) => `${k}: ${v}`).join("; ") : parsed.message;
      throw new ProxmoxError(`Proxmox ${method} ${path} failed (${res.status})${detail ? `: ${detail}` : ""}`, res.status);
    }
    return parsed.data as T;
  }

  version() {
    return this.call<{ version: string; release: string }>("GET", "/version");
  }

  nodeStatus(node: string) {
    return this.call<NodeStatus>("GET", `/nodes/${seg(node)}/status`);
  }

  clusterResources() {
    return this.call<ClusterResource[]>("GET", "/cluster/resources", { type: "vm" });
  }

  /** Every storage the caller can see, with usage (disk/maxdisk) and what it holds. */
  clusterStorage() {
    return this.call<ClusterResource[]>("GET", "/cluster/resources", { type: "storage" });
  }

  /** Resolves when `vmid` is free cluster-wide; throws (400) when it is taken. */
  /** The next free guest id. */
  nextId() {
    return this.call<string | number>("GET", "/cluster/nextid").then(Number);
  }

  /** Storages on a node that hold the given content (vztmpl for container templates, rootdir for container disks). */
  nodeStorages(node: string, content: string) {
    return this.call<{ storage: string; type: string; avail?: number; total?: number; active?: number; enabled?: number }[]>("GET", `/nodes/${seg(node)}/storage`, { content, enabled: 1 });
  }

  storageContent(node: string, storage: string, content: string) {
    return this.call<{ volid: string; size?: number; format?: string }[]>("GET", `/nodes/${seg(node)}/storage/${seg(storage)}/content`, { content });
  }

  /** Pools the caller can see. */
  pools() {
    return this.call<{ poolid: string; comment?: string }[]>("GET", "/pools");
  }

  checkVmidFree(vmid: number) {
    return this.call<string | number>("GET", "/cluster/nextid", { vmid });
  }

  createLxc(node: string, params: Record<string, string | number | boolean | undefined>) {
    return this.call<string>("POST", `/nodes/${seg(node)}/lxc`, params);
  }

  cloneLxc(node: string, vmid: number, params: Record<string, string | number | boolean | undefined>) {
    return this.call<string>("POST", `/nodes/${seg(node)}/lxc/${seg(vmid)}/clone`, params);
  }

  setLxcConfig(node: string, vmid: number, params: Record<string, string | number | boolean | undefined>) {
    return this.call<null>("PUT", `/nodes/${seg(node)}/lxc/${seg(vmid)}/config`, params);
  }

  lxcConfig(node: string, vmid: number) {
    return this.call<Record<string, string | number | undefined>>("GET", `/nodes/${seg(node)}/lxc/${seg(vmid)}/config`);
  }

  lxcStatus(node: string, vmid: number) {
    return this.call<LxcStatus>("GET", `/nodes/${seg(node)}/lxc/${seg(vmid)}/status/current`);
  }

  lxcInterfaces(node: string, vmid: number) {
    return this.call<LxcInterface[]>("GET", `/nodes/${seg(node)}/lxc/${seg(vmid)}/interfaces`);
  }

  startLxc(node: string, vmid: number) {
    return this.call<string>("POST", `/nodes/${seg(node)}/lxc/${seg(vmid)}/status/start`);
  }

  stopLxc(node: string, vmid: number) {
    return this.call<string>("POST", `/nodes/${seg(node)}/lxc/${seg(vmid)}/status/stop`);
  }

  destroyLxc(node: string, vmid: number) {
    return this.call<string>("DELETE", `/nodes/${seg(node)}/lxc/${seg(vmid)}`, { force: true });
  }

  /** Power action on any guest, container or VM. Returns the task UPID. */
  guestPower(node: string, type: GuestType, vmid: number, action: PowerAction) {
    return this.call<string>("POST", `/nodes/${seg(node)}/${type}/${seg(vmid)}/status/${action}`);
  }

  guestSnapshot(node: string, type: GuestType, vmid: number, snapname: string, description?: string) {
    return this.call<string>("POST", `/nodes/${seg(node)}/${type}/${seg(vmid)}/snapshot`, { snapname, description });
  }

  /** Usage history for a guest, as the Summary graphs in the Proxmox UI use it. Needs VM.Audit. */
  guestRrd(node: string, type: GuestType, vmid: number, timeframe: RrdTimeframe, cf: RrdCf = "AVERAGE") {
    return this.call<RrdPoint[]>("GET", `/nodes/${seg(node)}/${type}/${seg(vmid)}/rrddata`, { timeframe, cf });
  }

  /** Usage history for the node itself. Needs Sys.Audit. */
  nodeRrd(node: string, timeframe: RrdTimeframe, cf: RrdCf = "AVERAGE") {
    return this.call<RrdPoint[]>("GET", `/nodes/${seg(node)}/rrddata`, { timeframe, cf });
  }

  taskStatus(node: string, upid: string) {
    return this.call<TaskStatus>("GET", `/nodes/${seg(node)}/tasks/${seg(upid)}/status`);
  }

  /** Waits for a Proxmox task (UPID) to finish and throws if it did not end OK. */
  async waitTask(node: string, upid: string, opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {}) {
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const pollMs = opts.pollMs ?? 1_000;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.taskStatus(node, upid);
      if (s.status === "stopped") {
        // A task that finished with warnings reports "WARNINGS: n" and still succeeded.
        if (s.exitstatus !== "OK" && !s.exitstatus?.startsWith("WARNINGS")) throw new ProxmoxError(`Proxmox task failed: ${s.exitstatus ?? "unknown"}`, 500);
        return;
      }
      if (Date.now() > deadline) throw new ProxmoxError(`Proxmox task did not finish within ${timeoutMs} ms`, 504);
      await sleep(pollMs);
    }
  }
}
