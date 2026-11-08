import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { LIMITS, ServerHandshake, fingerprint, generateIdentity, select, sha256hex, verificationString, newPairingSecret, encodePairing, type Candidate, type Capabilities, type Heartbeat, type Identity, type Requirements, type Transport, endpointsFor, type SchedRequest } from "@papercliped-engine/worker-fabric";
import type { StateStore } from "../state.ts";
import { HttpError } from "../http.ts";

/**
 * The Worker Fabric hub: the durable registry of adopted workers and everything the host decides about them. It owns
 * identity, pairing, sessions, leases, scheduling and the audit trail (docs/WORKER-FABRIC.md). Sockets are handed in
 * through `accept`, so the same code runs behind the real listener and in tests.
 *
 * State that must survive a restart (workers, public keys, deny list, pairings by hash, leases, control tokens, audit)
 * is in `state.json` under the `fabric` setting; live connections and heartbeats are memory only.
 */

export interface WorkerRec {
  id: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  state: "adopted" | "revoked";
  companies: string[] | null;
  shellSlots: number;
  inferenceSlots: number;
  draining: boolean;
  disabled: boolean;
  createdAt: number;
  adoptedBy: string;
  lastSeen: number | null;
  version: string | null;
  capabilities: Capabilities | null;
  transport: { provider: string; address: string } | null;
  /** Workspace paths whose removal is still owed to this worker (it was offline when a lease was destroyed). */
  cleanup: string[];
}
interface PairingRec { id: string; name: string; hash: string; createdAt: number; expiresAt: number; companies: string[] | null; by: string }
export interface LeaseRec {
  id: string;
  workerId: string;
  companyId: string;
  agentId: string;
  runId: string;
  environmentId: string;
  workspace: string;
  state: "active" | "released" | "stopped" | "destroyed";
  needsInference: boolean;
  createdAt: number;
  releasedAt?: number;
}
export interface AuditRec { n: number; at: number; actor: string; action: string; workerId?: string; detail?: string }
interface Stored {
  hostPublic?: string;
  workers: Record<string, WorkerRec>;
  pairings: Record<string, PairingRec>;
  denied: string[];
  leases: Record<string, LeaseRec>;
  tokens: Record<string, string>;
  audit: AuditRec[];
  seq: number;
}
export interface PendingRec { id: string; publicKey: string; fingerprint: string; verification: string; name: string; capabilities: Capabilities | null; requestedAt: number; expiresAt: number; remote: string }

/** What the hub needs from a socket: the `ws` WebSocket fits. */
export interface Sock {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", cb: (data: Buffer | string) => void): unknown;
  on(event: "close", cb: () => void): unknown;
  on(event: "error", cb: (e: Error) => void): unknown;
}
type Session = { seal(v: unknown): string; open<T = unknown>(f: string): T };
interface Conn { sock: Sock; session: Session; workerId: string; lastFrame: number; hb: Heartbeat | null; calls: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>; execs: Map<string, Exec> }
interface Exec { onOut: (stream: "stdout" | "stderr", data: string) => void; resolve: (r: ExecResult) => void; leaseId: string; secrets: string[] }
export interface ExecResult { exitCode: number | null; signal: string | null; timedOut: boolean }
interface PendingConn { rec: PendingRec; conn: { sock: Sock; session: Session }; settle: (r: { approved: true; name: string; companies: string[] | null; by: string } | { approved: false }) => void }

export interface HubOptions {
  state: StateStore;
  now?: () => number;
  /** Where workers should connect: provider URLs for pairing codes. */
  transports?: () => Transport[];
  /** Shell slots for a worker that reports `cores` and has no limit set. */
  heartbeatMs?: number;
}

