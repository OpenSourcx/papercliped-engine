import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { ProxmoxClient, ProxmoxError, type GuestType, type PowerAction, type RrdCf, type RrdTimeframe, type StreamTransport, type Transport } from "@papercliped-engine/proxmox-client";
import { createConsoleRelay, realConnect, type Connect } from "./console.ts";
import { SessionStore, type Session } from "./sessions.ts";

/**
 * The ePaperclip host service's HTTP handler.
 *
 * Integrated Access Control: users sign in with their Proxmox username and password (any realm: pam, pve, ldap ...),
 * through Proxmox's own login. Every request after that runs against Proxmox *as that user*, with their ticket, so
 * Proxmox's own permissions decide what each person can see and do. There is no separate user database to drift.
 *
 * The browser never sees a Proxmox ticket: it holds an opaque session cookie (HttpOnly, SameSite=Strict, Secure).
 * State-changing requests must also carry the X-EPC-Request header, which a cross-site form cannot send.
 */

export interface AppDeps {
  pve: { baseUrl: string; node: string; caPem?: string; transport?: Transport; streamTransport?: StreamTransport };
  /** How to reach Proxmox's console websockets; tests inject a fake. */
  connect?: Connect;
  /** Largest ISO or template upload accepted, in bytes. */
  maxUploadBytes?: number;
  sessions: SessionStore;
  staticDir: string | null;
  secureCookies: boolean;
  now?: () => number;
}

const COOKIE = "epc_session";
const MAX_BODY = 8 * 1024;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".md": "text/plain; charset=utf-8" };
const TIMEFRAMES = ["hour", "day", "week", "month", "year"];
const POWER = ["start", "shutdown", "stop", "reboot"];

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Counts failed logins per client address and per username; too many in 15 minutes locks that key for 15 minutes. */
class LoginLimiter {
  private readonly fails = new Map<string, { n: number; first: number }>();
  private readonly now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }
  blocked(keys: string[]) {
    const t = this.now();
    return keys.some((k) => {
      const f = this.fails.get(k);
      return f !== undefined && t - f.first < 15 * 60_000 && f.n >= 8;
    });
  }
  fail(keys: string[]) {
    const t = this.now();
    // Forget windows that have closed so a flood of usernames can't grow this without bound.
    if (this.fails.size > 10_000) for (const [k, f] of this.fails) if (t - f.first >= 15 * 60_000) this.fails.delete(k);
    for (const k of keys) {
      const f = this.fails.get(k);
      this.fails.set(k, !f || t - f.first >= 15 * 60_000 ? { n: 1, first: t } : { n: f.n + 1, first: f.first });
    }
  }
  clear(keys: string[]) {
    for (const k of keys) this.fails.delete(k);
  }
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function baseHeaders(res: ServerResponse, secure: boolean) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(self)");
  if (secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string | string[]> = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "json_only", "Send JSON");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "too_large", "Request body too large");
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, "bad_json", "Body must be a JSON object");
  }
}

/** "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst" -> "Debian 12 standard" */
export function templateName(volid: string): string {
  const file = volid.split("/").pop() ?? volid;
  const m = file.match(/^([a-z]+)-([\d.]+)-([a-z]+)?/i);
  if (!m) return file;
  const distro = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return [distro, m[2], m[3]].filter(Boolean).join(" ");
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

/** Validates a new-machine request strictly: every field is checked against a narrow pattern or range. */
export function parseMachineSpec(b: Record<string, unknown>): MachineSpec {
  const bad = (msg: string): never => {
    throw new HttpError(400, "bad_request", msg);
  };
  const int = (v: unknown, lo: number, hi: number, what: string) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : bad(`${what} must be between ${lo} and ${hi}`));
  const name = typeof b.name === "string" && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(b.name) ? b.name : bad("Use lowercase letters, digits and hyphens for the name");
  const template = typeof b.template === "string" && /^[\w.-]+:vztmpl\/[\w.+-]+$/.test(b.template) ? b.template : bad("Pick a container template");
  const storage = typeof b.storage === "string" && /^[\w.-]{1,64}$/.test(b.storage) ? b.storage : bad("Pick a storage for the disk");
  const pool = b.pool === undefined || b.pool === null ? undefined : typeof b.pool === "string" && /^[\w.-]{1,64}$/.test(b.pool) ? b.pool : bad("Unknown pool");
  const password = b.password === undefined || b.password === "" ? undefined : typeof b.password === "string" && b.password.length >= 8 && b.password.length <= 128 ? b.password : bad("The password needs 8 to 128 characters");
  const sshKey = b.sshKey === undefined || b.sshKey === "" ? undefined : typeof b.sshKey === "string" && /^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+( [^\n\r]{0,200})?$/.test(b.sshKey.trim()) ? b.sshKey.trim() : bad("That doesn't look like an SSH public key");
  return { name, template, storage, pool, password, sshKey, cores: int(b.cores, 1, 64, "Cores"), memoryMb: int(b.memoryMb, 256, 262144, "Memory"), diskGb: int(b.diskGb, 2, 4096, "Disk") };
}

