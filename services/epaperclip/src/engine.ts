import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { engineAllowed } from "./engine-allow.ts";
import { HttpError } from "./http.ts";
import type { EngineLogin, Session } from "./sessions.ts";
import type { StateStore } from "./state.ts";

/**
 * The gateway to the engine (Paperclip, on loopback). Browsers never talk to it directly and never hold an engine
 * cookie: the host service signs each Proxmox user in to a managed engine account and forwards `/engine/api/*` as them.
 *
 * Accounts:
 * - The service account (`system@epaperclip.invalid`) is created on first start and claims the instance
 *   (`POST /api/bootstrap/claim`), so it is the engine's only instance admin. It is never exposed to a browser.
 * - Each Proxmox user gets a managed account. Its email is derived from the Proxmox user id: lower-cased, "@" becomes
 *   ".", anything outside [a-z0-9._-] becomes "-", cut to 40 characters, plus the first 8 hex digits of the SHA-256 of
 *   the exact user id so that ids that sanitise alike stay apart: `sam@pve` -> `sam.pve-<8 hex>@epaperclip.invalid`.
 *   `.invalid` is reserved (RFC 2606), so these addresses can never reach a real mailbox.
 * - Passwords are 32 random bytes, kept only in the vault. Nobody types or sees them.
 *
 * The engine rate-limits sign-ins per client address, and every sign-in comes from this host, so engine sessions are
 * kept in memory per Proxmox user (they last a week) and shared by that user's browser sessions.
 */

export const MANAGED_DOMAIN = "epaperclip.invalid";
export const SERVICE_EMAIL = `system@${MANAGED_DOMAIN}`;

export interface EngineStatus {
  installed: boolean;
  reachable: boolean;
  ready: boolean;
  version: string | null;
  bootstrap: "pending" | "ready";
  /** Whether the instance admin is ours ("ours"), someone else's ("other"), or not settled yet. */
  serviceAccount: "ours" | "other" | "pending" | "error";
  error?: string;
}

export interface BoardAccess {
  userId: string;
  isInstanceAdmin: boolean;
  companyIds: string[];
  memberships: { companyId: string; membershipRole: string; status: string }[];
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

type ServiceState = { state: "unknown" } | { state: "ours" } | { state: "other" } | { state: "error"; error: string };

interface SavedService {
  email: string;
  created: boolean;
  claimed: boolean;
  userId?: string;
  claimedAt?: number;
}

/** Thrown when the engine can't be reached or doesn't answer; the browser gets 503 engine_unavailable. */
export class EngineDown extends Error {}

export const engineUnavailable = () => new HttpError(503, "engine_unavailable", "The engine isn't answering. It may still be starting; try again in a moment.");

/** Request headers a browser may pass to the engine. Everything else (cookies, authorization, x-paperclip-cloud-*, forwarding headers) is dropped. */
const REQUEST_HEADERS = ["content-type", "content-length", "accept", "accept-language", "range", "if-none-match", "user-agent", "x-paperclip-tab-visible", "x-paperclip-route"];
/** Response headers passed back. Never Set-Cookie. */
const RESPONSE_HEADERS = ["content-type", "content-length", "etag", "cache-control", "content-disposition", "last-modified", "content-range", "accept-ranges"];
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
/** Bodies up to this size are held so a request can be replayed once after the engine session is renewed. */
const REPLAY_BYTES = 1024 * 1024;
const MAX_REPLY = 8 * 1024 * 1024;
/** Engine areas that would let a browser touch the managed account itself, or the instance bootstrap. */
const BLOCKED = [/^\/api\/auth(\/|$)/, /^\/api\/bootstrap(\/|$)/, /^\/api\/cli-auth(\/|$)/];
const EVENTS_WS = /^\/engine\/api\/companies\/([A-Za-z0-9_-]{1,64})\/events\/ws$/;

export function managedEmail(username: string): string {
  const local =
    username
      .toLowerCase()
      .replace(/@/g, ".")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/[.-]{2,}/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 40)
      .replace(/[.-]+$/, "") || "user";
  return `${local}-${createHash("sha256").update(username).digest("hex").slice(0, 8)}@${MANAGED_DOMAIN}`;
}

const newPassword = () => randomBytes(32).toString("base64url");
const userKey = (username: string) => `engine.user.${createHash("sha256").update(username).digest("hex").slice(0, 32)}`;

