import { ClientHandshake, decodePairing, orderEndpoints, type Capabilities, type Identity } from "@papercliped-engine/worker-fabric";
import type { Server } from "node:http";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { detectCapabilities, tailscaleIp, vitals } from "./caps.ts";
import { WorkerFiles, type WorkerConfig } from "./config.ts";
import { Gate } from "./gate.ts";
import { Runner } from "./runner.ts";
import { WorkspaceError, ensureWorkspace, removeWorkspace } from "./workspace.ts";

export const VERSION = "0.1.0";

export interface ClientOptions {
  files: WorkerFiles;
  log?: (msg: string) => void;
  /** Injected in tests. */
  detect?: (c: WorkerConfig) => Promise<Capabilities>;
  WebSocketImpl?: typeof WebSocket;
  backoff?: { minMs: number; maxMs: number };
  version?: string;
}

type Json = Record<string, unknown>;
export type Status = { state: "idle" | "connecting" | "pending" | "online" | "refused" | "revoked"; detail?: string; verification?: string; workerId?: string | null };

/**
 * The worker's connection to the host. It dials out, proves its key, then serves the host's requests. Anything that
 * breaks the connection is retried with growing, jittered delays and the worker keeps its work state in the
 * workspace directory, not in memory, so a restart loses nothing but running commands.
 */
export class WorkerClient {
  private readonly o: ClientOptions;
  private readonly log: (m: string) => void;
  private stopped = false;
  private ws: WebSocket | null = null;
  private runner: Runner;
  private gate: Gate | null = null;
  private gateServer: Server | null = null;
  private send: ((v: unknown) => void) | null = null;
  status: Status = { state: "idle" };
  private caps: Capabilities | null = null;
  private timers: NodeJS.Timeout[] = [];
  onStatus?: (s: Status) => void;

  constructor(o: ClientOptions) {
    this.o = o;
    this.log = o.log ?? (() => {});
    this.runner = new Runner(
      { out: (id, stream, data) => this.send?.({ ev: "out", id, stream, data }), exit: (id, r) => this.send?.({ ev: "exit", id, ...r }) },
      () => this.inferenceEnv(),
    );
  }

  private set(s: Status) {
    this.status = s;
    this.onStatus?.(s);
  }
  /** Added to every command: the tools the worker brought (its own Node.js) and the user's ~/.local/bin on PATH, and the inference gate. */
  private inferenceEnv(): Record<string, string> {
    const home = process.env.HOME ?? "";
    const extra = [dirname(process.execPath), home ? join(home, ".local", "bin") : ""].filter((d) => d && existsSync(d));
    const path = [...extra, ...(process.env.PATH ?? "").split(":").filter(Boolean)].filter((d, i, a) => a.indexOf(d) === i).join(":");
    const env: Record<string, string> = { PATH: path };
    if (this.gateServer) {
      const url = `http://127.0.0.1:${this.o.files.config().inference.gatePort}`;
      env.OLLAMA_HOST = url;
      env.EPAPERCLIP_INFERENCE_URL = url;
    }
    return env;
  }

  /** Stores the pairing code's contents; the next connection adopts. */
  adopt(code: string) {
    const p = decodePairing(code);
    const c = this.o.files.config();
    c.hostKey = p.hostKey;
    c.endpoints = p.urls;
    c.workerId = null;
    c.revoked = false;
    c.pairing = { id: p.id, secret: p.secret };
    this.o.files.saveConfig(c);
    this.set({ state: "idle" });
  }
  /** Starts a request for approval with no pairing code: the host asks a person. Needs the host endpoint and key. */
  requestAdoption(hostKey: string, endpoints: { provider: string; url: string }[]) {
    const c = this.o.files.config();
    c.hostKey = hostKey;
    c.endpoints = endpoints;
    c.workerId = null;
    c.revoked = false;
    c.pairing = null;
    this.o.files.saveConfig(c);
  }

