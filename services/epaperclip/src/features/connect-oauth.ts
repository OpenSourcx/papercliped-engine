import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { ProxmoxError } from "@papercliped-engine/proxmox-client";
import { HttpError } from "../http.ts";
import type { Session } from "../sessions.ts";
import type { StateStore } from "../state.ts";
import { appendAudit, getToken, newTokenParts, pveTokenName, removeToken, storeToken } from "./access-tokens.ts";
import { CHALLENGE_RE, FailureCounter, type RedirectAllow, checkAllowEntry, RateWindow, VERIFIER_RE, checkRedirectUri, cleanText, hashSecret, newHexId, newSalt, newSecret, pkceMatches, redirectMatches, sameHash } from "./connect-util.ts";

/**
 * The OAuth 2.1 authorization server for MCP clients (Claude, ChatGPT, Codex, any MCP client), docs/CONNECTORS.md.
 *
 * - Public clients register themselves (RFC 7591) with strict redirect addresses; there are no client secrets, so
 *   PKCE (S256) is mandatory. Authorization codes live 60 seconds in memory and work once.
 * - A signed-in person approves on a console page (the cookie is SameSite=Strict, so it only reaches our own page).
 *   Approving mints a real Proxmox API token of that person, `<user>!epc-<id>`, sealed in the vault, and the grant
 *   points at it. Everything the app then does goes through that token, so Proxmox keeps deciding what is allowed and
 *   removing the person or the token in Proxmox ends the app's access at once.
 * - The app never sees that token. It gets an opaque access token (`epo_`, one hour) and a refresh token (`epr_`,
 *   rotated on every use; a refresh token used twice ends the grant). Only salted SHA-256 hashes are kept.
 * - Two access levels: Read only (`paperclip:read`) and Full control (`paperclip:control`).
 */

export const SCOPE_READ = "paperclip:read";
export const SCOPE_CONTROL = "paperclip:control";
export type Scope = typeof SCOPE_READ | typeof SCOPE_CONTROL;
export const SCOPES: { id: Scope; label: string; description: string }[] = [
  { id: SCOPE_READ, label: "Read only", description: "See this host, its machines and storage, and your organizations, agents and tasks. Nothing can be changed." },
  { id: SCOPE_CONTROL, label: "Full control", description: "Everything in Read only, plus acting for you: create tasks, comment, wake and pause agents, decide approvals, and propose host changes for you to approve." },
];

export const ACCESS_TTL_MS = 60 * 60_000;
export const GRANT_TTL_MS = 90 * 86_400_000;
const CODE_TTL_MS = 60_000;
const PENDING_TTL_MS = 10 * 60_000;
const UNUSED_CLIENT_MS = 24 * 3600_000;
const MAX_CLIENTS = 500;
const REDIRECT_ALLOW = "connect.redirectAllow";
const MAX_REDIRECT_ALLOW = 50;
const MAX_GRANTS_PER_USER = 30;

const ACCESS_RE = /^epo_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
const REFRESH_RE = /^epr_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

export interface ClientRec {
  id: string;
  name: string;
  redirectUris: string[];
  createdAt: number;
  /** Set once a person approved this client; clients that never get approved are forgotten after a day. */
  authorizedAt: number | null;
}

interface Hashed {
  salt: string;
  hash: string;
}

export interface GrantRec {
  id: string;
  clientId: string;
  clientName: string;
  /** Where the app sends people back to (host only, shown on the consent and revoke screens). */
  redirectHost: string;
  userid: string;
  scope: Scope;
  /** Full control only: host changes (power, snapshots) run at once instead of becoming a plan the person approves. */
  direct: boolean;
  /** Organization ids the app may reach; null means all the person's organizations. */
  orgs: string[] | null;
  /** The ePaperclip API-token record (and Proxmox token `epc-<id>`) this grant acts through. */
  tokenId: string;
  status: "pending" | "active";
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  access?: Hashed & { expiresAt: number };
  refresh?: Hashed;
  /** Hashes of refresh tokens that were already used. Seeing one again means a copy was stolen. */
  usedRefresh: string[];
}

