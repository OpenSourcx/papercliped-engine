import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { sseEvents } from "../src/pin.ts";
import { SessionStore } from "../src/sessions.ts";
import { StateStore } from "../src/state.ts";
import { fakeEngine, fakePve, fakeProviders } from "./fakes.ts";

/** Pin's chat route end to end: what the console names is checked on the server before Pin is told anything about it. */

let eng: Awaited<ReturnType<typeof fakeEngine>>;
let prov: Awaited<ReturnType<typeof fakeProviders>>;
let server: Server;
let base: string;

beforeEach(async () => {
  eng = await fakeEngine({ bootstrap: "ready" });
  const pve = fakePve();
  prov = await fakeProviders();
  const app = createApp({ pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport }, sessions: new SessionStore(), staticDir: null, secureCookies: false, state: new StateStore(mkdtempSync(join(tmpdir(), "epc-pinctx-"))), engine: { url: eng.url, sleep: async () => {} }, fetch: prov.fetch });
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await eng.close();
  await prov.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-EPC-Request": "1", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
async function signIn() {
  const r = await send("POST", "/api/login", { username: "sam", password: "right", realm: "pve" });
  return r.headers.get("set-cookie")!.split(";")[0]!;
}
const answer = () => [
  { event: "message_start", data: { type: "message_start", message: { id: "m1" } } },
  { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" } } },
  { event: "message_stop", data: { type: "message_stop" } },
];
async function chat(c: string, context: unknown) {
  prov.set((_r, res) => res.end("{}"));
  await send("PUT", "/api/connectors/anthropic/credential", { apiKey: "sk-test-0123456789abcdefWXYZ" }, { Cookie: c });
  await send("PUT", "/api/pin/settings", { provider: "anthropic", model: "model-a" }, { Cookie: c });
  prov.sse(answer());
  const r = await send("POST", "/api/pin/chat", { messages: [{ role: "user", content: "Why did this fail?" }], context }, { Cookie: c });
  const events: { event: string; data: any }[] = [];
  for await (const e of sseEvents(r.body as unknown as AsyncIterable<Uint8Array>)) events.push({ event: e.event, data: JSON.parse(e.data) });
  return { events, system: String(JSON.parse(prov.asked.at(-1)!.body).system) };
}

describe("Pin chat with a named run", () => {
  it("tells Pin a run it can't see isn't available, and tells the console the chip is unavailable", async () => {
    const { events, system } = await chat(await signIn(), { page: "Run", device: "pve", runId: "run-1", resource: { kind: "lxc", node: "pve", vmid: 104 } });
    expect(system).toContain("Verified context.");
    expect(system).toContain("Run run-1 isn't available to this person");
    expect(system).toContain("Machine container 104: no agent runs recorded that this person can see");
    expect(events.find((e) => e.event === "context")?.data.items).toEqual([
      { kind: "run", id: "run-1", label: "Run", status: "unavailable" },
      { kind: "machine", id: "104", label: "Container 104", status: "ok" },
    ]);
    expect(events.at(-1)).toEqual({ event: "done", data: { stopReason: "end_turn" } });
  });

  it("drops malformed ids instead of passing them on, and adds nothing when nothing typed was named", async () => {
    const { events, system } = await chat(await signIn(), { page: "Overview", device: "pve", runId: "../../etc/passwd", companyId: "x y" });
    expect(system).not.toContain("Verified context");
    expect(system).not.toContain("passwd");
    expect(events.some((e) => e.event === "context")).toBe(false);
    expect(events.at(-1)?.event).toBe("done");
  });
});
