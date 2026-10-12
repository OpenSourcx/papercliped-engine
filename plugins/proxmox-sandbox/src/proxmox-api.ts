/**
 * The Proxmox VE API calls this provider needs, over an injectable HTTPS
 * transport.
 *
 * - Auth is an API token: `Authorization: PVEAPIToken=<user@realm!name>=<secret>`.
 *   Tokens need no CSRF token.
 * - Writes are `application/x-www-form-urlencoded` bodies sent with an exact
 *   Content-Length. Proxmox's web server (pveproxy) rejects chunked request
 *   bodies, which is what Node sends when a body has no declared length.
 * - TLS is verified against `caCert` when given (the cluster CA at
 *   /etc/pve/pve-root-ca.pem; node certificates list the node's IPs), against
 *   the system store otherwise, and only skipped when the operator explicitly
 *   set `allowInsecureTls`.
 */
import { request as httpsRequest } from "node:https";

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** PEM CA bundle to trust instead of the system store. */
  ca?: string;
  /** Skip certificate verification. Only set when the operator asked for it. */
  insecure: boolean;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  body: string;
}

export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

/** The real transport: node:https with an exact Content-Length on every body. */
export const nodeHttpsTransport: HttpTransport = (req) =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...req.headers };
    if (req.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(req.body, "utf8"));
    const request = httpsRequest(
      req.url,
      {
        method: req.method,
        headers,
        ca: req.ca,
        rejectUnauthorized: !req.insecure,
        timeout: req.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error(`Proxmox API request timed out after ${req.timeoutMs} ms`)));
    request.on("error", reject);
    if (req.body !== undefined) request.write(req.body, "utf8");
    request.end();
  });

export class ProxmoxApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly path: string;
  /** Proxmox's own explanation (its status reason and any per-field errors). */
  readonly detail: string;

  constructor(method: string, path: string, status: number, statusText: string, detail: string) {
    super(`Proxmox API ${method} ${path} failed (${status}${detail ? `: ${detail}` : statusText ? ` ${statusText}` : ""})`);
    this.name = "ProxmoxApiError";
    this.status = status;
    this.statusText = statusText;
    this.path = path;
    this.detail = detail;
  }

  /**
   * Whether the guest does not exist. Proxmox answers a missing container with
   * a 500 whose reason says the config file "does not exist", not with a 404.
   */
  get isNotFound(): boolean {
    return this.status === 404 || /does not exist|no such (vm|ct|container)|not found/i.test(`${this.statusText} ${this.detail}`);
  }
}

export class ProxmoxTaskError extends Error {
  readonly upid: string;
  readonly exitStatus: string;
  readonly logTail: string[];

  constructor(action: string, upid: string, exitStatus: string, logTail: string[]) {
    const tail = logTail.filter((line) => line.trim().length > 0 && line.trim() !== "TASK ERROR: " + exitStatus).slice(-5);
    super(`Proxmox task ${action} failed: ${exitStatus}${tail.length > 0 ? ` (log: ${tail.join(" | ")})` : ""}`);
    this.name = "ProxmoxTaskError";
    this.upid = upid;
    this.exitStatus = exitStatus;
    this.logTail = logTail;
  }
}

export type FormValue = string | number | boolean | null | undefined;
export type FormParams = Record<string, FormValue>;

export function encodeForm(params: FormParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.append(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  }
  return search.toString();
}