const STORAGE_RE = /^[A-Za-z][\w.-]{0,63}$/;
const FILE_RE = { iso: /^\w[\w.+-]{0,200}\.(iso|img)$/i, vztmpl: /^\w[\w.+-]{0,200}\.tar\.(gz|xz|zst)$/ } as const;
const ALGOS = ["md5", "sha1", "sha224", "sha256", "sha384", "sha512"];
const CONTENT_KINDS = ["iso", "vztmpl", "backup", "images", "rootdir", "snippets", "import"];

export function storageId(v: unknown): string {
  if (typeof v !== "string" || !STORAGE_RE.test(v)) throw new HttpError(400, "bad_request", "Unknown storage");
  return v;
}

/** A volume id inside the given storage, e.g. local:iso/debian.iso. Never a path that climbs out. */
export function volumeId(v: unknown, storage: string): string {
  if (typeof v !== "string" || !v.startsWith(`${storage}:`) || v.length > 300 || v.includes("..") || !/^[\w.-]+:[\w./+-]+$/.test(v)) throw new HttpError(400, "bad_request", "Unknown file");
  return v;
}

export function fileName(v: unknown, content: "iso" | "vztmpl"): string {
  if (typeof v !== "string" || !FILE_RE[content].test(v)) throw new HttpError(400, "bad_request", content === "iso" ? "Use a file name ending in .iso or .img" : "Use a file name ending in .tar.gz, .tar.xz or .tar.zst");
  return v;
}

export function checksum(c: unknown, a: unknown): { checksum?: string; algorithm?: string } {
  if (c === undefined || c === null || c === "") return {};
  if (typeof c !== "string" || !/^[0-9a-fA-F]{32,128}$/.test(c.trim())) throw new HttpError(400, "bad_request", "The checksum should be hexadecimal");
  if (typeof a !== "string" || !ALGOS.includes(a)) throw new HttpError(400, "bad_request", "Pick a checksum algorithm");
  return { checksum: c.trim().toLowerCase(), algorithm: a };
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
  start: boolean;
}

export function parseVmSpec(b: Record<string, unknown>): VmSpec {
  const bad = (msg: string): never => {
    throw new HttpError(400, "bad_request", msg);
  };
  const int = (v: unknown, lo: number, hi: number, what: string) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : bad(`${what} must be between ${lo} and ${hi}`));
  const name = typeof b.name === "string" && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(b.name) ? b.name : bad("Use lowercase letters, digits and hyphens for the name");
  const ostype = b.ostype === "l26" || b.ostype === "win11" || b.ostype === "other" ? b.ostype : bad("Pick an operating system type");
  const storage = storageId(b.storage);
  const iso = b.iso === null || b.iso === undefined || b.iso === "" ? null : typeof b.iso === "string" && /^[\w.-]+:iso\/[\w.+-]+$/.test(b.iso) && !b.iso.includes("..") ? b.iso : bad("Pick an ISO image");
  const pool = b.pool === undefined || b.pool === null ? undefined : typeof b.pool === "string" && /^[\w.-]{1,64}$/.test(b.pool) ? b.pool : bad("Unknown pool");
  return { name, iso, ostype, storage, pool, start: b.start !== false, cores: int(b.cores, 1, 128, "Cores"), memoryMb: int(b.memoryMb, 512, 1048576, "Memory"), diskGb: int(b.diskGb, 4, 16384, "Disk") };
}

/** Proxmox create parameters for a VM, following the defaults Proxmox's own wizard picks for each OS type. */
export function vmParams(vmid: number, v: VmSpec): Record<string, string | number | boolean | undefined> {
  const win = v.ostype === "win11";
  return {
    vmid,
    name: v.name,
    ostype: v.ostype,
    cores: v.cores,
    sockets: 1,
    cpu: "x86-64-v2-AES",
    memory: v.memoryMb,
    scsihw: "virtio-scsi-single",
    // Windows installs without extra drivers on SATA and e1000e; everything else gets VirtIO.
    [win ? "sata0" : "scsi0"]: `${v.storage}:${v.diskGb}${win ? "" : ",iothread=1"}`,
    ide2: v.iso ? `${v.iso},media=cdrom` : "none,media=cdrom",
    net0: `${win ? "e1000e" : "virtio"},bridge=vmbr0,firewall=1`,
    boot: `order=${win ? "sata0" : "scsi0"};ide2;net0`,
    agent: "1",
    bios: win ? "ovmf" : undefined,
    machine: win ? "q35" : undefined,
    efidisk0: win ? `${v.storage}:1,efitype=4m,pre-enrolled-keys=1` : undefined,
    tpmstate0: win ? `${v.storage}:1,version=v2.0` : undefined,
    pool: v.pool,
    onboot: false,
    start: v.start,
    description: "Created from ePaperclip",
  };
}

export interface BackupJobSpec {
  schedule: string;
  storage: string;
  all: boolean;
  vmids: number[];
  mode: "snapshot" | "suspend" | "stop";
  compress: "zstd" | "lzo" | "gzip" | "0";
  keepLast: number;
  enabled: boolean;
  comment?: string;
}

const MODES = ["snapshot", "suspend", "stop"];
const COMPRESS = ["zstd", "lzo", "gzip", "0"];

