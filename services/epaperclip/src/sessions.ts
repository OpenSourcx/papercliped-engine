import { randomBytes } from "node:crypto";

/**
 * Signed-in sessions. The browser holds only an opaque, random session id in an HttpOnly cookie; the user's Proxmox
 * ticket and CSRF token stay here, on the host. Proxmox tickets live two hours, so a session renews its ticket while
 * it is in use and ends after two hours of inactivity or twelve hours in total.
 */

export interface Session {
  id: string;
  username: string; // user@realm, as Proxmox reports it
  ticket: string;
  csrf: string;
  createdAt: number;
  renewedAt: number; // when the Proxmox ticket was last issued
  lastSeen: number;
  /** The person's engine session (their managed engine account's cookie). Server-side only, never sent to the browser. */
  engine?: EngineLogin;
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

export const IDLE_MS = 2 * 3600_000;
export const MAX_MS = 12 * 3600_000;
export const RENEW_AFTER_MS = 15 * 60_000;
const TFA_MS = 5 * 60_000;

const newId = () => randomBytes(32).toString("base64url");

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, PendingTfa>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  create(username: string, ticket: string, csrf: string): Session {
    const t = this.now();
    const s: Session = { id: newId(), username, ticket, csrf, createdAt: t, renewedAt: t, lastSeen: t };
    this.sessions.set(s.id, s);
    return s;
  }

  /** Returns a live session and marks it used, or null if it is unknown or expired (and forgets expired ones). */
  get(id: string | undefined): Session | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    const t = this.now();
    if (t - s.lastSeen > IDLE_MS || t - s.createdAt > MAX_MS) {
      this.sessions.delete(id);
      return null;
    }
    s.lastSeen = t;
    return s;
  }

  /** Like get, but doesn't count as use: for long-lived sockets checking that their session still exists. */
  peek(id: string): Session | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const t = this.now();
    return t - s.lastSeen > IDLE_MS || t - s.createdAt > MAX_MS ? null : s;
  }

  needsRenewal(s: Session): boolean {
    return this.now() - s.renewedAt > RENEW_AFTER_MS;
  }

  renew(s: Session, ticket: string, csrf: string) {
    s.ticket = ticket;
    s.csrf = csrf;
    s.renewedAt = this.now();
  }

  destroy(id: string | undefined) {
    if (id) this.sessions.delete(id);
  }

  /** Ends every session of one Proxmox user (their access was removed or disabled). Returns how many ended. */
  destroyUser(username: string): number {
    let n = 0;
    for (const [id, s] of this.sessions) if (s.username === username) (this.sessions.delete(id), n++);
    return n;
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
    for (const [id, s] of this.sessions) if (t - s.lastSeen > IDLE_MS || t - s.createdAt > MAX_MS) this.sessions.delete(id);
    for (const [id, p] of this.pending) if (p.expiresAt < t) this.pending.delete(id);
  }

  get size() {
    return this.sessions.size;
  }
}
