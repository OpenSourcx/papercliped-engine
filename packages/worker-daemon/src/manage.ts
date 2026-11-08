import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { LIMITS, manageMessage, verifyRaw, type ManageEnvelope, type Stats } from "@papercliped-engine/worker-fabric";
import type { WorkerFiles } from "./config.ts";

/**
 * Management requests from the host. Each one is signed by the host key this worker pinned at adoption, bound to this worker
 * id, fresh (two minutes) and single-use. The worker never takes a command line from the host here: only the fixed actions
 * below, with validated parameters. The few that need root go through `epw-admin`, a root-owned script that sudo allows by
 * exact argument (see deploy/worker/bootstrap.sh); without it those actions say so instead of failing mysteriously.
 */

export const ADMIN = process.env.EPW_ADMIN || "/usr/local/lib/epaperclip-worker/epw-admin";
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,80}(:[A-Za-z0-9._\-]{1,40})?$/;
const UNITS = { worker: "epaperclip-worker", ollama: "ollama", tailscale: "tailscaled" } as const;
const MAX_UPDATE_BYTES = 200 * 1024 * 1024;

export class ManageError extends Error {}

export interface ManagerDeps {
  files: WorkerFiles;
  ollamaUrl: () => string | null;
  fetchFn?: typeof fetch;
  now?: () => number;
  log?: (m: string) => void;
  exec?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; out: string }>;
  adminPath?: string;
  /** Free disk in GB where models live; injected in tests. */
  freeGb?: () => number;
  statsNow?: () => Promise<Stats>;
}

const defaultExec: NonNullable<ManagerDeps["exec"]> = (cmd, args, timeoutMs) =>
  new Promise((res) => execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (e, out, err) => res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out || "") + (e ? String(err || "") : "") })));

export class Manager {
  private readonly seen = new Map<string, number>();
  private readonly pullState = new Map<string, Stats["pulls"][number]>();
  private readonly d: Required<Omit<ManagerDeps, "freeGb" | "statsNow">> & { freeGb?: () => number; statsNow?: () => Promise<Stats> };

  constructor(d: ManagerDeps) {
    this.d = { fetchFn: fetch, now: Date.now, log: () => {}, exec: defaultExec, adminPath: ADMIN, ...d };
  }

  pulls(): Stats["pulls"] { return [...this.pullState.values()]; }

  /** Checks signature, binding, freshness and single use. Throws ManageError with a plain reason. */
  verify(env: ManageEnvelope): void {
    const cfg = this.d.files.config();
    if (!cfg.hostKey || !cfg.workerId) throw new ManageError("this worker is not adopted");
    if (env.workerId !== cfg.workerId) throw new ManageError("the request is for a different worker");
    const now = this.d.now();
    if (typeof env.ts !== "number" || Math.abs(now - env.ts) > LIMITS.manageSkewMs) throw new ManageError("the request is stale or this machine's clock is off by more than two minutes");
    if (typeof env.nonce !== "string" || env.nonce.length < 8 || env.nonce.length > 64) throw new ManageError("bad request");
    if (typeof env.sig !== "string" || !verifyRaw(cfg.hostKey, Buffer.from(manageMessage(env)), env.sig)) throw new ManageError("the request is not signed by the host this worker trusts");
    for (const [n, t] of this.seen) if (now - t > LIMITS.manageSkewMs * 2) this.seen.delete(n);
    if (this.seen.has(env.nonce)) throw new ManageError("this request was already used");
    this.seen.set(env.nonce, now);
  }

  async handle(env: ManageEnvelope): Promise<unknown> {
    this.verify(env);
    const p = env.params ?? {};
    switch (env.action) {
      case "restart-worker": return this.admin("restart-worker", true);
      case "restart-ollama": return this.admin("restart-ollama", false);
      case "model-pull": return this.pull(String(p.name ?? ""));
      case "model-remove": return this.remove(String(p.name ?? ""));
      case "stats": if (!this.d.statsNow) throw new ManageError("statistics are not available"); return { stats: await this.d.statsNow() };
      case "logs": return this.logs(String(p.unit ?? ""), Number(p.lines ?? 100));
      case "update": return this.update(env, String(p.url ?? ""), String(p.sha256 ?? ""));
      default: throw new ManageError("unknown action");
    }
  }

  private needAdmin() {
    if (!existsSync(this.d.adminPath)) throw new ManageError(`this action needs the helper ${this.d.adminPath}, which the machine setup (bootstrap.sh) installs. It is not present on this worker.`);
  }