function vmidList(v: unknown): number[] {
  if (!Array.isArray(v) || v.length > 500 || !v.every((x) => Number.isInteger(x) && x >= 100 && x <= 999_999_999)) throw new HttpError(400, "bad_request", "Pick the machines to back up");
  return v as number[];
}

/** A backup schedule, checked field by field. Proxmox validates the calendar expression itself. */
export function parseBackupJob(b: Record<string, unknown>): BackupJobSpec {
  const bad = (msg: string): never => {
    throw new HttpError(400, "bad_request", msg);
  };
  const schedule = typeof b.schedule === "string" && /^[\w :.,*\/~-]{1,64}$/.test(b.schedule.trim()) ? b.schedule.trim() : bad("Enter when it runs, like 21:00 or sat 02:00");
  const all = b.all === true;
  const vmids = all ? [] : vmidList(b.vmids);
  if (!all && vmids.length === 0) bad("Pick at least one machine, or back up all of them");
  const mode = MODES.includes(String(b.mode)) ? (b.mode as BackupJobSpec["mode"]) : bad("Unknown backup mode");
  const compress = COMPRESS.includes(String(b.compress ?? "zstd")) ? ((b.compress ?? "zstd") as BackupJobSpec["compress"]) : bad("Unknown compression");
  const keepLast = typeof b.keepLast === "number" && Number.isInteger(b.keepLast) && b.keepLast >= 1 && b.keepLast <= 1000 ? b.keepLast : bad("Keep between 1 and 1000 backups");
  const comment = b.comment === undefined || b.comment === "" ? undefined : typeof b.comment === "string" && b.comment.length <= 200 && !/[\r\n]/.test(b.comment) ? b.comment : bad("Keep the note to one line");
  return { schedule, storage: storageId(b.storage), all, vmids, mode, compress, keepLast, enabled: b.enabled !== false, comment };
}

export function backupJobParams(j: BackupJobSpec): Record<string, string | number | boolean | undefined> {
  return { schedule: j.schedule, storage: j.storage, all: j.all ? true : undefined, vmid: j.all ? undefined : j.vmids.join(","), mode: j.mode, compress: j.compress, enabled: j.enabled, "prune-backups": `keep-last=${j.keepLast}`, comment: j.comment, "notes-template": "{{guestname}}" };
}

/** "drive2:backup/vzdump-lxc-101-2025_10_10-21_00_02.tar.zst" -> { type: "lxc", vmid: 101 } */
export function backupOf(volid: string): { type: GuestType; vmid: number } | null {
  const m = volid.match(/:backup\/vzdump-(lxc|qemu|openvz)-(\d+)-/);
  if (!m) return null;
  return { type: m[1] === "qemu" ? "qemu" : "lxc", vmid: Number(m[2]) };
}

const str = (v: unknown, max = 256) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

