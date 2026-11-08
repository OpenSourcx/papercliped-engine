import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Gate } from "../src/gate.ts";

const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

async function fakeOllama(delayMs: number) {
  const seen = { concurrent: 0, max: 0, bodies: [] as unknown[] };
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/api/tags") return void res.end(JSON.stringify({ models: [{ name: "qwen2.5-coder:3b" }] }));
      seen.bodies.push(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      seen.concurrent++;
      seen.max = Math.max(seen.max, seen.concurrent);
      setTimeout(() => { seen.concurrent--; res.end(JSON.stringify({ response: "ok" })); }, delayMs);
    });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  closers.push(() => { s.closeAllConnections(); s.close(); });
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, seen };
}
async function gateFor(url: string, slots: number, maxContext: number | null) {
  const g = new Gate(slots);
  const s = g.server(url, maxContext);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  closers.push(() => { s.closeAllConnections(); s.close(); });
  return { g, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

describe("inference gate", () => {
  it("runs one generation at a time and queues the rest in order", async () => {
    const up = await fakeOllama(400);
    const { g, base } = await gateFor(up.url, 1, 4096);
    const order: number[] = [];
    const calls = [1, 2, 3, 4].map((n) => fetch(`${base}/api/generate`, { method: "POST", body: JSON.stringify({ model: "m", prompt: String(n) }) }).then(() => order.push(n)));
    await new Promise((r) => setTimeout(r, 150));
    expect(g.stats()).toEqual({ running: 1, queued: 3 });
    await Promise.all(calls);
    expect(up.seen.max).toBe(1);
    expect(order).toEqual([1, 2, 3, 4]);
    expect(g.stats()).toEqual({ running: 0, queued: 0 });
  });

  it("clamps the context window and lets other paths through without a slot", async () => {
    const up = await fakeOllama(10);
    const { base } = await gateFor(up.url, 1, 4096);
    await fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify({ model: "m", options: { num_ctx: 32768 } }) });
    await fetch(`${base}/api/generate`, { method: "POST", body: JSON.stringify({ model: "m" }) });
    expect((up.seen.bodies[0] as { options: { num_ctx: number } }).options.num_ctx).toBe(4096);
    expect((up.seen.bodies[1] as { options: { num_ctx: number } }).options.num_ctx).toBe(4096);
    const tags = (await (await fetch(`${base}/api/tags`)).json()) as { models: { name: string }[] };
    expect(tags.models[0].name).toBe("qwen2.5-coder:3b");
  });

  it("releases the slot when a client gives up", async () => {
    const up = await fakeOllama(200);
    const { g, base } = await gateFor(up.url, 1, null);
    const ac = new AbortController();
    const first = fetch(`${base}/api/generate`, { method: "POST", body: "{}", signal: ac.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await first;
    await new Promise((r) => setTimeout(r, 100));
    const r = await fetch(`${base}/api/generate`, { method: "POST", body: "{}" });
    expect(r.status).toBe(200);
    expect(g.stats().running).toBe(0);
  });

  it("allows more lanes when configured", async () => {
    const up = await fakeOllama(100);
    const { base } = await gateFor(up.url, 2, null);
    await Promise.all([1, 2, 3, 4].map(() => fetch(`${base}/api/generate`, { method: "POST", body: "{}" })));
    expect(up.seen.max).toBe(2);
  });
});
