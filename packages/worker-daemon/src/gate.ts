import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * The inference gate: a loopback proxy in front of the node's model runtime. It admits `slots` generations at a time
 * (Orion: one), queues the rest in order, and clamps the context window. Commands run for the host get its address,
 * so agents can never start more simultaneous generations than the node can hold. Other paths pass straight through.
 */

const GENERATING = /^\/(api\/(generate|chat|embed|embeddings)|v1\/(chat\/completions|completions|embeddings))$/;

export class Gate {
  private running = 0;
  private readonly queue: (() => void)[] = [];
  private readonly slots: number;
  constructor(slots: number) {
    this.slots = Math.max(1, slots);
  }
  stats() {
    return { running: this.running, queued: this.queue.length };
  }
  acquire(): Promise<() => void> {
    let used = false;
    const release = () => {
      if (used) return;
      used = true;
      this.running -= 1;
      this.queue.shift()?.();
    };
    if (this.running < this.slots) {
      this.running += 1;
      return Promise.resolve(release);
    }
    return new Promise((res) => this.queue.push(() => { this.running += 1; res(release); }));
  }
  server(upstream: string, maxContext: number | null): Server {
    const target = new URL(upstream);
    return createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const path = (req.url ?? "").split("?")[0]!;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 8 * 1024 * 1024) return void res.writeHead(413).end();
        chunks.push(c as Buffer);
      }
      let body = Buffer.concat(chunks);
      if (maxContext && req.method === "POST" && /^\/api\/(generate|chat)$/.test(path)) {
        try {
          const j = JSON.parse(body.toString("utf8")) as { options?: { num_ctx?: number } };
          j.options = { ...(j.options ?? {}), num_ctx: Math.min(j.options?.num_ctx ?? maxContext, maxContext) };
          body = Buffer.from(JSON.stringify(j));
        } catch { /* not JSON: pass it on and let the runtime answer */ }
      }
      let release: (() => void) | null = null;
      let gone = false;
      res.on("close", () => { gone = true; });
      if (GENERATING.test(path)) {
        release = await this.acquire();
        if (gone) { release(); return; }
      }
      const up = httpRequest({ hostname: target.hostname, port: target.port || 80, path: req.url, method: req.method, headers: { ...req.headers, host: target.host, "content-length": body.length } }, (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
        ur.on("end", () => release?.());
        ur.on("error", () => { release?.(); res.destroy(); });
      });
      up.on("error", () => { release?.(); if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "the model runtime is not reachable" })); else res.destroy(); });
      res.on("close", () => { if (!res.writableFinished) up.destroy(); });
      up.end(body);
    });
  }
}
