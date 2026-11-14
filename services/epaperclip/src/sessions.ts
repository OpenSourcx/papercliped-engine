import { createHash, randomBytes } from "node:crypto";

/**
 * Signed-in sessions. The browser holds only an opaque, random session id in an HttpOnly cookie; the user's Proxmox
 * ticket and CSRF token stay here, on the host. Proxmox tickets live two hours, so a session renews its ticket while
 * it is in use and ends after two hours of inactivity or twelve hours in total.
 *
 * Sessions are kept in the host's sealed state (see SessionPersistence), so a restart or an upgrade does not sign
 * anyone out. The limits above, the 8 h federated cap and every way of ending a session (sign-out, a removed or
 * disabled user, an unlinked identity, a password change) still apply, and are written at once. API-token principals
 * are never stored.
 */

export interface Session {
  id: string;
  username: string; // user@realm, as Proxmox reports it
  ticket: string;
  csrf: string;
  createdAt: number;
  renewedAt: number; // when the Proxmox ticket was last issued
  lastSeen: number;
  /** Where and with what this session was opened (for the sessions list). Never a secret. */
  ip?: string;
  agent?: string;
  /** How the person signed in: with a password (and code), or through an OpenID Connect realm. */
  via?: "password" | "openid";
  /** The identity link behind a federated sign-in (never a secret). Unlinking that link ends exactly these sessions. */
  link?: string;
  /** An absolute end earlier than the normal idle/total caps (federated sessions are capped at 8 h). */
  maxAt?: number;
  /** The person's engine session (their managed engine account's cookie). Server-side only, never sent to the browser. */
  engine?: EngineLogin;
  /**
   * Set only on the short-lived principal built for an ePaperclip API token (Bearer). It never lives in the session
   * store, has no Proxmox ticket (`ticket` and `csrf` are empty), and acts on Proxmox with its Proxmox API token.
   */
  apiToken?: ApiTokenPrincipal;
}

export interface ApiTokenPrincipal {
  /** The ePaperclip token's id (public, not the secret). */
  id: string;
  name: string;
  readOnly: boolean;
  /** Privilege-separated: Proxmox limits it to the permissions given to the token itself, which the engine can't see. */
  privsep: boolean;
  /** `user@realm!tokenname`, the Proxmox API token this one maps to. */
  pveTokenId: string;
  /** Its secret, read from the vault for this request only. Never logged, never returned. */
  pveSecret: string;
}

export interface EngineLogin {
  cookie: string; // the Cookie header the engine expects, e.g. "paperclip-default.session_token=..."
  userId: string | null;
  at: number;
}

export interface PendingTfa {
  id: string;
  username: string;
  challenge: string; // Proxmox's partial ticket
  expiresAt: number;
  attempts: number;
}

/** A short public handle for a session, safe to show and to name in a revoke request (the session id itself is the secret). */
export const sessionHandle = (id: string) => createHash("sha256").update("session\0").update(id).digest("hex").slice(0, 16);

export const IDLE_MS = 2 * 3600_000;
export const MAX_MS = 12 * 3600_000;
export const RENEW_AFTER_MS = 15 * 60_000;
const TFA_MS = 5 * 60_000;

const newId = () => randomBytes(32).toString("base64url");

/** Where sessions survive a restart: one sealed value (the vault encrypts it; tickets are credentials). */
export interface SessionPersistence {
  load(): string | null;
  save(value: string): void;
}

