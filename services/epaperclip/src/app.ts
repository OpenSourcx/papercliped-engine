import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { extname, join, normalize, resolve, sep } from "node:path";
import { ProxmoxClient, ProxmoxError, nodeTransport, type GuestType, type PowerAction, type RrdCf, type RrdTimeframe, type StreamTransport, type Transport } from "@papercliped-engine/proxmox-client";
import { LIBRARY, isoEntries, pickLatest, type Latest } from "@papercliped-engine/os-library";
import { DEFAULT_INDEX_URL, MarketplaceError, verifyIndex, type Index, type TrustedKey } from "@papercliped-engine/marketplace";
import { fetchVendorText, type FetchText } from "./vendorFetch.ts";
import { createConsoleRelay, realConnect, type Connect } from "./console.ts";
import { FirewallInputError, GROUP, NAME, checkAlias, checkIpsetEntry, checkOptions, checkRule, consoleAllowed, consoleRule, ruleParams, type Level } from "./firewall.ts";
import { checkIface, checkMachineOptions, checkNic, isCidr4, isIpv4, ifaceParams, nextNicKey, nicString, normalizeConfig } from "./hardware.ts";
import { randomBytes } from "node:crypto";
import { FEATURES } from "./features/index.ts";
import { BearerAuth, appendAudit } from "./features/access-tokens.ts";
import { ConnectService, registerConnect } from "./features/connect-oauth.ts";
import { connectRoot, isConnectRoot } from "./features/connect.ts";
import { registerMarket } from "./features/connect-adapters.ts";
import { NodeScope } from "./features/clusterNode.ts";
import { Iac, validateSpec, type OrgRole } from "./iac.ts";
import { SessionStore, type Session } from "./sessions.ts";
import { HttpError, cookieValue, readJson, sendJson } from "./http.ts";
import { StateStore } from "./state.ts";
import { RoutineIngress } from "./routine-ingress.ts";
import { EngineGateway, type EngineStatus } from "./engine.ts";
import { Connectors, isProvider, type HttpFetch } from "./connectors.ts";
import { Pin, type PinToolHost } from "./pin.ts";
import { ConnectionsStore, registerConnections } from "./features/connect-connections.ts";
import { AgentContainers, parseSetup } from "./containers.ts";
import type { SshRunner } from "./containers-ssh.ts";

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
  /** How to read a vendor's checksum file; tests inject a fake. */
  fetchText?: FetchText;
  /** The Store's signed catalog: where it is published and which keys it may be signed by. No keys means no catalog. */
  marketplace?: { url?: string; keys: TrustedKey[] };
  /** The port this console is served on, kept reachable when the firewall is turned on. */
  consolePort?: number;
  /** How to reach Proxmox's console websockets; tests inject a fake. */
  connect?: Connect;
  /** Largest ISO or template upload accepted, in bytes. */
  maxUploadBytes?: number;
  sessions: SessionStore;
  staticDir: string | null;
  secureCookies: boolean;
  now?: () => number;
  /** The service's state and vault. Without one, state lives in memory for this run only. */
  state?: StateStore;
  /** Where the engine is. Without it, the engine routes answer 503 and no engine accounts are made. */
  engine?: { url: string; publicUrl?: string; installDir?: string; sleep?: (ms: number) => Promise<void>; extraAllowed?: RegExp[] };
  /** Outbound HTTP to model providers (connector tests, Pin); tests inject a fake. */
  fetch?: HttpFetch;
  /** Agent containers: where the built provider plugin is installed, and how ssh runs. Tests inject fakes. */
  containers?: { pluginDir?: string; ssh?: SshRunner; paceMs?: number };
  /** The address people reach this device at (EPC_PUBLIC_URL), used in OAuth metadata. Without it, the request's Host header is used. */
  publicUrl?: string;
}

const COOKIE_BASE = "epc_session";
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".md": "text/plain; charset=utf-8" };
const TIMEFRAMES = ["hour", "day", "week", "month", "year"];
const POWER = ["start", "shutdown", "stop", "reboot", "reset"];

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

/** One key per person however the name is typed: `sam` + realm `pve`, `sam@pve`, `SAM@PVE` all count against the same record. */
export function userKey(username: string, realm?: string): string {
  const at = username.lastIndexOf("@");
  const name = at >= 0 ? username.slice(0, at) : username;
  const r = at >= 0 ? username.slice(at + 1) : (realm ?? "");
  return `user:${name.toLowerCase()}@${r.toLowerCase()}`;
}

function baseHeaders(res: ServerResponse, secure: boolean) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(self)");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
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

/** The Proxmox side of an organization: a pool for its machines and the limits it should stay within. */
export interface ResourceGroup {
  name: string;
  pool: string;
  cores: number;
  memoryMb: number;
  diskGb: number;
  maxGuests: number;
  updatedAt: number;
  updatedBy: string;
}

export function parseResourceGroup(b: Record<string, unknown>): Pick<ResourceGroup, "name" | "cores" | "memoryMb" | "diskGb" | "maxGuests"> {
  const bad = (msg: string): never => {
    throw new HttpError(400, "bad_request", msg);
  };
  const int = (v: unknown, lo: number, hi: number, what: string) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : bad(`${what} must be between ${lo} and ${hi}`));
  const name = typeof b.name === "string" && b.name.trim().length > 0 && b.name.length <= 80 && !/[\u0000-\u001f\u007f]/.test(b.name) ? b.name.trim() : bad("Give the resource group a name of up to 80 characters");
  return { name, cores: int(b.cores, 1, 1024, "Cores"), memoryMb: int(b.memoryMb, 256, 16_777_216, "Memory"), diskGb: int(b.diskGb, 1, 1_048_576, "Disk"), maxGuests: int(b.maxGuests, 1, 1000, "Machines") };
}

/** "Northwind Labs" -> "northwind-labs", for the pool id epc-<slug>. */
export const poolSlug = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "") || "org";

/**
 * What a partial Proxmox ticket (the one that means "second factor still owed") says can be answered: an authenticator
 * code, recovery keys, a security key (with the options the browser needs). Unreadable means "ask for a code", the
 * long-standing default. Legacy U2F and Yubico OTP are listed so the console can say why they can't be answered here.
 */
export interface TfaMethods {
  totp: boolean;
  recovery: boolean;
  webauthn: Record<string, unknown> | null;
  unsupported: boolean;
}
export function tfaMethods(ticket: string): TfaMethods {
  const fallback: TfaMethods = { totp: true, recovery: true, webauthn: null, unsupported: false };
  try {
    const seg = ticket.split(":").find((x) => x.startsWith("!tfa!"));
    if (!seg) return fallback;
    const c = JSON.parse(decodeURIComponent(seg.slice(5))) as Record<string, unknown>;
    const has = (k: string) => c[k] !== undefined && c[k] !== false && c[k] !== null;
    const w = c.webauthn && typeof c.webauthn === "object" ? (c.webauthn as Record<string, unknown>) : null;
    const totp = has("totp");
    const recovery = has("recovery");
    return { totp, recovery, webauthn: w, unsupported: !totp && !recovery && !w && (has("u2f") || has("yubico")) };
  } catch {
    return fallback;
  }
}

