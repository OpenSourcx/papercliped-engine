import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { ProxmoxClient, ProxmoxError } from "@papercliped-engine/proxmox-client";
import { HttpError } from "../http.ts";
import type { ApiTokenPrincipal, Session, SessionStore } from "../sessions.ts";
import type { StateStore } from "../state.ts";
import type { FeatureCtx } from "./index.ts";

/**
 * ePaperclip API tokens: long-lived Bearer credentials for automation.
 *
 * A token is `epc_<id>_<secret>`. The host keeps only a salted SHA-256 of the secret plus metadata (state setting
 * "apiTokens"). The host acts on Proxmox with the person's ticket, which expires, so each token maps to a real Proxmox
 * API token of that person (`<user>!epc-<id>`); that token's secret is sealed in the vault and used as
 * `PVEAPIToken=...` when a Bearer request arrives. No Proxmox password is ever kept.
 */

export const TOKEN_RE = /^epc_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
const SETTING = "apiTokens";
const AUDIT = "audit";
const AUDIT_MAX = 500;
const DAY = 86_400_000;
export const MAX_LIFETIME_DAYS = 366;
export const DEFAULT_LIFETIME_DAYS = 90;

export interface TokenRecord {
  id: string;
  name: string;
  userid: string;
  createdAt: number;
  expiresAt: number;
  readOnly: boolean;
  privsep: boolean;
  /** The Proxmox token name (without the user), `epc-<id>`. */
  pveName: string;
  salt: string;
  hash: string;
  lastUsedAt: number | null;
}

export type PublicToken = Omit<TokenRecord, "salt" | "hash">;

export interface AuditEntry {
  at: number;
  actor: string;
  action: string;
  target?: string;
  detail?: string;
  ip?: string;
}

const hashOf = (salt: string, secret: string) => createHash("sha256").update(salt).update("\0").update(secret).digest("hex");
const secretName = (id: string) => `apitoken.${id}`;
export const pveTokenName = (id: string) => `epc-${id}`;
export const isManagedPveToken = (name: string) => /^epc-[0-9a-f]{16}$/.test(name);

export function appendAudit(state: StateStore, now: () => number, e: Omit<AuditEntry, "at">) {
  const list = state.getSetting<AuditEntry[]>(AUDIT) ?? [];
  list.push({ at: now(), ...e });
  state.setSetting(AUDIT, list.slice(-AUDIT_MAX));
}

export const readAudit = (state: StateStore): AuditEntry[] => state.getSetting<AuditEntry[]>(AUDIT) ?? [];

const records = (state: StateStore) => state.getSetting<Record<string, TokenRecord>>(SETTING) ?? {};
const toPublic = ({ salt: _s, hash: _h, ...rest }: TokenRecord): PublicToken => rest;

export const listTokens = (state: StateStore, userid?: string): PublicToken[] =>
  Object.values(records(state))
    .filter((r) => !userid || r.userid === userid)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(toPublic);

export const getToken = (state: StateStore, id: string): TokenRecord | undefined => records(state)[id];

/** Stores a new token; returns the string to show once. */
export function storeToken(state: StateStore, now: () => number, p: { name: string; userid: string; expiresAt: number; readOnly: boolean; privsep: boolean; pveSecret: string; id: string; secret: string }): PublicToken {
  const salt = randomBytes(16).toString("hex");
  const rec: TokenRecord = { id: p.id, name: p.name, userid: p.userid, createdAt: now(), expiresAt: p.expiresAt, readOnly: p.readOnly, privsep: p.privsep, pveName: pveTokenName(p.id), salt, hash: hashOf(salt, p.secret), lastUsedAt: null };
  state.setSecret(secretName(p.id), p.pveSecret);
  try {
    state.setSetting(SETTING, { ...records(state), [p.id]: rec });
  } catch (e) {
    state.deleteSecret(secretName(p.id));
    throw e;
  }
  return toPublic(rec);
}

export function removeToken(state: StateStore, id: string): TokenRecord | undefined {
  const all = records(state);
  const rec = all[id];
  if (!rec) return undefined;
  delete all[id];
  state.setSetting(SETTING, all);
  state.deleteSecret(secretName(id));
  return rec;
}

