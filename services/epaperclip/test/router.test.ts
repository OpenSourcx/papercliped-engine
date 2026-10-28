import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Connectors } from "../src/connectors.ts";
import { ConnectionsStore } from "../src/features/connect-connections.ts";
import { sseEvents } from "../src/pin.ts";
import { fromAnthropic, fromOpenAI, toAnthropic, toOpenAI } from "../src/router/formats.ts";
import { Router, RouterKeys } from "../src/router/router.ts";
import { routerHandler } from "../src/router/server.ts";
import { StateStore } from "../src/state.ts";
import { startConnectApp } from "./fakes-connect.ts";

/**
 * The Router (docs/ROUTER.md): both wire formats, translation between them, pass-through for same-format calls,
 * fallback along the chain, resting connections that keep failing, usage in the shared ledger, and its keys.
 * Providers are a fake fetch that answers the way Anthropic and OpenAI-compatible services stream.
 */

const ANT_KEY = "sk-ant-api03-PROVIDERKEYPROVIDERKEY0000";
const DS_KEY = "sk-deepseek-PROVIDERKEYPROVIDERKEY1111";
const GROQ_KEY = "gsk_groq_PROVIDERKEYPROVIDERKEY2222";

type Seen = { url: string; headers: Record<string, string>; body: any };
const sseBody = (blocks: string[]) => new Response(new ReadableStream({ start(c) { for (const b of blocks) c.enqueue(new TextEncoder().encode(b)); c.close(); } }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
const ev = (event: string | null, data: unknown) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;

/** An Anthropic stream that says "Hi" and calls one tool. */
const anthropicAnswer = () => sseBody([
  ev("message_start", { type: "message_start", message: { id: "msg_up", usage: { input_tokens: 40, output_tokens: 1 } } }),
  ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }),
  ev("content_block_stop", { type: "content_block_stop", index: 0 }),
  ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "list_files", input: {} } }),
  ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":" } }),
  ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"/srv\"}" } }),
  ev("content_block_stop", { type: "content_block_stop", index: 1 }),
  ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } }),
  ev("message_stop", { type: "message_stop" }),
]);

/** An OpenAI-compatible stream that says "Yo" and calls one tool, its name arriving before its arguments in pieces. */
const openaiAnswer = () => sseBody([
  ev(null, { choices: [{ index: 0, delta: { role: "assistant", content: "Yo" } }] }),
  ev(null, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "list_files", arguments: "" } }] } }] }),
  ev(null, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"path\":\"/srv\"}" } }] } }] }),
  ev(null, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
  ev(null, { choices: [], usage: { prompt_tokens: 30, completion_tokens: 8 } }),
  "data: [DONE]\n\n",
]);