/** How often plain use ("last seen") is written to disk; creating, ending and renewing a session are written at once. */
export const PERSIST_TOUCH_MS = 60_000;

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly persistence: SessionPersistence | null;
  private lastSaved = 0;
  private readonly pending = new Map<string, PendingTfa>();
  private readonly now: () => number;
  /** Bumped whenever someone's sessions are ended, so API-token principals of that person are re-checked at once. */
  private readonly epochs = new Map<string, number>();

  constructor(now: () => number = Date.now, persistence: SessionPersistence | null = null) {
    this.now = now;
    this.persistence = persistence;
    this.restore();
  }

  private expired(s: Session, t: number): boolean {
    return t - s.lastSeen > IDLE_MS || t - s.createdAt > MAX_MS || (s.maxAt !== undefined && t >= s.maxAt);
  }

  /** Brings back the sessions saved by an earlier run, dropping any that have expired since. Damaged data starts empty. */
  private restore() {
    if (!this.persistence) return;
    let raw: string | null = null;
    try {
      raw = this.persistence.load();
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { v?: number; sessions?: Session[]; epochs?: Record<string, number> };
      if (parsed.v !== 1 || !Array.isArray(parsed.sessions)) return;
      const t = this.now();
      for (const s of parsed.sessions) {
        if (s && typeof s.id === "string" && typeof s.username === "string" && typeof s.ticket === "string" && typeof s.csrf === "string" && !this.expired(s, t)) this.sessions.set(s.id, s);
      }
      for (const [u, n] of Object.entries(parsed.epochs ?? {})) if (Number.isInteger(n)) this.epochs.set(u, n);
    } catch {
      /* unreadable: nobody is signed in, which is safe */
    }
  }

  /** Writes the live sessions. A failed write never breaks a request: the session just won't outlive this process. */
  private save() {
    if (!this.persistence) return;
    const t = this.now();
    try {
      this.persistence.save(JSON.stringify({ v: 1, sessions: [...this.sessions.values()].filter((s) => !s.apiToken && !this.expired(s, t)), epochs: Object.fromEntries(this.epochs) }));
      this.lastSaved = t;
    } catch {
      /* best effort */
    }
  }

  /** Writes now (for shutdown), so the last few seconds of use are not lost. */
  flush() {
    this.save();
  }

  private touched() {
    if (this.now() - this.lastSaved >= PERSIST_TOUCH_MS) this.save();
  }

  create(username: string, ticket: string, csrf: string, meta: { ip?: string; agent?: string; via?: "password" | "openid"; link?: string; maxAt?: number } = {}): Session {
    const t = this.now();
    const s: Session = { id: newId(), username, ticket, csrf, createdAt: t, renewedAt: t, lastSeen: t, ...(meta.ip ? { ip: meta.ip } : {}), ...(meta.agent ? { agent: meta.agent.slice(0, 200) } : {}), ...(meta.via ? { via: meta.via } : {}), ...(meta.link ? { link: meta.link } : {}), ...(meta.maxAt ? { maxAt: meta.maxAt } : {}) };
    this.sessions.set(s.id, s);
    this.save();
    return s;
  }

  /** Returns a live session and marks it used, or null if it is unknown or expired (and forgets expired ones). */
  get(id: string | undefined): Session | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    const t = this.now();
    if (this.expired(s, t)) {
      this.sessions.delete(id);
      this.save();
      return null;
    }
    s.lastSeen = t;
    this.touched();
    return s;
  }

  /** Like get, but doesn't count as use: for long-lived sockets checking that their session still exists. */
  peek(id: string): Session | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const t = this.now();
    return t - s.lastSeen > IDLE_MS || t - s.createdAt > MAX_MS || (s.maxAt !== undefined && t >= s.maxAt) ? null : s;
  }

  needsRenewal(s: Session): boolean {
    return this.now() - s.renewedAt > RENEW_AFTER_MS;
  }

  renew(s: Session, ticket: string, csrf: string) {
    s.ticket = ticket;
    s.csrf = csrf;
    s.renewedAt = this.now();
    this.save();
  }

  destroy(id: string | undefined) {
    if (id && this.sessions.delete(id)) this.save();
  }

  /** Ends every session of one Proxmox user (their access was removed or disabled). Returns how many ended. */
  destroyUser(username: string): number {
    this.epochs.set(username, (this.epochs.get(username) ?? 0) + 1);
    let n = 0;
    for (const [id, s] of this.sessions) if (s.username === username) (this.sessions.delete(id), n++);
    this.save();
    return n;
  }

  /** Live sessions, optionally of one person, oldest first. */
  list(username?: string): Session[] {
    const t = this.now();
    return [...this.sessions.values()].filter((s) => (!username || s.username === username) && t - s.lastSeen <= IDLE_MS && t - s.createdAt <= MAX_MS && (s.maxAt === undefined || t < s.maxAt)).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Ends every session created through one identity link. Returns how many. */
  destroyLink(linkId: string): number {
    let n = 0;
    for (const [id, s] of this.sessions) if (s.link === linkId) (this.sessions.delete(id), n++);
    if (n) this.save();
    return n;
  }

  /** Ends one session by its public handle, if it belongs to `username` (or to anyone when `username` is null). Returns who it was. */
  destroyByHandle(handle: string, username: string | null): string | null {
    for (const [id, s] of this.sessions) {
      if (sessionHandle(id) !== handle || (username !== null && s.username !== username)) continue;
      this.sessions.delete(id);
      // API tokens of that person are re-checked at once, as when all their sessions end.
      this.epochs.set(s.username, (this.epochs.get(s.username) ?? 0) + 1);
      this.save();
      return s.username;
    }
    return null;
  }

  /** Ends someone's other sessions, keeping one (the person changing their password stays signed in where they are). */
  destroyUserExcept(username: string, keepId: string | undefined): number {
    let n = 0;
    for (const [id, s] of this.sessions) if (s.username === username && id !== keepId) (this.sessions.delete(id), n++);
    if (n) this.save();
    return n;
  }

  /** Changes whenever `destroyUser(username)` runs. */
  epoch(username: string): number {
    return this.epochs.get(username) ?? 0;
  }

  startTfa(username: string, challenge: string): PendingTfa {
    const p: PendingTfa = { id: newId(), username, challenge, expiresAt: this.now() + TFA_MS, attempts: 0 };
    this.pending.set(p.id, p);
    return p;
  }

  /** The pending two-factor step, if it exists and hasn't expired or run out of attempts. */
  getTfa(id: string | undefined): PendingTfa | null {
    if (!id) return null;
    const p = this.pending.get(id);
    if (!p || p.expiresAt < this.now() || p.attempts >= 5) {
      if (p) this.pending.delete(id);
      return null;
    }
    return p;
  }

  endTfa(id: string) {
    this.pending.delete(id);
  }

  sweep() {
    const t = this.now();
    let ended = 0;
    for (const [id, s] of this.sessions) if (this.expired(s, t)) (this.sessions.delete(id), ended++);
    for (const [id, p] of this.pending) if (p.expiresAt < t) this.pending.delete(id);
    if (ended) this.save();
  }

  get size() {
    return this.sessions.size;
  }
}