/** Revokes every ePaperclip API token of one person (their Proxmox user was deleted). Returns how many. */
export function revokeAllForUser(state: StateStore, userid: string): number {
  let n = 0;
  for (const r of Object.values(records(state))) if (r.userid === userid && removeToken(state, r.id)) n++;
  return n;
}

export function newTokenParts() {
  const id = randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return { id, secret, token: `epc_${id}_${secret}` };
}

/** Failure counter keyed by client address: too many bad tokens locks that address out for a while. */
class FailureLimiter {
  private readonly fails = new Map<string, { n: number; first: number }>();
  private readonly now: () => number;
  private readonly max = 10;
  private readonly windowMs = 5 * 60_000;
  constructor(now: () => number) {
    this.now = now;
  }
  blocked(k: string) {
    const f = this.fails.get(k);
    return f !== undefined && this.now() - f.first < this.windowMs && f.n >= this.max;
  }
  fail(k: string) {
    const t = this.now();
    if (this.fails.size > 10_000) for (const [key, f] of this.fails) if (t - f.first >= this.windowMs) this.fails.delete(key);
    const f = this.fails.get(k);
    this.fails.set(k, !f || t - f.first >= this.windowMs ? { n: 1, first: t } : { n: f.n + 1, first: f.first });
  }
}

/** Bearer authentication for the host's HTTP API. One instance per app. */
export class BearerAuth {
  private readonly principals = new WeakMap<IncomingMessage, Session>();
  private readonly failures: FailureLimiter;
  private readonly valid = new Map<string, { at: number; epoch: number }>();
  private readonly usage = new Map<string, { n: number; start: number }>();
  private readonly auditedAt = new Map<string, number>();
  private readonly persistedUse = new Map<string, number>();

  private readonly o: {
      state: StateStore;
      sessions: SessionStore;
      now: () => number;
      pve: (tokenId: string, secret: string) => ProxmoxClient;
      /** Requests per token per minute. */
      perMinute?: number;
      /** How long a successful Proxmox check of the mapped token is trusted. */
      recheckMs?: number;
  };

  constructor(o: BearerAuth["o"]) {
    this.o = o;
    this.failures = new FailureLimiter(o.now);
  }

  /** The principal built for this request by `attach`, if it carried a valid Bearer token. */
  principal(req: IncomingMessage): Session | undefined {
    return this.principals.get(req);
  }

  /** Read-only tokens may only read. */
  guard(s: Session, req: IncomingMessage) {
    if (s.apiToken?.readOnly && req.method !== "GET" && req.method !== "HEAD") throw new HttpError(403, "read_only_token", "This API token is read-only, so it can't make changes");
  }

  private audit(action: string, ip: string, actor: string, detail?: string, target?: string) {
    // One failure entry per address and kind per minute, so a flood can't churn the log or the state file.
    if (action.endsWith(".failed")) {
      const k = `${action}|${ip}`;
      const last = this.auditedAt.get(k) ?? 0;
      if (this.o.now() - last < 60_000) return;
      if (this.auditedAt.size > 5000) this.auditedAt.clear();
      this.auditedAt.set(k, this.o.now());
    }
    try {
      appendAudit(this.o.state, this.o.now, { actor, action, ip, ...(detail ? { detail } : {}), ...(target ? { target } : {}) });
    } catch {
      /* the audit trail must never break a request */
    }
  }

  private reject(ip: string, why: string, actor = "unknown"): never {
    this.failures.fail(ip);
    this.audit("token.use.failed", ip, actor, why);
    throw new HttpError(401, "invalid_token", "That API token isn't valid");
  }