  private async admin(verb: string, detached: boolean): Promise<unknown> {
    this.needAdmin();
    const args = ["-n", this.d.adminPath, verb];
    if (detached) {
      // Restarting ourselves kills this process: answer first, then do it.
      setTimeout(() => { void this.d.exec("sudo", args, 30_000); }, 400).unref();
      return { scheduled: true };
    }
    const r = await this.d.exec("sudo", args, 60_000);
    if (r.code !== 0) throw new ManageError(`${verb} failed: ${r.out.trim().slice(0, 300) || `exit ${r.code}`}`);
    return { done: true };
  }

  private ollama(): string {
    const u = this.d.ollamaUrl();
    if (!u) throw new ManageError("no Ollama was found on this worker");
    return u.replace(/\/+$/, "");
  }

  private async pull(name: string): Promise<unknown> {
    if (!MODEL_NAME.test(name)) throw new ManageError("that is not a valid model name");
    const base = this.ollama();
    if ([...this.pullState.values()].some((x) => !x.done)) throw new ManageError("another model download is still running");
    const free = this.d.freeGb?.();
    if (free !== undefined && free < 2) throw new ManageError(`only ${free.toFixed(1)} GB of disk is free; refusing to download a model`);
    const st: Stats["pulls"][number] = { name, pct: null, status: "starting", done: false };
    this.pullState.clear();
    this.pullState.set(name, st);
    void (async () => {
      try {
        const r = await this.d.fetchFn(`${base}/api/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, stream: true }) });
        if (!r.ok || !r.body) throw new Error(`Ollama answered ${r.status}`);
        const dec = new TextDecoder();
        let buf = "";
        for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
          buf += dec.decode(chunk, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            const j = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
            if (j.error) throw new Error(j.error);
            st.status = (j.status ?? st.status).slice(0, 60);
            if (j.total && j.completed !== undefined) st.pct = Math.round((j.completed / j.total) * 100);
          }
        }
        st.pct = 100; st.status = "success"; st.done = true;
      } catch (e) {
        st.done = true; st.status = "failed"; st.error = (e as Error).message.slice(0, 200);
      }
      this.d.log(`model pull ${name}: ${st.status}${st.error ? ` (${st.error})` : ""}`);
    })();
    return { started: true };
  }

  private async remove(name: string): Promise<unknown> {
    if (!MODEL_NAME.test(name)) throw new ManageError("that is not a valid model name");
    const r = await this.d.fetchFn(`${this.ollama()}/api/delete`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }), signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new ManageError(r.status === 404 ? "that model is not installed" : `Ollama answered ${r.status}`);
    return { removed: name };
  }

  private async logs(unit: string, lines: number): Promise<unknown> {
    const u = UNITS[unit as keyof typeof UNITS];
    if (!u) throw new ManageError("unit must be worker, ollama or tailscale");
    const n = Math.max(10, Math.min(500, Math.floor(lines) || 100));
    const r = await this.d.exec("journalctl", ["-u", u, "-n", String(n), "--no-pager", "-o", "short-iso"], 10_000);
    if (r.code !== 0 && !r.out.trim()) throw new ManageError("the journal could not be read (is this worker in the systemd-journal group?)");
    return { unit, text: r.out.slice(-64 * 1024) };
  }

  private async update(env: ManageEnvelope, url: string, sha: string): Promise<unknown> {
    this.needAdmin();
    if (!/^https:\/\/[^\s]+$/.test(url) || url.length > 500) throw new ManageError("the update address must be an https:// URL");
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new ManageError("the update needs a 64 character sha256");
    const r = await this.d.fetchFn(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new ManageError(`download failed (${r.status})`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_UPDATE_BYTES) throw new ManageError("the update is larger than 200 MB");
    if (createHash("sha256").update(buf).digest("hex") !== sha) throw new ManageError("the download does not match the checksum in the signed request; nothing was installed");
    const dir = join(this.d.files.dir, "staging");
    mkdirSync(dir, { recursive: true, mode: 0o750 });
    writeFileSync(join(dir, "update.tar.gz"), buf, { mode: 0o640 });
    // The root helper re-verifies the host signature itself, against a key only root can change.
    writeFileSync(join(dir, "request.json"), JSON.stringify(env), { mode: 0o640 });
    return this.admin("update-worker", true);
  }
}