/** What an OpenAI-compatible service answers when the request didn't ask for a stream. */
const openaiWhole = () => new Response(JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Yo" }, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 8 } }), { status: 200, headers: { "Content-Type": "application/json" } });
const openaiFor = (s: Seen) => (s.body.stream === true ? openaiAnswer() : openaiWhole());

let state: StateStore;
let store: ConnectionsStore;
let keys: RouterKeys;
let router: Router;
let server: Server;
let base: string;
let key: string;
let seen: Seen[];
let answer: (s: Seen) => Response;
let clock: number;

beforeEach(async () => {
  seen = [];
  clock = 1_800_000_000_000;
  answer = (s) => (s.url.includes("anthropic") ? anthropicAnswer() : openaiFor(s));
  const fetchImpl = async (url: string, init: RequestInit) => {
    const s: Seen = { url, headers: Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])), body: JSON.parse(String(init.body)) };
    seen.push(s);
    return answer(s);
  };
  state = new StateStore(null);
  const connectors = new Connectors(state, fetchImpl, () => clock);
  store = new ConnectionsStore({ state, connectors, fetch: fetchImpl, now: () => clock });
  connectors.setKey("anthropic", ANT_KEY, "root@pam");
  store.update("anthropic", { model: "claude-sonnet-4-5" }, "root@pam");
  store.create({ catalog: "deepseek", apiKey: DS_KEY, model: "deepseek-chat" }, "root@pam");
  store.create({ catalog: "groq", apiKey: GROQ_KEY, model: "llama-3.3-70b" }, "root@pam");
  store.saveFallbackOrder(["anthropic", "x:deepseek", "x:groq"], "root@pam");
  keys = new RouterKeys(state, () => clock);
  key = keys.create("ada's claude code", "root@pam").key;
  router = new Router({ connections: store, fetch: fetchImpl, now: () => clock });
  server = createServer(routerHandler({ router, keys }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", authorization: `Bearer ${key}`, ...headers }, body: JSON.stringify(body) });
const events = async (r: Response) => {
  const out: { event: string; data: any }[] = [];
  for await (const e of sseEvents(r.body as unknown as AsyncIterable<Uint8Array>)) out.push({ event: e.event, data: e.data === "[DONE]" ? "[DONE]" : JSON.parse(e.data) });
  return out;
};
const usageRows = () => store.usage(1).byModel;

describe("keys", () => {
  it("answers only with a Router key, given either way, and never from a web page", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await post("/v1/messages", {}, { authorization: "" })).status).toBe(401);
    expect((await post("/v1/messages", {}, { authorization: "Bearer epr_nope" })).status).toBe(401);
    expect((await post("/v1/messages", {}, { authorization: `Bearer ${ANT_KEY}` })).status).toBe(401);
    const viaX = await post("/v1/messages", { model: "auto", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }, { authorization: "", "x-api-key": key });
    expect(viaX.status).toBe(200);
    await viaX.text();
    const page = await post("/v1/messages", {}, { origin: "https://evil.example" });
    expect(page.status).toBe(403);
    const r401 = (await (await post("/v1/messages", {}, { authorization: "" })).json()) as any;
    expect(r401).toMatchObject({ type: "error", error: { type: "authentication_error" } });
  });

  it("keeps only a hash, shows the key once, and a revoked key stops working", async () => {
    expect(JSON.stringify(state.getSetting("router.keys"))).not.toContain(key);
    const [view] = keys.list();
    expect(view).toMatchObject({ name: "ada's claude code", last4: key.slice(-4) });
    expect(view).not.toHaveProperty("hash");
    keys.revoke(view.id, "root@pam");
    expect((await post("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "hi" }] })).status).toBe(401);
    expect(() => keys.create("", "root@pam")).toThrow();
    keys.create("ci", "root@pam");
    expect(() => keys.create("CI", "root@pam")).toThrow(/already exists/);
  });
});

describe("same format: passed through", () => {
  it("sends an Anthropic request to Anthropic untouched, with the provider's key and the client's beta header", async () => {
    const body = { model: "claude-sonnet-4-5", max_tokens: 50, stream: true, system: [{ type: "text", text: "Be brief", cache_control: { type: "ephemeral" } }], thinking: { type: "enabled", budget_tokens: 1024 }, messages: [{ role: "user", content: "hi" }] };
    const r = await post("/v1/messages", body, { authorization: "", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31" });
    expect(r.status).toBe(200);
    const out = await events(r);
    expect(out.map((e) => e.event)).toContain("message_stop");
    const s = seen[0];
    expect(s.url).toBe("https://api.anthropic.com/v1/messages");
    expect(s.body).toEqual(body); // thinking and cache_control survive
    expect(s.headers["x-api-key"]).toBe(ANT_KEY);
    expect(s.headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    expect(JSON.stringify(s.headers)).not.toContain(key);
    expect(usageRows()).toEqual([expect.objectContaining({ connection: "anthropic", model: "claude-sonnet-4-5", calls: 1, tokensIn: 40, tokensOut: 12 })]);
  });

  it("sends an OpenAI request to an OpenAI-compatible service with only the model changed", async () => {
    const r = await post("/v1/chat/completions", { model: "deepseek/deepseek-reasoner", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "hi" }], seed: 7 });
    expect(r.status).toBe(200);
    await r.text();
    expect(seen[0].url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(seen[0].body).toMatchObject({ model: "deepseek-reasoner", seed: 7, stream: true });
    expect(seen[0].headers.authorization).toBe(`Bearer ${DS_KEY}`);
    expect(usageRows()).toEqual([expect.objectContaining({ connection: "x:deepseek", model: "deepseek-reasoner", tokensIn: 30, tokensOut: 8 })]);
  });
});

describe("different formats: translated", () => {
  it("lets Claude Code use DeepSeek: an Anthropic request becomes OpenAI's, and the answer comes back as Anthropic events", async () => {
    store.update("anthropic", { enabled: false }, "root@pam");
    const r = await post("/v1/messages", {
      model: "claude-sonnet-4-5", max_tokens: 100, stream: true, system: "You are terse.",
      tools: [{ name: "list_files", description: "List files", input_schema: { type: "object", properties: { path: { type: "string" } } } }, { type: "web_search_20250305", name: "web_search" }],
      messages: [
        { role: "user", content: "what's in /srv?" },
        { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "toolu_0", name: "list_files", input: { path: "/" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_0", content: "srv etc" }, { type: "text", text: "and /srv?" }] },
      ],
    }, { authorization: "", "x-api-key": key, "anthropic-version": "2023-06-01" });
    expect(r.status).toBe(200);
    const sent = seen[0];
    expect(sent.url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(sent.body.model).toBe("deepseek-chat");
    expect(sent.body.messages).toEqual([
      { role: "system", content: "You are terse." },
      { role: "user", content: "what's in /srv?" },
      { role: "assistant", content: "Looking.", tool_calls: [{ id: "toolu_0", type: "function", function: { name: "list_files", arguments: "{\"path\":\"/\"}" } }] },
      { role: "tool", tool_call_id: "toolu_0", content: "srv etc" },
      { role: "user", content: "and /srv?" },
    ]);
    expect(sent.body.tools.map((t: any) => t.function.name)).toEqual(["list_files"]); // the server tool is left out
    const out = await events(r);
    expect(out.map((e) => e.data.type)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(out[1].data.content_block).toEqual({ type: "text", text: "" });
    expect(out[2].data.delta).toEqual({ type: "text_delta", text: "Yo" });
    expect(out[4].data.content_block).toMatchObject({ type: "tool_use", id: "call_9", name: "list_files" });
    expect(out[5].data.delta).toEqual({ type: "input_json_delta", partial_json: "{\"path\":\"/srv\"}" });
    expect(out[7].data).toMatchObject({ delta: { stop_reason: "tool_use" }, usage: { input_tokens: 30, output_tokens: 8 } });
  });

  it("answers an OpenAI client from Anthropic, streamed or whole", async () => {
    const req = { model: "anthropic/claude-sonnet-4-5", messages: [{ role: "system", content: "Be brief" }, { role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "list_files", parameters: { type: "object", properties: {} } } }], tool_choice: "required", max_tokens: 64 };
    const whole = (await (await post("/v1/chat/completions", req)).json()) as any;
    expect(seen[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen[0].body).toMatchObject({ model: "claude-sonnet-4-5", system: "Be brief", max_tokens: 64, tool_choice: { type: "any" }, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
    expect(whole.choices[0]).toMatchObject({ finish_reason: "tool_calls", message: { role: "assistant", content: "Hi", tool_calls: [{ id: "toolu_1", type: "function", function: { name: "list_files", arguments: "{\"path\":\"/srv\"}" } }] } });
    expect(whole.usage).toEqual({ prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 });

    const r = await post("/v1/chat/completions", { ...req, stream: true, stream_options: { include_usage: true } });
    const out = await events(r);
    const deltas = out.filter((e) => e.data !== "[DONE]" && e.data.choices?.length).map((e) => e.data.choices[0]);
    expect(deltas[0].delta).toEqual({ role: "assistant", content: "" });
    expect(deltas.map((d) => d.delta.content).filter(Boolean).join("")).toBe("Hi");
    expect(deltas.find((d) => d.delta.tool_calls?.[0]?.id)?.delta.tool_calls[0]).toMatchObject({ index: 0, id: "toolu_1", function: { name: "list_files" } });
    expect(deltas.at(-1)!.finish_reason).toBe("tool_calls");
    expect(out.at(-2)!.data.usage).toEqual({ prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 });
    expect(out.at(-1)!.data).toBe("[DONE]");
  });

  it("round-trips images and tool results between the two shapes", () => {
    const n = fromOpenAI({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }, { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{\"a\":1}" } }] }, { role: "tool", tool_call_id: "c1", content: "ok" }] });
    const a = toAnthropic(n, "claude");
    expect(a.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "see" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "f", input: { a: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] },
    ]);
    const back = toOpenAI(fromAnthropic({ model: "m", max_tokens: 5, messages: a.messages }), "gpt", true);
    expect(back).toMatchObject({ model: "gpt", max_completion_tokens: 5, stream: true });
    expect((back.messages as any[])[0].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
  });

  it("keeps an instruction that arrives mid-conversation, as Claude Code sends them", () => {
    const n = fromAnthropic({ model: "m", max_tokens: 9, system: "Top", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }, { role: "system", content: "Reminder: be brief" }] });
    expect((toOpenAI(n, "x", false).messages as any[]).map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "system"]);
    expect(toAnthropic(n, "y").system).toBe("Top\n\nReminder: be brief");
  });

  it("refuses a request it can't read, in the client's format", async () => {
    const r = await post("/v1/messages", { messages: [] }, { authorization: "", "x-api-key": key });
    expect(r.status).toBe(400);
    expect((await r.json()) as any).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    const o = await post("/v1/chat/completions", { model: "auto", messages: [{ role: "wizard", content: "x" }] });
    expect(o.status).toBe(400);
    expect(((await o.json()) as any).error.message).toMatch(/role/);
  });
});

describe("choosing and falling back", () => {
  it("resolves auto, a connection and model, OpenRouter-style names and maker prefixes", () => {
    expect(router.resolve("auto").map((c) => `${c.pid}:${c.model}`)).toEqual(["anthropic:claude-sonnet-4-5", "x:deepseek:deepseek-chat", "x:groq:llama-3.3-70b"]);
    expect(router.resolve("groq/mixtral")[0]).toMatchObject({ pid: "x:groq", model: "mixtral" });
    expect(router.resolve("x:deepseek/deepseek-coder")[0]).toMatchObject({ pid: "x:deepseek", model: "deepseek-coder" });
    expect(router.resolve("claude-haiku-4-5")[0]).toMatchObject({ pid: "anthropic", model: "claude-haiku-4-5" });
    expect(router.resolve("llama-3.3-70b")[0]).toMatchObject({ pid: "x:groq" });
    // A name no connection knows is answered by the chain, each with its default model.
    expect(router.resolve("mystery-model")[0]).toMatchObject({ pid: "anthropic", model: "claude-sonnet-4-5" });
    store.update("anthropic", { enabled: false }, "root@pam");
    expect(router.resolve("claude-haiku-4-5").map((c) => c.pid)).toEqual(["x:deepseek", "x:groq"]);
  });

  it("falls back when a service is rate-limiting, and rests it for a while", async () => {
    answer = (s) => (s.url.includes("anthropic") ? new Response(JSON.stringify({ error: { message: `slow down ${ANT_KEY}` } }), { status: 429, headers: { "retry-after": "20" } }) : openaiFor(s));
    const r = await post("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).choices[0].message.content).toBe("Yo");
    expect(seen.map((s) => new URL(s.url).host)).toEqual(["api.anthropic.com", "api.deepseek.com"]);
    expect(router.status()).toEqual([expect.objectContaining({ pid: "anthropic" })]);
    // While Anthropic rests, it isn't asked at all.
    seen = [];
    await (await post("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "again" }] })).text();
    expect(seen.map((s) => new URL(s.url).host)).toEqual(["api.deepseek.com"]);
    clock += 21_000;
    seen = [];
    await (await post("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "later" }] })).text();
    expect(new URL(seen[0].url).host).toBe("api.anthropic.com");
  });

  it("passes a plain bad request back instead of trying the next service, and never leaks a provider key", async () => {
    answer = () => new Response(JSON.stringify({ error: { message: `max_tokens is too large for key ${DS_KEY}` } }), { status: 400 });
    const r = await post("/v1/chat/completions", { model: "deepseek/deepseek-chat", messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(400);
    const text = await r.text();
    expect(text).toContain("max_tokens is too large");
    expect(text).not.toContain(DS_KEY);
    expect(seen).toHaveLength(1);
  });

  it("says what each service answered when none could", async () => {
    answer = () => new Response("{}", { status: 503 });
    const r = await post("/v1/messages", { model: "auto", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }, { authorization: "", "x-api-key": key });
    expect(r.status).toBe(502);
    const j = (await r.json()) as any;
    expect(j.error.message).toMatch(/Anthropic: 503.*DeepSeek: 503.*Groq: 503/);
    expect(seen).toHaveLength(3);
  });

  it("lists the models a client can name, in each format", async () => {
    const o = (await (await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } })).json()) as any;
    expect(o.data.map((m: any) => m.id)).toEqual(["auto", "anthropic/claude-sonnet-4-5", "deepseek/deepseek-chat", "groq/llama-3.3-70b"]);
    const a = (await (await fetch(`${base}/v1/models`, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } })).json()) as any;
    expect(a.data[0]).toMatchObject({ type: "model", id: "auto" });
    const c = (await (await post("/v1/messages/count_tokens", { model: "auto", messages: [{ role: "user", content: "x".repeat(400) }] })).json()) as any;
    expect(c.input_tokens).toBeGreaterThan(90);
  });
});

describe("managing the Router from the console", () => {
  it("lets an administrator make and revoke keys; others can't, and the key is shown only once", async () => {
    const h = await startConnectApp();
    try {
      const made = await h.call("POST", "/api/router/keys", { cookie: h.sam }, { name: "ops agent" });
      expect(made.status).toBe(201);
      const { key: k, view } = (await made.json()) as any;
      expect(k).toMatch(/^epr_/);
      const st = (await (await h.call("GET", "/api/router", { cookie: h.sam })).json()) as any;
      expect(st.keys).toEqual([expect.objectContaining({ id: view.id, name: "ops agent" })]);
      expect(JSON.stringify(st)).not.toContain(k);
      expect((await h.call("GET", "/api/router", { cookie: h.lee })).status).toBe(403);
      expect((await h.call("POST", "/api/router/keys", { cookie: h.lee }, { name: "sneaky" })).status).toBe(403);
      expect((await h.call("DELETE", `/api/router/keys/${view.id}`, { cookie: h.sam })).status).toBe(200);
    } finally {
      await h.closeAll();
    }
  });
});
