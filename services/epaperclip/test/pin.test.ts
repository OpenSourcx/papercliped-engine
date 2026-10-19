import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { managedEmail } from "../src/engine.ts";
import { CHATS_AT_ONCE, CHATS_PER_MINUTE, MAX_STEPS, Pin, parseMessages, sseEvents } from "../src/pin.ts";
import { SessionStore } from "../src/sessions.ts";
import { StateStore } from "../src/state.ts";
import { fakeEngine, fakePve, fakeProviders, until } from "./fakes.ts";

let eng: Awaited<ReturnType<typeof fakeEngine>>;
let pve: ReturnType<typeof fakePve>;
let prov: Awaited<ReturnType<typeof fakeProviders>>;
let server: Server;
let base: string;
let stateDir: string;

beforeEach(async () => {
  eng = await fakeEngine({ bootstrap: "ready" });
  pve = fakePve();
  prov = await fakeProviders();
  stateDir = mkdtempSync(join(tmpdir(), "epc-pin-"));
  const app = createApp({ pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport }, sessions: new SessionStore(), staticDir: null, secureCookies: false, state: new StateStore(stateDir), engine: { url: eng.url, sleep: async () => {} }, fetch: prov.fetch });
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
const get = (path: string, c: string) => fetch(base + path, { headers: { Cookie: c } });
const j = (r: Response): Promise<any> => r.json();
async function signIn(username = "sam") {
  const r = await send("POST", "/api/login", { username, password: "right", realm: "pve" });
  return r.headers.get("set-cookie")!.split(";")[0];
}
const KEY = "sk-test-0123456789abcdefWXYZ";
async function configure(c: string, id = "anthropic", model?: string) {
  prov.set((_r, res) => res.end("{}"));
  expect((await send("PUT", `/api/connectors/${id}/credential`, { apiKey: KEY }, { Cookie: c })).status).toBe(200);
  await send("PUT", "/api/pin/settings", { provider: id, ...(model ? { model } : {}) }, { Cookie: c });
}
/** Reads Pin's answer stream into a list of events. */
async function chat(c: string, messages: unknown = [{ role: "user", content: "What is running?" }], context: unknown = { page: "Overview", device: "pve" }) {
  const r = await send("POST", "/api/pin/chat", { messages, context }, { Cookie: c });
  expect(r.headers.get("content-type")).toContain("text/event-stream");
  const events: { event: string; data: any }[] = [];
  for await (const e of sseEvents(r.body as unknown as AsyncIterable<Uint8Array>)) events.push({ event: e.event, data: JSON.parse(e.data) });
  return events;
}
const text = (events: { event: string; data: any }[]) => events.filter((e) => e.event === "delta").map((e) => e.data.text).join("");

describe("connectors", () => {
  it("lists every provider without secrets, and tells administrators they can manage them", async () => {
    const c = await signIn();
    const r = await j(await get("/api/connectors", c));
    expect(r.canManage).toBe(true);
    expect(r.connectors.map((x: { id: string; configured: boolean }) => [x.id, x.configured])).toEqual([["anthropic", false], ["openai", false], ["gemini", false], ["openrouter", false]]);
    expect((await j(await get("/api/connectors", await signIn("lee")))).canManage).toBe(false);
  });

  it("lets only Proxmox administrators set keys, and never sends a key back", async () => {
    const lee = await signIn("lee");
    expect((await send("PUT", "/api/connectors/openai/credential", { apiKey: KEY }, { Cookie: lee })).status).toBe(403);
    const sam = await signIn();
    expect((await send("PUT", "/api/connectors/openai/credential", { apiKey: "short" }, { Cookie: sam })).status).toBe(400);
    expect((await send("PUT", "/api/connectors/openai/credential", { apiKey: `${KEY} rm -rf` }, { Cookie: sam })).status).toBe(400);
    expect((await fetch(base + "/api/connectors/openai/credential", { method: "PUT", headers: { Cookie: sam, "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: KEY }) })).status).toBe(403);
    expect((await send("PUT", "/api/connectors/nope/credential", { apiKey: KEY }, { Cookie: sam })).status).toBe(404);
    const r = await send("PUT", "/api/connectors/openai/credential", { apiKey: ` ${KEY} ` }, { Cookie: sam });
    const body = await r.text();
    expect(body).not.toContain(KEY);
    expect(JSON.parse(body).connector).toMatchObject({ id: "openai", configured: true, last4: "WXYZ", updatedBy: "sam@pve" });
    const asLee = await (await get("/api/connectors", lee)).text();
    expect(asLee).not.toContain(KEY);
    expect(JSON.parse(asLee).connectors[1]).toMatchObject({ configured: true, last4: "WXYZ" });
    expect(readFileSync(join(stateDir, "state.json"), "utf8")).not.toContain(KEY);
    expect((await send("DELETE", "/api/connectors/openai/credential", undefined, { Cookie: lee })).status).toBe(403);
    expect((await send("DELETE", "/api/connectors/openai/credential", undefined, { Cookie: sam })).status).toBe(200);
    expect((await j(await get("/api/connectors", sam))).connectors[1].configured).toBe(false);
  });

  it("tests a key with one real call per provider and records the result", async () => {
    const c = await signIn();
    for (const id of ["anthropic", "openai", "gemini", "openrouter"]) await send("PUT", `/api/connectors/${id}/credential`, { apiKey: KEY }, { Cookie: c });
    prov.set((_r, res) => res.end('{"data":[]}'));
    const ok = await j(await send("POST", "/api/connectors/anthropic/test", undefined, { Cookie: c }));
    expect(ok.connector).toMatchObject({ ok: true, testedAt: expect.any(Number) });
    expect(prov.asked.at(-1)).toMatchObject({ url: "https://api.anthropic.com/v1/models?limit=1", headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01" } });
    await send("POST", "/api/connectors/openai/test", undefined, { Cookie: c });
    expect(prov.asked.at(-1)).toMatchObject({ url: "https://api.openai.com/v1/models", headers: { authorization: `Bearer ${KEY}` } });
    await send("POST", "/api/connectors/gemini/test", undefined, { Cookie: c });
    expect(prov.asked.at(-1)!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1");
    expect(prov.asked.at(-1)!.headers["x-goog-api-key"]).toBe(KEY);
    await send("POST", "/api/connectors/openrouter/test", undefined, { Cookie: c });
    expect(prov.asked.at(-1)!.url).toBe("https://openrouter.ai/api/v1/key");
    prov.set((_r, res) => {
      res.writeHead(401);
      res.end('{"error":{"message":"invalid x-api-key"}}');
    });
    const bad = await j(await send("POST", "/api/connectors/anthropic/test", undefined, { Cookie: c }));
    expect(bad.connector).toMatchObject({ ok: false, error: expect.stringContaining("rejected the API key") });
    expect(JSON.stringify(bad)).not.toContain(KEY);
    expect((await send("POST", "/api/connectors/anthropic/test", undefined, { Cookie: await signIn("lee") })).status).toBe(403);
  });
});

describe("Pin settings and models", () => {
  it("starts in Assistant mode on the first configured provider and remembers choices per person", async () => {
    const c = await signIn();
    expect(await j(await get("/api/pin/settings", c))).toEqual({ provider: null, model: null, mode: "assistant", permission: "ask", connectors: [] });
    expect((await send("PUT", "/api/pin/settings", { provider: "openai" }, { Cookie: c })).status).toBe(400);
    await send("PUT", "/api/connectors/openai/credential", { apiKey: KEY }, { Cookie: c });
    expect(await j(await get("/api/pin/settings", c))).toEqual({ provider: "openai", model: null, mode: "assistant", permission: "ask", connectors: [] });
    const saved = await j(await send("PUT", "/api/pin/settings", { model: "model-a", mode: "agent", connectors: ["openai"] }, { Cookie: c }));
    expect(saved).toEqual({ provider: "openai", model: "model-a", mode: "agent", permission: "ask", connectors: ["openai"] });
    expect(new StateStore(stateDir).getSetting<Record<string, unknown>>("pin.settings")!["sam@pve"]).toEqual(saved);
    expect((await j(await get("/api/pin/settings", await signIn("lee")))).mode).toBe("assistant");
    expect((await send("PUT", "/api/pin/settings", { mode: "boss" }, { Cookie: c })).status).toBe(400);
    expect((await send("PUT", "/api/pin/settings", { model: "a b" }, { Cookie: c })).status).toBe(400);
  });

  it("lists models from the provider, normalised and cached briefly", async () => {
    const c = await signIn();
    await configure(c, "anthropic");
    prov.set((_r, res) => res.end(JSON.stringify({ data: [{ id: "model-b", display_name: "Model B" }, { id: "model-a", display_name: "Model A" }] })));
    const r = await j(await get("/api/pin/models?provider=anthropic", c));
    expect(r).toEqual({ provider: "anthropic", models: [{ id: "model-b", label: "Model B" }, { id: "model-a", label: "Model A" }] });
    const n = prov.asked.length;
    await get("/api/pin/models", c);
    expect(prov.asked.length).toBe(n);
    await configure(c, "gemini");
    prov.set((_r, res) => res.end(JSON.stringify({ models: [{ name: "models/model-g", displayName: "Model G", supportedGenerationMethods: ["generateContent"] }, { name: "models/embed-x", supportedGenerationMethods: ["embedContent"] }] })));
    expect((await j(await get("/api/pin/models?provider=gemini", c))).models).toEqual([{ id: "model-g", label: "Model G" }]);
    expect((await get("/api/pin/models?provider=openai", c)).status).toBe(404);
    await configure(c, "openrouter");
    prov.set((_r, res) => {
      res.writeHead(429);
      res.end("{}");
    });
    const limited = await get("/api/pin/models?provider=openrouter", c);
    expect(limited.status).toBe(502);
    expect((await j(limited)).code).toBe("provider_rate_limited");
  });
});

describe("Pin chat", () => {
  const anthropicText = (...parts: string[]) => [
    { event: "message_start", data: { type: "message_start", message: { id: "m1" } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "ping", data: { type: "ping" } },
    ...parts.map((t) => ({ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } } })),
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ];

  it("checks the request before streaming", async () => {
    const c = await signIn();
    expect((await j(await send("POST", "/api/pin/chat", { messages: [{ role: "user", content: "hi" }] }, { Cookie: c }))).code).toBe("no_provider");
    await configure(c);
    expect((await j(await send("POST", "/api/pin/chat", { messages: [{ role: "user", content: "hi" }] }, { Cookie: c }))).code).toBe("no_model");
    await send("PUT", "/api/pin/settings", { model: "model-a" }, { Cookie: c });
    expect((await send("POST", "/api/pin/chat", { messages: [{ role: "assistant", content: "hi" }] }, { Cookie: c })).status).toBe(400);
    expect((await fetch(base + "/api/pin/chat", { method: "POST", headers: { Cookie: c, "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
  });

  it("streams an Anthropic answer, with who Pin is and where the person is in the system prompt", async () => {
    const c = await signIn();
    await configure(c, "anthropic", "model-a");
    prov.sse(anthropicText("Two machines ", "are running."));
    const events = await chat(c);
    expect(text(events)).toBe("Two machines are running.");
    expect(events.at(-1)).toEqual({ event: "done", data: { stopReason: "end_turn" } });
    const req = JSON.parse(prov.asked.at(-1)!.body);
    expect(prov.asked.at(-1)!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req).toMatchObject({ model: "model-a", stream: true, max_tokens: 2048, messages: [{ role: "user", content: "What is running?" }] });
    expect(req.system).toContain('You are Pin, the copilot built into ePaperclip on the Proxmox host "pve"');
    expect(req.system).toContain("Never claim to have done something");
    expect(req.system).toContain("Assistant mode");
    expect(req.system).toContain("- Page: Overview");
    expect(req.tools.map((t: { name: string }) => t.name)).toContain("list_machines");
  });

  it("runs read-only tools as the person and feeds the results back (Anthropic)", async () => {
    const c = await signIn();
    await configure(c, "anthropic", "model-a");
    let n = 0;
    prov.set((r, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const ev = (e: string, d: unknown) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
      if (n++ === 0) {
        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "machine_detail", input: {} } });
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"vm' } });
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'id": 101}' } });
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } });
      } else {
        for (const e of anthropicText("web has 2 cores.")) ev(e.event, e.data);
      }
      res.end();
    });
    const events = await chat(c);
    expect(events.filter((e) => e.event === "tool")).toEqual([{ event: "tool", data: { id: "tu1", name: "machine_detail", args: { vmid: 101 }, status: "done" } }]);
    expect(text(events)).toBe("web has 2 cores.");
    const second = JSON.parse(prov.asked.at(-1)!.body);
    expect(second.messages[1]).toEqual({ role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "machine_detail", input: { vmid: 101 } }] });
    const result = second.messages[2].content[0];
    expect(result).toMatchObject({ type: "tool_result", tool_use_id: "tu1" });
    expect(result.content).toContain('"cores":2');
    // Credentials in a machine's config never reach the model.
    expect(result.content).not.toContain("hunter2");
    expect(result.content).not.toContain("ssh-ed25519");
  });

  it("returns changes as proposals and never carries them out (OpenAI)", async () => {
    const c = await signIn();
    await configure(c, "openai", "model-a");
    let n = 0;
    prov.set((_r, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const d = (x: unknown) => res.write(`data: ${JSON.stringify(x)}\n\n`);
      if (n++ === 0) {
        d({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "power_machine", arguments: '{"vmid":' } }] } }] });
        d({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '101,"action":"stop"}' } }] } }] });
        d({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
      } else {
        d({ choices: [{ delta: { content: "I've proposed stopping web. Confirm it to go ahead." } }] });
        d({ choices: [{ delta: {}, finish_reason: "stop" }] });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
    const events = await chat(c, [{ role: "user", content: "Stop web" }]);
    expect(events.find((e) => e.event === "tool")!.data).toEqual({ id: "call_1", name: "power_machine", args: { vmid: 101, action: "stop" }, status: "proposed" });
    expect(text(events)).toContain("proposed");
    expect(events.at(-1)!.event).toBe("done");
    expect(pve.calls.some((x) => x.path.includes("/status/"))).toBe(false);
    const second = JSON.parse(prov.asked.at(-1)!.body);
    expect(prov.asked.at(-1)!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(second.max_completion_tokens).toBe(2048);
    expect(second.messages[0].role).toBe("system");
    expect(second.messages.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "power_machine" } }] });
    expect(second.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1", content: expect.stringContaining("NOT been done") });
  });

  it("reads organizations through the person's engine session (OpenRouter)", async () => {
    const c = await signIn();
    await until(() => eng.users.has(managedEmail("sam@pve")));
    eng.company("c1", "Northwind", { [eng.userId(managedEmail("sam@pve"))!]: "owner" });
    await configure(c, "openrouter", "vendor/model-a");
    let n = 0;
    prov.set((_r, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": OPENROUTER PROCESSING\n\n");
      if (n++ === 0) res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "org_summary", arguments: '{"companyId":"c1"}' } }] }, finish_reason: "tool_calls" }] })}\n\n`);
      else res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "One open issue." }, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    const events = await chat(c, [{ role: "user", content: "How is Northwind?" }], { page: "Organization", org: "Northwind" });
    expect(events.find((e) => e.event === "tool")!.data.status).toBe("done");
    const second = JSON.parse(prov.asked.at(-1)!.body);
    expect(prov.asked.at(-1)!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(second.max_tokens).toBe(2048);
    const result = JSON.parse(second.messages.at(-1).content);
    expect(result).toMatchObject({ organization: { name: "Northwind" }, openIssues: { count: 1 }, pendingApprovals: { count: 1 }, agents: { count: 1 } });
    expect(second.messages[0].content).toContain("- Organization: Northwind");
  });

  it("explains provider failures: a bad key, rate limits, overload mid-stream", async () => {
    const c = await signIn();
    await configure(c, "anthropic", "model-a");
    prov.set((_r, res) => {
      res.writeHead(401);
      res.end('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
    });
    expect((await chat(c)).at(-1)).toEqual({ event: "error", data: { code: "provider_auth", message: expect.stringContaining("rejected the API key") } });
    prov.set((_r, res) => {
      res.writeHead(429);
      res.end("{}");
    });
    expect((await chat(c)).at(-1)!.data.code).toBe("provider_rate_limited");
    prov.sse([...anthropicText("Part").slice(0, 3), { event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }]);
    const events = await chat(c);
    expect(events.at(-1)!.data.code).toBe("provider_overloaded");
  });

  it("stops a tool loop that never ends", async () => {
    const c = await signIn();
    await configure(c, "anthropic", "model-a");
    prov.set((_r, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `t${prov.asked.length}`, name: "recent_tasks", input: {} } })}\n\n`);
      res.end();
    });
    const events = await chat(c);
    expect(prov.asked.filter((a) => a.url.endsWith("/messages"))).toHaveLength(MAX_STEPS);
    expect(JSON.parse(prov.asked.at(-1)!.body).tool_choice).toEqual({ type: "none" });
    expect(events.at(-1)!.data.code).toBe("too_many_steps");
  });

  it("answers in words through Gemini", async () => {
    const c = await signIn();
    await configure(c, "gemini", "model-g");
    prov.sse([{ data: { candidates: [{ content: { parts: [{ text: "Hello " }] } }] } }, { data: { candidates: [{ content: { parts: [{ text: "there." }] }, finishReason: "STOP" }] } }]);
    const events = await chat(c);
    expect(text(events)).toBe("Hello there.");
    expect(prov.asked.at(-1)!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/model-g:streamGenerateContent?alt=sse");
  });
});

