/** The provider's whole view of the Worker Fabric: HTTP calls to the host's control API. It holds no state. */

export class ControlError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type Fetch = typeof fetch;

export interface ExecChunk { stream: "stdout" | "stderr"; data: string }
export interface ExecOutcome { exitCode: number | null; signal: string | null; timedOut: boolean }

export class Control {
  private readonly base: string;
  private readonly token: string;
  private readonly f: Fetch;
  constructor(o: { url: string; token: string; fetch?: Fetch }) {
    this.base = o.url;
    this.token = o.token;
    this.f = o.fetch ?? fetch;
  }
  private async post<T>(path: string, body: unknown, timeoutMs = 60_000): Promise<T> {
    let r: Response;
    try {
      r = await this.f(`${this.base}${path}`, { method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new ControlError(0, "unreachable", `Cannot reach the ePaperclip Worker Fabric at ${this.base}: ${(e as Error).message}`);
    }
    const text = await r.text();
    let j: { error?: string; code?: string } & Record<string, unknown> = {};
    try { j = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
    if (!r.ok) throw new ControlError(r.status, String(j.code ?? "error"), String(j.error ?? `Worker Fabric answered ${r.status}`));
    return j as T;
  }
  probe(b: Record<string, unknown>) {
    return this.post<{ ok: boolean; summary: string; candidates: { workerId: string; name: string; online: boolean; reasons: string[] }[] }>("/control/v1/probe", b);
  }
  acquire(b: Record<string, unknown>, timeoutMs: number) {
    return this.post<{ leaseId: string; workerId: string; workerName: string; workspace: string }>("/control/v1/leases", b, timeoutMs);
  }
  resume(id: string) {
    return this.post<{ leaseId: string; workspace: string; workerId: string }>(`/control/v1/leases/${encodeURIComponent(id)}/resume`, {});
  }
  workspace(id: string, b: Record<string, unknown>) {
    return this.post<{ cwd: string }>(`/control/v1/leases/${encodeURIComponent(id)}/workspace`, b);
  }
  release(id: string) {
    return this.post<{ state: string }>(`/control/v1/leases/${encodeURIComponent(id)}/release`, {});
  }
  stop(id: string) {
    return this.post<{ state: string }>(`/control/v1/leases/${encodeURIComponent(id)}/stop`, {});
  }
  destroy(id: string) {
    return this.post<{ state: string }>(`/control/v1/leases/${encodeURIComponent(id)}/destroy`, {});
  }
  /** Runs a command; `onOut` gets each chunk as it arrives. */
  async exec(id: string, b: Record<string, unknown>, onOut: (c: ExecChunk) => void, timeoutMs: number): Promise<ExecOutcome> {
    let r: Response;
    try {
      r = await this.f(`${this.base}/control/v1/leases/${encodeURIComponent(id)}/exec`, { method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new ControlError(0, "unreachable", `Cannot reach the ePaperclip Worker Fabric at ${this.base}: ${(e as Error).message}`);
    }
    if (!r.ok || !r.body) {
      const t = await r.text().catch(() => "");
      let j: { error?: string; code?: string } = {};
      try { j = JSON.parse(t); } catch { /* ignore */ }
      throw new ControlError(r.status, String(j.code ?? "error"), String(j.error ?? `Worker Fabric answered ${r.status}`));
    }
    const dec = new TextDecoder();
    let buf = "";
    let out: ExecOutcome | null = null;
    const line = (l: string) => {
      if (!l.trim()) return;
      const m = JSON.parse(l) as { ev: string; stream?: "stdout" | "stderr"; data?: string; exitCode?: number | null; signal?: string | null; timedOut?: boolean; code?: string; error?: string };
      if (m.ev === "out" && m.stream && typeof m.data === "string") onOut({ stream: m.stream, data: m.data });
      else if (m.ev === "exit") out = { exitCode: m.exitCode ?? null, signal: m.signal ?? null, timedOut: m.timedOut === true };
      else if (m.ev === "error") throw new ControlError(409, m.code ?? "error", m.error ?? "The command could not run.");
    };
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        line(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
    line(buf);
    if (!out) throw new ControlError(502, "stream_ended", "The connection to the worker ended before the command finished.");
    return out;
  }
}