/** Folds Set-Cookie answers into a Cookie header, dropping cookies the engine clears. */
export function mergeCookies(jar: string, setCookie: string[] | undefined): string {
  const map = new Map<string, string>();
  for (const part of jar.split(";")) {
    const at = part.indexOf("=");
    if (at > 0) map.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  for (const line of setCookie ?? []) {
    const [pair, ...attrs] = line.split(";");
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    const cleared = !value || attrs.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a) || (/^\s*expires\s*=/i.test(a) && Date.parse(a.split("=").slice(1).join("=")) < Date.now()));
    if (cleared) map.delete(name);
    else map.set(name, value);
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * Checks a browser path under /engine/api and returns the engine path (with the query string as sent). Refuses dot
 * segments, empty segments and encoded slashes, backslashes or NULs, so nothing can climb out of /api.
 */
export function enginePath(raw: string, extraAllowed: readonly RegExp[] = []): string {
  const q = raw.indexOf("?");
  const path = q < 0 ? raw : raw.slice(0, q);
  const query = q < 0 ? "" : raw.slice(q);
  if (!path.startsWith("/engine/api/")) throw new HttpError(404, "not_found", "Not found");
  if (path.length > 2048 || query.length > 8192) throw new HttpError(414, "too_long", "Address too long");
  if (!/^[A-Za-z0-9\-._~!$&'()*+,;=:@%/]+$/.test(path) || !/^(\?[\x21-\x7e]*)?$/.test(query)) throw new HttpError(400, "bad_path", "Bad path");
  const rest = path.slice("/engine".length);
  const segs = rest.split("/").slice(1);
  let decoded = "";
  segs.forEach((seg, i) => {
    let d: string;
    try {
      d = decodeURIComponent(seg);
    } catch {
      throw new HttpError(400, "bad_path", "Bad path");
    }
    if ((seg === "" && i !== segs.length - 1) || d === "." || d === ".." || /[/\\\0]/.test(d)) throw new HttpError(400, "bad_path", "Bad path");
    decoded += `/${d}`;
  });
  // The engine matches routes without regard to case, so the refusal list does too.
  const lower = decoded.toLowerCase();
  if (BLOCKED.some((re) => re.test(lower)) && lower !== "/api/cli-auth/me") throw new HttpError(404, "not_found", "Not found");
  // Allow-list: only the routes the console uses (src/engine-allow.ts). Everything else is closed, whatever the engine adds.
  if (!engineAllowed(decoded, extraAllowed)) throw new HttpError(404, "not_found", "Not found");
  return rest + query;
}

const json = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

/** A close code that may be sent on: reserved ones become 1000, or 1011 when the engine's side dropped abnormally. */
const closeCode = (code: number, fromEngine: boolean) => (code === 1000 || (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999) ? code : code === 1006 && fromEngine ? 1011 : 1000);

/** Optional checks around one forwarded request. `inspect` runs before it is sent and may throw to refuse it. */
export interface ForwardHooks {
  inspect?: (method: string, path: string, body: Buffer | null) => void;
  after?: (method: string, path: string, status: number) => void;
}

export class EngineGateway {
  readonly url: URL;
  readonly publicUrl: string;
  private readonly installDir: string;
  private readonly state: StateStore;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** Extra engine routes the proxy lets through; for tests with a stand-in engine. Empty in production. */
  private readonly extraAllowed: RegExp[];
  private service: ServiceState = { state: "unknown" };
  private serviceFlight: Promise<ServiceState> | null = null;
  private stopped = false;
  private readonly logins = new Map<string, EngineLogin>();
  private serviceLogin: EngineLogin | null = null;
  private readonly loginFlights = new Map<string, Promise<EngineLogin>>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, autoPong: false });

  constructor(opts: { url: string; publicUrl?: string; installDir?: string; state: StateStore; sleep?: (ms: number) => Promise<void>; now?: () => number; extraAllowed?: RegExp[] }) {
    this.extraAllowed = opts.extraAllowed ?? [];
    this.url = new URL(opts.url);
    this.publicUrl = new URL(opts.publicUrl ?? opts.url).origin;
    this.installDir = opts.installDir ?? "/opt/epaperclip/engine";
    this.state = opts.state;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref()));
  }

  // ---- Talking to the engine

  /** Starts one request to the engine. Origin is always the engine's own public URL, which its mutation guard requires. */
  private open(method: string, path: string, headers: Record<string, string>, onResponse: (res: IncomingMessage) => void, onError: (e: Error) => void): ClientRequest {
    const target = new URL(path, this.url);
    const req = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, { method, headers: { ...headers, Origin: this.publicUrl } });
    req.setTimeout(120_000, () => req.destroy(new EngineDown("timed out")));
    req.on("response", onResponse);
    req.on("error", (e) => onError(e instanceof HttpError || e instanceof EngineDown ? e : new EngineDown((e as NodeJS.ErrnoException).code ?? e.message)));
    return req;
  }

  private send(method: string, path: string, opts: { cookie?: string; json?: unknown; timeoutMs?: number } = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const body = opts.json === undefined ? undefined : JSON.stringify(opts.json);
      const headers: Record<string, string> = { Accept: "application/json" };
      if (opts.cookie) headers.Cookie = opts.cookie;
      if (body !== undefined) Object.assign(headers, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) });
      const req = this.open(
        method,
        path,
        headers,
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_REPLY) return void req.destroy(new EngineDown("answer too large"));
            chunks.push(c);
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", (e) => reject(new EngineDown(e.message)));
        },
        reject,
      );
      if (opts.timeoutMs) req.setTimeout(opts.timeoutMs, () => req.destroy(new EngineDown("timed out")));
      req.end(body);
    });
  }

  async health(): Promise<{ bootstrap: "pending" | "ready"; version: string | null }> {
    const r = await this.send("GET", "/api/health", { timeoutMs: 5000 });
    const h = json(r.text) as { status?: string; bootstrapStatus?: string; version?: string } | null;
    if (r.status !== 200 || !h) throw new EngineDown(`health answered ${r.status}`);
    return { bootstrap: h.bootstrapStatus === "bootstrap_pending" ? "pending" : "ready", version: typeof h.version === "string" ? h.version : null };
  }

  /** Better Auth email sign-in or sign-up. It rate-limits per address, so a 429 is waited out (briefly) and retried. */
  private async auth(kind: "sign-in" | "sign-up", email: string, password: string, name?: string): Promise<{ status: number; login?: EngineLogin }> {
    for (let attempt = 0; ; attempt++) {
      const r = await this.send("POST", `/api/auth/${kind}/email`, { json: kind === "sign-up" ? { email, password, name } : { email, password }, timeoutMs: 15_000 });
      if (r.status === 429 && attempt < 3) {
        const wait = Number(r.headers["x-retry-after"] ?? r.headers["retry-after"]);
        await this.sleep(Math.min(10_000, Number.isFinite(wait) && wait > 0 ? wait * 1000 : 3000));
        continue;
      }
      if (r.status !== 200) return { status: r.status };
      const cookie = mergeCookies("", r.headers["set-cookie"]);
      if (!cookie) throw new EngineDown("the engine signed in without a session cookie");
      const user = (json(r.text) as { user?: { id?: string } } | null)?.user;
      return { status: 200, login: { cookie, userId: typeof user?.id === "string" ? user.id : null, at: this.now() } };
    }
  }

  // ---- The service account

  /** Makes sure the engine's instance admin is our service account. One attempt; concurrent callers share it. */
  ensureServiceAccount(): Promise<ServiceState> {
    if (this.service.state === "ours" || this.service.state === "other") return Promise.resolve(this.service);
    if (!this.serviceFlight) this.serviceFlight = this.bootstrap().finally(() => (this.serviceFlight = null));
    return this.serviceFlight;
  }

  private async bootstrap(): Promise<ServiceState> {
    const h = await this.health();
    const saved = this.state.getSetting<SavedService>("engine.service");
    if (h.bootstrap === "ready") {
      // Someone claimed the engine. If it wasn't us, say so rather than guess: managed accounts still work.
      this.service = saved?.claimed ? { state: "ours" } : { state: "other" };
      return this.service;
    }
    let password = this.state.getSecret("engine.service.password");
    if (!password) {
      password = newPassword();
      this.state.setSecret("engine.service.password", password);
      this.state.setSetting("engine.service", { email: SERVICE_EMAIL, created: false, claimed: false } satisfies SavedService);
    }
    let r = saved?.created ? await this.auth("sign-in", SERVICE_EMAIL, password) : await this.auth("sign-up", SERVICE_EMAIL, password, "ePaperclip");
    if (!r.login && !saved?.created && r.status === 422) r = await this.auth("sign-in", SERVICE_EMAIL, password);
    if (!r.login && saved?.created && r.status === 401) r = await this.auth("sign-up", SERVICE_EMAIL, password, "ePaperclip");
    if (!r.login) {
      this.service = { state: "error", error: r.status === 401 || r.status === 422 ? `The engine already has an account named ${SERVICE_EMAIL} that this host can't sign in to.` : `The engine refused to create the service account (${r.status}).` };
      return this.service;
    }
    this.state.setSetting("engine.service", { email: SERVICE_EMAIL, created: true, claimed: false, userId: r.login.userId ?? undefined } satisfies SavedService);
    const claim = await this.send("POST", "/api/bootstrap/claim", { cookie: r.login.cookie, json: {}, timeoutMs: 15_000 });
    if (claim.status === 409) {
      this.service = { state: "other" };
      return this.service;
    }
    if (claim.status !== 200) {
      this.service = { state: "error", error: `The engine refused the first-admin claim (${claim.status}).` };
      return this.service;
    }
    this.state.setSetting("engine.service", { email: SERVICE_EMAIL, created: true, claimed: true, userId: r.login.userId ?? undefined, claimedAt: this.now() } satisfies SavedService);
    this.service = { state: "ours" };
    return this.service;
  }

  /** Keeps trying to settle the service account while the engine starts: 1s, 2s, 4s ... up to every 30s. */
  async start(log: (msg: string) => void = (m) => console.log(m)) {
    for (let attempt = 0; !this.stopped; attempt++) {
      try {
        const s = await this.ensureServiceAccount();
        if (s.state === "ours") log("epaperclip: engine ready, service account in place");
        if (s.state === "other") log("epaperclip: the engine was claimed by an account that isn't ePaperclip's service account");
        if (s.state === "error") log(`epaperclip: engine service account: ${s.error}`);
        return;
      } catch (e) {
        if (attempt === 0) log(`epaperclip: waiting for the engine at ${this.url.origin} (${(e as Error).message})`);
      }
      await this.sleep(Math.min(30_000, 1000 * 2 ** attempt));
    }
  }

  stop() {
    this.stopped = true;
  }

  private installedVersion(): string | null {
    try {
      const pkg = JSON.parse(readFileSync(join(this.installDir, "node_modules", "@paperclipai", "server", "package.json"), "utf8")) as { version?: unknown };
      return typeof pkg.version === "string" ? pkg.version : null;
    } catch {
      return null;
    }
  }

  async status(): Promise<EngineStatus> {
    const installed = this.installedVersion();
    const saved = this.state.getSetting<SavedService>("engine.service");
    try {
      const h = await this.health();
      let svc = this.service;
      if (svc.state !== "ours" && svc.state !== "other") svc = await this.ensureServiceAccount().catch((e: Error) => ({ state: "error" as const, error: e.message }));
      const out: EngineStatus = { installed: true, reachable: true, ready: h.bootstrap === "ready" && svc.state !== "error", version: installed ?? h.version, bootstrap: svc.state === "ours" || svc.state === "other" ? "ready" : h.bootstrap, serviceAccount: svc.state === "unknown" ? "pending" : svc.state };
      if (svc.state === "other") out.error = "The engine's instance admin was claimed by another account, not ePaperclip's service account. Organizations still work; instance administration from ePaperclip doesn't.";
      if (svc.state === "error") out.error = svc.error;
      return out;
    } catch (e) {
      if (!(e instanceof EngineDown)) throw e;
      return { installed: installed !== null, reachable: false, ready: false, version: installed, bootstrap: saved?.claimed ? "ready" : "pending", serviceAccount: saved?.claimed ? "ours" : "pending", error: installed === null ? "The engine isn't installed." : "The engine isn't answering. It may still be starting." };
    }
  }

  // ---- Managed accounts

  /** The engine session for this signed-in person, creating their managed account the first time. */
  async loginFor(s: Session): Promise<EngineLogin> {
    // The engine knows the person, not the token: a privilege-separated API token is meant to have only the permissions
    // it was given in Proxmox, and the engine can't see those, so it never gets the person's engine access.
    if (s.apiToken?.privsep) throw new HttpError(403, "token_scope", "This API token is privilege-separated, so it can't use the engine. Create a token that acts as you if it needs to.");
    if (s.engine) return s.engine;
    const cached = this.logins.get(s.username);
    if (cached) return (s.engine = cached);
    return (s.engine = await this.signInOnce(s.username));
  }

  /** The engine said 401 to `stale`: sign in again, unless another request already did. */
  private async reauth(s: Session, stale: EngineLogin): Promise<EngineLogin> {
    const cached = this.logins.get(s.username);
    if (cached && cached !== stale) return (s.engine = cached);
    if (cached === stale) this.logins.delete(s.username);
    return (s.engine = await this.signInOnce(s.username));
  }

  private signInOnce(username: string): Promise<EngineLogin> {
    let flight = this.loginFlights.get(username);
    if (!flight) {
      flight = this.signInManaged(username).then(
        (l) => {
          this.logins.set(username, l);
          return l;
        },
        (e) => Promise.reject(e instanceof EngineDown ? engineUnavailable() : e),
      );
      flight.finally(() => this.loginFlights.delete(username)).catch(() => {});
      this.loginFlights.set(username, flight);
    }
    return flight;
  }

  private async signInManaged(username: string): Promise<EngineLogin> {
    const email = managedEmail(username);
    const key = userKey(username);
    let password = this.state.getSecret(key);
    if (password) {
      const r = await this.auth("sign-in", email, password);
      if (r.login) return this.recordAccount(username, email, r.login);
      if (r.status === 429) throw new HttpError(503, "engine_busy", "The engine is limiting sign-ins right now. Try again in a few seconds.");
      // 401: the account isn't there any more (the engine's data was reset, say), so create it again below.
      if (r.status !== 401) throw new HttpError(502, "engine_error", `The engine refused the sign-in (${r.status}).`);
    } else {
      // The password is stored before the account exists, so a crash in between can't strand an account nobody can open.
      password = newPassword();
      this.state.setSecret(key, password);
    }
    const up = await this.auth("sign-up", email, password, username.split("@")[0] || username);
    if (up.login) return this.recordAccount(username, email, up.login);
    if (up.status === 422) throw new HttpError(409, "engine_account_conflict", `The engine already has an account for ${username} that this host can't sign in to. An engine administrator needs to remove ${email}.`);
    if (up.status === 429) throw new HttpError(503, "engine_busy", "The engine is limiting sign-ins right now. Try again in a few seconds.");
    throw new HttpError(502, "engine_error", `The engine refused to create the account (${up.status}).`);
  }

  private recordAccount(username: string, email: string, login: EngineLogin): EngineLogin {
    const accounts = this.state.getSetting<Record<string, { email: string; userId: string | null; createdAt: number }>>("engine.accounts") ?? {};
    if (!accounts[username] || accounts[username].userId !== login.userId) {
      accounts[username] = { email, userId: login.userId, createdAt: accounts[username]?.createdAt ?? this.now() };
      this.state.setSetting("engine.accounts", accounts);
    }
    return login;
  }

  /** The service account's own engine session, when it holds the instance admin claim. */
  private async serviceSession(fresh = false): Promise<EngineLogin | null> {
    if ((await this.ensureServiceAccount()).state !== "ours") return null;
    if (this.serviceLogin && !fresh) return this.serviceLogin;
    const password = this.state.getSecret("engine.service.password");
    if (!password) return null;
    const r = await this.auth("sign-in", SERVICE_EMAIL, password);
    return (this.serviceLogin = r.login ?? null);
  }

  /**
   * Proxmox decides who administers the engine: administrators of this node (Sys.Modify on "/") are the engine's
   * instance admins, so they can create organizations; everyone else works in the organizations they're invited to.
   * Called on each sign-in, so taking the right away in Proxmox takes it away here too.
   */
  async syncAdmin(s: Session, nodeAdmin: boolean): Promise<"promoted" | "demoted" | "unchanged" | "unavailable"> {
    await this.loginFor(s);
    return this.syncAdminUser(s.username, nodeAdmin);
  }

  /** The same, for any Proxmox user (access control calls it when an administrator changes someone's device role). */
  async syncAdminUser(username: string, nodeAdmin: boolean): Promise<"promoted" | "demoted" | "unchanged" | "unavailable"> {
    const userId = await this.accountId(username).catch(() => null);
    if (!userId) return "unavailable";
    const admins = this.state.getSetting<Record<string, boolean>>("engine.admins") ?? {};
    if (Boolean(admins[username]) === nodeAdmin) return "unchanged";
    let svc = await this.serviceSession();
    if (!svc) return "unavailable";
    const path = `/api/admin/users/${encodeURIComponent(userId)}/${nodeAdmin ? "promote" : "demote"}-instance-admin`;
    let r = await this.send("POST", path, { cookie: svc.cookie, json: {}, timeoutMs: 15_000 });
    if (r.status === 401) {
      svc = await this.serviceSession(true);
      if (!svc) return "unavailable";
      r = await this.send("POST", path, { cookie: svc.cookie, json: {}, timeoutMs: 15_000 });
    }
    if (r.status < 200 || r.status >= 300) throw new HttpError(502, "engine_error", `The engine refused to ${nodeAdmin ? "make" : "remove"} ${username} ${nodeAdmin ? "an" : "as"} administrator (${r.status}).`);
    this.state.setSetting("engine.admins", { ...admins, [username]: nodeAdmin });
    return nodeAdmin ? "promoted" : "demoted";
  }

  /** Engine answers can refresh the session cookie; keep the refreshed one here, never pass it on. */
  private absorb(login: EngineLogin, setCookie: string[] | undefined) {
    if (setCookie?.length) {
      const next = mergeCookies(login.cookie, setCookie);
      if (next) login.cookie = next;
    }
  }

  /** A JSON call to the engine as this person, renewing their engine session once on 401. */
  async userCall(s: Session, method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    try {
      let login = await this.loginFor(s);
      let r = await this.send(method, path, { cookie: login.cookie, json: body, timeoutMs: 20_000 });
      if (r.status === 401) {
        login = await this.reauth(s, login);
        r = await this.send(method, path, { cookie: login.cookie, json: body, timeoutMs: 20_000 });
      }
      this.absorb(login, r.headers["set-cookie"]);
      return { status: r.status, data: json(r.text) };
    } catch (e) {
      throw e instanceof EngineDown ? engineUnavailable() : e;
    }
  }

  async userJson<T>(s: Session, method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.userCall(s, method, path, body);
    if (r.status >= 200 && r.status < 300) return r.data as T;
    const msg = (r.data as { error?: string } | null)?.error;
    if (r.status === 403) throw new HttpError(403, "forbidden", msg ?? "The engine says you don't have access to this");
    if (r.status === 404) throw new HttpError(404, "not_found", msg ?? "Not found in the engine");
    if (r.status === 400 || r.status === 409 || r.status === 422) throw new HttpError(r.status, "engine_rejected", msg ?? `The engine refused this (${r.status})`);
    throw new HttpError(502, "engine_error", `The engine answered ${r.status}`);
  }

  /** Turns an engine answer into data or a clear HttpError. */
  private static settle<T>(r: { status: number; data: unknown }): T {
    if (r.status >= 200 && r.status < 300) return r.data as T;
    const msg = (r.data as { error?: string } | null)?.error;
    if (r.status === 403) throw new HttpError(403, "forbidden", msg ?? "The engine says you don't have access to this");
    if (r.status === 404) throw new HttpError(404, "not_found", msg ?? "Not found in the engine");
    if (r.status === 400 || r.status === 409 || r.status === 422) throw new HttpError(r.status, "engine_rejected", msg ?? `The engine refused this (${r.status})`);
    throw new HttpError(502, "engine_error", `The engine answered ${r.status}`);
  }

  /**
   * A JSON call as another person's managed engine account (creating it if needed), without their browser session.
   * Used by access control to accept an invitation on someone's behalf after Proxmox has granted them the access.
   */
  async accountJson<T>(username: string, method: string, path: string, body?: unknown): Promise<T> {
    try {
      let login = this.logins.get(username) ?? (await this.signInOnce(username));
      let r = await this.send(method, path, { cookie: login.cookie, json: body, timeoutMs: 20_000 });
      if (r.status === 401) {
        if (this.logins.get(username) === login) this.logins.delete(username);
        login = await this.signInOnce(username);
        r = await this.send(method, path, { cookie: login.cookie, json: body, timeoutMs: 20_000 });
      }
      this.absorb(login, r.headers["set-cookie"]);
      return EngineGateway.settle<T>({ status: r.status, data: json(r.text) });
    } catch (e) {
      throw e instanceof EngineDown ? engineUnavailable() : e;
    }
  }

  /** The engine user id behind a Proxmox user's managed account, creating the account if needed. */
  async accountId(username: string): Promise<string | null> {
    const known = this.state.getSetting<Record<string, { userId: string | null }>>("engine.accounts")?.[username]?.userId;
    if (known) return known;
    const login = this.logins.get(username) ?? (await this.signInOnce(username));
    return login.userId;
  }

  /** Proxmox user names by engine user id, for the managed accounts this host made. */
  accountsByEngineId(): Map<string, string> {
    const accounts = this.state.getSetting<Record<string, { userId: string | null }>>("engine.accounts") ?? {};
    return new Map(Object.entries(accounts).flatMap(([u, a]) => (a.userId ? [[a.userId, u] as [string, string]] : [])));
  }

  /** Whether the service account holds the engine's instance admin claim (and can act across organizations). */
  async serviceReady(): Promise<boolean> {
    return (await this.serviceSession().catch(() => null)) !== null;
  }

  /** A JSON call as the service account (the engine's instance admin). Null when this host doesn't hold the claim. */
  async serviceJson<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    try {
      let svc = await this.serviceSession();
      if (!svc) return null;
      let r = await this.send(method, path, { cookie: svc.cookie, json: body, timeoutMs: 20_000 });
      if (r.status === 401) {
        svc = await this.serviceSession(true);
        if (!svc) return null;
        r = await this.send(method, path, { cookie: svc.cookie, json: body, timeoutMs: 20_000 });
      }
      return EngineGateway.settle<T>({ status: r.status, data: json(r.text) });
    } catch (e) {
      throw e instanceof EngineDown ? engineUnavailable() : e;
    }
  }

  me(s: Session): Promise<BoardAccess> {
    return this.userJson<BoardAccess>(s, "GET", "/api/cli-auth/me");
  }

  /**
   * Forwards a routine webhook to the engine's public trigger route, with no engine login (the engine authenticates the
   * call itself). Used only by the routine ingress (src/routine-ingress.ts), which has already limited who may call it.
   */
  firePublicTrigger(publicId: string, headers: Record<string, string>, body: Buffer): Promise<{ status: number; text: string }> {
    if (!/^[0-9a-f]{24}$/.test(publicId)) return Promise.reject(new HttpError(404, "not_found", "Not found"));
    return new Promise((resolve, reject) => {
      const up = this.open(
        "POST",
        `/api/routine-triggers/public/${publicId}/fire`,
        { ...headers, "content-length": String(body.length) },
        (res) => {
          const parts: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size <= 64 * 1024) parts.push(c);
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 502, text: Buffer.concat(parts).toString("utf8") }));
          res.on("error", () => reject(engineUnavailable()));
        },
        (e) => reject(e instanceof EngineDown ? engineUnavailable() : e),
      );
      up.end(body);
    });
  }

  /** This person's active membership in an organization, or null. */
  async membership(s: Session, companyId: string): Promise<{ role: string } | null> {
    const me = await this.me(s);
    const m = (me.memberships ?? []).find((x) => x.companyId === companyId && x.status === "active");
    return m ? { role: m.membershipRole } : null;
  }

  // ---- The /engine/api proxy

  /** Forwards one browser request to the engine as the signed-in person, streaming both bodies. */
  async forward(req: IncomingMessage, res: ServerResponse, s: Session, maxBytes: number, hooks: ForwardHooks = {}): Promise<void> {
    const method = req.method ?? "GET";
    if (!METHODS.has(method)) throw new HttpError(405, "method", "Method not allowed");
    const target = enginePath(req.url ?? "/", this.extraAllowed);
    const headers: Record<string, string> = {};
    for (const name of REQUEST_HEADERS) {
      const v = req.headers[name];
      if (typeof v === "string") headers[name] = v;
    }
    const announced = headers["content-length"] === undefined ? null : Number(headers["content-length"]);
    if (announced !== null && (!Number.isSafeInteger(announced) || announced < 0)) throw new HttpError(400, "bad_length", "Bad Content-Length");
    if (announced !== null && announced > maxBytes) throw new HttpError(413, "too_large", `Uploads are limited to ${Math.floor(maxBytes / 1024 ** 2)} MiB`);
    const hasBody = method !== "GET" && method !== "HEAD" && (announced ? announced > 0 : req.headers["transfer-encoding"] !== undefined);
    if (!hasBody) delete headers["content-length"];

    // Hold the first part of the body: if it is all there is, the request can be replayed after renewing the session.
    const it = req[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    const held: Buffer[] = [];
    let heldBytes = 0;
    let complete = !hasBody;
    while (!complete && heldBytes <= REPLAY_BYTES) {
      const n = await it.next();
      if (n.done) complete = true;
      else {
        held.push(n.value);
        heldBytes += n.value.length;
        if (heldBytes > maxBytes) throw new HttpError(413, "too_large", `Uploads are limited to ${Math.floor(maxBytes / 1024 ** 2)} MiB`);
      }
    }
    // A caller's check of the request (it may refuse it) while the first part of the body is in hand.
    hooks.inspect?.(method, target, complete ? Buffer.concat(held) : null);
    let streamed = false;

    const attempt = (login: EngineLogin) =>
      new Promise<IncomingMessage>((resolve, reject) => {
        const up = this.open(method, target, { ...headers, Cookie: login.cookie }, resolve, reject);
        void (async () => {
          for (const c of held) if (!up.write(c)) await new Promise((r) => up.once("drain", r));
          if (!complete) {
            streamed = true;
            let seen = heldBytes;
            for (;;) {
              const n = await it.next();
              if (n.done) break;
              seen += n.value.length;
              if (seen > maxBytes) return void up.destroy(new HttpError(413, "too_large", `Uploads are limited to ${Math.floor(maxBytes / 1024 ** 2)} MiB`));
              if (!up.write(n.value)) await new Promise((r) => up.once("drain", r));
            }
          }
          up.end();
        })().catch((e: Error) => up.destroy(e));
      });

    let login: EngineLogin;
    let upRes: IncomingMessage;
    try {
      login = await this.loginFor(s);
      upRes = await attempt(login);
      if (upRes.statusCode === 401) {
        if (!streamed) {
          upRes.resume();
          login = await this.reauth(s, login);
          upRes = await attempt(login);
        } else {
          // A large upload can't be replayed; renew now so the browser's retry works.
          login = await this.reauth(s, login).catch(() => login);
        }
      }
    } catch (e) {
      throw e instanceof EngineDown ? engineUnavailable() : e;
    }
    this.absorb(login, upRes.headers["set-cookie"]);
    hooks.after?.(method, target, upRes.statusCode ?? 0);

    const out: Record<string, string | string[]> = {};
    for (const name of RESPONSE_HEADERS) {
      const v = upRes.headers[name];
      if (v !== undefined) out[name] = v;
    }
    // Whatever the engine serves can't run as a page of this origin: no scripts, no frames, and active types download.
    out["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'; sandbox";
    const type = String(upRes.headers["content-type"] ?? "");
    if (/html|javascript|ecmascript|xml|svg/i.test(type) && !/json/i.test(type) && !out["content-disposition"]) out["content-disposition"] = "attachment";
    res.writeHead(upRes.statusCode ?? 502, out);
    if (method === "HEAD") {
      upRes.resume();
      return void res.end();
    }
    await new Promise<void>((resolve) => {
      upRes.pipe(res);
      upRes.on("error", () => res.destroy());
      res.on("close", () => {
        if (!res.writableFinished) upRes.destroy();
        resolve();
      });
      res.on("finish", resolve);
    });
  }

  // ---- The live-events WebSocket

  /** Relays one organization's live events. The caller has checked the Origin and that `s` is signed in. */
  async relayEvents(req: IncomingMessage, socket: Duplex, head: Buffer, s: Session, alive: () => boolean) {
    const refuse = (status: number, reason: string) => socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    const pathname = new URL(req.url ?? "/", "http://epaperclip").pathname;
    const m = pathname.match(EVENTS_WS);
    if (!m) return refuse(404, "Not Found");
    // The query string is dropped: the engine would take ?token= as an agent key, and only the person's session may be used.
    const target = `${this.url.protocol === "https:" ? "wss" : "ws"}://${this.url.host}/api/companies/${m[1]}/events/ws`;
    // The engine may speak as soon as its side opens, before the browser's upgrade is done: hold those frames until then.
    const early: { data: WebSocket.RawData; isBinary: boolean }[] = [];
    const hold = (data: WebSocket.RawData, isBinary: boolean) => void (early.length < 256 && early.push({ data, isBinary }));
    const connect = (login: EngineLogin) =>
      new Promise<{ ws?: WebSocket; status?: number }>((resolve) => {
        const ws = new WebSocket(target, { headers: { Cookie: login.cookie, Origin: this.publicUrl }, maxPayload: 4 * 1024 * 1024, handshakeTimeout: 10_000, autoPong: false });
        ws.on("message", hold);
        ws.once("open", () => resolve({ ws }));
        ws.once("unexpected-response", (r, res) => {
          res.resume();
          r.destroy();
          resolve({ status: res.statusCode ?? 502 });
        });
        // Stays attached for the socket's life (resolving twice is harmless), so a late error is never unhandled.
        ws.on("error", () => resolve({ status: 503 }));
      });
    let up: { ws?: WebSocket; status?: number };
    try {
      let login = await this.loginFor(s);
      up = await connect(login);
      if (up.status === 401) {
        login = await this.reauth(s, login);
        up = await connect(login);
      }
    } catch (e) {
      return refuse(e instanceof HttpError ? e.status : 503, "Engine Unavailable");
    }
    if (!up.ws) return refuse(up.status === 403 ? 403 : up.status === 404 ? 404 : up.status === 401 ? 401 : 503, up.status === 403 ? "Forbidden" : "Engine Unavailable");
    const engine = up.ws;
    if (socket.destroyed) return void engine.close(1000);
    this.wss.handleUpgrade(req, socket, head, (browser) => {
      browser.on("message", (data, isBinary) => engine.readyState === WebSocket.OPEN && engine.send(data, { binary: isBinary }));
      engine.off("message", hold);
      for (const f of early.splice(0)) browser.send(f.data, { binary: f.isBinary });
      engine.on("message", (data, isBinary) => browser.readyState === WebSocket.OPEN && browser.send(data, { binary: isBinary }));
      // Pings and pongs pass straight through, so each end sees whether the other is still there.
      browser.on("ping", (d) => engine.readyState === WebSocket.OPEN && engine.ping(d));
      browser.on("pong", (d) => engine.readyState === WebSocket.OPEN && engine.pong(d));
      engine.on("ping", (d) => browser.readyState === WebSocket.OPEN && browser.ping(d));
      engine.on("pong", (d) => browser.readyState === WebSocket.OPEN && browser.pong(d));
      browser.on("close", (code, reason) => engine.readyState <= WebSocket.OPEN && engine.close(closeCode(code, false), reason));
      engine.on("close", (code, reason) => browser.readyState <= WebSocket.OPEN && browser.close(closeCode(code, true), reason));
      browser.on("error", () => engine.terminate());
      engine.on("error", () => browser.terminate());
      // The socket belongs to the session: when the session ends, so does the stream.
      const check = setInterval(() => {
        if (alive()) return;
        browser.close(4001, "Session ended");
        engine.close(1000);
      }, 30_000);
      check.unref();
      browser.on("close", () => clearInterval(check));
    });
  }
}