  /** Authenticates `Authorization: Bearer epc_...`; on success the request has a principal. Throws 401/403/429 otherwise. */
  async attach(req: IncomingMessage): Promise<void> {
    const header = req.headers.authorization;
    if (header === undefined) return;
    const m = /^Bearer[ ]+(\S+)$/i.exec(header);
    if (!m) return; // Some other scheme: not ours.
    const ip = req.socket.remoteAddress ?? "?";
    if (this.failures.blocked(ip)) throw new HttpError(429, "too_many_attempts", "Too many invalid API tokens from this address. Wait a few minutes.");
    if (!m[1].startsWith("epc_")) return; // Not ours (the engine strips Authorization before forwarding).
    const parts = TOKEN_RE.exec(m[1]);
    if (!parts) return this.reject(ip, "malformed");
    const [, id, secret] = parts;
    const rec = getToken(this.o.state, id);
    // Always hash, even for unknown ids, so timing doesn't tell which ids exist.
    const salt = rec?.salt ?? "0".repeat(32);
    const got = Buffer.from(hashOf(salt, secret), "hex");
    const want = Buffer.from(rec?.hash ?? "0".repeat(64), "hex");
    const same = got.length === want.length && timingSafeEqual(got, want);
    if (!rec || !same) return this.reject(ip, rec ? "wrong secret" : "unknown token", rec ? `token ${id}` : "unknown");
    const t = this.o.now();
    if (rec.expiresAt <= t) {
      this.audit("token.use.failed", ip, rec.userid, "expired", `token ${id}`);
      throw new HttpError(401, "token_expired", "This API token has expired");
    }
    const u = this.usage.get(id);
    const limit = this.o.perMinute ?? 600;
    if (!u || t - u.start >= 60_000) this.usage.set(id, { n: 1, start: t });
    else if (++u.n > limit) throw new HttpError(429, "rate_limited", "This API token is making too many requests. Slow down.");

    let pveSecret: string | null = null;
    try {
      pveSecret = this.o.state.getSecret(secretName(id));
    } catch {
      pveSecret = null;
    }
    if (!pveSecret) {
      this.audit("token.use.failed", ip, rec.userid, "missing Proxmox token", `token ${id}`);
      throw new HttpError(401, "token_invalid", "This API token can no longer be used. Create a new one.");
    }
    const pveId = `${rec.userid}!${rec.pveName}`;
    // Is the mapped Proxmox token (and its user) still good? Checked at most once a minute, and at once after the
    // person's sessions were ended (disabled, deleted, access removed).
    const epoch = this.o.sessions.epoch(rec.userid);
    const ok = this.valid.get(id);
    if (!ok || t - ok.at > (this.o.recheckMs ?? 60_000) || ok.epoch !== epoch) {
      try {
        await this.o.pve(pveId, pveSecret).version();
      } catch (e) {
        if (e instanceof ProxmoxError && (e.status === 401 || e.status === 403)) {
          this.valid.delete(id);
          this.audit("token.use.failed", ip, rec.userid, "Proxmox rejected the mapped token", `token ${id}`);
          throw new HttpError(401, "token_invalid", "Proxmox no longer accepts this API token (the user was disabled or removed, or its Proxmox token was deleted)");
        }
        throw e;
      }
      this.valid.set(id, { at: t, epoch });
    }
    const principal: ApiTokenPrincipal = { id, name: rec.name, readOnly: rec.readOnly, pveTokenId: pveId, pveSecret };
    this.principals.set(req, { id: `token:${id}`, username: rec.userid, ticket: "", csrf: "", createdAt: rec.createdAt, renewedAt: t, lastSeen: t, apiToken: principal });
    // Remember when it was last used, writing the state file at most every five minutes per token.
    if (t - (this.persistedUse.get(id) ?? 0) > 5 * 60_000) {
      this.persistedUse.set(id, t);
      try {
        const all = records(this.o.state);
        if (all[id]) this.o.state.setSetting(SETTING, { ...all, [id]: { ...all[id], lastUsedAt: t } });
      } catch {
        /* best effort */
      }
    }
  }

  /** Proxmox answered 401 to a token principal: stop trusting it until it is checked again. */
  rejectedByProxmox(s: Session, req: IncomingMessage) {
    if (!s.apiToken) return;
    this.valid.delete(s.apiToken.id);
    this.audit("token.use.failed", req.socket.remoteAddress ?? "?", s.username, "Proxmox rejected the mapped token", `token ${s.apiToken.id}`);
  }
}

// ---- Routes: creating, listing and revoking tokens (cookie sessions only).

const enc = encodeURIComponent;

function cookieOnly(ctx: FeatureCtx): Session {
  const s = ctx.session();
  if (s.apiToken) throw new HttpError(403, "ticket_only", "API tokens can't create or revoke API tokens. Sign in to the console to do that.");
  return s;
}

