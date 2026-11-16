import { createServer, request as httpRequest, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { codingProfile } from "@papercliped-engine/worker-fabric";

const GENERATING = /^\/(api\/(generate|chat|embed|embeddings)|v1\/(chat\/completions|completions|embeddings|responses))$/;

/** One bounded FIFO shared by native Ollama, Aider and OpenAI-compatible local clients. */
export class Gate {
  private running = 0;
  private readonly queue: { start(): void; cancel(): void }[] = [];
  private readonly slots: number;
  private readonly maxQueue: number;
  constructor(slots: number, maxQueue = 32) {
    if (!Number.isInteger(slots) || slots < 1) throw new Error("inference slots must be a positive integer");
    this.slots = slots;
    this.maxQueue = maxQueue;
  }
  stats() { return { running: this.running, queued: this.queue.length }; }
  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      let used = false;
      const entry = {
        start: () => {
          signal?.removeEventListener("abort", entry.cancel);
          this.running++;
          resolve(() => {
            if (used) return;
            used = true;
            this.running--;
            this.queue.shift()?.start();
          });
        },
        cancel: () => {
          const i = this.queue.indexOf(entry);
          if (i >= 0) this.queue.splice(i, 1);
          signal?.removeEventListener("abort", entry.cancel);
          reject(new Error("request cancelled"));
        },
      };
      if (signal?.aborted) return entry.cancel();
      if (this.running < this.slots) return entry.start();
      if (this.queue.length >= this.maxQueue) return reject(new Error("inference queue is full"));
      this.queue.push(entry);
      signal?.addEventListener("abort", entry.cancel, { once: true });
    });
  }
  server(upstream: string, maxContext: number | null, admission: (model: string) => string | null = () => null): Server {
    const target = new URL(upstream);
    if (!["http:", "https:"].includes(target.protocol)) throw new Error("unsupported inference protocol");
    return createServer((req, res) => {
      const ac = new AbortController();
      res.on("close", () => ac.abort());
      const fail = (status: number, error: string) => { if (!res.destroyed && !res.headersSent) res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error })); };
      void (async () => {
        const path = (req.url ?? "").split("?")[0]!;
        if (path === "/epaperclip/health") return void res.end(JSON.stringify({ gate: true, maxContext, ...this.stats() }));
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) return fail(413, "request body too large");
          chunks.push(chunk);
        }
        let body = Buffer.concat(chunks);
        let model = "";
        if (GENERATING.test(path) && req.method === "POST") {
          let data: Record<string, any>;
          try { data = JSON.parse(body.toString("utf8")); }
          catch { return fail(400, "expected a JSON inference request"); }
          if (!data || typeof data !== "object" || Array.isArray(data)) return fail(400, "expected an object");
          model = typeof data.model === "string" ? data.model : "";
          const profile = codingProfile(model);
          if (maxContext && /^\/api\/(generate|chat)$/.test(path)) {
            const asked = data.options?.num_ctx;
            if (asked !== undefined && (!Number.isSafeInteger(asked) || asked < 1)) return fail(400, "num_ctx must be a positive integer");
            data.options = { ...data.options, num_ctx: Math.min(asked ?? maxContext, maxContext, profile?.maxContext ?? Infinity) };
            body = Buffer.from(JSON.stringify(data));
          }
        }
        let release: (() => void) | undefined;
        if (GENERATING.test(path)) {
          try { release = await this.acquire(ac.signal); }
          catch (e) { if (!ac.signal.aborted) fail(429, (e as Error).message); return; }
          if (ac.signal.aborted) return release();
          let why: string | null;
          try { why = admission(model); } catch (e) { release(); throw e; }
          if (why) { release(); return fail(503, why); }
        }
        const headers = { ...req.headers, host: target.host, "content-length": String(body.length) };
        delete headers["transfer-encoding"];
        const request = target.protocol === "https:" ? httpsRequest : httpRequest;
        const up = request({ hostname: target.hostname, port: target.port || (target.protocol === "https:" ? 443 : 80), path: req.url, method: req.method, headers }, (ur) => {
          res.writeHead(ur.statusCode ?? 502, ur.headers);
          ur.pipe(res);
          ur.on("end", () => release?.());
          ur.on("error", () => { release?.(); res.destroy(); });
          ur.on("aborted", () => { release?.(); res.destroy(); });
        });
        const abort = () => { if (!res.writableFinished) up.destroy(); };
        ac.signal.addEventListener("abort", abort, { once: true });
        up.on("close", () => { release?.(); ac.signal.removeEventListener("abort", abort); });
        up.on("error", () => { release?.(); if (res.headersSent) res.destroy(); else fail(502, "the model runtime is not reachable"); });
        up.end(body);
      })().catch((e) => fail(500, (e as Error).message));
    });
  }
}
