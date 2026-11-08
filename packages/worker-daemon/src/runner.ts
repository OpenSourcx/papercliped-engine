import { spawn, type ChildProcess } from "node:child_process";
import { LIMITS } from "@papercliped-engine/worker-fabric";

/** Runs commands for the host: streamed output, a timeout, and cancellation of the whole process group. */

export interface RunSpec { id: string; command: string; args: string[]; cwd: string; env: Record<string, string>; stdin?: string; timeoutMs?: number; owner: string }
export interface RunEvents { out(id: string, stream: "stdout" | "stderr", data: string): void; exit(id: string, r: { exitCode: number | null; signal: string | null; timedOut: boolean }): void }

export class Runner {
  private readonly procs = new Map<string, { child: ChildProcess; owner: string; killed: boolean }>();
  private readonly ev: RunEvents;
  private readonly baseEnv: () => Record<string, string>;
  constructor(ev: RunEvents, baseEnv: () => Record<string, string> = () => ({})) {
    this.ev = ev;
    this.baseEnv = baseEnv;
  }
  count() {
    return this.procs.size;
  }
  start(s: RunSpec) {
    if (this.procs.has(s.id)) throw new Error("duplicate run id");
    const child = spawn(s.command, s.args, { cwd: s.cwd, env: { ...(process.env as Record<string, string>), ...this.baseEnv(), ...s.env }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const rec = { child, owner: s.owner, killed: false };
    this.procs.set(s.id, rec);
    let timedOut = false;
    let done = false;
    const finish = (exitCode: number | null, signal: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.procs.delete(s.id);
      this.ev.exit(s.id, { exitCode, signal, timedOut });
    };
    const timer = s.timeoutMs && s.timeoutMs > 0 ? setTimeout(() => { timedOut = true; this.kill(s.id); }, s.timeoutMs) : undefined;
    const pipe = (stream: "stdout" | "stderr") => {
      child[stream].setEncoding("utf8");
      child[stream].on("data", (d: string) => {
        for (let i = 0; i < d.length; i += LIMITS.chunkBytes) this.ev.out(s.id, stream, d.slice(i, i + LIMITS.chunkBytes));
      });
    };
    pipe("stdout");
    pipe("stderr");
    child.on("error", (e) => {
      this.ev.out(s.id, "stderr", `${e.message}\n`);
      finish(127, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
    child.stdin.on("error", () => {});
    child.stdin.end(s.stdin ?? "");
  }
  kill(id: string) {
    const r = this.procs.get(id);
    if (!r || r.killed) return;
    r.killed = true;
    const pid = r.child.pid;
    const sig = (g: NodeJS.Signals) => { try { if (pid) process.kill(-pid, g); } catch { /* already gone */ } };
    sig("SIGTERM");
    setTimeout(() => sig("SIGKILL"), 2000).unref();
  }
  cancel(owner?: string, id?: string): number {
    let n = 0;
    for (const [rid, r] of this.procs) if ((!owner || r.owner === owner) && (!id || id === "*" || id === rid)) { this.kill(rid); n++; }
    return n;
  }
}