const SETTING = "fabric";
const AUDIT_MAX = 600;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const sanitizeKey = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[.-]+/, "").slice(0, 64) || "x";
const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export class FabricHub {
  readonly state: StateStore;
  private readonly now: () => number;
  private readonly host: Identity;
  private readonly conns = new Map<string, Conn>();
  private readonly pending = new Map<string, PendingConn>();
  private readonly listeners = new Set<(event: string, data: unknown) => void>();
  private readonly hbMs: number;
  private readonly transports: () => Transport[];
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly unauthed = new Map<string, number>();

  constructor(o: HubOptions) {
    this.state = o.state;
    this.now = o.now ?? Date.now;
    this.hbMs = o.heartbeatMs ?? LIMITS.heartbeatMs;
    this.transports = o.transports ?? (() => []);
    let priv = this.state.getSecret("fabric.hostKey");
    let pub = this.read().hostPublic;
    if (!priv || !pub) {
      const id = generateIdentity();
      priv = id.privatePem;
      pub = id.publicKey;
      this.state.setSecret("fabric.hostKey", priv);
      this.write({ ...this.read(), hostPublic: pub });
    }
    this.host = { privatePem: priv, publicKey: pub };
  }

  // ---- state

  private read(): Stored {
    const s = this.state.getSetting<Stored>(SETTING);
    return { workers: {}, pairings: {}, denied: [], leases: {}, tokens: {}, audit: [], seq: 0, ...s };
  }
  private write(s: Stored) {
    this.state.setSetting(SETTING, s);
  }
  private mutate<T>(fn: (s: Stored) => T): T {
    const s = this.read();
    const r = fn(s);
    this.write(s);
    return r;
  }

  hostKey(): { publicKey: string; fingerprint: string } {
    return { publicKey: this.host.publicKey, fingerprint: fingerprint(this.host.publicKey) };
  }

  // ---- audit and events

  audit(actor: string, action: string, workerId?: string, detail?: string) {
    this.mutate((s) => {
      s.seq += 1;
      s.audit.push({ n: s.seq, at: this.now(), actor, action, ...(workerId ? { workerId } : {}), ...(detail ? { detail: detail.slice(0, 300) } : {}) });
      if (s.audit.length > AUDIT_MAX) s.audit.splice(0, s.audit.length - AUDIT_MAX);
    });
    this.emit("audit", { action, workerId });
  }
  auditList(o: { after?: number; limit?: number; workerId?: string } = {}): { events: AuditRec[]; latest: number } {
    const s = this.read();
    let ev = s.audit.filter((e) => e.n > (o.after ?? 0) && (!o.workerId || e.workerId === o.workerId));
    ev = ev.slice(-(Math.min(Math.max(o.limit ?? 200, 1), 500)));
    return { events: ev, latest: s.seq };
  }
  subscribe(cb: (event: string, data: unknown) => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }
  private emit(event: string, data: unknown) {
    for (const l of this.listeners) {
      try {
        l(event, data);
      } catch {
        /* a slow or broken subscriber must not break the hub */
      }
    }
  }

  // ---- views

  private candidate(w: WorkerRec, leases: LeaseRec[]): Candidate {
    const mine = leases.filter((l) => l.workerId === w.id && l.state === "active");
    return {
      id: w.id, name: w.name, state: w.state, online: this.online(w.id), draining: w.draining, disabled: w.disabled, companies: w.companies,
      shellSlots: w.shellSlots, inferenceSlots: w.inferenceSlots, shellLeases: mine.length, inferenceLeases: mine.filter((l) => l.needsInference).length,
      freeMemMb: this.conns.get(w.id)?.hb?.freeMemMb ?? null, capabilities: w.capabilities,
    };
  }
  online(workerId: string): boolean {
    const c = this.conns.get(workerId);
    return !!c && this.now() - c.lastFrame < this.hbMs * 3;
  }
  workerView(w: WorkerRec) {
    const c = this.conns.get(w.id);
    const leases = Object.values(this.read().leases).filter((l) => l.workerId === w.id && l.state === "active");
    return {
      id: w.id, name: w.name, state: w.state, online: this.online(w.id), draining: w.draining, disabled: w.disabled, fingerprint: w.fingerprint, version: w.version,
      lastSeen: c ? this.now() : w.lastSeen, connectedSince: c ? c.lastFrame : null, transport: w.transport, companies: w.companies, shellSlots: w.shellSlots, inferenceSlots: w.inferenceSlots,
      usage: { shellLeases: leases.length, inferenceRunning: c?.hb?.inferenceRunning ?? 0, inferenceQueued: c?.hb?.inferenceQueued ?? 0, loadAvg: c?.hb?.loadAvg ?? null, freeMemMb: c?.hb?.freeMemMb ?? null },
      capabilities: w.capabilities,
    };
  }
  workers() {
    return Object.values(this.read().workers).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map((w) => this.workerView(w));
  }
  worker(id: string): WorkerRec | undefined {
    return this.read().workers[id];
  }
  leases(workerId?: string): LeaseRec[] {
    return Object.values(this.read().leases).filter((l) => !workerId || l.workerId === workerId).sort((a, b) => b.createdAt - a.createdAt);
  }
  /** The key fingerprint of a request that was just approved (it leaves the pending list when it settles). */
  pendingFingerprint(id: string): string | null {
    return this.pending.get(id)?.rec.fingerprint ?? this.lastApproved.get(id) ?? null;
  }
  private readonly lastApproved = new Map<string, string>();
  pendingList() {
    this.expirePending();
    return [...this.pending.values()].map((p) => p.rec);
  }

  // ---- pairing

  /** Issues a single-use pairing code. The secret is returned once; only its hash is kept. */
  createPairing(by: string, o: { name?: string; companies?: string[] | null; transport?: string | null } = {}): { id: string; code: string; expiresAt: number } {
    const id = randomBytes(8).toString("hex");
    const secret = newPairingSecret();
    const rec: PairingRec = { id, name: (o.name ?? "").slice(0, 80), hash: sha256hex(secret), createdAt: this.now(), expiresAt: this.now() + LIMITS.pairingTtlMs, companies: o.companies ?? null, by };
    const urls = endpointsFor(this.transports(), o.transport);
    if (!urls.length) throw new HttpError(409, "no_transport", "No network address is available for workers to reach this host. Join a tailnet, or set EPC_FABRIC_PUBLIC_URL.");
    this.mutate((s) => {
      for (const [k, p] of Object.entries(s.pairings)) if (p.expiresAt < this.now()) delete s.pairings[k];
      if (Object.keys(s.pairings).length >= 50) throw new HttpError(429, "too_many_pairings", "Too many unused pairing codes. Cancel some first.");
      s.pairings[id] = rec;
    });
    this.audit(by, "pairing.create", undefined, rec.name || id);
    return { id, code: encodePairing({ urls, hostKey: this.host.publicKey, id, secret }), expiresAt: rec.expiresAt };
  }
  pairings() {
    const t = this.now();
    return Object.values(this.read().pairings).filter((p) => p.expiresAt > t).map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, expiresAt: p.expiresAt }));
  }
  cancelPairing(by: string, id: string) {
    const had = this.mutate((s) => delete s.pairings[id]);
    if (had) this.audit(by, "pairing.cancel", undefined, id);
    return had;
  }
  /** Consumes a pairing atomically: the second use of one code always fails. */
  private consumePairing(p: { id: string; secret: string }): PairingRec | null {
    if (typeof p.id !== "string" || typeof p.secret !== "string") return null;
    return this.mutate((s) => {
      const rec = s.pairings[p.id];
      if (!rec) return null;
      // Gone for good whether or not this attempt is right: guessing burns the code.
      delete s.pairings[p.id];
      if (rec.expiresAt < this.now() || !eq(rec.hash, sha256hex(p.secret))) return null;
      return rec;
    });
  }

  private expirePending() {
    for (const [id, p] of this.pending) if (p.rec.expiresAt < this.now()) p.settle({ approved: false });
  }
  approvePending(by: string, id: string, o: { name?: string; companies?: string[] | null } = {}) {
    const p = this.pending.get(id);
    if (!p || p.rec.expiresAt < this.now()) throw new HttpError(404, "not_found", "That adoption request is gone or expired.");
    this.lastApproved.set(id, p.rec.fingerprint);
    if (this.lastApproved.size > 50) this.lastApproved.delete(this.lastApproved.keys().next().value as string);
    p.settle({ approved: true, name: (o.name ?? p.rec.name).slice(0, 80), companies: o.companies ?? null, by });
  }
  denyPending(by: string, id: string) {
    const p = this.pending.get(id);
    if (!p) throw new HttpError(404, "not_found", "That adoption request is gone.");
    this.audit(by, "adopt.deny", undefined, p.rec.verification);
    p.settle({ approved: false });
  }

  private adopt(publicKey: string, name: string, companies: string[] | null, by: string, caps: Capabilities | null, remote: string): WorkerRec {
    const fp = fingerprint(publicKey);
    return this.mutate((s) => {
      if (s.denied.includes(fp)) throw new Error("denied");
      const id = `wrk_${randomBytes(6).toString("hex")}`;
      const cores = caps?.cpu.cores ?? 2;
      const rec: WorkerRec = {
        id, name: name.trim() || caps?.hostname || id, publicKey, fingerprint: fp, state: "adopted", companies, shellSlots: Math.max(1, Math.floor(cores / 2)),
        inferenceSlots: caps?.inference ? 1 : 0, draining: false, disabled: false, createdAt: this.now(), adoptedBy: by, lastSeen: null, version: null, capabilities: caps, transport: { provider: "unknown", address: remote }, cleanup: [],
      };
      s.workers[id] = rec;
      return rec;
    });
  }

  // ---- connections

  /**
   * Takes a freshly accepted socket through the handshake. A worker never sees why it was refused: an unknown,
   * revoked or mismatched identity all end in the same close.
   */
  accept(sock: Sock, remote: string) {
    const hs = new ServerHandshake(this.host);
    let stage: "hello" | "auth" | "run" = "hello";
    let helloMode: "auth" | "adopt" = "auth";
    let helloWorker: string | undefined;
    let conn: Conn | null = null;
    const slot = this.unauthed.get(remote) ?? 0;
    if (slot >= 8) return void sock.terminate();
    this.unauthed.set(remote, slot + 1);
    let released = false;
    const freeSlot = () => {
      if (released) return;
      released = true;
      const n = (this.unauthed.get(remote) ?? 1) - 1;
      if (n <= 0) this.unauthed.delete(remote);
      else this.unauthed.set(remote, n);
    };
    const deadline = setTimeout(() => { if (stage !== "run") sock.terminate(); }, 15_000);
    deadline.unref();
    const reject = (action: string, detail?: string) => {
      this.audit("worker", action, helloWorker, `${remote}${detail ? ` ${detail}` : ""}`);
      sock.close(4403, "refused");
    };
    sock.on("error", () => {});
    sock.on("close", () => {
      clearTimeout(deadline);
      freeSlot();
      if (conn) this.dropConn(conn);
    });
    sock.on("message", (data) => {
      const text = typeof data === "string" ? data : data.toString("utf8");
      void (async () => {
        try {
          if (stage === "hello") {
            const { hello, challenge } = hs.onHello(text);
            helloMode = hello.mode;
            helloWorker = hello.workerId;
            stage = "auth";
            sock.send(challenge);
            return;
          }
          if (stage === "auth") {
            stage = "run";
            const { session, auth } = hs.onAuth(text);
            freeSlot();
            conn = await this.authenticate(sock, session, helloMode, helloWorker, auth, remote);
            if (!conn) return sock.close(4403, "refused");
            clearTimeout(deadline);
            return;
          }
          if (conn) this.onFrame(conn, text);
        } catch (e) {
          if (stage === "run" && conn) {
            this.audit("worker", "channel.error", conn.workerId, (e as Error).message);
            sock.close(4400, "bad frame");
          } else reject("handshake.failed", (e as Error).message);
        }
      })();
    });
  }

  private async authenticate(sock: Sock, session: Session, mode: "auth" | "adopt", wantId: string | undefined, auth: { pub: string; pairing?: { id: string; secret: string }; name?: string; caps?: Capabilities }, remote: string): Promise<Conn | null> {
    const s = this.read();
    const fp = fingerprint(auth.pub);
    if (s.denied.includes(fp)) return void this.audit("worker", "connect.revoked", wantId, `${remote} ${fp}`), null;
    const known = Object.values(s.workers).find((w) => w.publicKey === auth.pub);
    let rec: WorkerRec | null = null;
    if (known) {
      if (known.state !== "adopted") return void this.audit("worker", "connect.revoked", known.id, remote), null;
      if (mode === "auth" && wantId !== known.id) return void this.audit("worker", "connect.identity_mismatch", wantId, remote), null;
      rec = known;
    } else if (mode === "auth") {
      return void this.audit("worker", "connect.unknown", wantId, `${remote} ${fp}`), null;
    } else {
      const caps = auth.caps ?? null;
      if (auth.pairing) {
        const p = this.consumePairing(auth.pairing);
        if (!p) return void this.audit("worker", "pairing.rejected", undefined, `${remote} ${fp}`), null;
        rec = this.adopt(auth.pub, (auth.name || p.name), p.companies, p.by, caps, remote);
        this.audit(p.by, "worker.adopt", rec.id, `pairing ${p.id}`);
      } else {
        const decision = await this.waitForApproval(sock, session, auth, caps, remote);
        if (!decision.approved) return void this.audit("worker", "adopt.denied", undefined, `${remote} ${fp}`), null;
        rec = this.adopt(auth.pub, decision.name, decision.companies, decision.by, caps, remote);
        this.audit(decision.by, "worker.adopt", rec.id, "approved request");
      }
    }
    return this.attach(sock, session, rec, remote);
  }

  private waitForApproval(sock: Sock, session: Session, auth: { pub: string; name?: string }, caps: Capabilities | null, remote: string) {
    this.expirePending();
    if (this.pending.size >= LIMITS.maxPending) return Promise.resolve({ approved: false as const });
    const id = randomBytes(6).toString("hex");
    const rec: PendingRec = { id, publicKey: auth.pub, fingerprint: fingerprint(auth.pub), verification: verificationString(auth.pub), name: (auth.name || caps?.hostname || "").slice(0, 80), capabilities: caps, requestedAt: this.now(), expiresAt: this.now() + LIMITS.pairingTtlMs, remote };
    return new Promise<{ approved: true; name: string; companies: string[] | null; by: string } | { approved: false }>((resolve) => {
      const done = (r: { approved: true; name: string; companies: string[] | null; by: string } | { approved: false }) => {
        if (!this.pending.delete(id)) return;
        this.emit("pending", { id });
        resolve(r);
      };
      this.pending.set(id, { rec, conn: { sock, session }, settle: done });
      sock.on("close", () => done({ approved: false }));
      try {
        sock.send(session.seal({ ev: "pending", id, verification: rec.verification, expiresAt: rec.expiresAt }));
      } catch {
        done({ approved: false });
      }
      this.audit("worker", "adopt.request", undefined, `${rec.verification} ${remote}`);
      this.emit("pending", { id });
    });
  }

  private attach(sock: Sock, session: Session, rec: WorkerRec, remote: string): Conn {
    const old = this.conns.get(rec.id);
    if (old) {
      old.sock.close(4409, "replaced");
      this.dropConn(old);
    }
    const conn: Conn = { sock, session, workerId: rec.id, lastFrame: this.now(), hb: null, calls: new Map(), execs: new Map() };
    this.conns.set(rec.id, conn);
    this.mutate((s) => {
      const w = s.workers[rec.id]!;
      w.lastSeen = this.now();
      w.transport = { provider: w.transport?.provider ?? "unknown", address: remote };
    });
    this.send(conn, { ev: "ready", workerId: rec.id, name: rec.name, hbMs: this.hbMs });
    this.audit("worker", "worker.connect", rec.id, remote);
    this.emit("worker", { id: rec.id });
    // Anything owed from while it was away.
    const owed = this.worker(rec.id)?.cleanup ?? [];
    for (const path of owed) void this.call(rec.id, "ws.remove", { path }).then(() => this.mutate((s) => { const w = s.workers[rec.id]; if (w) w.cleanup = w.cleanup.filter((p) => p !== path); })).catch(() => {});
    return conn;
  }

  private dropConn(conn: Conn) {
    if (this.conns.get(conn.workerId) === conn) {
      this.conns.delete(conn.workerId);
      this.mutate((s) => { const w = s.workers[conn.workerId]; if (w) w.lastSeen = this.now(); });
      this.audit("worker", "worker.disconnect", conn.workerId);
      this.emit("worker", { id: conn.workerId });
    }
    for (const c of conn.calls.values()) { clearTimeout(c.timer); c.reject(new Error("The worker disconnected.")); }
    conn.calls.clear();
    for (const [id, e] of conn.execs) e.resolve({ exitCode: null, signal: "DISCONNECT", timedOut: false }), conn.execs.delete(id);
  }

  private send(conn: Conn, msg: unknown) {
    conn.sock.send(conn.session.seal(msg));
  }

  private onFrame(conn: Conn, text: string) {
    const m = conn.session.open<Record<string, unknown>>(text);
    conn.lastFrame = this.now();
    if (typeof m.id === "string" && "ok" in m) {
      const c = conn.calls.get(m.id);
      if (!c) return;
      conn.calls.delete(m.id);
      clearTimeout(c.timer);
      if (m.ok) c.resolve(m.result);
      else c.reject(new Error(typeof m.error === "string" ? m.error.slice(0, 500) : "The worker refused."));
      return;
    }
    switch (m.ev) {
      case "hb": {
        const hb = m.hb as Heartbeat;
        if (hb && typeof hb === "object") conn.hb = { at: this.now(), loadAvg: num(hb.loadAvg), freeMemMb: num(hb.freeMemMb), running: num(hb.running) ?? 0, inferenceRunning: num(hb.inferenceRunning) ?? 0, inferenceQueued: num(hb.inferenceQueued) ?? 0 };
        break;
      }
      case "caps": {
        const caps = m.caps as Capabilities;
        if (!caps || typeof caps !== "object" || typeof caps.arch !== "string") break;
        this.mutate((s) => {
          const w = s.workers[conn.workerId];
          if (!w) return;
          const had = w.capabilities;
          w.capabilities = caps;
          w.version = typeof m.version === "string" ? m.version.slice(0, 40) : w.version;
          w.lastSeen = this.now();
          // The first report decides the default inference lane count; an operator's later setting is kept.
          if (!had) w.inferenceSlots = caps.inference ? 1 : 0;
          if (!had) w.shellSlots = Math.max(1, Math.floor(caps.cpu.cores / 2));
          const prov = (caps.networks ?? []).find((n) => n.address && w.transport?.address.includes(n.address));
          if (prov && w.transport) w.transport.provider = prov.provider;
        });
        this.audit("worker", "caps.update", conn.workerId, `${caps.arch} ${caps.cpu.cores} cores ${caps.inference?.models.length ?? 0} models`);
        this.emit("worker", { id: conn.workerId });
        break;
      }
      case "out": {
        const e = typeof m.id === "string" ? conn.execs.get(m.id) : undefined;
        if (e && (m.stream === "stdout" || m.stream === "stderr") && typeof m.data === "string") e.onOut(m.stream, scrub(m.data, e.secrets));
        break;
      }
      case "exit": {
        const e = typeof m.id === "string" ? conn.execs.get(m.id) : undefined;
        if (e && typeof m.id === "string") {
          conn.execs.delete(m.id);
          e.resolve({ exitCode: typeof m.exitCode === "number" ? m.exitCode : null, signal: typeof m.signal === "string" ? m.signal : null, timedOut: m.timedOut === true });
        }
        break;
      }
    }
  }

  /** A request to a connected worker; rejects if it is offline or does not answer. */
  call<T = unknown>(workerId: string, op: string, args: unknown, timeoutMs = 30_000): Promise<T> {
    const conn = this.conns.get(workerId);
    if (!conn) return Promise.reject(new HttpError(409, "offline", "The worker is offline."));
    const id = randomBytes(6).toString("hex");
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { conn.calls.delete(id); reject(new HttpError(504, "worker_timeout", `The worker did not answer ${op}.`)); }, timeoutMs);
      conn.calls.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.send(conn, { id, op, args });
      } catch (e) {
        conn.calls.delete(id);
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  // ---- console actions

  updateWorker(by: string, id: string, patch: { name?: unknown; companies?: unknown; shellSlots?: unknown; inferenceSlots?: unknown; drain?: unknown; disabled?: unknown }) {
    const w = this.worker(id);
    if (!w || w.state !== "adopted") throw new HttpError(404, "not_found", "No such worker.");
    const changes: string[] = [];
    this.mutate((s) => {
      const r = s.workers[id]!;
      if (typeof patch.name === "string" && patch.name.trim()) { r.name = patch.name.trim().slice(0, 80); changes.push("name"); }
      if (patch.companies === null || (Array.isArray(patch.companies) && patch.companies.every((c) => typeof c === "string" && ID.test(c)))) { r.companies = patch.companies as string[] | null; changes.push("scope"); }
      if (typeof patch.shellSlots === "number" && Number.isInteger(patch.shellSlots) && patch.shellSlots >= 0 && patch.shellSlots <= 64) { r.shellSlots = patch.shellSlots; changes.push("shellSlots"); }
      if (typeof patch.inferenceSlots === "number" && Number.isInteger(patch.inferenceSlots) && patch.inferenceSlots >= 0 && patch.inferenceSlots <= 8) { r.inferenceSlots = patch.inferenceSlots; changes.push("inferenceSlots"); }
      if (typeof patch.drain === "boolean") { r.draining = patch.drain; changes.push(patch.drain ? "drain" : "undrain"); }
      if (typeof patch.disabled === "boolean") { r.disabled = patch.disabled; changes.push(patch.disabled ? "disable" : "enable"); }
    });
    if (!changes.length) throw new HttpError(400, "bad_request", "Nothing to change.");
    this.audit(by, "worker.update", id, changes.join(","));
    this.emit("worker", { id });
    // A disabled worker takes no more work and stops what it is running.
    if (patch.disabled === true) void this.killAll(id);
    return this.workerView(this.worker(id)!);
  }

  /** Durable: the record stays with its state and the key goes on the deny list. */
  revoke(by: string, id: string) {
    const w = this.worker(id);
    if (!w) throw new HttpError(404, "not_found", "No such worker.");
    this.mutate((s) => {
      const r = s.workers[id]!;
      r.state = "revoked";
      if (!s.denied.includes(r.fingerprint)) s.denied.push(r.fingerprint);
      for (const l of Object.values(s.leases)) if (l.workerId === id && l.state !== "destroyed") l.state = "destroyed";
    });
    const conn = this.conns.get(id);
    if (conn) {
      try { this.send(conn, { id: "rv", op: "revoked", args: {} }); } catch { /* closing anyway */ }
      conn.sock.close(4403, "revoked");
      this.dropConn(conn);
    }
    this.audit(by, "worker.revoke", id);
    this.emit("worker", { id });
  }

  forget(by: string, id: string) {
    const w = this.worker(id);
    if (!w) throw new HttpError(404, "not_found", "No such worker.");
    if (w.state !== "revoked") throw new HttpError(409, "not_revoked", "Revoke the worker before removing its record.");
    // The key stays on the deny list.
    this.mutate((s) => { delete s.workers[id]; for (const [k, l] of Object.entries(s.leases)) if (l.workerId === id) delete s.leases[k]; });
    this.audit(by, "worker.forget", id);
  }

  refresh(id: string) {
    return this.call(id, "caps.refresh", {});
  }

  // ---- control tokens (per organization)

  issueControlToken(companyId: string): string {
    if (!ID.test(companyId)) throw new HttpError(400, "bad_request", "Bad organization id.");
    const token = `fct_${randomBytes(24).toString("base64url")}`;
    this.mutate((s) => { s.tokens[companyId] = sha256hex(token); });
    this.audit("host", "token.issue", undefined, companyId);
    return token;
  }
  /** The organization a control token belongs to, or null. */
  companyForToken(token: string | undefined): string | null {
    if (!token || !token.startsWith("fct_")) return null;
    const h = sha256hex(token);
    for (const [c, hash] of Object.entries(this.read().tokens)) if (eq(hash, h)) return c;
    return null;
  }

  // ---- leases

  probe(companyId: string, o: { workerId?: string | null; requirements?: Requirements; needsInference?: boolean }) {
    const s = this.read();
    const all = Object.values(s.workers).filter((w) => w.state === "adopted").map((w) => this.candidate(w, Object.values(s.leases)));
    const sel = select(all, { companyId, workerId: o.workerId ?? null, requirements: o.requirements, needsInference: o.needsInference });
    return { sel, candidates: all.map((c) => ({ workerId: c.id, name: c.name, online: c.online, reasons: sel.ok ? [] : sel.reasons.find((r) => r.workerId === c.id)?.reasons ?? [] })) };
  }

  /** Reserves capacity on a compatible worker and prepares the run's workspace. Selection and reservation are one synchronous step. */
  async acquire(companyId: string, a: { agentId: string; runId: string; environmentId: string; workerId?: string | null; requirements?: Requirements; needsInference?: boolean; workspaceKey?: string; reuse?: boolean }): Promise<LeaseRec> {
    if (!ID.test(a.agentId) || !ID.test(a.runId) || !ID.test(a.environmentId)) throw new HttpError(400, "bad_request", "Bad agent, run or environment id.");
    const wsKey = sanitizeKey(a.workspaceKey || a.runId);
    let created: LeaseRec;
    {
      const s = this.read();
      const dup = Object.values(s.leases).find((l) => l.state === "active" && l.companyId === companyId && l.agentId === a.agentId && l.workspace.endsWith(`/${wsKey}`));
      if (dup) throw new HttpError(409, "lease_conflict", "That agent already holds a lease on this workspace.");
      const all = Object.values(s.workers).filter((w) => w.state === "adopted").map((w) => this.candidate(w, Object.values(s.leases)));
      // A reusable workspace comes back to the worker that has it.
      const prior = a.reuse ? Object.values(s.leases).find((l) => l.state !== "active" && l.state !== "destroyed" && l.companyId === companyId && l.agentId === a.agentId && l.environmentId === a.environmentId && l.workspace.endsWith(`/${wsKey}`)) : undefined;
      const sel = select(all, { companyId, workerId: prior?.workerId ?? a.workerId ?? null, requirements: a.requirements, needsInference: a.needsInference });
      if (!sel.ok) throw new HttpError(409, sel.code, `No worker can take this run: ${sel.reasons.map((r) => `${r.name}: ${r.reasons.join(", ")}`).join("; ") || "no workers are adopted"}`);
      const root = sel.worker.capabilities?.workspaceRoot ?? "/workspaces";
      created = { id: `wl_${randomBytes(8).toString("hex")}`, workerId: sel.worker.id, companyId, agentId: a.agentId, runId: a.runId, environmentId: a.environmentId, workspace: `${root.replace(/\/+$/, "")}/${sanitizeKey(companyId)}/${sanitizeKey(a.agentId)}/${wsKey}`, state: "active", needsInference: !!a.needsInference, createdAt: this.now() };
      this.mutate((st) => { st.leases[created.id] = created; });
    }
    try {
      await this.call(created.workerId, "ws.ensure", { path: created.workspace, mode: "directory" });
    } catch (e) {
      this.mutate((st) => { delete st.leases[created.id]; });
      throw e;
    }
    this.audit("provider", "lease.acquire", created.workerId, `${created.id} ${created.agentId}`);
    this.emit("lease", { id: created.id });
    return created;
  }

  lease(companyId: string, id: string): LeaseRec {
    const l = this.read().leases[id];
    if (!l || l.companyId !== companyId) throw new HttpError(404, "not_found", "No such lease.");
    return l;
  }
  private setLease(id: string, patch: Partial<LeaseRec>) {
    this.mutate((s) => { if (s.leases[id]) Object.assign(s.leases[id]!, patch); });
  }

  async resume(companyId: string, id: string): Promise<LeaseRec> {
    const l = this.lease(companyId, id);
    const w = this.worker(l.workerId);
    if (l.state === "destroyed" || !w || w.state !== "adopted") throw new HttpError(410, "expired", "That lease is gone.");
    if (l.state !== "active") {
      const s = this.read();
      const c = this.candidate(w, Object.values(s.leases));
      if (!c.online) throw new HttpError(409, "offline", "The worker is offline.");
      if (w.disabled || w.draining) throw new HttpError(410, "expired", "The worker is not taking work.");
      if (c.shellLeases >= c.shellSlots) throw new HttpError(409, "no_capacity", "All shell slots are in use.");
      this.setLease(id, { state: "active" });
    }
    await this.call(l.workerId, "ws.ensure", { path: l.workspace, mode: "directory" });
    this.audit("provider", "lease.resume", l.workerId, id);
    return this.lease(companyId, id);
  }

  async realize(companyId: string, id: string, o: { mode?: "directory" | "worktree"; repo?: string; ref?: string }): Promise<string> {
    const l = this.lease(companyId, id);
    if (l.state !== "active") throw new HttpError(409, "lease_inactive", "The lease is not active.");
    await this.call(l.workerId, "ws.ensure", { path: l.workspace, mode: o.mode ?? "directory", repo: o.repo, ref: o.ref });
    return l.workspace;
  }

  /** Runs a command in the lease's workspace; output is delivered as it arrives. */
  async exec(companyId: string, id: string, p: { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }, onOut: (stream: "stdout" | "stderr", data: string) => void, onStart?: (execId: string) => void): Promise<ExecResult> {
    const l = this.lease(companyId, id);
    if (l.state !== "active") throw new HttpError(409, "lease_inactive", "The lease is not active.");
    const w = this.worker(l.workerId);
    if (!w || w.state !== "adopted") throw new HttpError(410, "expired", "The worker is gone.");
    const conn = this.conns.get(l.workerId);
    if (!conn || !this.online(l.workerId)) throw new HttpError(409, "offline", "The worker is offline.");
    if (typeof p.command !== "string" || !p.command || p.command.length > 4096 || (p.args ?? []).some((x) => typeof x !== "string")) throw new HttpError(400, "bad_request", "Bad command.");
    const cwd = (p.cwd ?? l.workspace).replace(/\/+$/, "");
    if (cwd !== l.workspace && !cwd.startsWith(`${l.workspace}/`)) throw new HttpError(403, "outside_workspace", "Commands run inside the lease's workspace.");
    const secrets = Object.entries(p.env ?? {}).filter(([k, v]) => /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i.test(k) && typeof v === "string" && v.length >= 8).map(([, v]) => v);
    const execId = `x_${randomBytes(6).toString("hex")}`;
    return await new Promise<ExecResult>((resolve, reject) => {
      conn.execs.set(execId, { onOut, resolve, leaseId: id, secrets });
      onStart?.(execId);
      this.audit("provider", "exec.start", l.workerId, `${id} ${execId} ${p.command.split(/\s+/)[0]!.slice(0, 60)}`);
      this.call(l.workerId, "exec", { id: execId, command: p.command, args: p.args ?? [], cwd, env: p.env ?? {}, stdin: p.stdin, timeoutMs: p.timeoutMs, owner: id }, 5_000).catch((e) => {
        if (conn.execs.delete(execId)) reject(e);
      });
    });
  }

  private async killAll(workerId: string, owner?: string) {
    if (!this.conns.has(workerId)) return;
    await this.call(workerId, "cancel", { target: "*", owner }, 15_000).catch(() => {});
  }

  async release(companyId: string, id: string): Promise<LeaseRec> {
    const l = this.lease(companyId, id);
    if (l.state === "active") {
      await this.killAll(l.workerId, id);
      this.setLease(id, { state: "released", releasedAt: this.now() });
      this.audit("provider", "lease.release", l.workerId, id);
      this.emit("lease", { id });
    }
    return this.lease(companyId, id);
  }
  async stop(companyId: string, id: string): Promise<LeaseRec> {
    const l = this.lease(companyId, id);
    if (l.state === "destroyed") return l;
    await this.killAll(l.workerId, id);
    this.setLease(id, { state: "stopped", releasedAt: this.now() });
    this.audit("provider", "lease.stop", l.workerId, id);
    this.emit("lease", { id });
    return this.lease(companyId, id);
  }
  /** Destroys the run: its processes, its workspace and its lease. The worker itself is never touched. */
  async destroy(companyId: string, id: string): Promise<LeaseRec> {
    const l = this.read().leases[id];
    if (!l || l.companyId !== companyId) return { id, workerId: "", companyId, agentId: "", runId: "", environmentId: "", workspace: "", state: "destroyed", needsInference: false, createdAt: 0 };
    await this.killAll(l.workerId, id);
    try {
      await this.call(l.workerId, "ws.remove", { path: l.workspace });
    } catch {
      // Offline: the removal is owed and happens when the worker reconnects.
      this.mutate((s) => { const w = s.workers[l.workerId]; if (w && !w.cleanup.includes(l.workspace)) w.cleanup.push(l.workspace); });
    }
    this.mutate((s) => { delete s.leases[id]; });
    this.audit("provider", "lease.destroy", l.workerId, id);
    this.emit("lease", { id });
    return { ...l, state: "destroyed" };
  }

  // ---- lifecycle

  /** Closes sessions that stopped talking. Call once; it keeps running until `close`. */
  start() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      for (const c of [...this.conns.values()]) if (this.now() - c.lastFrame > this.hbMs * 3) { c.sock.terminate(); this.dropConn(c); }
      this.expirePending();
    }, Math.max(1000, this.hbMs));
    this.sweepTimer.unref();
  }
  close() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const c of this.conns.values()) c.sock.close(1001, "host stopping");
  }
  connectedIds(): string[] {
    return [...this.conns.keys()];
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
function scrub(text: string, secrets: string[]): string {
  let t = text;
  for (const s of secrets) if (t.includes(s)) t = t.split(s).join("[redacted]");
  return t;
}
export { createHash };