export function createApp(d: AppDeps) {
  const now = d.now ?? Date.now;
  const limiter = new LoginLimiter(now);
  const pveOpts = { baseUrl: d.pve.baseUrl, caPem: d.pve.caPem, transport: d.pve.transport, streamTransport: d.pve.streamTransport };
  const maxUpload = d.maxUploadBytes ?? 64 * 1024 ** 3;
  const cookie = (id: string, maxAge: number) => `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${d.secureCookies ? "; Secure" : ""}`;

  const clientFor = async (s: Session): Promise<ProxmoxClient> => {
    if (d.sessions.needsRenewal(s)) {
      // Renew the Proxmox ticket by presenting the current one, as Proxmox's own UI does.
      const r = await ProxmoxClient.login(pveOpts, { username: s.username, password: s.ticket });
      if (r.needTfa || !r.csrf) throw new ProxmoxError("ticket renewal needs a new sign-in", 401);
      d.sessions.renew(s, r.ticket, r.csrf);
    }
    return new ProxmoxClient({ ...pveOpts, ticket: s.ticket, csrf: s.csrf });
  };

  const requireSession = (req: IncomingMessage): Session => {
    const s = d.sessions.get(cookieValue(req, COOKIE));
    if (!s) throw new HttpError(401, "signed_out", "Sign in with your Proxmox account");
    return s;
  };

  /** Mutations must come from our own pages: a custom header (cross-site forms can't add one) and a matching Origin. */
  const requireSameSite = (req: IncomingMessage) => {
    if (req.headers["x-epc-request"] !== "1") throw new HttpError(403, "csrf", "Missing request header");
    const origin = req.headers.origin;
    if (origin === undefined) return;
    let host: string | null = null;
    try {
      host = new URL(origin).host;
    } catch {
      host = null;
    }
    if (host !== req.headers.host) throw new HttpError(403, "csrf", "Cross-site request refused");
  };

  const asUser = async <T,>(req: IncomingMessage, res: ServerResponse, fn: (pve: ProxmoxClient, s: Session) => Promise<T>) => {
    const s = requireSession(req);
    try {
      return await fn(await clientFor(s), s);
    } catch (e) {
      if (e instanceof ProxmoxError && e.status === 401) {
        d.sessions.destroy(s.id);
        res.setHeader("Set-Cookie", cookie("", 0));
        throw new HttpError(401, "signed_out", "Your Proxmox session ended; sign in again");
      }
      if (e instanceof ProxmoxError && e.status === 403) throw new HttpError(403, "forbidden", "Your Proxmox account doesn't have permission for this");
      throw e;
    }
  };

  const signIn = (res: ServerResponse, username: string, ticket: string, csrf: string) => {
    const s = d.sessions.create(username, ticket, csrf);
    sendJson(res, 200, { user: { username } }, { "Set-Cookie": cookie(s.id, 12 * 3600) });
  };

  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = req.method ?? "GET";
    const path = url.pathname;
    const ip = req.socket.remoteAddress ?? "?";

    if (method === "GET" && path === "/api/health") return sendJson(res, 200, { ok: true });

    if (method === "GET" && path === "/api/realms") {
      const realms = await ProxmoxClient.realms(pveOpts);
      return sendJson(res, 200, { realms: realms.map((r) => ({ realm: r.realm, type: r.type, comment: r.comment ?? null, default: r.default === 1 })) });
    }

    if (method === "POST" && path === "/api/login") {
      requireSameSite(req);
      const b = await readJson(req);
      const username = str(b.username, 64);
      const password = str(b.password, 1024);
      const realm = b.realm === undefined ? undefined : str(b.realm, 32) ?? undefined;
      if (!username || !password) throw new HttpError(400, "bad_request", "Enter a username and password");
      const keys = [`ip:${ip}`, `user:${username.toLowerCase()}@${realm ?? ""}`];
      if (limiter.blocked(keys)) throw new HttpError(429, "too_many_attempts", "Too many failed sign-ins. Wait 15 minutes and try again.");
      try {
        const r = await ProxmoxClient.login(pveOpts, { username, password, realm });
        limiter.clear(keys);
        if (r.needTfa) {
          const p = d.sessions.startTfa(r.username, r.ticket);
          return sendJson(res, 200, { needTfa: true, challenge: p.id });
        }
        return signIn(res, r.username, r.ticket, r.csrf!);
      } catch (e) {
        if (e instanceof ProxmoxError && e.status === 401) {
          limiter.fail(keys);
          throw new HttpError(401, "bad_credentials", "Wrong username or password");
        }
        throw e;
      }
    }

    if (method === "POST" && path === "/api/login/tfa") {
      requireSameSite(req);
      const b = await readJson(req);
      const p = d.sessions.getTfa(str(b.challenge, 128) ?? undefined);
      if (!p) throw new HttpError(401, "tfa_expired", "That sign-in expired. Start again.");
      const kind = b.kind === "recovery" ? "recovery" : "totp";
      const code = str(b.code, 128);
      if (!code || (kind === "totp" && !/^\d{6,8}$/.test(code))) throw new HttpError(400, "bad_code", "Enter the code from your authenticator app");
      p.attempts++;
      try {
        const r = await ProxmoxClient.login(pveOpts, { username: p.username, password: `${kind}:${code}`, tfaChallenge: p.challenge });
        if (r.needTfa || !r.csrf) throw new HttpError(401, "bad_code", "That code didn't work");
        d.sessions.endTfa(p.id);
        return signIn(res, r.username, r.ticket, r.csrf);
      } catch (e) {
        if (e instanceof ProxmoxError && e.status === 401) throw new HttpError(401, "bad_code", "That code didn't work");
        throw e;
      }
    }

    if (method === "POST" && path === "/api/logout") {
      requireSameSite(req);
      d.sessions.destroy(cookieValue(req, COOKIE));
      return sendJson(res, 200, { ok: true }, { "Set-Cookie": cookie("", 0) });
    }

    if (method === "GET" && path === "/api/me") {
      const s = requireSession(req);
      const [name, realm] = s.username.split("@");
      return sendJson(res, 200, { user: { username: s.username, name, realm, node: d.pve.node } });
    }

    if (method === "GET" && path === "/api/host") {
      const data = await asUser(req, res, async (pve) => {
        const [version, resources, status, storage] = await Promise.all([
          pve.version(),
          pve.clusterResources(),
          // Node status needs Sys.Audit; users without it still get their guests.
          pve.nodeStatus(d.pve.node).catch((e) => (e instanceof ProxmoxError && e.status === 403 ? null : Promise.reject(e))),
          // Storage lists only what the user may audit (Datastore.Audit); none is fine.
          pve.clusterStorage().catch((e) => (e instanceof ProxmoxError && e.status === 403 ? [] : Promise.reject(e))),
        ]);
        return {
          node: d.pve.node,
          version: version.version,
          status,
          resources: resources.filter((r) => r.type === "lxc" || r.type === "qemu"),
          storage: storage.filter((r) => r.type === "storage" && (r.node === d.pve.node || r.shared === 1)).map((r) => ({ storage: r.storage, plugintype: r.plugintype ?? null, content: r.content ?? "", status: r.status ?? "unknown", used: r.disk ?? 0, total: r.maxdisk ?? 0, shared: r.shared === 1 })),
        };
      });
      return sendJson(res, 200, data);
    }

    const stats = path.match(/^\/api\/stats\/(node|guests\/(\d+))$/);
    if (method === "GET" && stats) {
      const timeframe = url.searchParams.get("timeframe") ?? "hour";
      const cf = url.searchParams.get("cf") ?? "AVERAGE";
      if (!TIMEFRAMES.includes(timeframe) || (cf !== "AVERAGE" && cf !== "MAX")) throw new HttpError(400, "bad_request", "Unknown timeframe or consolidation");
      const points = await asUser(req, res, async (pve) => {
        if (stats[1] === "node") return pve.nodeRrd(d.pve.node, timeframe as RrdTimeframe, cf as RrdCf);
        const vmid = Number(stats[2]);
        const g = (await pve.clusterResources()).find((r) => r.vmid === vmid);
        if (!g || (g.type !== "lxc" && g.type !== "qemu")) throw new HttpError(404, "not_found", "Unknown machine");
        return pve.guestRrd(g.node ?? d.pve.node, g.type as GuestType, vmid, timeframe as RrdTimeframe, cf as RrdCf);
      });
      return sendJson(res, 200, { points });
    }

    if (method === "GET" && path === "/api/machines/options") {
      const data = await asUser(req, res, async (pve) => {
        const node = d.pve.node;
        const [tplStores, diskStores, isoStores, imageStores, pools, nextid] = await Promise.all([
          pve.nodeStorages(node, "vztmpl"),
          pve.nodeStorages(node, "rootdir"),
          pve.nodeStorages(node, "iso"),
          pve.nodeStorages(node, "images"),
          pve.pools().catch(() => []),
          pve.nextId(),
        ]);
        const active = <T extends { active?: number }>(l: T[]) => l.filter((s) => s.active !== 0);
        const templates = (await Promise.all(active(tplStores).map((s) => pve.storageContent(node, s.storage, "vztmpl").catch(() => [])))).flat();
        const isos = (await Promise.all(active(isoStores).map((s) => pve.storageContent(node, s.storage, "iso").catch(() => [])))).flat();
        const disk = (l: typeof diskStores) => active(l).map((s) => ({ storage: s.storage, type: s.type, avail: s.avail ?? null }));
        return {
          nextid,
          templates: templates.map((t) => ({ volid: t.volid, name: templateName(t.volid), size: t.size ?? null })),
          isos: isos.map((t) => ({ volid: t.volid, name: t.volid.split("/").pop() ?? t.volid, size: t.size ?? null })),
          storages: disk(diskStores),
          vmStorages: disk(imageStores),
          pools: pools.map((p) => p.poolid),
        };
      });
      return sendJson(res, 200, data);
    }

    if (method === "POST" && path === "/api/machines") {
      requireSameSite(req);
      const spec = parseMachineSpec(await readJson(req));
      const created = await asUser(req, res, async (pve) => {
        const vmid = await pve.nextId();
        // An unprivileged container on the default bridge with DHCP, started once created. Proxmox checks this user's
        // VM.Allocate, Datastore.AllocateSpace and pool permissions; nothing here widens them.
        const upid = await pve.createLxc(d.pve.node, {
          vmid,
          hostname: spec.name,
          ostemplate: spec.template,
          cores: spec.cores,
          memory: spec.memoryMb,
          swap: 512,
          rootfs: `${spec.storage}:${spec.diskGb}`,
          net0: "name=eth0,bridge=vmbr0,ip=dhcp",
          unprivileged: true,
          onboot: false,
          start: true,
          pool: spec.pool,
          password: spec.password,
          "ssh-public-keys": spec.sshKey,
          description: "Created from ePaperclip",
        });
        return { vmid, task: upid };
      });
      return sendJson(res, 202, created);
    }

    const content = path.match(/^\/api\/storage\/([^/]+)\/content$/);
    if (method === "GET" && content) {
      const storage = storageId(decodeURIComponent(content[1]));
      const kind = url.searchParams.get("content") ?? undefined;
      if (kind !== undefined && !CONTENT_KINDS.includes(kind)) throw new HttpError(400, "bad_request", "Unknown content type");
      const items = await asUser(req, res, (pve) => pve.storageContentAll(d.pve.node, storage, kind));
      return sendJson(res, 200, { items: items.map((i) => ({ volid: i.volid, content: i.content, format: i.format ?? null, size: i.size ?? null, ctime: i.ctime ?? null, vmid: i.vmid ?? null, notes: i.notes ?? null, protected: i.protected === 1 })) });
    }

    const del = path.match(/^\/api\/storage\/([^/]+)\/delete$/);
    if (method === "POST" && del) {
      requireSameSite(req);
      const storage = storageId(decodeURIComponent(del[1]));
      const volid = volumeId((await readJson(req)).volid, storage);
      const task = await asUser(req, res, (pve) => pve.deleteVolume(d.pve.node, storage, volid));
      return sendJson(res, 202, { task: task ?? null });
    }

    if (method === "GET" && path === "/api/templates/catalog") {
      const list = await asUser(req, res, (pve) => pve.templateCatalog(d.pve.node));
      return sendJson(res, 200, { templates: list.map((t) => ({ template: t.template, headline: t.headline ?? null, description: t.description ?? null, os: t.os ?? null, version: t.version ?? null, section: t.section ?? null, infopage: t.infopage ?? null })) });
    }

    if (method === "POST" && path === "/api/templates/download") {
      requireSameSite(req);
      const b = await readJson(req);
      const storage = storageId(b.storage);
      const template = fileName(b.template, "vztmpl");
      const task = await asUser(req, res, (pve) => pve.downloadTemplate(d.pve.node, storage, template));
      return sendJson(res, 202, { task });
    }

    const dl = path.match(/^\/api\/storage\/([^/]+)\/download-url$/);
    if (method === "POST" && dl) {
      requireSameSite(req);
      const storage = storageId(decodeURIComponent(dl[1]));
      const b = await readJson(req);
      const kind = b.content === "vztmpl" ? "vztmpl" : b.content === "iso" ? "iso" : null;
      if (!kind) throw new HttpError(400, "bad_request", "Choose ISO image or container template");
      let target: URL;
      try {
        target = new URL(String(b.url));
      } catch {
        throw new HttpError(400, "bad_request", "Enter a full http(s) address");
      }
      if ((target.protocol !== "https:" && target.protocol !== "http:") || String(b.url).length > 2048) throw new HttpError(400, "bad_request", "Enter a full http(s) address");
      const filename = fileName(b.filename, kind);
      const sum = checksum(b.checksum, b.algorithm);
      const task = await asUser(req, res, (pve) => pve.downloadUrl(d.pve.node, storage, { url: target.href, content: kind, filename, ...sum, verifyCertificates: b.verifyCertificates !== false }));
      return sendJson(res, 202, { task });
    }

    const up = path.match(/^\/api\/storage\/([^/]+)\/upload$/);
    if (method === "POST" && up) {
      requireSameSite(req);
      const storage = storageId(decodeURIComponent(up[1]));
      const kind = url.searchParams.get("content") === "vztmpl" ? "vztmpl" : url.searchParams.get("content") === "iso" ? "iso" : null;
      if (!kind) throw new HttpError(400, "bad_request", "Choose ISO image or container template");
      const filename = fileName(url.searchParams.get("filename"), kind);
      const sum = checksum(url.searchParams.get("checksum") || undefined, url.searchParams.get("algorithm"));
      if (req.headers["content-type"] !== "application/octet-stream") throw new HttpError(415, "binary_only", "Send the file as application/octet-stream");
      const size = Number(req.headers["content-length"]);
      if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(411, "length_required", "The upload needs a Content-Length");
      if (size > maxUpload) throw new HttpError(413, "too_large", `Uploads are limited to ${Math.floor(maxUpload / 1024 ** 3)} GiB`);
      // Stream straight through to Proxmox; stop if the browser sends more or less than it announced.
      async function* exact() {
        let seen = 0;
        for await (const chunk of req) {
          seen += (chunk as Buffer).length;
          if (seen > size) throw new HttpError(400, "bad_length", "The upload was larger than announced");
          yield chunk as Buffer;
        }
        if (seen !== size) throw new HttpError(400, "bad_length", "The upload ended early");
      }
      const task = await asUser(req, res, (pve) => pve.upload(d.pve.node, storage, { content: kind, filename, size, file: exact(), ...sum }));
      return sendJson(res, 202, { task });
    }

    if (method === "GET" && path === "/api/tasks") {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
      const list = await asUser(req, res, (pve) => pve.tasks(d.pve.node, limit));
      return sendJson(res, 200, { tasks: list.map((t) => ({ upid: t.upid, type: t.type, id: t.id ?? null, user: t.user, status: t.status ?? null, start: t.starttime, end: t.endtime ?? null })) });
    }

    const task = path.match(/^\/api\/tasks\/([^/]+)$/);
    if (method === "GET" && task) {
      const upid = decodeURIComponent(task[1]);
      // UPID:node:pid:pstart:starttime:type:id:user: — the id can hold a volume id with ":" and "/", so only the fixed
      // fields are pinned. It is URL-encoded on the way to Proxmox, and must name this node.
      if (!/^UPID:[\w.-]+:[0-9A-Fa-f]+:[0-9A-Fa-f]+:[0-9A-Fa-f]+:\w+:\S*$/.test(upid) || upid.length > 400 || upid.split(":")[1] !== d.pve.node) throw new HttpError(400, "bad_request", "Unknown task");
      const [status, log] = await asUser(req, res, (pve) => Promise.all([pve.taskStatus(d.pve.node, upid), pve.taskLog(d.pve.node, upid, Math.min(2000, Number(url.searchParams.get("lines") ?? 500) || 500))]));
      return sendJson(res, 200, { status: status.status, exitstatus: (status as { exitstatus?: string }).exitstatus ?? null, log: log.map((l) => l.t) });
    }

    if (method === "POST" && path === "/api/vms") {
      requireSameSite(req);
      const spec = parseVmSpec(await readJson(req));
      const created = await asUser(req, res, async (pve) => {
        const vmid = await pve.nextId();
        return { vmid, task: await pve.createVm(d.pve.node, vmParams(vmid, spec)) };
      });
      return sendJson(res, 202, created);
    }

    if (method === "GET" && path === "/api/backups/jobs") {
      const jobs = await asUser(req, res, (pve) => pve.backupJobs());
      const keep = (p: unknown) => {
        const v = typeof p === "string" ? p.match(/keep-last=(\d+)/)?.[1] : p && typeof p === "object" ? (p as Record<string, number>)["keep-last"] : undefined;
        return v ? Number(v) : null;
      };
      return sendJson(res, 200, {
        jobs: jobs.map((j) => ({ id: j.id, schedule: j.schedule ?? null, storage: j.storage ?? null, all: j.all === 1, vmids: (j.vmid ?? "").split(",").filter(Boolean).map(Number), pool: j.pool ?? null, mode: j.mode ?? "snapshot", compress: j.compress ?? null, enabled: j.enabled !== 0, keepLast: keep(j["prune-backups"]), comment: j.comment ?? null, nextRun: j["next-run"] ?? null })),
      });
    }

    if (method === "POST" && path === "/api/backups/jobs") {
      requireSameSite(req);
      const job = parseBackupJob(await readJson(req));
      await asUser(req, res, (pve) => pve.createBackupJob(backupJobParams(job)));
      return sendJson(res, 201, { ok: true });
    }

    const job = path.match(/^\/api\/backups\/jobs\/([\w-]{1,64})(\/delete)?$/);
    if (method === "POST" && job) {
      requireSameSite(req);
      const id = job[1];
      if (job[2]) {
        await asUser(req, res, (pve) => pve.deleteBackupJob(id));
        return sendJson(res, 200, { ok: true });
      }
      const b = await readJson(req);
      // Turning a job on or off is its own small change; anything else replaces the whole definition.
      if (Object.keys(b).length === 1 && typeof b.enabled === "boolean") {
        await asUser(req, res, (pve) => pve.updateBackupJob(id, { enabled: b.enabled as boolean }));
        return sendJson(res, 200, { ok: true });
      }
      const spec = parseBackupJob(b);
      const params = backupJobParams(spec);
      await asUser(req, res, (pve) => pve.updateBackupJob(id, { ...params, delete: spec.all ? "vmid" : "all" }));
      return sendJson(res, 200, { ok: true });
    }

    if (method === "POST" && path === "/api/backups/run") {
      requireSameSite(req);
      const b = await readJson(req);
      const all = b.all === true;
      const vmids = all ? [] : vmidList(b.vmids);
      if (!all && !vmids.length) throw new HttpError(400, "bad_request", "Pick the machines to back up");
      const mode = MODES.includes(String(b.mode ?? "snapshot")) ? String(b.mode ?? "snapshot") : null;
      if (!mode) throw new HttpError(400, "bad_request", "Unknown backup mode");
      const storage = storageId(b.storage);
      const notes = b.notes === undefined || b.notes === "" ? "{{guestname}}" : typeof b.notes === "string" && b.notes.length <= 200 && !/[\r\n]/.test(b.notes) ? b.notes : null;
      if (notes === null) throw new HttpError(400, "bad_request", "Keep the note to one line");
      const task = await asUser(req, res, (pve) => pve.vzdump(d.pve.node, { all: all ? true : undefined, vmid: all ? undefined : vmids.join(","), storage, mode, compress: "zstd", "notes-template": notes }));
      return sendJson(res, 202, { task });
    }

    if (method === "POST" && path === "/api/backups/restore") {
      requireSameSite(req);
      const b = await readJson(req);
      const from = storageId(b.from);
      const volid = volumeId(b.volid, from);
      const src = backupOf(volid);
      if (!src) throw new HttpError(400, "bad_request", "That isn't a machine backup");
      const target = storageId(b.storage);
      const replace = b.replace === true;
      const created = await asUser(req, res, async (pve) => {
        let vmid = src.vmid;
        if (replace) {
          // Replacing overwrites the original machine; Proxmox refuses while it runs, and so do we, clearly.
          const g = (await pve.clusterResources()).find((r) => r.vmid === vmid);
          if (g && g.status === "running") throw new HttpError(409, "running", "Stop the machine before restoring over it");
        } else {
          vmid = await pve.nextId();
        }
        const common = { vmid, storage: target, force: replace ? true : undefined, unique: replace ? undefined : true, start: b.start === true ? true : undefined };
        const task = src.type === "lxc" ? await pve.createLxc(d.pve.node, { ...common, ostemplate: volid, restore: true }) : await pve.createVm(d.pve.node, { ...common, archive: volid });
        return { vmid, task };
      });
      return sendJson(res, 202, created);
    }

    const power = path.match(/^\/api\/guests\/(\d+)\/power$/);
    if (method === "POST" && power) {
      requireSameSite(req);
      const b = await readJson(req);
      const action = String(b.action);
      if (!POWER.includes(action)) throw new HttpError(400, "bad_request", "Unknown action");
      const vmid = Number(power[1]);
      const upid = await asUser(req, res, async (pve) => {
        const g = (await pve.clusterResources()).find((r) => r.vmid === vmid);
        if (!g || (g.type !== "lxc" && g.type !== "qemu")) throw new HttpError(404, "not_found", "Unknown machine");
        // Proxmox checks VM.PowerMgmt for this user; ePaperclip adds nothing it could get wrong.
        return pve.guestPower(g.node ?? d.pve.node, g.type as GuestType, vmid, action as PowerAction);
      });
      return sendJson(res, 202, { task: upid });
    }

    throw new HttpError(404, "not_found", "Not found");
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!d.staticDir) return sendJson(res, 404, { error: "Console not installed", code: "no_console" });
    const root = resolve(d.staticDir);
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    } catch {
      return sendJson(res, 400, { error: "Bad path", code: "bad_path" });
    }
    let file = resolve(join(root, rel));
    if (file !== root && !file.startsWith(root + sep)) return sendJson(res, 404, { error: "Not found", code: "not_found" });
    let isFile = false;
    try {
      isFile = statSync(file).isFile();
    } catch {
      isFile = false;
    }
    // The console is a single-page app: unknown paths without an extension get index.html and route in the browser.
    if (!isFile) {
      if (extname(rel)) return sendJson(res, 404, { error: "Not found", code: "not_found" });
      file = join(root, "index.html");
    }
    const hashed = rel.startsWith("assets/");
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache" });
    if (req.method === "HEAD") return res.end();
    createReadStream(file).pipe(res);
  }

  // Live consoles: same session cookie, and the Origin must be this host (WebSockets get no CORS protection).
  const upgrade = createConsoleRelay({
    connect: d.connect ?? realConnect(d.pve.caPem),
    precheck: (req) => {
      const origin = req.headers.origin;
      let host: string | null = null;
      try {
        host = origin ? new URL(origin).host : null;
      } catch {
        host = null;
      }
      if (!host || host !== req.headers.host) return { status: 403, reason: "Forbidden" };
      if (!d.sessions.get(cookieValue(req, COOKIE))) return { status: 401, reason: "Unauthorized" };
      return null;
    },
    authorize: async (req, url) => {
      const s = d.sessions.get(cookieValue(req, COOKIE));
      if (!s) throw new Error("Your session ended. Sign in again.");
      try {
        const pve = await clientFor(s);
        const m = url.pathname.match(/^\/api\/console\/guests\/(\d+)$/);
        let guest: { type: GuestType; vmid: number } | null = null;
        let node = d.pve.node;
        if (m) {
          const g = (await pve.clusterResources()).find((r) => r.vmid === Number(m[1]));
          if (!g || (g.type !== "lxc" && g.type !== "qemu")) throw new Error("Unknown machine.");
          if (g.status !== "running") throw new Error("The machine isn't running. Start it to open its console.");
          guest = { type: g.type as GuestType, vmid: g.vmid! };
          node = g.node ?? node;
        }
        const tp = await pve.termproxy(node, guest);
        const base = new URL(d.pve.baseUrl);
        return {
          url: `wss://${base.host}${ProxmoxClient.consoleSocketPath(node, guest, tp.port, tp.ticket)}`,
          headers: { Cookie: `PVEAuthCookie=${encodeURIComponent(s.ticket)}` },
          handshake: `${tp.user}:${tp.ticket}\n`,
        };
      } catch (e) {
        if (e instanceof ProxmoxError && e.status === 403) throw new Error("Your Proxmox account doesn't have console access here (Sys.Console or VM.Console).");
        if (e instanceof ProxmoxError && e.status === 401) throw new Error("Your Proxmox session ended. Sign in again.");
        if (e instanceof ProxmoxError && e.detail && /serial/i.test(e.detail)) throw new Error("This VM has no serial port. Use its graphical console in Proxmox, or add a serial port (serial0: socket).");
        if (e instanceof ProxmoxError) throw new Error(e.detail ? `Proxmox: ${e.detail}` : "Proxmox couldn't open the console.");
        throw e;
      }
    },
  });

  const handle = async function handle(req: IncomingMessage, res: ServerResponse) {
    baseHeaders(res, d.secureCookies);
    const url = new URL(req.url ?? "/", "http://epaperclip");
    try {
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed", code: "method" });
      return serveStatic(req, res, url);
    } catch (e) {
      // A refused upload: answer and drop the connection instead of reading gigabytes nobody wants.
      if (!req.complete && !res.headersSent) res.setHeader("Connection", "close");
      if (res.headersSent) return void res.destroy();
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, code: e.code });
      // Proxmox's own reasons ("file exists", "checksum mismatch", "storage does not support content type") help the
      // user fix the request, and they could read them in Proxmox's UI anyway.
      if (e instanceof ProxmoxError && e.detail) return sendJson(res, e.status >= 400 && e.status < 500 ? 400 : 502, { error: e.detail.slice(0, 500), code: "proxmox_rejected" });
      if (e instanceof ProxmoxError) return sendJson(res, 502, { error: "Proxmox didn't answer as expected", code: "proxmox_error" });
      const net = (e as { code?: unknown })?.code;
      if (typeof net === "string" && /^E[A-Z]+|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(net)) return sendJson(res, 502, { error: `Can't reach Proxmox (${net})`, code: "proxmox_unreachable" });
      return sendJson(res, 500, { error: "Internal error", code: "internal" });
    }
  };
  return Object.assign(handle, { upgrade });
}