  async start() {
    this.stopped = false;
    await this.startGate().catch((e) => this.log(`inference gate not started: ${(e as Error).message}`));
    void this.loop();
  }
  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.runner.cancel();
    this.ws?.close();
    this.gateServer?.close();
    this.gateServer = null;
  }

  private offlineHook(): boolean {
    return existsSync(join(this.o.files.dir, "simulate-offline"));
  }

  private async startGate() {
    const c = this.o.files.config();
    const caps = await (this.o.detect ?? ((cc) => detectCapabilities({ workspaceRoot: cc.workspaceRoot, ollamaUrl: cc.ollamaUrl, maxContext: cc.inference.maxContext, setupMode: cc.setupMode })))(c);
    this.caps = caps;
    if (!caps.inference) return;
    this.gate = new Gate(c.inference.slots);
    const srv = this.gate.server(caps.inference.url, c.inference.maxContext);
    await new Promise<void>((res, rej) => { srv.once("error", rej); srv.listen(c.inference.gatePort, "127.0.0.1", () => res()); });
    this.gateServer = srv;
    this.log(`inference gate on 127.0.0.1:${c.inference.gatePort} -> ${caps.inference.url} (${c.inference.slots} at a time)`);
  }

  private async loop() {
    const b = this.o.backoff ?? { minMs: 1000, maxMs: 60_000 };
    let delay = b.minMs;
    let refusals = 0;
    while (!this.stopped) {
      const c = this.o.files.config();
      if (c.revoked) { this.set({ state: "revoked", detail: "This worker was removed by the host. Run `epaperclip-worker adopt <code>` to join again." }); await sleep(30_000, () => this.stopped); continue; }
      if (!c.hostKey || !c.endpoints.length) { this.set({ state: "idle", detail: "Not adopted yet. Run `epaperclip-worker adopt <code>`." }); await sleep(2000, () => this.stopped); continue; }
      // Diagnostic hook: while `simulate-offline` exists in the worker's folder the worker behaves as if the network were gone
      // (it drops the connection and does not dial). Used to prove reconnection without touching the machine's real network.
      if (this.offlineHook()) { this.set({ state: "connecting", detail: "simulating network loss (simulate-offline exists)" }); await sleep(500, () => this.stopped); continue; }
      const started = Date.now();
      const outcome = await this.connectOnce(c).catch((e) => ({ kind: "error" as const, msg: (e as Error).message }));
      if (this.stopped) break;
      if (outcome.kind === "refused") refusals += 1; else refusals = 0;
      if (Date.now() - started > 30_000) delay = b.minMs;
      const wait = refusals >= 3 ? Math.max(delay, 5 * 60_000) : delay;
      this.log(`disconnected (${outcome.kind}${"msg" in outcome && outcome.msg ? `: ${outcome.msg}` : ""}); retrying in ${Math.round(wait / 1000)}s`);
      if (refusals >= 3) this.set({ state: "refused", detail: "The host refused this worker repeatedly. It may have been removed; check the console." });
      await sleep(wait * (0.7 + Math.random() * 0.6), () => this.stopped);
      delay = Math.min(delay * 2, b.maxMs);
    }
  }

  private connectOnce(c: WorkerConfig): Promise<{ kind: "closed" | "refused" | "error"; msg?: string }> {
    const identity = this.o.files.identity();
    return (async () => {
      const ts = await tailscaleIp();
      const lan = (this.caps?.networks ?? []).some((n) => n.provider === "lan");
      const endpoints = orderEndpoints(c.endpoints, { tailscale: !!ts, lan }, c.prefer);
      let last = "no endpoint reachable";
      for (const ep of endpoints) {
        this.set({ state: "connecting", detail: ep.url, workerId: c.workerId });
        const r = await this.dial(ep.url, c, identity).catch((e) => ({ kind: "error" as const, msg: (e as Error).message }));
        if (r.kind !== "error" || r.msg !== "unreachable") return r;
        last = `${ep.provider} endpoint unreachable`;
      }
      return { kind: "error", msg: last };
    })();
  }

  private dial(url: string, c: WorkerConfig, identity: Identity): Promise<{ kind: "closed" | "refused" | "error"; msg?: string }> {
    return new Promise((resolve) => {
      const WS = this.o.WebSocketImpl ?? WebSocket;
      let ws: WebSocket;
      try { ws = new WS(url); } catch (e) { return resolve({ kind: "error", msg: (e as Error).message }); }
      this.ws = ws;
      const hs = new ClientHandshake(identity, c.hostKey!);
      let session: ReturnType<ClientHandshake["finish"]>["session"] | null = null;
      let opened = false;
      let ready = false;
      const adopting = !c.workerId;
      const fin = (r: { kind: "closed" | "refused" | "error"; msg?: string }) => {
        for (const t of this.timers) clearInterval(t);
        this.timers = [];
        this.send = null;
        this.runner.cancel();
        resolve(r);
      };
      const hookTimer = setInterval(() => { if (this.offlineHook()) { this.log("simulate-offline: dropping the connection"); ws.close(4000, "simulated network loss"); } }, 500);
      this.timers.push(hookTimer);
      ws.onopen = () => { opened = true; ws.send(hs.hello(adopting ? "adopt" : "auth", c.workerId ?? undefined)); };
      ws.onerror = () => { if (!opened) fin({ kind: "error", msg: "unreachable" }); };
      ws.onclose = (ev) => fin(ev.code === 4403 && !ready ? { kind: "refused" } : { kind: "closed", msg: ev.reason || undefined });
      ws.onmessage = (ev) => {
        const text = typeof ev.data === "string" ? ev.data : String(ev.data);
        void (async () => {
          try {
            if (!session) {
              const caps = this.caps ?? (await (this.o.detect ?? ((cc) => detectCapabilities({ workspaceRoot: cc.workspaceRoot, ollamaUrl: cc.ollamaUrl, maxContext: cc.inference.maxContext, setupMode: cc.setupMode })))(c));
              this.caps = caps;
              const f = hs.finish(text, { pairing: adopting ? c.pairing ?? undefined : undefined, name: c.name || undefined, caps: adopting ? caps : undefined });
              session = f.session;
              this.send = (v) => { if (ws.readyState === 1) ws.send(session!.seal(v)); };
              ws.send(f.authFrame);
              return;
            }
            const m = session.open<Json>(text);
            if (m.ev === "pending") {
              this.set({ state: "pending", verification: String(m.verification), detail: `Approve this worker in the console. Verification code ${m.verification}` });
              this.log(`waiting for approval; verification code ${m.verification}`);
              return;
            }
            if (m.ev === "ready") {
              ready = true;
              const cc = this.o.files.config();
              cc.workerId = String(m.workerId);
              if (!cc.name) cc.name = String(m.name ?? "");
              cc.pairing = null;
              this.o.files.saveConfig(cc);
              this.set({ state: "online", workerId: cc.workerId });
              this.log(`connected as ${cc.workerId}`);
              await this.announce(cc);
              const hb = Math.max(100, Number(m.hbMs) || 10_000);
              this.timers.push(setInterval(() => this.beat(), hb));
              return;
            }
            if (typeof m.op === "string") await this.handle(m as { id: string; op: string; args: Json }, c);
          } catch (e) {
            this.log(`channel error: ${(e as Error).message}`);
            ws.close(4400, "protocol");
          }
        })();
      };
    });
  }

  private async announce(c: WorkerConfig) {
    const caps = await (this.o.detect ?? ((cc) => detectCapabilities({ workspaceRoot: cc.workspaceRoot, ollamaUrl: cc.ollamaUrl, maxContext: cc.inference.maxContext, setupMode: cc.setupMode })))(c);
    this.caps = caps;
    this.send?.({ ev: "caps", caps, version: this.o.version ?? VERSION });
    this.beat();
  }
  private beat() {
    const g = this.gate?.stats();
    this.send?.({ ev: "hb", hb: { at: Date.now(), ...vitals(), running: this.runner.count(), inferenceRunning: g?.running ?? 0, inferenceQueued: g?.queued ?? 0 } });
  }

  private async handle(m: { id: string; op: string; args: Json }, c: WorkerConfig) {
    const reply = (ok: boolean, result?: unknown, error?: string) => this.send?.({ id: m.id, ok, ...(ok ? { result } : { error }) });
    try {
      const root = this.o.files.config().workspaceRoot;
      switch (m.op) {
        case "ws.ensure": {
          const p = await ensureWorkspace(root, m.args as never);
          return reply(true, { path: p });
        }
        case "ws.remove":
          await removeWorkspace(root, String(m.args.path));
          return reply(true, {});
        case "exec": {
          const a = m.args as unknown as { id: string; command: string; args: string[]; cwd: string; env: Record<string, string>; stdin?: string; timeoutMs?: number; owner: string };
          // The shell is unrestricted by design; the directory must at least exist and be absolute.
          const cwd = String(a.cwd);
          if (!cwd.startsWith("/") || !existsSync(cwd)) throw new WorkspaceError(`the directory ${cwd} does not exist on this worker`);
          this.runner.start({ id: a.id, command: a.command, args: a.args ?? [], cwd, env: a.env ?? {}, stdin: a.stdin, timeoutMs: a.timeoutMs, owner: a.owner });
          return reply(true, { started: true });
        }
        case "cancel":
          return reply(true, { cancelled: this.runner.cancel(m.args.owner as string | undefined, m.args.target as string | undefined) });
        case "caps.refresh":
          await this.announce(c);
          return reply(true, {});
        case "inference.install": {
          const a = m.args as { action?: "ollama" | "pull"; model?: string };
          const model = typeof a.model === "string" ? a.model : "";
          const command = a.action === "ollama" ? "curl -fsSL https://ollama.com/install.sh | sh" : `ollama pull ${model}`;
          if (c.setupMode !== "pin") return reply(true, { ok: false, code: "guided_only", command });
          try {
            return reply(true, await helperCall({ action: String(a.action ?? ""), model }));
          } catch (e) {
            return reply(true, { ok: false, code: "helper_missing", command, detail: e instanceof Error ? e.message : "helper unavailable" });
          }
        }
        case "revoked": {
          const cc = this.o.files.config();
          cc.revoked = true;
          this.o.files.saveConfig(cc);
          this.set({ state: "revoked" });
          return;
        }
        default:
          return reply(false, undefined, "unknown operation");
      }
    } catch (e) {
      reply(false, undefined, e instanceof WorkspaceError || e instanceof Error ? e.message.slice(0, 400) : "failed");
    }
  }
}

/** The narrow privileged helper, if the worker installer installed it. It accepts only fixed actions. */
function helperCall(req: { action: string; model: string }, timeoutMs = 180_000): Promise<unknown> {
  const socket = process.env.EPW_HELPER_SOCKET || "/run/epaperclip-worker/helper.sock";
  return new Promise((resolve, reject) => {
    const s = connect(socket);
    let buf = "";
    const done = (fn: () => void) => { s.destroy(); fn(); };
    s.setTimeout(timeoutMs, () => done(() => reject(new Error("the privileged helper timed out"))));
    s.on("error", (e) => done(() => reject(e)));
    s.on("connect", () => s.write(JSON.stringify(req) + "\n"));
    s.on("data", (d) => {
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (i < 0) return;
      try { resolve(JSON.parse(buf.slice(0, i))); } catch { reject(new Error("the helper answered badly")); }
      done(() => {});
    });
  });
}

const sleep = (ms: number, stop: () => boolean) =>
  new Promise<void>((res) => {
    const t0 = Date.now();
    const iv = setInterval(() => { if (stop() || Date.now() - t0 >= ms) { clearInterval(iv); res(); } }, Math.min(250, ms));
  });
