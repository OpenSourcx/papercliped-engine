import { request as httpsRequest } from "node:https";

/**
 * A minimal Proxmox VE API client: only the calls the broker needs.
 * Auth is an API token (`Authorization: PVEAPIToken=user@realm!tokenid=secret`); writes send form bodies, as the
 * Proxmox API expects. TLS is always verified; for the default self-signed setup pass the cluster CA
 * (`/etc/pve/pve-root-ca.pem`) as `caPem`. The node certificate lists the node's IPs, so hostname checks still pass.
 */

export type Transport = (req: { method: string; url: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; body: string }>;

/** Like Transport, but streams the request body (for uploads that can be gigabytes). */
export type StreamTransport = (req: { method: string; url: string; headers: Record<string, string>; body: AsyncIterable<Uint8Array | string> }) => Promise<{ status: number; body: string }>;

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
  streamTransport?: StreamTransport;
} & ({ tokenId: string; tokenSecret: string; ticket?: undefined } | { ticket: string; csrf: string; tokenId?: undefined });

export interface LoginResult {
  username: string;
  ticket: string;
  csrf: string | null; // absent on a partial (two-factor) ticket
  needTfa: boolean;
}

export class ProxmoxError extends Error {
  readonly status: number;
  /** Proxmox's own explanation (field errors or its message), when it gave one. Safe to show the signed-in user. */
  readonly detail: string | null;
  constructor(message: string, status: number, detail: string | null = null) {
    super(message);
    this.status = status;
    this.detail = detail;
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

export interface StorageItem {
  volid: string;
  content: string; // iso | vztmpl | backup | images | rootdir | snippets | import
  format?: string;
  size?: number;
  ctime?: number;
  vmid?: number;
  notes?: string;
  protected?: number;
}

export interface CatalogTemplate {
  template: string; // file name, e.g. debian-12-standard_12.7-1_amd64.tar.zst
  package?: string;
  headline?: string;
  description?: string;
  os?: string;
  version?: string;
  section?: string; // system | turnkeylinux | mail ...
  type?: string; // lxc
  infopage?: string;
}

export interface BackupJob {
  id: string;
  type?: string; // vzdump
  schedule?: string; // systemd calendar event, e.g. "21:00" or "sat 02:00"
  storage?: string;
  vmid?: string; // comma list
  all?: number;
  pool?: string;
  exclude?: string;
  mode?: string; // snapshot | suspend | stop
  compress?: string; // zstd | lzo | gzip | 0
  enabled?: number;
  comment?: string;
  "prune-backups"?: string | Record<string, number>;
  "next-run"?: number;
  node?: string;
}

export interface NetworkInterface {
  iface: string;
  type: string; // bridge | eth | bond | vlan | OVSBridge | alias | unknown ...
  active?: number;
  autostart?: number;
  method?: string; // static | manual | dhcp
  cidr?: string;
  address?: string;
  netmask?: string;
  gateway?: string;
  cidr6?: string;
  gateway6?: string;
  bridge_ports?: string;
  bridge_vlan_aware?: number;
  slaves?: string;
  bond_mode?: string;
  "vlan-raw-device"?: string;
  "vlan-id"?: number;
  comments?: string;
  mtu?: number;
  exists?: number;
  families?: string[];
}

export interface Snapshot {
  name: string; // "current" is the live state
  description?: string;
  snaptime?: number;
  parent?: string;
  vmstate?: number;
}

export interface TaskEntry {
  upid: string;
  type: string; // vzdump, qmstart, download, imgcopy, aptupdate ...
  id?: string; // guest id or volume, depending on type
  user: string;
  status?: string; // OK, an error, or absent while running
  starttime: number;
  endtime?: number;
  node?: string;
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
export type PowerAction = "start" | "stop" | "shutdown" | "reboot" | "reset";

export interface LxcInterface {
  name: string;
  inet?: string; // 192.168.1.50/24
  hwaddr?: string;
}

export interface TaskStatus {
  status: string; // running | stopped
  exitstatus?: string; // OK, or an error message
}

/**
 * Proxmox's web server doesn't accept chunked request bodies, which is what Node sends when a body is written without a
 * length. Always send the exact Content-Length.
 */
export function nodeTransport(caPem?: string): Transport {
  return (req) =>
    new Promise((resolve, reject) => {
      const headers = req.body ? { ...req.headers, "Content-Length": String(Buffer.byteLength(req.body)) } : req.headers;
      const r = httpsRequest(req.url, { method: req.method, headers, ca: caPem, timeout: 30_000 }, (res) => {
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

function nodeStreamTransport(caPem?: string): StreamTransport {
  return (req) =>
    new Promise((resolve, reject) => {
      const r = httpsRequest(req.url, { method: req.method, headers: req.headers, ca: caPem, timeout: 10 * 60_000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      r.on("timeout", () => r.destroy(new Error("Proxmox upload stalled")));
      r.on("error", reject);
      (async () => {
        for await (const chunk of req.body) if (!r.write(chunk)) await new Promise((ok) => r.once("drain", ok));
        r.end();
      })().catch((e) => r.destroy(e));
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
  private readonly streamTransport: StreamTransport;

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
    this.streamTransport = opts.streamTransport ?? nodeStreamTransport(opts.caPem);
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
    if (res.status !== 200) {
      let why: string | null = null;
      try {
        const b = JSON.parse(res.body || "{}") as { message?: string; errors?: Record<string, string> };
        why = (b.errors ? Object.entries(b.errors).map(([k, v]) => `${k}: ${v}`).join("; ") : b.message)?.trim() || null;
      } catch {
        // Not JSON: Proxmox put its reason, if any, in the status line.
      }
      throw new ProxmoxError(`Proxmox login failed (${res.status})${why ? `: ${why}` : ""}`, res.status === 0 ? 502 : res.status, res.status === 401 ? null : why);
    }
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

  /**
   * OpenID Connect, step one (`POST /access/openid/auth-url`, open to anyone): the identity provider's address to send
   * the browser to. `redirectUrl` is where the provider returns the person, normally the origin of this site.
   */
  static async openidAuthUrl(opts: { baseUrl: string; caPem?: string; transport?: Transport }, p: { realm: string; redirectUrl: string }): Promise<string> {
    const body = await ProxmoxClient.anonymousPost(opts, "/access/openid/auth-url", { realm: p.realm, "redirect-url": p.redirectUrl });
    const url = (body as { data?: unknown }).data;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new ProxmoxError("Proxmox returned no sign-in address for this realm", 502);
    return url;
  }

  /** OpenID Connect, step two (`POST /access/openid/login`): trades the provider's code and state for a Proxmox ticket. */
  static async openidLogin(opts: { baseUrl: string; caPem?: string; transport?: Transport }, p: { code: string; state: string; redirectUrl: string }): Promise<LoginResult> {
    const body = await ProxmoxClient.anonymousPost(opts, "/access/openid/login", { code: p.code, state: p.state, "redirect-url": p.redirectUrl });
    const data = (body as { data?: { username?: string; ticket?: string; CSRFPreventionToken?: string } }).data;
    if (!data?.ticket || !data.username) throw new ProxmoxError("Proxmox returned no ticket for this sign-in", 502);
    return { username: data.username, ticket: data.ticket, csrf: data.CSRFPreventionToken ?? null, needTfa: false };
  }

  private static async anonymousPost(opts: { baseUrl: string; caPem?: string; transport?: Transport }, path: string, params: Record<string, string>): Promise<unknown> {
    const transport = opts.transport ?? nodeTransport(opts.caPem);
    const res = await transport({ method: "POST", url: `${apiBase(opts.baseUrl)}${path}`, headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(params).toString() });
    if (res.status !== 200) {
      let why: string | null = null;
      try {
        const b = JSON.parse(res.body || "{}") as { message?: string; errors?: Record<string, string> };
        why = (b.errors ? Object.entries(b.errors).map(([k, v]) => `${k}: ${v}`).join("; ") : b.message)?.trim() || null;
      } catch {
        // No JSON: the reason, if any, is in the status line.
      }
      throw new ProxmoxError(`Proxmox ${path} failed (${res.status})${why ? `: ${why}` : ""}`, res.status === 0 ? 502 : res.status, why);
    }
    try {
      return JSON.parse(res.body || "{}");
    } catch {
      throw new ProxmoxError(`Proxmox ${path} returned something unreadable`, 502);
    }
  }

  /** Parameters may also be lists (sent as repeated keys, the way Proxmox expects array parameters). */
  async call<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, params?: Record<string, string | number | boolean | string[] | undefined>): Promise<T> {
    return (await this.callFull<T>(method, path, params)).data;
  }

  /** Like call, but also returns the extra top-level fields some endpoints add next to `data` (e.g. `changes`). */
  async callFull<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, params?: Record<string, string | number | boolean | string[] | undefined>): Promise<{ data: T; extra: Record<string, unknown> }> {
    const entries = Object.entries(params ?? {}).filter((e): e is [string, string | number | boolean | string[]] => e[1] !== undefined);
    const form = new URLSearchParams(entries.flatMap(([k, v]): [string, string][] => (Array.isArray(v) ? v.map((x): [string, string] => [k, x]) : [[k, typeof v === "boolean" ? (v ? "1" : "0") : String(v)]]))).toString();
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
      throw new ProxmoxError(`Proxmox ${method} ${path} failed (${res.status})${detail ? `: ${detail}` : ""}`, res.status, detail ? detail.trim() : null);
    }
    const { data, ...extra } = parsed as { data?: T } & Record<string, unknown>;
    return { data: data as T, extra };
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

  /** What a storage holds: ISO images, container templates, backups, disk images. */
  storageContentAll(node: string, storage: string, content?: string) {
    return this.call<StorageItem[]>("GET", `/nodes/${seg(node)}/storage/${seg(storage)}/content`, { content });
  }

  /** Deletes one volume. Returns a task id (newer Proxmox) or null. */
  deleteVolume(node: string, storage: string, volid: string) {
    return this.call<string | null>("DELETE", `/nodes/${seg(node)}/storage/${seg(storage)}/content/${seg(volid)}`);
  }

  /** Proxmox's appliance catalog: the container templates it can download. */
  templateCatalog(node: string) {
    return this.call<CatalogTemplate[]>("GET", `/nodes/${seg(node)}/aplinfo`);
  }

  downloadTemplate(node: string, storage: string, template: string) {
    return this.call<string>("POST", `/nodes/${seg(node)}/aplinfo`, { storage, template });
  }

  /** Has Proxmox download a file from a URL straight into a storage. */
  downloadUrl(node: string, storage: string, p: { url: string; content: "iso" | "vztmpl" | "import"; filename: string; checksum?: string; algorithm?: string; verifyCertificates?: boolean }) {
    return this.call<string>("POST", `/nodes/${seg(node)}/storage/${seg(storage)}/download-url`, { url: p.url, content: p.content, filename: p.filename, checksum: p.checksum, "checksum-algorithm": p.checksum ? p.algorithm : undefined, "verify-certificates": p.verifyCertificates ?? true });
  }

  /**
   * Uploads an ISO image or container template, streaming it as multipart/form-data the way Proxmox's UI does.
   * `size` must be the exact byte count of `file`.
   */
  async upload(node: string, storage: string, p: { content: "iso" | "vztmpl" | "import"; filename: string; size: number; file: AsyncIterable<Uint8Array | string>; checksum?: string; algorithm?: string }): Promise<string> {
    const boundary = `----epaperclip${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
    const field = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    let head = field("content", p.content);
    if (p.checksum && p.algorithm) head += field("checksum", p.checksum) + field("checksum-algorithm", p.algorithm);
    head += `--${boundary}\r\nContent-Disposition: form-data; name="filename"; filename="${p.filename.replace(/["\r\n]/g, "")}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const headBuf = Buffer.from(head);
    const tailBuf = Buffer.from(tail);
    async function* body() {
      yield headBuf;
      yield* p.file;
      yield tailBuf;
    }
    const res = await this.streamTransport({
      method: "POST",
      url: `${this.base}/nodes/${seg(node)}/storage/${seg(storage)}/upload`,
      headers: { ...this.headers, ...this.writeHeaders, Accept: "application/json", "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(headBuf.length + p.size + tailBuf.length) },
      body: body(),
    });
    let parsed: { data?: string; errors?: Record<string, string>; message?: string } = {};
    try {
      parsed = res.body ? JSON.parse(res.body) : {};
    } catch {
      // not JSON
    }
    if (res.status < 200 || res.status >= 300) {
      const detail = parsed.errors ? Object.entries(parsed.errors).map(([k, v]) => `${k}: ${v}`).join("; ") : parsed.message ?? null;
      throw new ProxmoxError(`Proxmox upload failed (${res.status})`, res.status, detail);
    }
    return parsed.data ?? "";
  }

  /** Recent tasks on a node. Proxmox shows each user their own unless they may audit the system. */
  tasks(node: string, limit = 50, vmid?: number) {
    return this.call<TaskEntry[]>("GET", `/nodes/${seg(node)}/tasks`, { limit, vmid });
  }

  /** Deletes a guest. `purge` also removes it from backup schedules and replication; unreferenced disks go too. */
  destroyGuest(node: string, type: GuestType, vmid: number) {
    return this.call<string>("DELETE", `/nodes/${seg(node)}/${type}/${seg(vmid)}`, { purge: true, "destroy-unreferenced-disks": true });
  }

  /** Turns a stopped guest into a template. This can't be undone. */
  convertToTemplate(node: string, type: GuestType, vmid: number) {
    return this.call<string | null>("POST", `/nodes/${seg(node)}/${type}/${seg(vmid)}/template`);
  }

  /** A task's log lines. Proxmox fills a log that has nothing in it yet with placeholder lines whose text is "no content" (with line numbers, not only 0); those aren't output, so they are dropped. */
  async taskLog(node: string, upid: string, limit = 500) {
    const lines = await this.call<{ n: number; t: string }[]>("GET", `/nodes/${seg(node)}/tasks/${seg(upid)}/log`, { start: 0, limit });
    return lines.filter((l) => l.t.trim() !== "no content");
  }

  createVm(node: string, params: Record<string, string | number | boolean | undefined>) {
    return this.call<string>("POST", `/nodes/${seg(node)}/qemu`, params);
  }

  /**
   * Opens Proxmox's terminal proxy for a guest (an LXC console, or a VM's serial console) or for the node's own shell.
   * Returns the one-time port and ticket for its vncwebsocket; see consoleSocketPath.
   */
  termproxy(node: string, guest: { type: GuestType; vmid: number } | null) {
    const path = guest ? `/nodes/${seg(node)}/${guest.type}/${seg(guest.vmid)}/termproxy` : `/nodes/${seg(node)}/termproxy`;
    return this.call<{ port: number; ticket: string; user: string; upid: string }>("POST", path, guest?.type === "qemu" ? { serial: "serial0" } : undefined);
  }

  /**
   * Starts a command in a VM through its guest agent and returns its pid to poll with agentExecStatus. Needs the agent
   * running in the guest and the privilege Proxmox asks for (VM.GuestAgent.Unrestricted; VM.Monitor on older versions).
   */
  agentExec(node: string, vmid: number, command: string[], inputData?: string) {
    return this.call<{ pid: number }>("POST", `/nodes/${seg(node)}/qemu/${seg(vmid)}/agent/exec`, { command, ...(inputData !== undefined ? { "input-data": inputData } : {}) });
  }

  agentExecStatus(node: string, vmid: number, pid: number) {
    return this.call<{ exited?: number | boolean; exitcode?: number; signal?: number; "out-data"?: string; "err-data"?: string; "out-truncated"?: number | boolean; "err-truncated"?: number | boolean }>("GET", `/nodes/${seg(node)}/qemu/${seg(vmid)}/agent/exec-status`, { pid });
  }

  /**
   * Opens a terminal on a guest and returns how to connect to it as this user: the wss address, the cookie to send and
   * the line that completes Proxmox's handshake. Used to run a command inside a container without any ssh.
   */
  async terminalTarget(node: string, guest: { type: GuestType; vmid: number }): Promise<{ url: string; headers: Record<string, string>; handshake: string }> {
    const tp = await this.termproxy(node, guest);
    const host = new URL(this.base).host;
    return { url: `wss://${host}${ProxmoxClient.consoleSocketPath(node, guest, tp.port, tp.ticket)}`, headers: { ...this.headers }, handshake: `${tp.user}:${tp.ticket}\n` };
  }

  /** Opens the node terminal proxy running one of Proxmox's own commands (`upgrade` runs the package upgrade in the terminal). */
  termproxyCommand(node: string, cmd: "upgrade") {
    return this.call<{ port: number; ticket: string; user: string; upid: string }>("POST", `/nodes/${seg(node)}/termproxy`, { cmd });
  }

  /** The vncwebsocket path (under /api2/json) that carries a termproxy session. */
  static consoleSocketPath(node: string, guest: { type: GuestType; vmid: number } | null, port: number, vncticket: string): string {
    const base = guest ? `/nodes/${seg(node)}/${guest.type}/${seg(guest.vmid)}` : `/nodes/${seg(node)}`;
    return `/api2/json${base}/vncwebsocket?port=${seg(port)}&vncticket=${seg(vncticket)}`;
  }

  /** Scheduled backup jobs (Datacenter → Backup). */
  backupJobs() {
    return this.call<BackupJob[]>("GET", "/cluster/backup");
  }

  createBackupJob(params: Record<string, string | number | boolean | undefined>) {
    return this.call<null>("POST", "/cluster/backup", params);
  }

  updateBackupJob(id: string, params: Record<string, string | number | boolean | undefined>) {
    return this.call<null>("PUT", `/cluster/backup/${seg(id)}`, params);
  }

  deleteBackupJob(id: string) {
    return this.call<null>("DELETE", `/cluster/backup/${seg(id)}`);
  }

  /** Backs up guests now. Returns the task id. */
  vzdump(node: string, params: Record<string, string | number | boolean | undefined>) {
    return this.call<string>("POST", `/nodes/${seg(node)}/vzdump`, params);
  }

  /** The node's network interfaces, plus the diff of changes written but not applied yet (Proxmox's "pending"). */
  async network(node: string): Promise<{ interfaces: NetworkInterface[]; changes: string | null }> {
    const r = await this.callFull<NetworkInterface[]>("GET", `/nodes/${seg(node)}/network`);
    return { interfaces: r.data ?? [], changes: typeof r.extra.changes === "string" && r.extra.changes ? r.extra.changes : null };
  }

  createInterface(node: string, params: Record<string, string | number | boolean | undefined>) {
    return this.call<null>("POST", `/nodes/${seg(node)}/network`, params);
  }

  updateInterface(node: string, iface: string, params: Record<string, string | number | boolean | undefined>) {
    return this.call<null>("PUT", `/nodes/${seg(node)}/network/${seg(iface)}`, params);
  }

  deleteInterface(node: string, iface: string) {
    return this.call<null>("DELETE", `/nodes/${seg(node)}/network/${seg(iface)}`);
  }

  /** Applies pending network changes (ifreload). Returns a task id. */
  applyNetwork(node: string) {
    return this.call<string>("PUT", `/nodes/${seg(node)}/network`);
  }

  revertNetwork(node: string) {
    return this.call<null>("DELETE", `/nodes/${seg(node)}/network`);
  }

  /** A guest's configuration (cores, memory, disks, network devices ...). */
  guestConfig(node: string, type: GuestType, vmid: number) {
    return this.call<Record<string, string | number>>("GET", `/nodes/${seg(node)}/${type}/${seg(vmid)}/config`);
  }

  /** Changes a guest's configuration. PUT is synchronous for both containers and VMs. */
  setGuestConfig(node: string, type: GuestType, vmid: number, params: Record<string, string | number | boolean | undefined>) {
    return this.call<string | null>("PUT", `/nodes/${seg(node)}/${type}/${seg(vmid)}/config`, params);
  }

  /** Grows a disk, e.g. size "+10G". Disks can't shrink. */
  resizeDisk(node: string, type: GuestType, vmid: number, disk: string, size: string) {
    return this.call<string | null>("PUT", `/nodes/${seg(node)}/${type}/${seg(vmid)}/resize`, { disk, size });
  }

  snapshots(node: string, type: GuestType, vmid: number) {
    return this.call<Snapshot[]>("GET", `/nodes/${seg(node)}/${type}/${seg(vmid)}/snapshot`);
  }

  createSnapshot(node: string, type: GuestType, vmid: number, name: string, description?: string, vmstate?: boolean) {
    return this.call<string>("POST", `/nodes/${seg(node)}/${type}/${seg(vmid)}/snapshot`, { snapname: name, description, vmstate: type === "qemu" ? vmstate : undefined });
  }

  rollbackSnapshot(node: string, type: GuestType, vmid: number, name: string) {
    return this.call<string>("POST", `/nodes/${seg(node)}/${type}/${seg(vmid)}/snapshot/${seg(name)}/rollback`);
  }

  deleteSnapshot(node: string, type: GuestType, vmid: number, name: string) {
    return this.call<string>("DELETE", `/nodes/${seg(node)}/${type}/${seg(vmid)}/snapshot/${seg(name)}`);
  }

  /** Clones a guest into a new one. Full clones copy every disk; linked clones need a template. */
  cloneGuest(node: string, type: GuestType, vmid: number, params: Record<string, string | number | boolean | undefined>) {
    return this.call<string>("POST", `/nodes/${seg(node)}/${type}/${seg(vmid)}/clone`, params);
  }

  /** Opens a VNC proxy for a VM's screen, for noVNC over vncwebsocket. With generate-password, VNC auth uses `password`. */
  vncproxy(node: string, vmid: number) {
    return this.call<{ port: number | string; ticket: string; user: string; upid: string; password?: string; cert?: string }>("POST", `/nodes/${seg(node)}/qemu/${seg(vmid)}/vncproxy`, { websocket: true, "generate-password": true });
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