export type PublicGrant = Omit<GrantRec, "access" | "refresh" | "usedRefresh"> & { clientHost: string };

interface CodeRec {
  grantId: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  expiresAt: number;
  used: boolean;
}

export interface McpPrincipal {
  session: Session;
  grant: GrantRec;
}

export interface AuthRequest {
  client: ClientRec;
  redirectUri: string;
  scope: Scope;
  state: string | null;
  challenge: string;
  resource: string | null;
}

export interface ConnectOptions {
  state: StateStore;
  now: () => number;
  /** A Proxmox client for a Proxmox API token. Read-only grants get one whose transport refuses anything but GET. */
  pve: (tokenId: string, secret: string, readOnly: boolean) => ProxmoxClient;
  /** Epoch of a person's sessions: bumps when their access is removed, so the app's Proxmox token is re-checked at once. */
  epoch: (userid: string) => number;
  /** The address people use to reach this device, when known (otherwise taken from the request's Host header). */
  publicUrl?: string;
  secure: boolean;
}

const CLIENTS = "oauth.clients";
const GRANTS = "oauth.grants";
const ORPHANS = "oauth.orphans";
const MCP_LOG = "connect.log";
const MCP_LOG_MAX = 500;

export interface McpLogEntry {
  at: number;
  grantId: string;
  user: string;
  client: string;
  tool: string;
  ok: boolean;
  control: boolean;
  note?: string;
}

const refreshSalt = (grantId: string) => `refresh:${grantId}`;
const oauthError = (status: number, error: string, description: string) => new HttpError(status, error, description);

/** The service behind the OAuth endpoints, the MCP endpoint and the console's connected-apps screens. One per host service. */
export class ConnectService {
  readonly o: ConnectOptions;
  private readonly codes = new Map<string, CodeRec>();
  private readonly failures: FailureCounter;
  readonly registerLimit: RateWindow;
  readonly tokenLimit: RateWindow;
  readonly consentLimit: RateWindow;
  readonly mcpLimit: RateWindow;
  readonly toolLimit: RateWindow;
  private readonly valid = new Map<string, { at: number; epoch: number }>();
  private readonly persistedUse = new Map<string, number>();

  constructor(o: ConnectOptions) {
    this.o = o;
    this.failures = new FailureCounter(20, 5 * 60_000, o.now);
    this.registerLimit = new RateWindow(10, 3600_000, o.now);
    this.tokenLimit = new RateWindow(60, 60_000, o.now);
    this.consentLimit = new RateWindow(20, 60_000, o.now);
    this.mcpLimit = new RateWindow(240, 60_000, o.now);
    this.toolLimit = new RateWindow(90, 60_000, o.now);
  }

  // ---- Where we are