export interface ProxmoxClientOptions {
  apiUrl: string;
  tokenId: string;
  tokenSecret: string;
  caCert?: string | null;
  allowInsecureTls?: boolean;
  transport?: HttpTransport;
  requestTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface LxcStatus {
  status: string; // running | stopped
  vmid?: number | string;
  name?: string;
  lock?: string;
  template?: number;
}

export interface LxcInterface {
  name: string;
  hwaddr?: string;
  inet?: string;
  inet6?: string;
  "ip-addresses"?: Array<{ "ip-address"?: string; "ip-address-type"?: string; prefix?: number }>;
}

export interface TaskStatus {
  status: string; // running | stopped
  exitstatus?: string;
}

const seg = (value: string | number) => encodeURIComponent(String(value));
export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ProxmoxClient {
  private readonly base: string;
  private readonly auth: string;
  private readonly transport: HttpTransport;
  private readonly ca: string | undefined;
  private readonly insecure: boolean;
  private readonly requestTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ProxmoxClientOptions) {
    const url = new URL(options.apiUrl);
    if (url.protocol !== "https:") throw new Error("Proxmox apiUrl must use https.");
    this.base = `${url.origin}/api2/json`;
    this.auth = `PVEAPIToken=${options.tokenId}=${options.tokenSecret}`;
    this.transport = options.transport ?? nodeHttpsTransport;
    this.ca = options.caCert ?? undefined;
    // A configured CA always wins: never skip verification when we know what to trust.
    this.insecure = !this.ca && options.allowInsecureTls === true;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async request<T>(method: HttpRequest["method"], path: string, params: FormParams = {}): Promise<T> {
    const form = encodeForm(params);
    const hasBody = method === "POST" || method === "PUT";
    const url = `${this.base}${path}${!hasBody && form ? `?${form}` : ""}`;
    const headers: Record<string, string> = { Authorization: this.auth, Accept: "application/json" };
    if (hasBody) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const response = await this.transport({
      method,
      url,
      headers,
      body: hasBody ? form : undefined,
      timeoutMs: this.requestTimeoutMs,
      ca: this.ca,
      insecure: this.insecure,
    });
    let parsed: { data?: unknown; errors?: Record<string, string> | string; message?: string } | null = null;
    try {
      parsed = response.body ? JSON.parse(response.body) : null;
    } catch {
      parsed = null;
    }
    if (response.status < 200 || response.status >= 300) {
      const parts: string[] = [];
      if (response.statusText) parts.push(response.statusText.trim());
      if (parsed?.message && !parts.includes(parsed.message.trim())) parts.push(parsed.message.trim());
      if (parsed?.errors) {
        if (typeof parsed.errors === "string") parts.push(parsed.errors.trim());
        else for (const [field, message] of Object.entries(parsed.errors)) parts.push(`${field}: ${String(message).trim()}`);
      }
      throw new ProxmoxApiError(method, path, response.status, response.statusText, parts.join("; "));
    }
    return (parsed?.data ?? null) as T;
  }

  version() {
    return this.request<{ version: string; release?: string; repoid?: string }>("GET", "/version");
  }

  nodeStatus(node: string) {
    return this.request<Record<string, unknown>>("GET", `/nodes/${seg(node)}/status`);
  }

  async nextId(): Promise<number> {
    const value = await this.request<string | number>("GET", "/cluster/nextid");
    const vmid = Number(value);
    if (!Number.isInteger(vmid)) throw new Error(`Proxmox returned an invalid next vmid: ${String(value)}`);
    return vmid;
  }

  pool(poolid: string) {
    return this.request<{ members?: unknown[]; comment?: string }>("GET", `/pools/${seg(poolid)}`);
  }

  storageStatus(node: string, storage: string) {
    return this.request<{ active?: number | boolean; enabled?: number | boolean; content?: string; avail?: number }>(
      "GET",
      `/nodes/${seg(node)}/storage/${seg(storage)}/status`,
    );
  }

  storageVolume(node: string, storage: string, volid: string) {
    return this.request<{ format?: string; size?: number }>("GET", `/nodes/${seg(node)}/storage/${seg(storage)}/content/${seg(volid)}`);
  }

  lxcConfig(node: string, vmid: number) {
    return this.request<Record<string, unknown>>("GET", `/nodes/${seg(node)}/lxc/${vmid}/config`);
  }

  lxcStatus(node: string, vmid: number) {
    return this.request<LxcStatus>("GET", `/nodes/${seg(node)}/lxc/${vmid}/status/current`);
  }

  lxcInterfaces(node: string, vmid: number) {
    return this.request<LxcInterface[] | null>("GET", `/nodes/${seg(node)}/lxc/${vmid}/interfaces`);
  }

  cloneLxc(node: string, vmid: number, params: FormParams) {
    return this.request<string>("POST", `/nodes/${seg(node)}/lxc/${vmid}/clone`, params);
  }

  createLxc(node: string, params: FormParams) {
    return this.request<string>("POST", `/nodes/${seg(node)}/lxc`, params);
  }

  updateLxcConfig(node: string, vmid: number, params: FormParams) {
    return this.request<null>("PUT", `/nodes/${seg(node)}/lxc/${vmid}/config`, params);
  }

  resizeLxc(node: string, vmid: number, disk: string, size: string) {
    return this.request<string | null>("PUT", `/nodes/${seg(node)}/lxc/${vmid}/resize`, { disk, size });
  }

  lxcPower(node: string, vmid: number, action: "start" | "shutdown" | "stop", params: FormParams = {}) {
    return this.request<string>("POST", `/nodes/${seg(node)}/lxc/${vmid}/status/${action}`, params);
  }

  destroyLxc(node: string, vmid: number, params: FormParams) {
    return this.request<string>("DELETE", `/nodes/${seg(node)}/lxc/${vmid}`, params);
  }

  taskStatus(node: string, upid: string) {
    return this.request<TaskStatus>("GET", `/nodes/${seg(node)}/tasks/${seg(upid)}/status`);
  }

  async taskLogTail(node: string, upid: string, lines = 20): Promise<string[]> {
    try {
      const entries = await this.request<Array<{ n: number; t: string }>>("GET", `/nodes/${seg(node)}/tasks/${seg(upid)}/log`, {
        start: 0,
        limit: 500,
      });
      return (entries ?? []).map((entry) => entry.t).slice(-lines);
    } catch {
      return [];
    }
  }

  /**
   * Polls a task until it stops. Throws ProxmoxTaskError with Proxmox's exit
   * status and the end of the task log when it did not end with OK (or with
   * only warnings).
   */
  async waitForTask(node: string, upid: string, action: string, deadline: number): Promise<void> {
    let delay = 500;
    for (;;) {
      const status = await this.taskStatus(node, upid);
      if (status.status === "stopped") {
        const exit = status.exitstatus ?? "unknown";
        if (exit === "OK" || /^WARNINGS: \d+$/.test(exit)) return;
        throw new ProxmoxTaskError(action, upid, exit, await this.taskLogTail(node, upid));
      }
      if (Date.now() + delay > deadline) {
        throw new Error(`Timed out waiting for Proxmox task ${action} (${upid}).`);
      }
      await this.sleep(delay);
      delay = Math.min(delay * 2, 2_000);
    }
  }
}