describe("Pin helpers", () => {
  it("parses server-sent events split anywhere, with CRLF, comments and multi-line data", async () => {
    const enc = new TextEncoder();
    async function* chunks() {
      for (const s of ["event: a\r", "\ndata: 1\r\n", "data: 2\r\n\r\n: comment\n\n", "data: last"]) yield enc.encode(s);
    }
    const out = [];
    for await (const e of sseEvents(chunks())) out.push(e);
    expect(out).toEqual([{ event: "a", data: "1\n2" }, { event: "message", data: "last" }]);
  });

  it("trims history to recent, alternating messages that end with the person", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }));
    const out = parseMessages([...many, { role: "user", content: "again" }]);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out[0].role).toBe("user");
    expect(out.at(-1)).toEqual({ role: "user", content: "again" });
    expect(parseMessages([{ role: "user", content: "a" }, { role: "user", content: "b" }])).toEqual([{ role: "user", content: "a\n\nb" }]);
  });
});

describe("chat cost and load limits", () => {
  it("lets one person start only so many chats a minute, and so many at once, without affecting anyone else", () => {
    let t = 1_000_000;
    const pin = new Pin({ state: new StateStore(null), connectors: null as never, fetch: (async () => new Response()) as never, now: () => t });
    const open = Array.from({ length: CHATS_AT_ONCE }, () => pin.admit("sam@pve"));
    expect(() => pin.admit("sam@pve")).toThrow(/still answering/);
    expect(() => pin.admit("lee@pve")()).not.toThrow(); // someone else is unaffected
    open[0]();
    open[0](); // releasing twice doesn't free a second slot
    pin.admit("sam@pve")();
    expect(() => pin.admit("sam@pve")).not.toThrow();
    for (const r of open.slice(1)) r();
    // The per-minute count: 20 in a minute, then wait.
    const fresh = new Pin({ state: new StateStore(null), connectors: null as never, fetch: (async () => new Response()) as never, now: () => t });
    for (let i = 0; i < CHATS_PER_MINUTE; i++) fresh.admit("sam@pve")();
    expect(() => fresh.admit("sam@pve")).toThrow(/lot of questions/);
    t += 61_000;
    expect(() => fresh.admit("sam@pve")()).not.toThrow();
  });

  it("answers 429 over HTTP once the minute's allowance is used", async () => {
    const c = await signIn();
    await configure(c, "anthropic", "test-model");
    prov.set((_r, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n`);
    });
    let status = 0;
    for (let i = 0; i < CHATS_PER_MINUTE + 1; i++) {
      const r = await send("POST", "/api/pin/chat", { messages: [{ role: "user", content: "hi" }], context: {} }, { Cookie: c });
      status = r.status;
      await r.text();
    }
    expect(status).toBe(429);
    expect((await send("PUT", "/api/pin/settings", { mode: "agent" }, { Cookie: c })).status).toBe(200); // other routes unaffected
  });
});

describe("when the model provider struggles", () => {
  const okStream = (res: import("node:http").ServerResponse, text = "All good.") => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  };
  const fail = (res: import("node:http").ServerResponse, status: number, message: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify({ error: { message } }));
  };
  const completions = () => prov.asked.filter((a) => a.url.endsWith("/chat/completions"));

  it("asks again after a brief rate limit, and shows nothing until it answers", async () => {
    const c = await signIn();
    await configure(c, "openrouter", "vendor/model-x");
    let n = 0;
    prov.set((_r, res) => (++n === 1 ? fail(res, 429, "slow down", { "Retry-After": "0" }) : okStream(res, "Here you go.")));
    const events = await chat(c);
    expect(text(events)).toBe("Here you go.");
    expect(events.some((e) => e.event === "error")).toBe(false);
    expect(completions()).toHaveLength(2);
  });

  it("gives up after two more tries and passes on what the provider said", async () => {
    const c = await signIn();
    await configure(c, "openrouter", "vendor/model-x");
    prov.set((_r, res) => fail(res, 429, "Provider returned error: free-models-per-day limit reached"));
    const last = (await chat(c)).at(-1)!;
    expect(last.event).toBe("error");
    expect(last.data.code).toBe("provider_rate_limited");
    expect(last.data.message).toContain("free-models-per-day limit reached");
    expect(last.data.message).toMatch(/pick another model/i);
    expect(completions()).toHaveLength(3);
  });

  it("says plainly when an account is out of credit, with where to fix it", async () => {
    const c = await signIn();
    await configure(c, "openrouter", "vendor/model-x");
    prov.set((_r, res) => fail(res, 402, "Insufficient credits"));
    const last = (await chat(c)).at(-1)!;
    expect(last.data.code).toBe("provider_no_credit");
    expect(last.data.message).toContain("out of credit (Insufficient credits)");
    expect(last.data.message).toContain("openrouter.ai/settings/credits");
    expect(completions()).toHaveLength(1); // no point asking again
  });

  it("asks for a shorter reply when the balance can't pay for the full length", async () => {
    const c = await signIn();
    await configure(c, "openrouter", "vendor/model-x");
    prov.set((r, res) => (JSON.parse(r.body).max_tokens > 900 ? fail(res, 402, "This request requires more credits, or fewer max_tokens. You requested up to 2048 tokens, but can only afford 900.") : okStream(res, "Short and sweet.")));
    const events = await chat(c);
    expect(text(events)).toBe("Short and sweet.");
    expect(completions().map((a) => JSON.parse(a.body).max_tokens)).toEqual([2048, 868]);
  });

  it("tells you when a model can't use tools instead of showing a raw refusal", async () => {
    const c = await signIn();
    await configure(c, "openrouter", "vendor/no-tools");
    prov.set((_r, res) => fail(res, 404, 'No endpoints found that support tool use. Try disabling "tools".'));
    const last = (await chat(c)).at(-1)!;
    expect(last.data.code).toBe("provider_no_tools");
    expect(last.data.message).toMatch(/can't use tools, which Pin needs/);
    expect(last.data.message).toMatch(/pick another model/i);
  });

  it("offers OpenRouter models that can call tools, and marks the free ones", async () => {
    const c = await signIn();
    await configure(c, "openrouter");
    prov.set((_r, res) =>
      res.end(JSON.stringify({ data: [
        { id: "vendor/chat-only", name: "Chat Only", supported_parameters: ["temperature"], pricing: { prompt: "0.000001", completion: "0.000002" } },
        { id: "vendor/with-tools", name: "With Tools", supported_parameters: ["temperature", "tools"], pricing: { prompt: "0.000001", completion: "0.000002" } },
        { id: "vendor/gratis:free", name: "Gratis", supported_parameters: ["tools"], pricing: { prompt: "0", completion: "0" } },
        { id: "vendor/unknown", name: "Unknown" },
      ] })),
    );
    const models = (await j(await get("/api/pin/models?provider=openrouter", c))).models;
    expect(models.map((m: { id: string }) => m.id)).toEqual(["vendor/gratis:free", "vendor/unknown", "vendor/with-tools"]);
    expect(models.find((m: { id: string }) => m.id === "vendor/gratis:free").label).toBe("Gratis (free)");
  });
});