  /** `https://host` as people reach this device. */
  origin(req: IncomingMessage): string {
    if (this.o.publicUrl) return this.o.publicUrl.replace(/\/+$/, "");
    const host = String(req.headers.host ?? "");
    if (!/^(?:[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:]{2,45}\])(?::\d{1,5})?$/.test(host)) throw new HttpError(400, "bad_host", "Unusable Host header");
    return `${this.o.secure ? "https" : "http"}://${host}`;
  }

  // ---- Storage

  private clients = (): Record<string, ClientRec> => this.o.state.getSetting<Record<string, ClientRec>>(CLIENTS) ?? {};
  private grants = (): Record<string, GrantRec> => this.o.state.getSetting<Record<string, GrantRec>>(GRANTS) ?? {};
  private saveGrants = (g: Record<string, GrantRec>) => this.o.state.setSetting(GRANTS, g);
  client = (id: string): ClientRec | undefined => this.clients()[id];
  grant = (id: string): GrantRec | undefined => this.grants()[id];
  private audit(actor: string, action: string, target?: string, detail?: string, ip?: string) {
    try {
      appendAudit(this.o.state, this.o.now, { actor, action, ...(target ? { target } : {}), ...(detail ? { detail } : {}), ...(ip ? { ip } : {}) });
    } catch {
      /* the audit trail must never break a request */
    }
  }
  auditFor(actor: string, action: string, target?: string, detail?: string, ip?: string) {
    this.audit(actor, action, target, detail, ip);
  }

  /** The app-call log: every tool call, newest last, kept apart from the main audit trail so reads can't push lifecycle events out. */
  logCall(e: Omit<McpLogEntry, "at">) {
    try {
      const list = this.o.state.getSetting<McpLogEntry[]>(MCP_LOG) ?? [];
      list.push({ at: this.o.now(), ...e });
      this.o.state.setSetting(MCP_LOG, list.slice(-MCP_LOG_MAX));
    } catch {
      /* best effort */
    }
  }
  callLog = (): McpLogEntry[] => this.o.state.getSetting<McpLogEntry[]>(MCP_LOG) ?? [];

  // ---- Custom-scheme redirect addresses an administrator allowed (cursor://, vscode://). Empty by default: apps get https and loopback only.

  redirectAllow(): RedirectAllow[] {
    const v = this.o.state.getSetting<RedirectAllow[]>(REDIRECT_ALLOW);
    return Array.isArray(v) ? v : [];
  }

  addRedirectAllow(rawUri: unknown, rawKind: unknown, who: string, ip?: string): RedirectAllow {
    const e = checkAllowEntry(rawUri, rawKind);
    const list = this.redirectAllow();
    if (list.some((x) => x.uri === e.uri && x.kind === e.kind)) throw oauthError(409, "conflict", "That address is already allowed.");
    if (list.length >= MAX_REDIRECT_ALLOW) throw oauthError(409, "conflict", `At most ${MAX_REDIRECT_ALLOW} addresses can be allowed. Remove one you no longer need.`);
    const entry: RedirectAllow = { uri: e.uri, kind: e.kind, addedBy: who, addedAt: this.o.now() };
    this.o.state.setSetting(REDIRECT_ALLOW, [...list, entry]);
    this.audit(who, "oauth.redirect_allow", e.uri, `allowed ${e.kind} ${e.uri}`, ip);
    return entry;
  }

  removeRedirectAllow(uri: string, kind: unknown, who: string, ip?: string): boolean {
    const list = this.redirectAllow();
    const rest = list.filter((x) => !(x.uri === uri && x.kind === kind));
    if (rest.length === list.length) return false;
    this.o.state.setSetting(REDIRECT_ALLOW, rest);
    this.audit(who, "oauth.redirect_remove", uri, `no longer allowed: ${kind} ${uri}`, ip);
    return true;
  }

  // ---- Registration (RFC 7591)

  register(body: Record<string, unknown>, ip: string): Record<string, unknown> {
    if (!this.registerLimit.take(ip)) throw oauthError(429, "slow_down", "Too many registrations from this address. Try again later.");
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5) throw oauthError(400, "invalid_redirect_uri", "Send 1 to 5 redirect addresses.");
    let redirectUris: string[];
    try {
      const allow = this.redirectAllow();
      redirectUris = [...new Set(uris.map((u) => checkRedirectUri(u, allow)))];
    } catch (e) {
      throw oauthError(400, "invalid_redirect_uri", e instanceof HttpError ? e.message : "Bad redirect address.");
    }
    const method = body.token_endpoint_auth_method;
    if (method !== undefined && method !== "none") throw oauthError(400, "invalid_client_metadata", "Only public clients (token_endpoint_auth_method none) are supported; they use PKCE.");
    for (const [k, allowed] of [["grant_types", ["authorization_code", "refresh_token"]], ["response_types", ["code"]]] as const) {
      const v = body[k];
      if (v !== undefined && (!Array.isArray(v) || v.length > 4 || !v.every((x) => typeof x === "string" && (allowed as readonly string[]).includes(x)))) throw oauthError(400, "invalid_client_metadata", `Unsupported ${k}.`);
    }
    if (body.scope !== undefined && (typeof body.scope !== "string" || !this.parseScope(body.scope, true))) throw oauthError(400, "invalid_client_metadata", "Unknown scope.");
    const name = cleanText(body.client_name, 80) || "An MCP app";
    const all = this.clients();
    const t = this.o.now();
    // Apps that registered but were never approved are forgotten after a day, and the table has a ceiling.
    for (const [id, c] of Object.entries(all)) if (!c.authorizedAt && t - c.createdAt > UNUSED_CLIENT_MS) delete all[id];
    if (Object.keys(all).length >= MAX_CLIENTS) throw oauthError(503, "temporarily_unavailable", "Too many registered apps. Remove unused ones in Connected apps.");
    const id = `epc_client_${randomBytes(12).toString("base64url")}`;
    all[id] = { id, name, redirectUris, createdAt: t, authorizedAt: null };
    this.o.state.setSetting(CLIENTS, all);
    this.audit("anonymous", "oauth.register", id, `${name}: ${redirectUris.map((u) => new URL(u).host).join(", ")}`, ip);
    return { client_id: id, client_id_issued_at: Math.floor(t / 1000), client_name: name, redirect_uris: redirectUris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: `${SCOPE_READ} ${SCOPE_CONTROL}` };
  }

  /** "paperclip:read paperclip:control" -> the highest asked for. Unknown scopes are an error. Returns null when invalid (and `lenient`). */
  parseScope(raw: string | null | undefined, lenient = false): Scope | null {
    const parts = (raw ?? "").split(/[ ]+/).filter(Boolean);
    if (parts.length === 0) return SCOPE_READ;
    if (!parts.every((p) => p === SCOPE_READ || p === SCOPE_CONTROL)) {
      if (lenient) return null;
      throw oauthError(400, "invalid_scope", "Only paperclip:read and paperclip:control exist.");
    }
    return parts.includes(SCOPE_CONTROL) ? SCOPE_CONTROL : SCOPE_READ;
  }

  // ---- Authorization request

  /** Checks an authorization request. Errors here are shown on the console page; nothing is redirected to an unchecked address. */
  validateAuthRequest(q: URLSearchParams, origin: string): AuthRequest {
    const get = (k: string) => q.get(k);
    const client = this.client(get("client_id") ?? "");
    if (!client) throw oauthError(400, "invalid_client", "This app isn't registered here. Remove it from the app and add it again.");
    const uri = get("redirect_uri");
    if (!uri) throw oauthError(400, "invalid_request", "The app sent no redirect address.");
    let redirectUri: string;
    try {
      redirectUri = checkRedirectUri(uri, this.redirectAllow());
    } catch {
      throw oauthError(400, "invalid_request", "The app's redirect address isn't allowed.");
    }
    if (!redirectMatches(client.redirectUris, redirectUri)) throw oauthError(400, "invalid_request", "The app's redirect address doesn't match the one it registered.");
    if (get("response_type") !== "code") throw oauthError(400, "unsupported_response_type", "Only response_type=code is supported.");
    const challenge = get("code_challenge") ?? "";
    if (!CHALLENGE_RE.test(challenge) || get("code_challenge_method") !== "S256") throw oauthError(400, "invalid_request", "The app must use PKCE with S256.");
    const scope = this.parseScope(get("scope"));
    const resource = get("resource");
    if (resource !== null && ![origin, `${origin}/`, `${origin}/mcp`].includes(resource)) throw oauthError(400, "invalid_target", "The app asked for a different server than this one.");
    const state = get("state");
    if (state !== null && (state.length > 1024 || /[\u0000-\u001f\u007f]/.test(state))) throw oauthError(400, "invalid_request", "The state value is not acceptable.");
    return { client, redirectUri, scope: scope!, state, challenge, resource };
  }

  /** The address to send the person back to, with a code or an error. */
  redirectWith(req: AuthRequest, origin: string, params: Record<string, string>): string {
    const u = new URL(req.redirectUri);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (req.state !== null) u.searchParams.set("state", req.state);
    u.searchParams.set("iss", origin);
    return u.href;
  }

  /** Creates the grant for an approval and the one-time code. The Proxmox token and its ePaperclip record already exist. */
  createGrant(p: { req: AuthRequest; userid: string; direct: boolean; orgs: string[] | null; tokenId: string }): { code: string; grant: GrantRec } {
    const t = this.o.now();
    const all = this.grants();
    // Approvals nobody finished are dropped; their Proxmox tokens are removed the next time the person is signed in.
    for (const [id, g] of Object.entries(all)) if (g.status === "pending" && t - g.createdAt > PENDING_TTL_MS) this.dropGrantRecord(all, id);
    if (Object.values(all).filter((g) => g.userid === p.userid).length >= MAX_GRANTS_PER_USER) throw new HttpError(409, "too_many_apps", `You have ${MAX_GRANTS_PER_USER} connected apps already. Revoke ones you don't use.`);
    const id = newHexId();
    const grant: GrantRec = {
      id, clientId: p.req.client.id, clientName: p.req.client.name, redirectHost: new URL(p.req.redirectUri).host, userid: p.userid, scope: p.req.scope,
      direct: p.req.scope === SCOPE_CONTROL && p.direct, orgs: p.orgs, tokenId: p.tokenId, status: "pending", createdAt: t, expiresAt: t + GRANT_TTL_MS, lastUsedAt: null, usedRefresh: [],
    };
    all[id] = grant;
    this.saveGrants(all);
    const clients = this.clients();
    if (clients[p.req.client.id]) {
      clients[p.req.client.id].authorizedAt = t;
      this.o.state.setSetting(CLIENTS, clients);
    }
    const code = randomBytes(32).toString("base64url");
    this.pruneCodes();
    this.codes.set(createHash("sha256").update(code).digest("hex"), { grantId: id, clientId: grant.clientId, redirectUri: p.req.redirectUri, challenge: p.req.challenge, expiresAt: t + CODE_TTL_MS, used: false });
    return { code, grant };
  }

  private pruneCodes() {
    const t = this.o.now();
    for (const [k, c] of this.codes) if (c.expiresAt < t) this.codes.delete(k);
  }

  // ---- Token endpoint

  async token(body: Record<string, unknown>, ip: string): Promise<Record<string, unknown>> {
    if (this.failures.blocked(ip)) throw oauthError(429, "slow_down", "Too many bad requests from this address. Wait a few minutes.");
    if (!this.tokenLimit.take(ip)) throw oauthError(429, "slow_down", "Too many requests. Slow down.");
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
    const bad = (status: number, error: string, why: string): never => {
      this.failures.fail(ip);
      throw oauthError(status, error, why);
    };
    const type = str("grant_type");
    if (type === "authorization_code") {
      const entry = this.codes.get(createHash("sha256").update(str("code")).digest("hex"));
      if (!entry) return bad(400, "invalid_grant", "That code is not valid.");
      const grant = this.grant(entry.grantId);
      if (entry.used) {
        // A code presented twice: someone copied it. Nothing issued from it may live.
        if (grant) await this.revoke(entry.grantId, "system", "authorization code reused");
        return bad(400, "invalid_grant", "That code was already used.");
      }
      entry.used = true;
      if (entry.expiresAt < this.o.now()) return bad(400, "invalid_grant", "That code expired.");
      if (!grant || grant.status !== "pending") return bad(400, "invalid_grant", "That code is not valid.");
      if (str("client_id") !== entry.clientId) return bad(400, "invalid_grant", "That code belongs to another app.");
      if (str("redirect_uri") !== entry.redirectUri) return bad(400, "invalid_grant", "The redirect address doesn't match the authorization request.");
      if (!pkceMatches(str("code_verifier"), entry.challenge)) return bad(400, "invalid_grant", "The PKCE check failed.");
      const resource = str("resource");
      if (resource && !resource.endsWith("/mcp") && !/^https?:\/\/[^/]+\/?$/.test(resource)) return bad(400, "invalid_target", "Unknown resource.");
      this.audit(grant.userid, "oauth.token", `grant ${grant.id}`, `${grant.clientName}: authorized (${grant.scope})`, ip);
      return this.issue(grant.id);
    }
    if (type === "refresh_token") {
      const m = REFRESH_RE.exec(str("refresh_token"));
      if (!m) return bad(400, "invalid_grant", "That refresh token is not valid.");
      const grant = this.grant(m[1]);
      // Refresh secrets are 256 random bits, so a fixed per-grant salt is enough, and it lets us recognise one that was already rotated away.
      const h = hashSecret(refreshSalt(m[1]), m[2]);
      if (!grant || grant.status !== "active") return bad(400, "invalid_grant", "That refresh token is not valid.");
      if (grant.refresh && sameHash(h, grant.refresh.hash)) {
        if (str("client_id") !== grant.clientId) return bad(400, "invalid_grant", "That refresh token belongs to another app.");
        if (grant.expiresAt <= this.o.now()) return bad(400, "invalid_grant", "This connection expired. Add it again.");
        if (!getToken(this.o.state, grant.tokenId)) return bad(400, "invalid_grant", "This connection was revoked.");
        const out = this.issue(grant.id);
        this.audit(grant.userid, "oauth.refresh", `grant ${grant.id}`, grant.clientName, ip);
        return out;
      }
      // Not the current refresh token: if it was one we already rotated away, it was copied. End the grant.
      const old = grant.usedRefresh.some((u) => sameHash(u, h));
      if (old) {
        await this.revoke(grant.id, "system", "refresh token reused");
        return bad(400, "invalid_grant", "That refresh token was already used, so this connection was ended for safety. Add it again.");
      }
      return bad(400, "invalid_grant", "That refresh token is not valid.");
    }
    return bad(400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
  }

  /** New access and refresh tokens for a grant; the previous refresh token is remembered (as a hash) to catch reuse. */
  private issue(grantId: string): Record<string, unknown> {
    const all = this.grants();
    const g = all[grantId];
    const t = this.o.now();
    const access = newSecret();
    const refresh = newSecret();
    if (g.refresh) g.usedRefresh = [...g.usedRefresh, g.refresh.hash].slice(-5);
    const aSalt = newSalt();
    g.access = { salt: aSalt, hash: hashSecret(aSalt, access), expiresAt: t + ACCESS_TTL_MS };
    g.refresh = { salt: refreshSalt(g.id), hash: hashSecret(refreshSalt(g.id), refresh) };
    g.status = "active";
    this.saveGrants(all);
    return { access_token: `epo_${g.id}_${access}`, token_type: "Bearer", expires_in: Math.floor(ACCESS_TTL_MS / 1000), refresh_token: `epr_${g.id}_${refresh}`, scope: g.scope };
  }

  // ---- Using an access token

  /** The 401 for /mcp: tells the app where to find the authorization server (RFC 9728). */
  challenge(req: IncomingMessage, error?: string): HttpError & { headers: Record<string, string> } {
    const origin = this.origin(req);
    const e = new HttpError(401, error ?? "unauthorized", error ? "That access token isn't valid. Reconnect the app." : "Connect this app to ePaperclip first.") as HttpError & { headers: Record<string, string> };
    e.headers = { "WWW-Authenticate": `Bearer realm="ePaperclip", resource_metadata="${origin}/.well-known/oauth-protected-resource"${error ? `, error="invalid_token"` : `, scope="${SCOPE_READ}"`}` };
    return e;
  }

  /** Authenticates `Authorization: Bearer epo_...`. Throws a 401 with the RFC 9728 challenge when it isn't good. */
  async authenticate(req: IncomingMessage): Promise<McpPrincipal> {
    const ip = req.socket.remoteAddress ?? "?";
    const header = req.headers.authorization;
    const m = header ? /^Bearer[ ]+(\S+)$/i.exec(header) : null;
    if (!m) throw this.challenge(req);
    if (this.failures.blocked(ip)) throw new HttpError(429, "too_many_attempts", "Too many invalid tokens from this address. Wait a few minutes.");
    const parts = ACCESS_RE.exec(m[1]);
    if (!parts) {
      this.failures.fail(ip);
      throw this.challenge(req, "invalid_token");
    }
    const grant = this.grant(parts[1]);
    // Always hash, even for an unknown grant, so timing doesn't tell which exist.
    const h = hashSecret(grant?.access?.salt ?? "0".repeat(32), parts[2]);
    if (!grant || !grant.access || !sameHash(h, grant.access.hash)) {
      this.failures.fail(ip);
      throw this.challenge(req, "invalid_token");
    }
    const t = this.o.now();
    if (grant.status !== "active" || grant.access.expiresAt <= t || grant.expiresAt <= t) throw this.challenge(req, "invalid_token");
    if (!this.mcpLimit.take(`grant:${grant.id}`)) throw new HttpError(429, "rate_limited", "This app is making too many requests. Slow down.");
    // The grant acts through its Proxmox API token. Revoking it in the Access screen, deleting the person, or Proxmox
    // refusing the token all end the app's access.
    const rec = getToken(this.o.state, grant.tokenId);
    let secret: string | null = null;
    try {
      secret = rec ? this.o.state.getSecret(`apitoken.${grant.tokenId}`) : null;
    } catch {
      secret = null;
    }
    if (!rec || !secret || rec.expiresAt <= t) throw this.challenge(req, "invalid_token");
    const pveId = `${rec.userid}!${rec.pveName}`;
    const epoch = this.o.epoch(rec.userid);
    const ok = this.valid.get(grant.id);
    if (!ok || t - ok.at > 60_000 || ok.epoch !== epoch) {
      try {
        await this.o.pve(pveId, secret, true).version();
      } catch (e) {
        if (e instanceof ProxmoxError && (e.status === 401 || e.status === 403)) {
          this.valid.delete(grant.id);
          this.audit(rec.userid, "oauth.use.failed", `grant ${grant.id}`, "Proxmox rejected the mapped token", ip);
          throw this.challenge(req, "invalid_token");
        }
        throw e;
      }
      this.valid.set(grant.id, { at: t, epoch });
    }
    if (t - (this.persistedUse.get(grant.id) ?? 0) > 5 * 60_000) {
      this.persistedUse.set(grant.id, t);
      try {
        const all = this.grants();
        if (all[grant.id]) {
          all[grant.id].lastUsedAt = t;
          this.saveGrants(all);
        }
      } catch {
        /* best effort */
      }
    }
    const session: Session = {
      id: `oauth:${grant.id}`, username: rec.userid, ticket: "", csrf: "", createdAt: grant.createdAt, renewedAt: t, lastSeen: t,
      apiToken: { id: rec.id, name: rec.name, readOnly: false, privsep: false, pveTokenId: pveId, pveSecret: secret },
    };
    return { session, grant };
  }

  /** The person's Proxmox client for a grant: Read only grants get one that cannot send anything but GET. */
  clientFor(p: McpPrincipal): ProxmoxClient {
    const a = p.session.apiToken!;
    return this.o.pve(a.pveTokenId, a.pveSecret, p.grant.scope === SCOPE_READ);
  }

  // ---- The console's side: list, change, revoke

  list(userid?: string): PublicGrant[] {
    return Object.values(this.grants())
      .filter((g) => g.status === "active" && (!userid || g.userid === userid))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ access: _a, refresh: _r, usedRefresh: _u, ...rest }) => ({ ...rest, clientHost: rest.redirectHost }));
  }

  /** Changes what an active grant may do. Only its owner (or an administrator) calls this, from the console. */
  update(id: string, patch: { scope?: Scope; direct?: boolean; orgs?: string[] | null }, who: string): GrantRec {
    const all = this.grants();
    const g = all[id];
    if (!g || g.status !== "active") throw new HttpError(404, "not_found", "No such connected app");
    if (patch.scope !== undefined) g.scope = patch.scope;
    if (patch.direct !== undefined) g.direct = patch.direct;
    if (patch.orgs !== undefined) g.orgs = patch.orgs;
    if (g.scope === SCOPE_READ) g.direct = false;
    this.saveGrants(all);
    this.audit(who, "oauth.update", `grant ${id}`, `${g.clientName}: ${g.scope}${g.direct ? ", direct" : ""}${g.orgs ? `, ${g.orgs.length} org(s)` : ""}`);
    return g;
  }

  private dropGrantRecord(all: Record<string, GrantRec>, id: string) {
    const g = all[id];
    if (!g) return;
    delete all[id];
    removeToken(this.o.state, g.tokenId);
    this.valid.delete(id);
    // The Proxmox token can only be deleted by its owner with a ticket. Remember it for the next signed-in request.
    const orphans = this.o.state.getSetting<{ userid: string; pveName: string }[]>(ORPHANS) ?? [];
    orphans.push({ userid: g.userid, pveName: pveTokenName(g.tokenId) });
    this.o.state.setSetting(ORPHANS, orphans.slice(-200));
  }

  /** Ends a grant now: its tokens stop working and its Proxmox token is queued for deletion. Returns what it was. */
  async revoke(id: string, who: string, why?: string): Promise<GrantRec | undefined> {
    const all = this.grants();
    const g = all[id];
    if (!g) return undefined;
    this.dropGrantRecord(all, id);
    this.saveGrants(all);
    this.audit(who, "oauth.revoke", `grant ${id}`, `${g.clientName} (${g.userid})${why ? `: ${why}` : ""}`);
    return g;
  }

  /** Deletes queued Proxmox tokens of the signed-in person (and, for an administrator, of anyone). */
  async sweepOrphans(pve: ProxmoxClient, userid: string, admin: boolean): Promise<{ deleted: number; failed: number }> {
    const orphans = this.o.state.getSetting<{ userid: string; pveName: string }[]>(ORPHANS) ?? [];
    if (!orphans.length) return { deleted: 0, failed: 0 };
    const keep: typeof orphans = [];
    let deleted = 0;
    let failed = 0;
    for (const o of orphans) {
      if (o.userid !== userid && !admin) {
        keep.push(o);
        continue;
      }
      try {
        await pve.call("DELETE", `/access/users/${encodeURIComponent(o.userid)}/token/${encodeURIComponent(o.pveName)}`);
        deleted++;
      } catch (e) {
        // Already gone is fine; anything else stays queued.
        const gone = e instanceof ProxmoxError && (e.status === 404 || /does not exist|no such/i.test(e.detail ?? ""));
        if (gone) deleted++;
        else {
          failed++;
          keep.push(o);
        }
      }
    }
    this.o.state.setSetting(ORPHANS, keep);
    return { deleted, failed };
  }

  /** RFC 7009: the app gives up its tokens. Always answers the same, whatever was sent. */
  async revokeByToken(body: Record<string, unknown>) {
    const tok = typeof body.token === "string" ? body.token : "";
    const m = ACCESS_RE.exec(tok) ?? REFRESH_RE.exec(tok);
    if (!m) return;
    const g = this.grant(m[1]);
    if (!g || (typeof body.client_id === "string" && body.client_id !== g.clientId)) return;
    const isAccess = tok.startsWith("epo_");
    const part = isAccess ? g.access : g.refresh;
    if (part && sameHash(hashSecret(part.salt, m[2]), part.hash)) await this.revoke(g.id, g.userid, "revoked by the app");
  }

  /** Pending approvals that were never finished and expired grants, removed. */
  sweepExpired() {
    const t = this.o.now();
    const all = this.grants();
    let changed = false;
    for (const [id, g] of Object.entries(all)) {
      if ((g.status === "pending" && t - g.createdAt > PENDING_TTL_MS) || g.expiresAt <= t) {
        this.dropGrantRecord(all, id);
        changed = true;
      }
    }
    if (changed) this.saveGrants(all);
  }

  /** Apps that registered but never got approved can be forgotten at once. */
  forgetClient(id: string) {
    const all = this.clients();
    delete all[id];
    this.o.state.setSetting(CLIENTS, all);
  }
}

// One service per state store, so the routes (which only see the request context) can find it.
const registry = new WeakMap<StateStore, ConnectService>();
export const registerConnect = (state: StateStore, s: ConnectService) => void registry.set(state, s);
export const connectOf = (state: StateStore): ConnectService | undefined => registry.get(state);

export { VERIFIER_RE, newTokenParts, storeToken };
