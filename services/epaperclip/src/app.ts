import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { ProxmoxClient, ProxmoxError, type GuestType, type PowerAction, type RrdCf, type RrdTimeframe, type Transport } from "@papercliped-engine/proxmox-client";
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
  pve: { baseUrl: string; node: string; caPem?: string; transport?: Transport };
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

const str = (v: unknown, max = 256) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

export function createApp(d: AppDeps) {
  const now = d.now ?? Date.now;
  const limiter = new LoginLimiter(now);
  const pveOpts = { baseUrl: d.pve.baseUrl, caPem: d.pve.caPem, transport: d.pve.transport };
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
        const [tplStores, diskStores, pools, nextid] = await Promise.all([
          pve.nodeStorages(node, "vztmpl"),
          pve.nodeStorages(node, "rootdir"),
          pve.pools().catch(() => []),
          pve.nextId(),
        ]);
        const templates = (await Promise.all(tplStores.filter((s) => s.active !== 0).map((s) => pve.storageContent(node, s.storage, "vztmpl").catch(() => [])))).flat();
        return {
          nextid,
          templates: templates.map((t) => ({ volid: t.volid, name: templateName(t.volid), size: t.size ?? null })),
          storages: diskStores.filter((s) => s.active !== 0).map((s) => ({ storage: s.storage, type: s.type, avail: s.avail ?? null })),
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

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    baseHeaders(res, d.secureCookies);
    const url = new URL(req.url ?? "/", "http://epaperclip");
    try {
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed", code: "method" });
      return serveStatic(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, code: e.code });
      if (e instanceof ProxmoxError) return sendJson(res, 502, { error: "Proxmox didn't answer as expected", code: "proxmox_error" });
      const net = (e as { code?: unknown })?.code;
      if (typeof net === "string" && /^E[A-Z]+|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(net)) return sendJson(res, 502, { error: `Can't reach Proxmox (${net})`, code: "proxmox_unreachable" });
      return sendJson(res, 500, { error: "Internal error", code: "internal" });
    }
  };
}