export async function handleEpcTokens(ctx: FeatureCtx): Promise<boolean> {
  const { method, path } = ctx;
  if (path === "/api/access/epc-tokens" && method === "GET") {
    const s = ctx.session();
    const all = ctx.url.searchParams.get("all") === "1";
    const admin = all ? await ctx.asUser((pve) => ctx.isNodeAdmin(pve)) : false;
    ctx.json(200, { tokens: listTokens(ctx.state, admin ? undefined : s.username), scope: admin ? "all" : "mine", maxDays: MAX_LIFETIME_DAYS, defaultDays: DEFAULT_LIFETIME_DAYS });
    return true;
  }
  if (path === "/api/access/epc-tokens" && method === "POST") {
    ctx.sameSite();
    const s = cookieOnly(ctx);
    const b = await ctx.readJson();
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, "bad_request", "Give the token a name of up to 64 characters");
    const days = b.expiresInDays === undefined ? DEFAULT_LIFETIME_DAYS : b.expiresInDays;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_LIFETIME_DAYS) throw new HttpError(400, "bad_request", `Expiry is between 1 and ${MAX_LIFETIME_DAYS} days`);
    if (b.readOnly !== undefined && typeof b.readOnly !== "boolean") throw new HttpError(400, "bad_request", "readOnly must be true or false");
    if (b.privsep !== undefined && typeof b.privsep !== "boolean") throw new HttpError(400, "bad_request", "privsep must be true or false");
    const readOnly = b.readOnly === true;
    const privsep = b.privsep === true;
    const { id, secret, token } = newTokenParts();
    const expiresAt = ctx.now() + days * DAY;
    const pveName = pveTokenName(id);
    const created = await ctx.asUser((pve) =>
      pve.callFull<{ value?: string }>("POST", `/access/users/${enc(s.username)}/token/${enc(pveName)}`, { comment: `ePaperclip API token: ${name}`.slice(0, 120), expire: Math.floor(expiresAt / 1000), privsep }),
    );
    const value = created.data?.value;
    if (!value) throw new HttpError(502, "proxmox_error", "Proxmox didn't return a token secret");
    let pub: PublicToken;
    try {
      pub = storeToken(ctx.state, ctx.now, { name, userid: s.username, expiresAt, readOnly, privsep, pveSecret: value, id, secret });
    } catch (e) {
      await ctx.asUser((pve) => pve.call("DELETE", `/access/users/${enc(s.username)}/token/${enc(pveName)}`)).catch(() => {});
      throw e;
    }
    appendAudit(ctx.state, ctx.now, { actor: s.username, action: "token.create", target: `token ${id}`, detail: `${name}${readOnly ? " (read-only)" : ""}`, ip: ctx.req.socket.remoteAddress ?? "?" });
    ctx.json(201, { token, record: pub, proxmoxTokenId: `${s.username}!${pveName}`, note: privsep ? "Privilege-separated: this token has no permissions until you give it ACLs in Roles & permissions." : "This token acts as you, with all your permissions." });
    return true;
  }
  const one = path.match(/^\/api\/access\/epc-tokens\/([0-9a-f]{16})$/);
  if (one && method === "DELETE") {
    ctx.sameSite();
    const s = cookieOnly(ctx);
    const rec = getToken(ctx.state, one[1]);
    if (!rec) throw new HttpError(404, "not_found", "No such API token");
    if (rec.userid !== s.username) {
      const admin = await ctx.asUser((pve) => ctx.isNodeAdmin(pve));
      if (!admin) throw new HttpError(403, "forbidden", "Only the token's owner or a Proxmox administrator can revoke it");
    }
    removeToken(ctx.state, rec.id); // Dead for ePaperclip from this moment.
    appendAudit(ctx.state, ctx.now, { actor: s.username, action: "token.revoke", target: `token ${rec.id}`, detail: `${rec.name} (${rec.userid})`, ip: ctx.req.socket.remoteAddress ?? "?" });
    const warnings: string[] = [];
    await ctx
      .asUser((pve) => pve.call("DELETE", `/access/users/${enc(rec.userid)}/token/${enc(rec.pveName)}`))
      .catch((e: Error) => warnings.push(`The token is revoked here, but its Proxmox token (${rec.userid}!${rec.pveName}) couldn't be deleted: ${e.message}`));
    ctx.json(200, { ok: true, warnings });
    return true;
  }
  return false;
}
