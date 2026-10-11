import { request as httpsRequest } from "node:https";

/**
 * A minimal Proxmox VE API client: only the calls the broker needs.
 * Auth is an API token (`Authorization: PVEAPIToken=user@realm!tokenid=secret`); writes send form bodies, as the
 * Proxmox API expects. TLS is always verified; for the default self-signed setup pass the cluster CA
 * (`/etc/pve/pve-root-ca.pem`) as `caPem`. The node certificate lists the node's IPs, so hostname checks still pass.
 */

export type Transport = (req: { method: string; url: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; body: string }>;

export interface ProxmoxClientOptions {
  baseUrl: string; // e.g. https://192.168.1.200:8006
  tokenId: string; // user@realm!tokenname
  tokenSecret: string;
  caPem?: string;
  transport?: Transport;
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
}

export type GuestType = "lxc" | "qemu";
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

export class ProxmoxClient {
  private readonly base: string;
  private readonly auth: string;
  private readonly transport: Transport;

  constructor(opts: ProxmoxClientOptions) {
    const u = new URL(opts.baseUrl);
    if (u.protocol !== "https:") throw new Error("Proxmox URL must use https");
    this.base = `${u.origin}/api2/json`;
    this.auth = `PVEAPIToken=${opts.tokenId}=${opts.tokenSecret}`;
    this.transport = opts.transport ?? nodeTransport(opts.caPem);
  }

  async call<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
    const entries = Object.entries(params ?? {}).filter((e): e is [string, string | number | boolean] => e[1] !== undefined);
    const form = new URLSearchParams(entries.map(([k, v]): [string, string] => [k, typeof v === "boolean" ? (v ? "1" : "0") : String(v)])).toString();
    const withQuery = method === "GET" || method === "DELETE";
    const url = `${this.base}${path}${withQuery && form ? `?${form}` : ""}`;
    const headers: Record<string, string> = { Authorization: this.auth, Accept: "application/json" };
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
    return this.call<{ cpu: number; cpuinfo?: { cpus?: number; model?: string }; memory: { total: number; used: number; free: number } }>("GET", `/nodes/${seg(node)}/status`);
  }

  clusterResources() {
    return this.call<ClusterResource[]>("GET", "/cluster/resources", { type: "vm" });
  }

  /** Resolves when `vmid` is free cluster-wide; throws (400) when it is taken. */
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