export function createApp(d: AppDeps) {
  const now = d.now ?? Date.now;
  // Over HTTPS the session cookie carries the __Host- prefix: browsers then refuse to take it from a sibling domain or over
  // plain HTTP, and it can't be given a Domain, so nobody can plant their own session id in someone else's browser.
  const COOKIE = d.secureCookies ? `__Host-${COOKIE_BASE}` : COOKIE_BASE;
  const limiter = new LoginLimiter(now);
  const pveOpts = { baseUrl: d.pve.baseUrl, caPem: d.pve.caPem, transport: d.pve.transport, streamTransport: d.pve.streamTransport };
  const maxUpload = d.maxUploadBytes ?? 64 * 1024 ** 3;
  const cookie = (id: string, maxAge: number) => `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${d.secureCookies ? "; Secure" : ""}`;

  const clientFor = async (s: Session): Promise<ProxmoxClient> => {
    // An ePaperclip API token acts through its own Proxmox API token (no ticket to renew).
    if (s.apiToken) return new ProxmoxClient({ ...pveOpts, tokenId: s.apiToken.pveTokenId, tokenSecret: s.apiToken.pveSecret });
    if (d.sessions.needsRenewal(s)) {
      // Renew the Proxmox ticket by presenting the current one, as Proxmox's own UI does.
      const r = await ProxmoxClient.login(pveOpts, { username: s.username, password: s.ticket });
      if (r.needTfa || !r.csrf) throw new ProxmoxError("ticket renewal needs a new sign-in", 401);
      d.sessions.renew(s, r.ticket, r.csrf);
    }
    return new ProxmoxClient({ ...pveOpts, ticket: s.ticket, csrf: s.csrf });
  };

  const requireSession = (req: IncomingMessage): Session => {
    const t = bearer.principal(req);
    if (t) {
      bearer.guard(t, req);
      return t;
    }
    const s = d.sessions.get(cookieValue(req, COOKIE));
    if (!s) throw new HttpError(401, "signed_out", "Sign in with your Proxmox account");
    return s;
  };

  /** One line in the audit trail for a change made through the people routes; never breaks the request. */
  const audit = (req: IncomingMessage, action: string, target?: string, detail?: string) => {
    try {
      const s = requireSession(req);
      appendAudit(state, now, { actor: s.username, action, ip: req.socket.remoteAddress ?? "?", ...(target ? { target } : {}), ...(detail ? { detail } : {}) });
    } catch {
      /* the audit trail must never break a request */
    }
  };

  /** Mutations must come from our own pages: a custom header (cross-site forms can't add one) and a matching Origin. */
  const requireSameSite = (req: IncomingMessage) => {
    // A request that proved an API token has no browser; cookies are never accepted as tokens, nor tokens as cookies.
    const t = bearer.principal(req);
    if (t) return bearer.guard(t, req);
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
      if (e instanceof ProxmoxError && e.status === 401 && s.apiToken) {
        bearer.rejectedByProxmox(s, req);
        throw new HttpError(401, "token_invalid", "Proxmox no longer accepts this API token");
      }
      if (e instanceof ProxmoxError && e.status === 401) {
        d.sessions.destroy(s.id);
        res.setHeader("Set-Cookie", cookie("", 0));
        throw new HttpError(401, "signed_out", "Your Proxmox session ended; sign in again");
      }
      if (e instanceof ProxmoxError && e.status === 403) throw new HttpError(403, "forbidden", "Your Proxmox account doesn't have permission for this");
      throw e;
    }
  };

  // The node the console is managing in a cluster (X-EPC-Node); `hn(req)` is what host-level routes use instead of this device.
  const nodeScope = new NodeScope(d.pve.node, now);
  const hn = (req: IncomingMessage) => nodeScope.of(req);

  const state = d.state ?? new StateStore(null);
  const gateway = d.engine ? new EngineGateway({ ...d.engine, state, now }) : null;
  const bearer = new BearerAuth({ state, sessions: d.sessions, now, pve: (tokenId, tokenSecret) => new ProxmoxClient({ ...pveOpts, tokenId, tokenSecret }) });
  // The Papercliped bridge: OAuth for MCP apps and /mcp (docs/CONNECTORS.md). Read only apps get a Proxmox client that can only GET.
  const readOnlyTransport = (t: Transport): Transport => (r) => (r.method === "GET" ? t(r) : Promise.reject(new Error("read-only connection")));
  const connect = new ConnectService({
    state, now, secure: d.secureCookies, publicUrl: d.publicUrl, epoch: (u) => d.sessions.epoch(u),
    pve: (tokenId, tokenSecret, readOnly) => {
      const t = d.pve.transport ?? nodeTransport(d.pve.caPem);
      return new ProxmoxClient({ ...pveOpts, tokenId, tokenSecret, ...(readOnly ? { transport: readOnlyTransport(t), streamTransport: () => Promise.reject(new Error("read-only connection")) } : {}) });
    },
  });
  registerConnect(state, connect);
  const iac = new Iac({ gateway, state, sessions: d.sessions });
  const routineIngress = new RoutineIngress({ state, gateway, now });
  // OpenID Connect sign-in in flight: bound to the browser that started it by a short-lived cookie, used once.
  const OIDC_COOKIE = `${d.secureCookies ? "__Host-" : ""}epc_oidc`;
  const oidcPending = new Map<string, { state: string; realm: string; redirectUrl: string; exp: number }>();
  const oidcStarts = new Map<string, { n: number; start: number }>();
  const outbound: HttpFetch = d.fetch ?? ((u, init) => fetch(u, init));
  const connectors = new Connectors(state, outbound, now);
  const connections = new ConnectionsStore({ state, connectors, fetch: outbound, now });
  registerConnections(state, connections);
  const pin = new Pin({ state, connectors, fetch: outbound, now, extra: connections.forPin() });

  const containers = new AgentContainers({ gateway, state, node: d.pve.node, pveUrl: d.pve.baseUrl, caPem: d.pve.caPem, now, ssh: d.containers?.ssh, pluginDir: d.containers?.pluginDir, paceMs: d.containers?.paceMs, sleep: d.containers?.paceMs === 0 ? async () => {} : undefined });

  const needEngine = (): EngineGateway => {
    if (!gateway) throw new HttpError(503, "engine_unavailable", "The engine isn't set up on this host.");
    return gateway;
  };

  /** Administrators of this node, as Proxmox sees them: Sys.Modify on "/". */
  const isNodeAdmin = async (pve: ProxmoxClient): Promise<boolean> => {
    try {
      const p = await pve.call<Record<string, Record<string, number>>>("GET", "/access/permissions", { path: "/" });
      return p?.["/"]?.["Sys.Modify"] === 1;
    } catch (e) {
      if (e instanceof ProxmoxError && e.status === 403) return false;
      throw e;
    }
  };

  const signIn = (req: IncomingMessage, res: ServerResponse, username: string, ticket: string, csrf: string, via: "password" | "openid" = "password", extraCookies: string[] = []) => {
    const ua = req.headers["user-agent"];
    const s = d.sessions.create(username, ticket, csrf, { ip: req.socket.remoteAddress ?? undefined, agent: typeof ua === "string" ? ua : undefined, via });
    appendAudit(state, now, { actor: username, action: "session.sign-in", detail: via === "openid" ? "OpenID Connect" : "password", ip: req.socket.remoteAddress ?? "?" });
    sendJson(res, 200, { user: { username } }, { "Set-Cookie": [cookie(s.id, 12 * 3600), ...extraCookies] });
    // Open (or create) the person's engine account in the background; sign-in to the console never waits on the engine.
    // Proxmox node administrators administer the engine too (they can create organizations); checked on every sign-in.
    gateway
      ?.loginFor(s)
      .then(async () => gateway!.syncAdmin(s, await isNodeAdmin(await clientFor(s))))
      .catch((e: Error) => console.warn(`epaperclip: no engine session yet for ${username}: ${e.message}`));
  };

  /** The Store's signed catalog, fetched and checked at most once an hour. Shared by the Store route and the adapter installer. */
  const loadMarket = async (): Promise<{ enabled: boolean; index: Index | null; problem: { code: string; message: string } | null }> => {
      const keys = d.marketplace?.keys ?? [];
      if (!keys.length) return { enabled: false, index: null, problem: null };
      if (now() - marketCache.at >= 3600_000 || (!marketCache.index && !marketCache.problem)) {
        const url = d.marketplace?.url ?? DEFAULT_INDEX_URL;
        marketCache.at = now();
        try {
          const [body, sig] = await Promise.all([fetchText(url), fetchText(`${url}.sig`)]);
          const index = verifyIndex(Buffer.from(body, "utf8"), sig, { keys, now: now(), lastSequence: marketSequence < 0 ? undefined : marketSequence });
          if (index.sequence > marketSequence) {
            marketSequence = index.sequence;
            // Kept across restarts, so an older (still unexpired) signed copy can't be replayed after one.
            try {
              state.setSetting("marketplace.sequence", marketSequence);
            } catch {
              /* the in-memory floor still holds */
            }
          }
          marketCache.index = index;
          marketCache.problem = null;
        } catch (e) {
          marketCache.problem = e instanceof MarketplaceError ? { code: e.code, message: e.message } : { code: "unreachable", message: `Couldn't read the catalog (${(e as Error).message}).` };
          // A catalog that failed its checks is never shown; one that merely couldn't be fetched keeps the last good copy.
          if (e instanceof MarketplaceError) marketCache.index = null;
        }
      }
    return { enabled: true, index: marketCache.index, problem: marketCache.problem };
  };
  registerMarket(state, loadMarket, outbound);

  const featureCtx = (req: IncomingMessage, res: ServerResponse, url: URL) => ({
    req, res, url, method: req.method ?? "GET", path: url.pathname,
    node: d.pve.node,
    state,
    gateway,
    sessions: d.sessions,
    iac,
    cookieSessionId: () => (bearer.principal(req) ? undefined : d.sessions.get(cookieValue(req, COOKIE))?.id),
    session: () => requireSession(req),
    asUser: <T,>(fn: (pve: ProxmoxClient, s: Session) => Promise<T>) => asUser(req, res, fn),
    sameSite: () => requireSameSite(req),
    isNodeAdmin,
    readJson: (max?: number) => readJson(req, max),
    json: (status: number, body: unknown, headers?: Record<string, string | string[]>) => sendJson(res, status, body, headers),
    now,
    HttpError,
  });

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
      const keys = [`ip:${ip}`, userKey(username, realm)];
      if (limiter.blocked(keys)) throw new HttpError(429, "too_many_attempts", "Too many failed sign-ins. Wait 15 minutes and try again.");
      try {
        const r = await ProxmoxClient.login(pveOpts, { username, password, realm });
        // A password that is right but still owes a second factor doesn't wipe the record: guessing codes counts too.
        if (!r.needTfa) limiter.clear(keys);
        if (r.needTfa) {
          const methods = tfaMethods(r.ticket);
          if (methods.unsupported) throw new HttpError(403, "tfa_unsupported", "This account's only second factor is a legacy U2F key or a Yubico OTP, which ePaperclip can't ask for. Add a security key (WebAuthn), an authenticator app or recovery keys from another session, or sign in with Proxmox's own page.");
          const p = d.sessions.startTfa(r.username, r.ticket);
          return sendJson(res, 200, { needTfa: true, challenge: p.id, methods: { totp: methods.totp, recovery: methods.recovery, webauthn: methods.webauthn } });
        }
        return signIn(req, res, r.username, r.ticket, r.csrf!);
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
      const kind = b.kind === "recovery" ? "recovery" : b.kind === "webauthn" ? "webauthn" : "totp";
      // A security key answers with the browser's signed response (JSON); the others with a short code.
      const code = kind === "webauthn" ? str(b.response, 16 * 1024) : str(b.code, 128);
      if (kind === "webauthn") {
        let ok = false;
        try {
          const v = JSON.parse(code ?? "") as { id?: unknown; type?: unknown };
          ok = typeof v.id === "string" && v.type === "public-key";
        } catch {
          ok = false;
        }
        if (!ok) throw new HttpError(400, "bad_code", "The security key's answer isn't valid. Try again.");
      } else if (!code || (kind === "totp" && !/^\d{6,8}$/.test(code))) throw new HttpError(400, "bad_code", "Enter the code from your authenticator app");
      // Wrong codes count against the person and the address across sign-ins, so starting over (password again) doesn't reset them.
      const keys = [`ip:${ip}`, userKey(p.username)];
      if (limiter.blocked(keys)) throw new HttpError(429, "too_many_attempts", "Too many failed sign-ins. Wait 15 minutes and try again.");
      p.attempts++;
      try {
        const r = await ProxmoxClient.login(pveOpts, { username: p.username, password: `${kind}:${code}`, tfaChallenge: p.challenge });
        if (r.needTfa || !r.csrf) {
          limiter.fail(keys);
          throw new HttpError(401, "bad_code", "That code didn't work");
        }
        d.sessions.endTfa(p.id);
        limiter.clear(keys);
        return signIn(req, res, r.username, r.ticket, r.csrf);
      } catch (e) {
        if (e instanceof ProxmoxError && e.status === 401) {
          limiter.fail(keys);
          throw new HttpError(401, "bad_code", "That code didn't work");
        }
        throw e;
      }
    }

    if (method === "POST" && path === "/api/login/openid/start") {
      requireSameSite(req);
      const b = await readJson(req);
      const realm = str(b.realm, 32);
      if (!realm || !/^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(realm)) throw new HttpError(400, "bad_request", "Pick a realm");
      const t = now();
      const hits = oidcStarts.get(ip);
      if (!hits || t - hits.start > 60_000) oidcStarts.set(ip, { n: 1, start: t });
      else if (++hits.n > 20) throw new HttpError(429, "too_many_attempts", "Too many sign-in attempts. Wait a minute.");
      if (oidcStarts.size > 5000) oidcStarts.clear();
      const known = (await ProxmoxClient.realms(pveOpts)).find((r) => r.realm === realm);
      if (!known || known.type !== "openid") throw new HttpError(400, "bad_request", "That realm doesn't sign in with OpenID Connect");
      // Where the provider sends the person back to: this site's own address, as Proxmox's own page does.
      const host = req.headers.host;
      if (!host || !/^[A-Za-z0-9.\-:[\]]{1,255}$/.test(host)) throw new HttpError(400, "bad_request", "Bad Host header");
      const redirectUrl = `${d.secureCookies ? "https" : "http"}://${host}`;
      let authUrl: string;
      try {
        authUrl = await ProxmoxClient.openidAuthUrl(pveOpts, { realm, redirectUrl });
      } catch (e) {
        if (e instanceof ProxmoxError && e.status >= 400 && e.status < 500) throw new HttpError(400, "openid_unavailable", `Proxmox couldn't start the sign-in: ${(e.detail ?? "check the realm's settings").slice(0, 200)}`);
        throw e;
      }
      const providerState = new URL(authUrl).searchParams.get("state");
      if (!providerState) throw new HttpError(502, "proxmox_error", "The identity provider's address has no state");
      const nonce = randomBytes(24).toString("base64url");
      for (const [k, v] of oidcPending) if (v.exp < t) oidcPending.delete(k);
      if (oidcPending.size > 1000) oidcPending.clear();
      oidcPending.set(nonce, { state: providerState, realm, redirectUrl, exp: t + 10 * 60_000 });
      return sendJson(res, 200, { url: authUrl }, { "Set-Cookie": `${OIDC_COOKIE}=${nonce}; Path=/; HttpOnly; SameSite=Strict; Max-Age=600${d.secureCookies ? "; Secure" : ""}` });
    }

    if (method === "POST" && path === "/api/login/openid/finish") {
      requireSameSite(req);
      const b = await readJson(req);
      const code = str(b.code, 2048);
      const st = str(b.state, 1024);
      const nonce = cookieValue(req, OIDC_COOKIE);
      const pending = nonce ? oidcPending.get(nonce) : undefined;
      const clear = `${OIDC_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${d.secureCookies ? "; Secure" : ""}`;
      if (nonce) oidcPending.delete(nonce); // Single use, whatever happens next.
      if (!code || !st || !pending || pending.exp < now() || pending.state !== st) throw new HttpError(401, "openid_expired", "That sign-in expired or didn't start here. Start again.");
      const keys = [`ip:${ip}`];
      if (limiter.blocked(keys)) throw new HttpError(429, "too_many_attempts", "Too many failed sign-ins. Wait 15 minutes and try again.");
      try {
        const r = await ProxmoxClient.openidLogin(pveOpts, { code, state: st, redirectUrl: pending.redirectUrl });
        limiter.clear(keys);
        return signIn(req, res, r.username, r.ticket, r.csrf!, "openid", [clear]);
      } catch (e) {
        if (e instanceof ProxmoxError && e.status >= 400 && e.status < 500) {
          limiter.fail(keys);
          throw new HttpError(401, "bad_credentials", "The identity provider's answer wasn't accepted. Start again.");
        }
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
      return sendJson(res, 200, { user: { username: s.username, name, realm, node: d.pve.node }, ...(s.apiToken ? { via: "token", readOnly: s.apiToken.readOnly } : {}) });
    }

    // ---- The engine, connectors and Pin.
    if (method === "GET" && path === "/api/engine/status") {
      requireSession(req);
      const status: EngineStatus = gateway ? await gateway.status() : { installed: false, reachable: false, ready: false, version: null, bootstrap: "pending", serviceAccount: "pending", error: "The engine isn't set up on this host." };
      return sendJson(res, 200, status);
    }

    if (method === "GET" && path === "/api/resource-groups") {
      const s = requireSession(req);
      const me = await needEngine().me(s);
      const member = new Set((me.memberships ?? []).filter((m) => m.status === "active").map((m) => m.companyId));
      const all = state.getSetting<Record<string, ResourceGroup>>("resourceGroups") ?? {};
      const groups = Object.entries(all).filter(([id]) => member.has(id)).map(([companyId, g]) => ({ companyId, ...g }));
      return sendJson(res, 200, { groups });
    }

    const rg = path.match(/^\/api\/resource-groups\/([A-Za-z0-9_-]{1,64})$/);
    if (rg && (method === "PUT" || method === "DELETE")) {
      requireSameSite(req);
      const s = requireSession(req);
      const companyId = rg[1];
      const spec = method === "PUT" ? parseResourceGroup(await readJson(req)) : null;
      // Organization limits are set by its owners and admins; Proxmox then decides whether this person may make the pool.
      const m = await needEngine().membership(s, companyId);
      if (!m) throw new HttpError(403, "not_member", "You aren't a member of that organization");
      if (m.role !== "owner" && m.role !== "admin") throw new HttpError(403, "forbidden", "Only the organization's owners and admins can change its resources");
      const all = state.getSetting<Record<string, ResourceGroup>>("resourceGroups") ?? {};
      const existing = all[companyId];
      if (spec) {
        const pool = await asUser(req, res, async (pve) => {
          if (existing) return existing.pool;
          const taken = new Set([...(await pve.pools().catch(() => [])).map((p) => p.poolid), ...Object.values(all).map((g) => g.pool)]);
          const base = `epc-${poolSlug(spec.name)}`;
          const free = [base, ...Array.from({ length: 8 }, (_, i) => `${base}-${i + 2}`)].find((p) => !taken.has(p));
          if (!free) throw new HttpError(409, "pool_taken", "Pick a more distinctive name; pools with this name already exist");
          await pve.call("POST", "/pools", { poolid: free, comment: `ePaperclip organization: ${spec.name}` });
          return free;
        });
        const group: ResourceGroup = { ...spec, pool, updatedAt: now(), updatedBy: s.username };
        state.setSetting("resourceGroups", { ...all, [companyId]: group });
        // A new pool: the organization's members get their roles on it in Proxmox (Integrated Access Control).
        const warnings = existing ? [] : await asUser(req, res, (pve) => iac.syncPool(pve, s, companyId)).catch((e: Error) => [e.message]);
        // Agent containers: the pool gets the sandbox token's rights and the organization's environment follows the new limits.
        warnings.push(...(await asUser(req, res, (pve) => containers.onResourceGroup(pve, companyId, (m, p, b) => needEngine().userJson(s, m, p, b))).catch((e: Error) => [e.message])));
        return sendJson(res, 200, { group: { companyId, ...group }, ...(warnings.length ? { warnings } : {}) });
      }
      if (!existing) throw new HttpError(404, "not_found", "That organization has no resource group");
      const poolRemoved = await asUser(req, res, async (pve) => {
        const info = await pve.call<{ members?: unknown[] }>("GET", `/pools/${encodeURIComponent(existing.pool)}`).catch((e) => (e instanceof ProxmoxError && e.status === 404 ? null : Promise.reject(e)));
        if (!info) return true;
        if ((info.members ?? []).length) return false;
        // Proxmox may refuse (no Pool.Allocate): the mapping still goes, the empty pool stays.
        return pve.call("DELETE", `/pools/${encodeURIComponent(existing.pool)}`).then(() => true, (e) => (e instanceof ProxmoxError && e.status === 403 ? false : Promise.reject(e)));
      });
      const rest = { ...all };
      delete rest[companyId];
      state.setSetting("resourceGroups", rest);
      return sendJson(res, 200, { ok: true, pool: existing.pool, poolRemoved });
    }

    // ---- Agent containers: agents run in unprivileged Proxmox containers, set up by a Proxmox administrator.
    if (method === "GET" && path === "/api/agent-containers") {
      requireSession(req);
      return sendJson(res, 200, await asUser(req, res, async (pve) => {
        const admin = await isNodeAdmin(pve);
        return containers.status(admin ? pve : null, admin);
      }));
    }
    if (method === "POST" && path === "/api/agent-containers/setup") {
      requireSameSite(req);
      const s = requireSession(req);
      const over = parseSetup(await readJson(req));
      const r = await asUser(req, res, async (pve) => {
        if (!(await isNodeAdmin(pve))) throw new HttpError(403, "forbidden", "Only Proxmox administrators (Sys.Modify on /) can set up agent containers");
        return containers.startSetup(() => clientFor(s), s.username, over, (m, p, b) => needEngine().userJson(s, m, p, b));
      });
      return sendJson(res, r.alreadyRunning ? 200 : 202, r);
    }
    const acJob = path.match(/^\/api\/agent-containers\/jobs\/([0-9a-f]{12})$/);
    if (method === "GET" && acJob) {
      requireSession(req);
      await asUser(req, res, async (pve) => {
        if (!(await isNodeAdmin(pve))) throw new HttpError(403, "forbidden", "Only Proxmox administrators can see agent containers jobs");
      });
      const j = containers.getJob(acJob[1]);
      if (!j) throw new HttpError(404, "not_found", "No such job");
      return sendJson(res, 200, j);
    }
    if (method === "DELETE" && path === "/api/agent-containers") {
      requireSameSite(req);
      const s = requireSession(req);
      const b = await readJson(req);
      const r = await asUser(req, res, async (pve) => {
        if (!(await isNodeAdmin(pve))) throw new HttpError(403, "forbidden", "Only Proxmox administrators (Sys.Modify on /) can remove agent containers");
        return containers.startTeardown(() => clientFor(s), s.username, b.confirm);
      });
      return sendJson(res, 202, r);
    }

    // ---- Integrated Access Control: people and permissions are Proxmox users and ACLs; the engine follows.
    if (method === "GET" && path === "/api/iac") {
      return sendJson(res, 200, await asUser(req, res, async (pve, s) => iac.overview(pve, s, await isNodeAdmin(pve))));
    }
    if (method === "POST" && path === "/api/iac/users") {
      requireSameSite(req);
      const spec = validateSpec(await readJson(req), true);
      const made = await asUser(req, res, async (pve, s) => iac.createUser(pve, s, await isNodeAdmin(pve), spec));
      audit(req, "user.create", made.userid, [spec.deviceRole ? `device role ${spec.deviceRole}` : "", spec.orgs?.length ? `${spec.orgs.length} organization${spec.orgs.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(", "));
      return sendJson(res, 200, made);
    }
    const iacUser = path.match(/^\/api\/iac\/users\/([^/]{3,100})(\/password)?$/);
    if (iacUser) {
      requireSameSite(req);
      const userid = decodeURIComponent(iacUser[1]);
      if (iacUser[2] && method === "PUT") {
        if (requireSession(req).apiToken) throw new HttpError(403, "ticket_only", "Changing a password needs a signed-in browser session; API tokens can't do it");
        const b = await readJson(req);
        await asUser(req, res, (pve) => iac.setPassword(pve, userid, b.password as string, b.confirmationPassword as string));
        audit(req, "password.reset", userid);
        // Whoever knew the old password (or held a session opened with it) is signed out; the person making the change stays.
        d.sessions.destroyUserExcept(userid, cookieValue(req, COOKIE));
        return sendJson(res, 200, { ok: true });
      }
      if (!iacUser[2] && method === "PUT") {
        const spec = validateSpec(await readJson(req), false);
        const done = await asUser(req, res, async (pve, s) => iac.updateUser(pve, s, await isNodeAdmin(pve), userid, spec));
        audit(req, "user.update", userid, Object.keys(spec).filter((k) => k !== "userid").join(", "));
        return sendJson(res, 200, done);
      }
      if (!iacUser[2] && method === "DELETE") {
        const done = await asUser(req, res, (pve, s) => iac.deleteUser(pve, s, userid));
        audit(req, "user.delete", userid);
        return sendJson(res, 200, done);
      }
    }
    const iacMember = path.match(/^\/api\/iac\/orgs\/([A-Za-z0-9_-]{1,64})\/members\/([^/]{3,100})$/);
    if (iacMember && (method === "PUT" || method === "DELETE")) {
      requireSameSite(req);
      const role = method === "PUT" ? ((await readJson(req)).role as OrgRole) : null;
      const userid = decodeURIComponent(iacMember[2]);
      await asUser(req, res, async (pve, s) => iac.setOrgRole(pve, s, await isNodeAdmin(pve), iacMember[1], userid, role));
      audit(req, "org-role.set", userid, `${iacMember[1]}: ${role ?? "removed"}`);
      return sendJson(res, 200, { ok: true });
    }
    if (method === "POST" && path === "/api/iac/groups") {
      requireSameSite(req);
      const b = await readJson(req);
      await asUser(req, res, (pve) => iac.createGroup(pve, String(b.groupid ?? ""), typeof b.comment === "string" ? b.comment : undefined));
      audit(req, "group.create", String(b.groupid ?? ""));
      return sendJson(res, 200, { ok: true });
    }
    const iacGroup = path.match(/^\/api\/iac\/groups\/([A-Za-z0-9._-]{1,64})$/);
    if (iacGroup && method === "DELETE") {
      requireSameSite(req);
      await asUser(req, res, (pve) => iac.deleteGroup(pve, iacGroup[1]));
      audit(req, "group.delete", iacGroup[1]);
      return sendJson(res, 200, { ok: true });
    }

    if (method === "GET" && path === "/api/connectors") {
      const canManage = await asUser(req, res, (pve) => isNodeAdmin(pve));
      // Connections added in Connectors (local models, other hosted providers) are offered to Pin beside the built-in four.
      const added = connections.forPin().usable().map((u) => ({ id: u.id, kind: "model" as const, label: u.label, configured: true }));
      return sendJson(res, 200, { connectors: [...connectors.list(), ...added], canManage });
    }

    const conn = path.match(/^\/api\/connectors\/([a-z]{1,32})\/(credential|test)$/);
    if (conn) {
      const id = conn[1];
      if (!isProvider(id)) throw new HttpError(404, "not_found", "Unknown connector");
      const allowed = conn[2] === "credential" ? method === "PUT" || method === "DELETE" : method === "POST";
      if (!allowed) throw new HttpError(405, "method", "Method not allowed");
      requireSameSite(req);
      const s = requireSession(req);
      const body = method === "PUT" ? await readJson(req) : null;
      if (!(await asUser(req, res, (pve) => isNodeAdmin(pve)))) throw new HttpError(403, "forbidden", "Only Proxmox administrators (Sys.Modify on /) can change connectors");
      if (method === "PUT") return sendJson(res, 200, { connector: connectors.setKey(id, body!.apiKey, s.username) });
      if (method === "DELETE") {
        connectors.remove(id);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 200, { connector: await connectors.test(id) });
    }

    if (path === "/api/pin/settings" && (method === "GET" || method === "PUT")) {
      if (method === "PUT") requireSameSite(req);
      const s = requireSession(req);
      if (method === "GET") return sendJson(res, 200, pin.settings(s.username));
      const body = await readJson(req);
      const before = pin.settings(s.username);
      const saved = pin.saveSettings(s.username, body);
      if (saved.permission !== before.permission) audit(req, "pin.permission", s.username, `${before.permission} to ${saved.permission}`);
      return sendJson(res, 200, saved);
    }

    if (method === "GET" && path === "/api/pin/models") {
      const s = requireSession(req);
      const provider = url.searchParams.get("provider") ?? pin.settings(s.username).provider;
      if (!provider || (!isProvider(provider) && !/^x:[a-z0-9][a-z0-9-]{0,31}$/.test(provider))) throw new HttpError(400, "bad_request", "Unknown provider");
      return sendJson(res, 200, { provider, models: await pin.models(provider) });
    }

    if (method === "POST" && path === "/api/pin/chat") {
      requireSameSite(req);
      const s = requireSession(req);
      const prepared = pin.prepare(s.username, await readJson(req, 512 * 1024));
      const release = pin.admit(s.username);
      const gone = new AbortController();
      res.on("close", () => !res.writableFinished && gone.abort());
      const host: PinToolHost = { node: d.pve.node, username: s.username, pve: () => clientFor(s), engine: <T,>(p: string) => needEngine().userJson<T>(s, "GET", p), enginePost: (p: string, body: unknown) => needEngine().userJson<{ id?: string; identifier?: string }>(s, "POST", p, body) };
      try {
        return await pin.chat(res, prepared, host, gone.signal);
      } finally {
        release();
      }
    }

    if (method === "GET" && path === "/api/host") {
      const data = await asUser(req, res, async (pve) => {
        const [version, resources, status, storage] = await Promise.all([
          pve.version(),
          pve.clusterResources(),
          // Node status needs Sys.Audit; users without it still get their guests.
          pve.nodeStatus(hn(req)).catch((e) => (e instanceof ProxmoxError && e.status === 403 ? null : Promise.reject(e))),
          // Storage lists only what the user may audit (Datastore.Audit); none is fine.
          pve.clusterStorage().catch((e) => (e instanceof ProxmoxError && e.status === 403 ? [] : Promise.reject(e))),
        ]);
        return {
          node: hn(req),
          version: version.version,
          status,
          resources: resources.filter((r) => r.type === "lxc" || r.type === "qemu"),
          storage: storage.filter((r) => r.type === "storage" && (r.node === hn(req) || r.shared === 1)).map((r) => ({ storage: r.storage, plugintype: r.plugintype ?? null, content: r.content ?? "", status: r.status ?? "unknown", used: r.disk ?? 0, total: r.maxdisk ?? 0, shared: r.shared === 1 })),
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
        if (stats[1] === "node") return pve.nodeRrd(hn(req), timeframe as RrdTimeframe, cf as RrdCf);
        const vmid = Number(stats[2]);
        const g = (await pve.clusterResources()).find((r) => r.vmid === vmid);
        if (!g || (g.type !== "lxc" && g.type !== "qemu")) throw new HttpError(404, "not_found", "Unknown machine");
        return pve.guestRrd(g.node ?? d.pve.node, g.type as GuestType, vmid, timeframe as RrdTimeframe, cf as RrdCf);
      });
      return sendJson(res, 200, { points });
    }

    if (method === "GET" && path === "/api/machines/options") {
      const data = await asUser(req, res, async (pve) => {
        const node = hn(req);
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
        const upid = await pve.createLxc(hn(req), {
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
      const items = await asUser(req, res, (pve) => pve.storageContentAll(hn(req), storage, kind));
      return sendJson(res, 200, { items: items.map((i) => ({ volid: i.volid, content: i.content, format: i.format ?? null, size: i.size ?? null, ctime: i.ctime ?? null, vmid: i.vmid ?? null, notes: i.notes ?? null, protected: i.protected === 1 })) });
    }

    const del = path.match(/^\/api\/storage\/([^/]+)\/delete$/);
    if (method === "POST" && del) {
      requireSameSite(req);
      const storage = storageId(decodeURIComponent(del[1]));
      const volid = volumeId((await readJson(req)).volid, storage);
      const task = await asUser(req, res, (pve) => pve.deleteVolume(hn(req), storage, volid));
      return sendJson(res, 202, { task: task ?? null });
    }

    if (method === "GET" && path === "/api/templates/catalog") {
      const list = await asUser(req, res, (pve) => pve.templateCatalog(hn(req)));
      return sendJson(res, 200, { templates: list.map((t) => ({ template: t.template, headline: t.headline ?? null, description: t.description ?? null, os: t.os ?? null, version: t.version ?? null, section: t.section ?? null, infopage: t.infopage ?? null })) });
    }

    if (method === "POST" && path === "/api/templates/download") {
      requireSameSite(req);
      const b = await readJson(req);
      const storage = storageId(b.storage);
      const template = fileName(b.template, "vztmpl");
      const task = await asUser(req, res, (pve) => pve.downloadTemplate(hn(req), storage, template));
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
      const task = await asUser(req, res, (pve) => pve.downloadUrl(hn(req), storage, { url: target.href, content: kind, filename, ...sum, verifyCertificates: b.verifyCertificates !== false }));
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
      const task = await asUser(req, res, (pve) => pve.upload(hn(req), storage, { content: kind, filename, size, file: exact(), ...sum }));
      return sendJson(res, 202, { task });
    }

    if (method === "GET" && path === "/api/tasks") {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
      const vm = url.searchParams.get("vmid");
      if (vm !== null && !/^\d{1,9}$/.test(vm)) throw new HttpError(400, "bad_request", "Unknown machine");
      const list = await asUser(req, res, (pve) => pve.tasks(hn(req), limit, vm === null ? undefined : Number(vm)));
      return sendJson(res, 200, { tasks: list.map((t) => ({ upid: t.upid, type: t.type, id: t.id ?? null, user: t.user, status: t.status ?? null, start: t.starttime, end: t.endtime ?? null })) });
    }

    const task = path.match(/^\/api\/tasks\/([^/]+)$/);
    if (method === "GET" && task) {
      const upid = decodeURIComponent(task[1]);
      // UPID:node:pid:pstart:starttime:type:id:user: — the id can hold a volume id with ":" and "/", so only the fixed
      // fields are pinned. It is URL-encoded on the way to Proxmox, and must name this node.
      if (!/^UPID:[\w.-]+:[0-9A-Fa-f]+:[0-9A-Fa-f]+:[0-9A-Fa-f]+:[\w-]+:\S*$/.test(upid) || upid.length > 400 || upid.split(":")[1] !== hn(req)) throw new HttpError(400, "bad_request", "Unknown task");
      const [status, log] = await asUser(req, res, (pve) => Promise.all([pve.taskStatus(hn(req), upid), pve.taskLog(hn(req), upid, Math.min(2000, Number(url.searchParams.get("lines") ?? 500) || 500))]));
      return sendJson(res, 200, { status: status.status, exitstatus: (status as { exitstatus?: string }).exitstatus ?? null, log: log.map((l) => l.t) });
    }

    if (method === "POST" && path === "/api/vms") {
      requireSameSite(req);
      const spec = parseVmSpec(await readJson(req));
      const created = await asUser(req, res, async (pve) => {
        const vmid = await pve.nextId();
        return { vmid, task: await pve.createVm(hn(req), vmParams(vmid, spec)) };
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
      const task = await asUser(req, res, (pve) => pve.vzdump(hn(req), { all: all ? true : undefined, vmid: all ? undefined : vmids.join(","), storage, mode, compress: "zstd", "notes-template": notes }));
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
        const task = src.type === "lxc" ? await pve.createLxc(hn(req), { ...common, ostemplate: volid, restore: true }) : await pve.createVm(hn(req), { ...common, archive: volid });
        return { vmid, task };
      });
      return sendJson(res, 202, created);
    }

    // ---- Machines: hardware, snapshots, clones, graphical console. Proxmox checks every change against the user.
    const findGuest = async (pve: ProxmoxClient, vmid: number) => {
      const g = (await pve.clusterResources()).find((r) => r.vmid === vmid);
      if (!g || (g.type !== "lxc" && g.type !== "qemu")) throw new HttpError(404, "not_found", "Unknown machine");
      return { node: g.node ?? d.pve.node, type: g.type as GuestType, status: g.status ?? "unknown", template: g.template === 1, name: g.name ?? String(vmid) };
    };
    const guestRoute = path.match(/^\/api\/guests\/(\d+)\/(config|resize|destroy|template|nets|nets\/(net\d+)\/delete|snapshots|snapshots\/([A-Za-z][\w-]{0,39})\/(rollback|delete)|clone|vnc)$/);
    if (guestRoute) {
      const vmid = Number(guestRoute[1]);
      const what = guestRoute[2];
      if (method === "GET" && what === "config") {
        const hw = await asUser(req, res, async (pve) => {
          const g = await findGuest(pve, vmid);
          const cfg = await pve.guestConfig(g.node, g.type, vmid);
          const pending = g.type === "qemu" && g.status === "running" ? await pve.call<{ key: string; pending?: unknown; delete?: number }[]>("GET", `/nodes/${encodeURIComponent(g.node)}/qemu/${vmid}/pending`).then((l) => l.filter((x) => x.pending !== undefined || x.delete).map((x) => x.key), () => []) : [];
          return { ...normalizeConfig(g.type, cfg, pending), status: g.status, template: g.template };
        });
        return sendJson(res, 200, hw);
      }
      if (method === "GET" && what === "snapshots") {
        const list = await asUser(req, res, async (pve) => {
          const g = await findGuest(pve, vmid);
          return pve.snapshots(g.node, g.type, vmid);
        });
        const current = list.find((x) => x.name === "current");
        return sendJson(res, 200, { snapshots: list.filter((x) => x.name !== "current").map((x) => ({ name: x.name, description: x.description ?? "", time: x.snaptime ?? null, parent: x.parent ?? null, vmstate: x.vmstate === 1 })), current: current?.parent ?? null });
      }
      if (method !== "POST") throw new HttpError(405, "method", "Method not allowed");
      requireSameSite(req);
      const b = await readJson(req);

      if (what === "config") {
        // Only these settings, each range-checked. Proxmox decides whether this user may change them.
        const params: Record<string, string | number | boolean | undefined> = {};
        const int = (v: unknown, lo: number, hi: number, label: string) => {
          if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) throw new HttpError(400, "bad_request", `${label} must be between ${lo} and ${hi}`);
          return v as number;
        };
        if (b.cores !== undefined) params.cores = int(b.cores, 1, 512, "Cores");
        if (b.sockets !== undefined) params.sockets = int(b.sockets, 1, 16, "Sockets");
        if (b.memoryMb !== undefined) params.memory = int(b.memoryMb, 16, 4_194_304, "Memory");
        if (b.swapMb !== undefined) params.swap = int(b.swapMb, 0, 1_048_576, "Swap");
        if (b.onboot !== undefined) params.onboot = b.onboot === true;
        if (b.description !== undefined) {
          if (typeof b.description !== "string" || b.description.length > 8192) throw new HttpError(400, "bad_request", "Notes are limited to 8192 characters");
          params.description = b.description;
        }
        if (b.tags !== undefined) {
          if (!Array.isArray(b.tags) || b.tags.length > 20 || !b.tags.every((t) => typeof t === "string" && /^[a-z0-9][\w.+-]{0,63}$/i.test(t))) throw new HttpError(400, "bad_request", "Tags are letters, digits, - _ . +");
          params.tags = (b.tags as string[]).join(";");
        }
        if (b.name !== undefined) {
          if (typeof b.name !== "string" || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(b.name)) throw new HttpError(400, "bad_request", "Use lowercase letters, digits and hyphens for the name");
        }
        const optionKeys = ["protection", "startup", "boot", "agent", "ostype"].filter((k) => b[k] !== undefined);
        if (!Object.keys(params).length && b.name === undefined && !optionKeys.length) throw new HttpError(400, "bad_request", "Nothing to change");
        await asUser(req, res, async (pve) => {
          const g = await findGuest(pve, vmid);
          if (b.name !== undefined) params[g.type === "lxc" ? "hostname" : "name"] = b.name as string;
          if (optionKeys.length) {
            try {
              Object.assign(params, checkMachineOptions(g.type, await pve.guestConfig(g.node, g.type, vmid), b));
            } catch (e) {
              throw new HttpError(400, "bad_request", (e as Error).message);
            }
          }
          await pve.setGuestConfig(g.node, g.type, vmid, params);
        });
        return sendJson(res, 200, { ok: true });
      }

      if (what === "destroy" || what === "template") {
        // Irreversible, so the machine's name must be typed, and protected or running machines are refused up front.
        const task = await asUser(req, res, async (pve) => {
          const g = await findGuest(pve, vmid);
          if (b.confirm !== g.name) throw new HttpError(409, "confirm", `Type the machine's name (${g.name}) to confirm.`);
          if (g.status === "running") throw new HttpError(409, "running", `${g.name} is running. Shut it down first.`);
          const cfg = await pve.guestConfig(g.node, g.type, vmid);
          if (what === "destroy" && String(cfg.protection ?? "0") === "1") throw new HttpError(409, "protected", `${g.name} is protected. Turn protection off first.`);
          if (what === "template" && g.template) throw new HttpError(409, "template", `${g.name} is already a template.`);
          return what === "destroy" ? pve.destroyGuest(g.node, g.type, vmid) : pve.convertToTemplate(g.node, g.type, vmid);
        });
        return sendJson(res, 202, { task: task ?? null });
      }

      if (what === "resize") {
        const disk = typeof b.disk === "string" && /^(rootfs|mp\d+|scsi\d+|sata\d+|virtio\d+|ide\d+)$/.test(b.disk) ? b.disk : null;
        if (!disk) throw new HttpError(400, "bad_request", "Unknown disk");
        if (!Number.isInteger(b.growGb) || (b.growGb as number) < 1 || (b.growGb as number) > 65_536) throw new HttpError(400, "bad_request", "Grow by 1 GB or more");
        const task = await asUser(req, res, async (pve) => {
          const g = await findGuest(pve, vmid);
          return pve.resizeDisk(g.node, g.type, vmid, disk, `+${b.growGb}G`);
        });
        return sendJson(res, 200, { task: task ?? null });
      }

      if (what === "nets") {
        const key = b.key === undefined || b.key === null ? null : typeof b.key === "string" && /^net\d{1,2}$/.test(b.key) ? b.key : "bad";
        if (key === "bad") throw new HttpError(400, "bad_request", "Unknown network device");
        await asUser(req, res, async (pve) => {
          const g = await findGuest(pve, vmid);
          let spec;
          try {
            spec = checkNic(g.type, b);
          } catch (e) {
            throw new HttpError(400, "bad_request", (e as Error).message);
          }
          const cfg = await pve.guestConfig(g.node, g.type, vmid);
          if (key && !(key in cfg)) throw new HttpError(404, "not_found", "Unknown network device");
          const k = key ?? nextNicKey(cfg);
          await pve.setGuestConfig(g.node, g.type, vmid, { [k]: nicString(g.type, k, spec, key ? String(cfg[key]) : undefined) });
        });
        return sendJson(res, 200, { ok: true });
      }

      if (guestRoute[3]) {
        const key = guestRoute[3];
        await asUser(req, res, async (pve) => {
          const g = await findGuest(pve, vmid);
          await pve.setGuestConfig(g.node, g.type, vmid, { delete: key });
        });
        return sendJson(res, 200, { ok: true });
      }

      if (what === "snapshots") {
        const name = typeof b.name === "string" && /^[A-Za-z][\w-]{1,39}$/.test(b.name) ? b.name : null;
        if (!name) throw new HttpError(400, "bad_request", "Use 2 to 40 letters, digits, - or _, starting with a letter");
        if (b.description !== undefined && (typeof b.description !== "string" || b.description.length > 1024)) throw new HttpError(400, "bad_request", "Keep the description under 1024 characters");
        const task = await asUser(req, res, async (pve) => {
          const g = await findGuest(pve, vmid);
          return pve.createSnapshot(g.node, g.type, vmid, name, (b.description as string | undefined) || undefined, b.vmstate === true);
        });
        return sendJson(res, 202, { task });
      }

      if (guestRoute[4]) {
        const snap = guestRoute[4];
        const task = await asUser(req, res, async (pve) => {
          const g = await findGuest(pve, vmid);
          return guestRoute[5] === "rollback" ? pve.rollbackSnapshot(g.node, g.type, vmid, snap) : pve.deleteSnapshot(g.node, g.type, vmid, snap);
        });
        return sendJson(res, 202, { task });
      }

      if (what === "clone") {
        const name = typeof b.name === "string" && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(b.name) ? b.name : null;
        if (!name) throw new HttpError(400, "bad_request", "Use lowercase letters, digits and hyphens for the name");
        const target = b.storage === undefined || b.storage === null || b.storage === "" ? undefined : storageId(b.storage);
        const pool = b.pool === undefined || b.pool === null ? undefined : typeof b.pool === "string" && /^[\w.-]{1,64}$/.test(b.pool) ? b.pool : null;
        if (pool === null) throw new HttpError(400, "bad_request", "Unknown pool");
        const created = await asUser(req, res, async (pve) => {
          const g = await findGuest(pve, vmid);
          const newid = await pve.nextId();
          // Linked clones only work from templates; anything else is a full copy.
          const full = g.template ? b.linked !== true : true;
          const task = await pve.cloneGuest(g.node, g.type, vmid, { newid, [g.type === "lxc" ? "hostname" : "name"]: name, full, storage: full ? target : undefined, pool, description: `Cloned from ${g.name} (#${vmid}) in ePaperclip` });
          return { vmid: newid, task, full };
        });
        return sendJson(res, 202, created);
      }

      if (what === "vnc") {
        const s = requireSession(req);
        if (s.apiToken) throw new HttpError(403, "ticket_only", "Consoles need a signed-in browser session; API tokens can't open them");
        const out = await asUser(req, res, async (pve) => {
          const g = await findGuest(pve, vmid);
          if (g.type !== "qemu") throw new HttpError(400, "bad_request", "Containers use the text console");
          if (g.status !== "running") throw new HttpError(409, "not_running", "Start the VM to see its screen");
          const v = await pve.vncproxy(g.node, vmid);
          const id = randomBytes(24).toString("base64url");
          for (const [k, x] of vncSessions) if (x.expires < now()) vncSessions.delete(k);
          vncSessions.set(id, { session: s.id, node: g.node, vmid, port: String(v.port), ticket: v.ticket, expires: now() + 30_000 });
          // The one-time VNC password is useless without the relay, which holds the Proxmox ticket.
          return { id, password: v.password ?? v.ticket };
        });
        return sendJson(res, 200, out);
      }
    }

    // ---- Host DNS and hosts file.
    if (path === "/api/network/dns" || path === "/api/network/hosts") {
      const node = encodeURIComponent(hn(req));
      const which = path.endsWith("dns") ? "dns" : "hosts";
      if (method === "GET") {
        const out = await asUser(req, res, (pve) => pve.call<Record<string, unknown>>("GET", `/nodes/${node}/${which}`));
        return sendJson(res, 200, which === "dns" ? { search: out.search ?? "", servers: [out.dns1, out.dns2, out.dns3].filter((x) => typeof x === "string" && x) } : { data: out.data ?? "", digest: out.digest ?? null });
      }
      if (method !== "POST") throw new HttpError(405, "method", "Method not allowed");
      requireSameSite(req);
      const b = await readJson(req);
      if (which === "dns") {
        const search = typeof b.search === "string" && /^[a-z0-9]([a-z0-9.-]{0,252})$/i.test(b.search) ? b.search : null;
        if (!search) throw new HttpError(400, "bad_request", "The search domain looks like example.lan");
        const servers = Array.isArray(b.servers) ? b.servers : [];
        if (servers.length < 1 || servers.length > 3 || !servers.every((x) => typeof x === "string" && (/^(\d{1,3}\.){3}\d{1,3}$/.test(x) || /^[0-9a-f:]{2,39}$/i.test(x)))) throw new HttpError(400, "bad_request", "Give 1 to 3 DNS server addresses");
        await asUser(req, res, (pve) => pve.call("PUT", `/nodes/${node}/dns`, { search, dns1: servers[0], dns2: servers[1], dns3: servers[2], delete: ["dns2", "dns3"].filter((_, i) => !servers[i + 1]).join(",") || undefined }));
        return sendJson(res, 200, { ok: true });
      }
      if (typeof b.data !== "string" || b.data.length > 65_536 || b.data.includes("\u0000")) throw new HttpError(400, "bad_request", "The hosts file must be text under 64 KB");
      if (b.digest !== undefined && b.digest !== null && (typeof b.digest !== "string" || !/^[0-9a-f]{20,64}$/.test(b.digest))) throw new HttpError(400, "bad_request", "Bad digest");
      // The digest makes Proxmox refuse the write if someone changed the file since it was read.
      await asUser(req, res, (pve) => pve.call("POST", `/nodes/${node}/hosts`, { data: b.data as string, digest: (b.digest as string | null) ?? undefined }));
      return sendJson(res, 200, { ok: true });
    }

    // ---- SDN: zones, VNets and subnets, staged until applied.
    if (path === "/api/sdn" && method === "GET") {
      const out = await asUser(req, res, async (pve) => {
        const [zones, vnets] = await Promise.all([pve.call<Record<string, unknown>[]>("GET", "/cluster/sdn/zones", { pending: 1 }), pve.call<Record<string, unknown>[]>("GET", "/cluster/sdn/vnets", { pending: 1 })]);
        const subnets = await Promise.all(vnets.map((v) => pve.call<Record<string, unknown>[]>("GET", `/cluster/sdn/vnets/${encodeURIComponent(String(v.vnet))}/subnets`, { pending: 1 }).catch(() => [])));
        // With pending=1, staged values sit under `pending`; show what will be after apply, and mark the state.
        const view = (x: Record<string, unknown>): Record<string, unknown> & { state: unknown } => ({ ...x, ...(x.pending && typeof x.pending === "object" ? (x.pending as Record<string, unknown>) : {}), state: x.state ?? null });
        const zs = zones.map(view).map((z) => ({ zone: z.zone, type: z.type, bridge: z.bridge ?? null, dhcp: z.dhcp ?? null, state: z.state }));
        const vs = vnets.map(view).map((v, i) => ({ vnet: v.vnet, zone: v.zone, tag: v.tag ?? null, alias: v.alias ?? null, state: v.state, subnets: subnets[i].map(view).map((sn) => ({ id: sn.subnet, cidr: sn.cidr ?? String(sn.subnet ?? "").replace(/^[^-]+-/, "").replace(/-(\d+)$/, "/$1"), gateway: sn.gateway ?? null, snat: sn.snat === 1, dhcpRange: Array.isArray(sn["dhcp-range"]) ? sn["dhcp-range"] : sn["dhcp-range"] ? [sn["dhcp-range"]] : [], state: sn.state })) }));
        const pending = [...zs, ...vs, ...vs.flatMap((v) => v.subnets)].filter((x) => x.state).length;
        return { zones: zs, vnets: vs, pending };
      });
      return sendJson(res, 200, out);
    }
    const sdn = path.match(/^\/api\/sdn\/(apply|zones|vnets)(?:\/([a-z][a-z0-9]{0,7})(?:\/(delete|subnets)(?:\/([\w.:-]{3,64})\/(delete))?)?)?$/);
    if (sdn && method === "POST") {
      requireSameSite(req);
      const b = await readJson(req);
      const ID = /^[a-z][a-z0-9]{0,7}$/;
      const [, kind, id, action, subId] = sdn;
      if (kind === "apply") {
        const task = await asUser(req, res, (pve) => pve.call<string>("PUT", "/cluster/sdn"));
        return sendJson(res, 202, { task });
      }
      if (kind === "zones" && !id) {
        const zone = typeof b.zone === "string" && ID.test(b.zone) ? b.zone : null;
        if (!zone) throw new HttpError(400, "bad_request", "Zone names are up to 8 lowercase letters and digits, starting with a letter");
        const type = b.type === "vlan" ? "vlan" : b.type === "simple" ? "simple" : null;
        if (!type) throw new HttpError(400, "bad_request", "Pick a simple or VLAN zone");
        const bridge = type === "vlan" ? (typeof b.bridge === "string" && /^[\w.-]{1,15}$/.test(b.bridge) ? b.bridge : null) : undefined;
        if (bridge === null) throw new HttpError(400, "bad_request", "VLAN zones need a bridge");
        await asUser(req, res, (pve) => pve.call("POST", "/cluster/sdn/zones", { zone, type, bridge, ipam: "pve", dhcp: type === "simple" && b.dhcp === true ? "dnsmasq" : undefined }));
        return sendJson(res, 201, { ok: true });
      }
      if (kind === "vnets" && !id) {
        const vnet = typeof b.vnet === "string" && ID.test(b.vnet) ? b.vnet : null;
        const zone = typeof b.zone === "string" && ID.test(b.zone) ? b.zone : null;
        if (!vnet || !zone) throw new HttpError(400, "bad_request", "VNet and zone names are up to 8 lowercase letters and digits");
        const tag = b.tag === undefined || b.tag === null || b.tag === "" ? undefined : Number.isInteger(b.tag) && (b.tag as number) >= 1 && (b.tag as number) <= 4094 ? (b.tag as number) : null;
        if (tag === null) throw new HttpError(400, "bad_request", "VLAN tags go from 1 to 4094");
        const alias = b.alias === undefined || b.alias === "" ? undefined : typeof b.alias === "string" && /^[\w .()-]{1,64}$/.test(b.alias) ? b.alias : null;
        if (alias === null) throw new HttpError(400, "bad_request", "Keep the description short and plain");
        await asUser(req, res, (pve) => pve.call("POST", "/cluster/sdn/vnets", { vnet, zone, tag, alias }));
        return sendJson(res, 201, { ok: true });
      }
      if (id && action === "delete") {
        await asUser(req, res, (pve) => pve.call("DELETE", `/cluster/sdn/${kind}/${id}`));
        return sendJson(res, 200, { ok: true });
      }
      if (kind === "vnets" && id && action === "subnets" && !subId) {
        let spec;
        try {
          const cidr = typeof b.cidr === "string" && isCidr4(b.cidr) ? b.cidr : null;
          if (!cidr) throw new Error("Use a network like 10.20.0.0/24");
          const gateway = b.gateway === undefined || b.gateway === null || b.gateway === "" ? undefined : typeof b.gateway === "string" && isIpv4(b.gateway) ? b.gateway : null;
          if (gateway === null) throw new Error("The gateway should be an IPv4 address");
          const range = b.dhcpStart && b.dhcpEnd ? (typeof b.dhcpStart === "string" && isIpv4(b.dhcpStart) && typeof b.dhcpEnd === "string" && isIpv4(b.dhcpEnd) ? `start-address=${b.dhcpStart},end-address=${b.dhcpEnd}` : null) : undefined;
          if (range === null) throw new Error("DHCP ranges are two IPv4 addresses");
          spec = { subnet: cidr, type: "subnet", gateway, snat: b.snat === true ? 1 : undefined, "dhcp-range": range };
        } catch (e) {
          throw new HttpError(400, "bad_request", (e as Error).message);
        }
        await asUser(req, res, (pve) => pve.call("POST", `/cluster/sdn/vnets/${id}/subnets`, spec));
        return sendJson(res, 201, { ok: true });
      }
      if (kind === "vnets" && id && action === "subnets" && subId) {
        await asUser(req, res, (pve) => pve.call("DELETE", `/cluster/sdn/vnets/${id}/subnets/${encodeURIComponent(subId)}`));
        return sendJson(res, 200, { ok: true });
      }
      throw new HttpError(404, "not_found", "Not found");
    }

    // ---- Host network. Changes are staged by Proxmox and only take effect when applied.
    if (method === "GET" && path === "/api/network") {
      const net = await asUser(req, res, (pve) => pve.network(hn(req)));
      return sendJson(res, 200, {
        interfaces: net.interfaces.map((i) => ({ iface: i.iface, type: i.type, active: i.active === 1, autostart: i.autostart === 1, cidr: i.cidr ?? (i.address && i.netmask ? `${i.address}/${i.netmask}` : null), gateway: i.gateway ?? null, ports: (i.bridge_ports ?? "").split(/\s+/).filter(Boolean), vlanAware: i.bridge_vlan_aware === 1, slaves: (i.slaves ?? "").split(/\s+/).filter(Boolean), bondMode: i.bond_mode ?? null, vlanRaw: i["vlan-raw-device"] ?? null, vlanId: i["vlan-id"] ?? null, comments: i.comments?.trim() || null, method: i.method ?? null })).sort((a, b) => a.iface.localeCompare(b.iface, undefined, { numeric: true })),
        changes: net.changes,
      });
    }
    const netRoute = path.match(/^\/api\/network(?:\/(apply|revert)|\/([\w.-]{1,15})(\/delete)?)?$/);
    if (method === "POST" && netRoute) {
      requireSameSite(req);
      const b = await readJson(req);
      if (netRoute[1] === "apply") {
        const task = await asUser(req, res, (pve) => pve.applyNetwork(hn(req)));
        return sendJson(res, 202, { task });
      }
      if (netRoute[1] === "revert") {
        await asUser(req, res, (pve) => pve.revertNetwork(hn(req)));
        return sendJson(res, 200, { ok: true });
      }
      const iface = netRoute[2];
      if (iface && netRoute[3]) {
        await asUser(req, res, async (pve) => {
          // Deleting the interface that carries the default route can cut the host off; ask for its name to be typed.
          const cur = (await pve.network(hn(req))).interfaces.find((i) => i.iface === iface);
          if (cur?.gateway && b.confirm !== iface) throw new HttpError(409, "confirm", `${iface} carries this host's gateway. Type its name to delete it.`);
          await pve.deleteInterface(hn(req), iface);
        });
        return sendJson(res, 200, { ok: true });
      }
      let spec;
      try {
        spec = checkIface(iface ? { ...b, iface } : b, !iface);
      } catch (e) {
        throw new HttpError(400, "bad_request", (e as Error).message);
      }
      await asUser(req, res, (pve) => (iface ? pve.updateInterface(hn(req), iface, ifaceParams(spec, false)) : pve.createInterface(hn(req), ifaceParams(spec, true))));
      return sendJson(res, iface ? 200 : 201, { ok: true });
    }

    // ---- Firewall, at the datacenter, host and machine levels, as the signed-in user.
    if (path.startsWith("/api/firewall/")) {
      const seg = path.split("/").slice(3).map(decodeURIComponent);
      const [scope, res2, a, b2, c] = seg;
      const consolePort = d.consolePort ?? 443;
      const resolve = async (pve: ProxmoxClient): Promise<{ level: Level | "group"; base: string }> => {
        if (scope === "datacenter") return { level: "cluster", base: "/cluster/firewall" };
        if (scope === "host") return { level: "node", base: `/nodes/${encodeURIComponent(hn(req))}/firewall` };
        const gm = scope?.match(/^guest-(\d+)$/);
        if (gm) {
          const g = (await pve.clusterResources()).find((r) => r.vmid === Number(gm[1]));
          if (!g || (g.type !== "lxc" && g.type !== "qemu")) throw new HttpError(404, "not_found", "Unknown machine");
          return { level: "guest", base: `/nodes/${encodeURIComponent(g.node ?? d.pve.node)}/${g.type}/${g.vmid}/firewall` };
        }
        const grp = scope?.match(/^group-(.+)$/);
        if (grp && GROUP.test(grp[1])) return { level: "group", base: `/cluster/firewall/groups/${encodeURIComponent(grp[1])}` };
        throw new HttpError(404, "not_found", "Unknown firewall");
      };
      const allowed: Record<string, (Level | "group")[]> = { options: ["cluster", "node", "guest"], rules: ["cluster", "node", "guest", "group"], aliases: ["cluster", "guest"], ipsets: ["cluster", "guest"], groups: ["cluster"], macros: ["cluster"], log: ["node", "guest"], refs: ["cluster", "guest"] };
      if (!res2 || !allowed[res2]) throw new HttpError(404, "not_found", "Not found");
      const rulesPath = (base: string, level: string) => (level === "group" ? base : `${base}/rules`);
      const mapRule = (r: Record<string, unknown>) => ({ pos: r.pos, type: r.type, action: r.action, enable: r.enable === 1, macro: r.macro ?? null, proto: r.proto ?? null, dport: r.dport ?? null, sport: r.sport ?? null, source: r.source ?? null, dest: r.dest ?? null, iface: r.iface ?? null, log: r.log ?? null, comment: r.comment ?? null });
      const fail = (e: unknown): never => {
        throw e instanceof FirewallInputError ? new HttpError(400, "bad_request", e.message) : e;
      };

      // Would the console stop being reachable after this change? (Firewall on, inbound policy not ACCEPT, no rule letting the port in.)
      const lockoutAfter = async (pve: ProxmoxClient, change: { options?: Record<string, string | number>; level?: Level | "group"; dropRule?: { level: string; pos: number } }) => {
        const node = encodeURIComponent(hn(req));
        const [cOpts, nOpts, cRules, nRules] = await Promise.all([
          pve.call<Record<string, string | number>>("GET", "/cluster/firewall/options"),
          pve.call<Record<string, string | number>>("GET", `/nodes/${node}/firewall/options`).catch(() => ({}) as Record<string, string | number>),
          pve.call<Record<string, unknown>[]>("GET", "/cluster/firewall/rules"),
          pve.call<Record<string, unknown>[]>("GET", `/nodes/${node}/firewall/rules`).catch(() => []),
        ]);
        const cluster = { ...cOpts, ...(change.level === "cluster" ? change.options : {}) };
        const host = { ...nOpts, ...(change.level === "node" ? change.options : {}) };
        const on = Number(cluster.enable ?? 0) === 1 && Number(host.enable ?? 1) === 1;
        const policy = String(cluster.policy_in ?? "DROP");
        if (!on || policy === "ACCEPT") return false;
        const keep = (list: Record<string, unknown>[], level: string) => list.filter((r) => !(change.dropRule && change.dropRule.level === level && r.pos === change.dropRule.pos));
        return !consoleAllowed([...keep(cRules, "cluster"), ...keep(nRules, "node")] as never, consolePort);
      };
      const guardOrKeep = async (pve: ProxmoxClient, body: Record<string, unknown>, change: Parameters<typeof lockoutAfter>[1]) => {
        if (body.ignoreLockout === true || !(await lockoutAfter(pve, change))) return;
        if (body.keepConsole === true) {
          await pve.call("POST", `/nodes/${encodeURIComponent(hn(req))}/firewall/rules`, { ...consoleRule(consolePort), pos: 0 });
          return;
        }
        throw new HttpError(409, "lockout", `This would block port ${consolePort}, which this console runs on. Let ePaperclip add a rule that keeps it reachable, or continue anyway.`);
      };

      if (method === "GET") {
        const out = await asUser(req, res, async (pve) => {
          const { level, base } = await resolve(pve);
          if (!allowed[res2].includes(level)) throw new HttpError(404, "not_found", "Not found");
          if (res2 === "options") return { options: await pve.call<Record<string, unknown>>("GET", `${base}/options`) };
          if (res2 === "rules") return { rules: (await pve.call<Record<string, unknown>[]>("GET", rulesPath(base, level))).map(mapRule), consolePort };
          if (res2 === "aliases") return { aliases: (await pve.call<{ name: string; cidr: string; comment?: string }[]>("GET", `${base}/aliases`)).map((x) => ({ name: x.name, cidr: x.cidr, comment: x.comment ?? null })) };
          if (res2 === "ipsets" && a) {
            if (!NAME.test(a)) throw new HttpError(400, "bad_request", "Unknown IP set");
            return { entries: (await pve.call<{ cidr: string; nomatch?: number; comment?: string }[]>("GET", `${base}/ipset/${encodeURIComponent(a)}`)).map((x) => ({ cidr: x.cidr, nomatch: x.nomatch === 1, comment: x.comment ?? null })) };
          }
          if (res2 === "ipsets") return { ipsets: (await pve.call<{ name: string; comment?: string }[]>("GET", `${base}/ipset`)).map((x) => ({ name: x.name, comment: x.comment ?? null })) };
          if (res2 === "groups") return { groups: (await pve.call<{ group: string; comment?: string }[]>("GET", `${base}/groups`)).map((x) => ({ group: x.group, comment: x.comment ?? null })) };
          if (res2 === "macros") return { macros: (await pve.call<{ macro: string; descr?: string }[]>("GET", `${base}/macros`)).map((x) => ({ macro: x.macro, descr: x.descr ?? "" })) };
          if (res2 === "log") return { lines: (await pve.call<{ n: number; t: string }[]>("GET", `${base}/log`, { limit: 200 })).map((x) => x.t) };
          return { refs: (await pve.call<{ type: string; name: string; ref: string; comment?: string }[]>("GET", `${base}/refs`)).map((x) => ({ type: x.type, name: x.name, ref: x.ref, comment: x.comment ?? null })) };
        });
        return sendJson(res, 200, out);
      }
      if (method !== "POST") throw new HttpError(405, "method", "Method not allowed");
      requireSameSite(req);
      const body = await readJson(req);
      const out = await asUser(req, res, async (pve) => {
        const { level, base } = await resolve(pve);
        if (!allowed[res2].includes(level)) throw new HttpError(404, "not_found", "Not found");
        if (res2 === "options") {
          let opts: Record<string, string | number> = {};
          try {
            opts = checkOptions(level as Level, body);
          } catch (e) {
            fail(e);
          }
          if (level !== "guest") await guardOrKeep(pve, body, { options: opts, level: level as Level });
          await pve.call("PUT", `${base}/options`, opts);
          return { ok: true };
        }
        if (res2 === "rules") {
          const rp = rulesPath(base, level);
          if (!a) {
            let rule;
            try {
              rule = checkRule(body);
            } catch (e) {
              fail(e);
            }
            const pos = Number.isInteger(body.pos) && (body.pos as number) >= 0 ? (body.pos as number) : undefined;
            await pve.call("POST", rp, { ...ruleParams(rule!, false), pos });
            return { ok: true };
          }
          const pos = Number(a);
          if (!Number.isInteger(pos) || pos < 0 || pos > 10_000) throw new HttpError(400, "bad_request", "Unknown rule");
          if (b2 === "delete") {
            if (level === "cluster" || level === "node") await guardOrKeep(pve, body, { dropRule: { level, pos } });
            await pve.call("DELETE", `${rp}/${pos}`);
            return { ok: true };
          }
          if (Object.keys(body).every((k) => k === "enable" || k === "ignoreLockout" || k === "keepConsole") && typeof body.enable === "boolean") {
            if (!body.enable && (level === "cluster" || level === "node")) await guardOrKeep(pve, body, { dropRule: { level, pos } });
            await pve.call("PUT", `${rp}/${pos}`, { enable: body.enable ? 1 : 0 });
            return { ok: true };
          }
          if (Object.keys(body).length === 1 && Number.isInteger(body.moveto)) {
            await pve.call("PUT", `${rp}/${pos}`, { moveto: body.moveto as number });
            return { ok: true };
          }
          let rule;
          try {
            rule = checkRule(body);
          } catch (e) {
            fail(e);
          }
          await pve.call("PUT", `${rp}/${pos}`, ruleParams(rule!, true));
          return { ok: true };
        }
        if (res2 === "groups") {
          if (!a) {
            if (typeof body.group !== "string" || !GROUP.test(body.group)) throw new HttpError(400, "bad_request", "Group names are 2 to 18 letters, digits, - or _, starting with a letter");
            await pve.call("POST", `${base}/groups`, { group: body.group, comment: typeof body.comment === "string" && body.comment.length <= 200 && !/[\r\n]/.test(body.comment) ? body.comment || undefined : undefined });
            return { ok: true };
          }
          if (!GROUP.test(a) || b2 !== "delete") throw new HttpError(404, "not_found", "Not found");
          await pve.call("DELETE", `${base}/groups/${encodeURIComponent(a)}`);
          return { ok: true };
        }
        if (res2 === "aliases") {
          try {
            if (!a) {
              const al = checkAlias(body);
              await pve.call("POST", `${base}/aliases`, al);
              return { ok: true };
            }
            if (!NAME.test(a)) throw new HttpError(400, "bad_request", "Unknown alias");
            if (b2 === "delete") {
              await pve.call("DELETE", `${base}/aliases/${encodeURIComponent(a)}`);
              return { ok: true };
            }
            const al = checkAlias({ ...body, name: body.name ?? a });
            await pve.call("PUT", `${base}/aliases/${encodeURIComponent(a)}`, { cidr: al.cidr, comment: al.comment, rename: al.name !== a ? al.name : undefined });
            return { ok: true };
          } catch (e) {
            return fail(e);
          }
        }
        if (res2 === "ipsets") {
          try {
            if (!a) {
              if (typeof body.name !== "string" || !NAME.test(body.name)) throw new FirewallInputError("Names start with a letter: letters, digits, - and _");
              await pve.call("POST", `${base}/ipset`, { name: body.name, comment: typeof body.comment === "string" && body.comment && body.comment.length <= 200 && !/[\r\n]/.test(body.comment) ? body.comment : undefined });
              return { ok: true };
            }
            if (!NAME.test(a)) throw new HttpError(400, "bad_request", "Unknown IP set");
            if (b2 === "delete") {
              await pve.call("DELETE", `${base}/ipset/${encodeURIComponent(a)}`);
              return { ok: true };
            }
            if (b2 === "entries" && !c) {
              await pve.call("POST", `${base}/ipset/${encodeURIComponent(a)}`, checkIpsetEntry(body));
              return { ok: true };
            }
            if (b2 === "entries" && c && seg[5] === "delete") {
              checkIpsetEntry({ cidr: c });
              await pve.call("DELETE", `${base}/ipset/${encodeURIComponent(a)}/${encodeURIComponent(c)}`);
              return { ok: true };
            }
            throw new HttpError(404, "not_found", "Not found");
          } catch (e) {
            return fail(e);
          }
        }
        throw new HttpError(404, "not_found", "Not found");
      });
      return sendJson(res, 200, out);
    }

    const lib = path.match(/^\/api\/library\/([a-z0-9-]{1,32})\/latest$/);
    if (method === "GET" && lib) {
      requireSession(req);
      const entry = isoEntries().find((e) => e.id === lib[1]);
      if (!entry) throw new HttpError(404, "not_found", LIBRARY.some((e) => e.id === lib[1]) ? "That one has no automatic download" : "Unknown system");
      const hit = latestCache.get(entry.id);
      if (hit && now() - hit.at < 6 * 3600_000) return sendJson(res, 200, hit.latest);
      let text: string;
      try {
        text = await fetchText(entry.source.sums);
      } catch (e) {
        throw new HttpError(502, "vendor_unreachable", `Couldn't read ${entry.vendor}'s download list (${(e as Error).message}). Try again in a moment, or download from a URL.`);
      }
      const latest = pickLatest(entry, text);
      if (!latest) throw new HttpError(502, "vendor_unrecognised", `${entry.vendor}'s download list didn't have a recognisable installer. Download it from a URL instead.`);
      latestCache.set(entry.id, { at: now(), latest });
      return sendJson(res, 200, latest);
    }

    if (method === "GET" && path === "/api/marketplace") {
      requireSession(req);
      const m = await loadMarket();
      if (!m.enabled) return sendJson(res, 200, { enabled: false, entries: [] });
      return sendJson(res, 200, { enabled: true, entries: m.index?.entries ?? [], sequence: m.index?.sequence ?? null, problem: m.problem });
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
        if (action === "reset" && g.type !== "qemu") throw new HttpError(400, "bad_request", "Only VMs can be reset; reboot the container instead");
        if (g.template === 1) throw new HttpError(409, "template", `${g.name ?? "This machine"} is a template; clone it to get a machine you can start.`);
        return pve.guestPower(g.node ?? d.pve.node, g.type as GuestType, vmid, action as PowerAction);
      });
      return sendJson(res, 202, { task: upid });
    }

    // Areas built as features (src/features/*): each answers its own routes or passes.
    if (FEATURES.length) {
      const ctx = featureCtx(req, res, url);
      for (const f of FEATURES) if (await f.handle(ctx)) return;
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
      // Browsers ask for this even though the page names its own icon; answer quietly instead of logging a 404.
      if (rel === "favicon.ico") {
        res.writeHead(204, { "Cache-Control": "public, max-age=86400" });
        return res.end();
      }
      if (extname(rel)) return sendJson(res, 404, { error: "Not found", code: "not_found" });
      file = join(root, "index.html");
    }
    const hashed = rel.startsWith("assets/");
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache" });
    if (req.method === "HEAD") return res.end();
    createReadStream(file).pipe(res);
  }

  // The Library's "what's the newest installer" answers, kept for six hours so the page is quick and vendors aren't hammered.
  const latestCache = new Map<string, { at: number; latest: Latest }>();
  const fetchText = d.fetchText ?? fetchVendorText;

  // The Store's signed catalog, kept for an hour. Only a copy signed by a pinned key is ever shown, and the sequence
  // number never goes back within this run. When it can't be read or checked, the answer says why and the Store carries on
  // with what ships with ePaperclip.
  const marketCache: { at: number; index: Index | null; problem: { code: string; message: string } | null } = { at: 0, index: null, problem: null };
  let marketSequence = (() => {
    const v = state.getSetting<number>("marketplace.sequence");
    return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : -1;
  })();

  // One-time VNC sessions: created by POST /api/guests/:vmid/vnc for one signed-in session, used once within 30 seconds.
  const vncSessions = new Map<string, { session: string; node: string; vmid: number; port: string; ticket: string; expires: number }>();

  // Sockets (consoles and engine events): same session cookie, and the Origin must be this host (WebSockets get no CORS protection).
  const socketPrecheck = (req: IncomingMessage) => {
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
  };
  const consoleUpgrade = createConsoleRelay({
    connect: d.connect ?? realConnect(d.pve.caPem),
    precheck: socketPrecheck,
    authorize: async (req, url) => {
      const s = d.sessions.get(cookieValue(req, COOKIE));
      if (!s) throw new Error("Your session ended. Sign in again.");
      const vnc = url.pathname.match(/^\/api\/vnc\/([\w-]+)$/);
      if (vnc) {
        const v = vncSessions.get(vnc[1]);
        vncSessions.delete(vnc[1]);
        if (!v || v.session !== s.id || v.expires < now()) throw new Error("That screen session expired. Open the console again.");
        const base = new URL(d.pve.baseUrl);
        return {
          url: `wss://${base.host}${ProxmoxClient.consoleSocketPath(v.node, { type: "qemu", vmid: v.vmid }, Number(v.port), v.ticket)}`,
          headers: { Cookie: `PVEAuthCookie=${encodeURIComponent(s.ticket)}` },
          binary: true,
        };
      }
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
        // The Updates screen asks for /api/console/node?cmd=upgrade: Proxmox runs the package upgrade in the node terminal
        // (it has no task for it). Only that one command is ever passed on; Proxmox decides whether this person may.
        const cmd = url.searchParams.get("cmd");
        if (cmd !== null && (cmd !== "upgrade" || guest)) throw new Error("That terminal command isn't available.");
        const tp = cmd === "upgrade" ? await pve.termproxyCommand(node, "upgrade") : await pve.termproxy(node, guest);
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

  // The engine's live events for one organization, relayed as the signed-in person.
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!new URL(req.url ?? "/", "http://epaperclip").pathname.startsWith("/engine/")) return consoleUpgrade(req, socket, head);
    const refused = socketPrecheck(req);
    if (refused || !gateway) return void socket.end(`HTTP/1.1 ${refused?.status ?? 503} ${refused?.reason ?? "Service Unavailable"}\r\nConnection: close\r\n\r\n`);
    const s = d.sessions.get(cookieValue(req, COOKIE))!;
    gateway.relayEvents(req, socket, head, s, () => d.sessions.peek(s.id) !== null).catch(() => socket.destroy());
  };

  /**
   * The one change to the engine that would let agents run on the host again is turning its managed-sandbox-only policy
   * off. The engine's API would let a Proxmox administrator do that from here, so this refuses it (the engine stays
   * unmodified; someone with a shell on the host could still change its database).
   */
  const engineGuard = (method: string, target: string, body: Buffer | null) => {
    if (method === "GET" || method === "HEAD") return;
    let p: string;
    try {
      p = decodeURIComponent(target.split("?")[0]).toLowerCase().replace(/\/+$/, "");
    } catch {
      return;
    }
    if (p !== "/api/instance/settings/experimental") return;
    let ok = false;
    try {
      const v = body === null ? null : JSON.parse(body.toString("utf8") || "{}");
      ok = v !== null && typeof v === "object" && !Array.isArray(v) && !("enableManagedSandboxOnly" in v && v.enableManagedSandboxOnly !== true);
    } catch {
      ok = false;
    }
    if (!ok) throw new HttpError(403, "agents_on_host_refused", "ePaperclip keeps agents off the host: the engine's managed-sandbox-only setting can't be turned off from here.");
  };

  /** /engine/api/*: the engine, as the signed-in person. Changes need the same header and Origin as our own API. */
  const engineProxy = async (req: IncomingMessage, res: ServerResponse) => {
    const s = requireSession(req);
    if (req.method !== "GET" && req.method !== "HEAD") requireSameSite(req);
    await needEngine().forward(req, res, s, maxUpload, {
      inspect: engineGuard,
      // New agents default to their organization's container environment right away.
      after: (m, p, status) => {
        if (status >= 200 && status < 300 && m === "POST" && /^\/api\/companies(\/[^/]+\/agent(s|-hires))?(\/|\?|$)/i.test(p)) void containers.reconcile((am, ap, ab) => needEngine().userJson(s, am, ap, ab)).catch(() => {});
      },
    });
  };

  const handle = async function handle(req: IncomingMessage, res: ServerResponse) {
    baseHeaders(res, d.secureCookies);
    const url = new URL(req.url ?? "/", "http://epaperclip");
    try {
      if (req.headers["x-epc-node"] !== undefined && url.pathname.startsWith("/api/")) {
        const sess = d.sessions.get(cookieValue(req, COOKIE));
        if (sess) await nodeScope.resolve(req, sess.id, () => clientFor(sess));
      }
      if (req.headers.authorization !== undefined && (url.pathname.startsWith("/api/") || url.pathname === "/engine" || url.pathname.startsWith("/engine/"))) await bearer.attach(req);
      // Every change under /api needs our own page's header and Origin (or an API token), whichever route it is for: a route
      // that forgets its own check can't be reached cross-site, and a read-only token can't reach it either.
      if (url.pathname.startsWith("/api/") && (req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE")) requireSameSite(req);
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      // OAuth for MCP apps and /mcp live at the root (docs/CONNECTORS.md); everything else there is the console.
      if (isConnectRoot(url.pathname) && (await connectRoot(featureCtx(req, res, url)))) return;
      if (url.pathname === "/engine" || url.pathname.startsWith("/engine/")) return await engineProxy(req, res);
      // The one unauthenticated door (off unless an administrator opened an organization): routine webhooks.
      if (url.pathname.startsWith("/hooks/")) return await routineIngress.handle(req, res, url);
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
      if (e instanceof ProxmoxError) {
        // For the host's log (journalctl -u epaperclip): what Proxmox said, never what was sent. Messages carry only the method, path and status.
        console.error(`epaperclip: ${e.message}`);
        return sendJson(res, 502, { error: "Proxmox didn't answer as expected", code: "proxmox_error" });
      }
      const net = (e as { code?: unknown })?.code;
      if (typeof net === "string" && /^E[A-Z]+|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(net)) return sendJson(res, 502, { error: `Can't reach Proxmox (${net})`, code: "proxmox_unreachable" });
      return sendJson(res, 500, { error: "Internal error", code: "internal" });
    }
  };
  return Object.assign(handle, { upgrade, engine: gateway, containers });
}
