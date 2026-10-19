import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkBaseUrl, CATALOG } from "../src/features/connect-catalog.ts";
import { sseEvents } from "../src/pin.ts";
import { fakeCompat, startConnectApp, type ConnectApp } from "./fakes-connect.ts";

let h: ConnectApp;
let a: Awaited<ReturnType<typeof fakeCompat>>;
let b: Awaited<ReturnType<typeof fakeCompat>>;
beforeEach(async () => {
  a = await fakeCompat();
  b = await fakeCompat({ key: "gsk_hosted_0123456789abcdefghij" });
  h = await startConnectApp({ providers: (u, i) => fetch(u, i) });
});
afterEach(async () => {
  await h.closeAll();
  await a.close();
  await b.close();
});

const j = async (r: Response) => (await r.json()) as any;
const stateText = () => readFileSync(join(h.state.dir!, "state.json"), "utf8");
const add = (body: Record<string, unknown>, cookie = h.sam) => h.call("POST", "/api/connect/connections", { cookie }, body);
const chat = async (cookie = h.sam) => {
  const r = await h.call("POST", "/api/pin/chat", { cookie }, { messages: [{ role: "user", content: "hi" }], context: { page: "Home", device: "pve" } });
  const events: { event: string; data: any }[] = [];
  for await (const e of sseEvents(r.body as unknown as AsyncIterable<Uint8Array>)) events.push({ event: e.event, data: JSON.parse(e.data) });
  return events;
};

describe("the address rules", () => {
  it("allows plain http only on your own network, and never metadata or credentials", () => {
    for (const ok of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1/", "http://192.168.1.20:8080/v1", "http://10.0.0.5/v1", "http://gpu-box:11434/v1", "http://ollama.lan/v1", "https://llm.example.com/v1"]) expect(() => checkBaseUrl(ok), ok).not.toThrow();
    for (const bad of ["http://api.example.com/v1", "http://169.254.169.254/latest", "https://169.254.169.254/", "http://metadata.google.internal/", "http://0.0.0.0/", "ftp://x/", "https://user:pw@llm.example.com/v1", "https://llm.example.com/v1?key=1", "https://llm.example.com/#x", "nonsense", "", "http://a b/"]) expect(() => checkBaseUrl(bad), bad).toThrow();
    expect(checkBaseUrl("http://localhost:11434/v1///")).toBe("http://localhost:11434/v1");
  });
  it("lists the big hosted providers and the local ones", () => {
    const ids = CATALOG.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["anthropic", "openai", "gemini", "openrouter", "xai", "mistral", "groq", "deepseek", "ollama", "lmstudio", "llamacpp", "vllm", "openai-compatible"]));
    for (const c of CATALOG) {
      if (c.kind === "hosted") expect(c.base, c.id).toMatch(/^https:\/\//);
      if (c.keysUrl) expect(c.keysUrl, c.id).toMatch(/^https:\/\//);
    }
  });
});

describe("adding connections", () => {
  it("adds a local server without a key, tests it, lists its models", async () => {
    const r = await add({ catalog: "ollama", baseUrl: a.base, model: "llama3.2" });
    expect(r.status).toBe(201);
    const c = (await j(r)).connection;
    expect(c).toMatchObject({ id: "ollama", label: "Ollama", configured: true, enabled: true, pin: true, builtin: false, model: "llama3.2" });
    const t = await j(await h.call("POST", "/api/connect/connections/ollama/test", { cookie: h.sam }));
    expect(t.connection).toMatchObject({ ok: true, modelCount: 2 });
    expect(a.st.asked.at(-1)!.auth).toBeUndefined(); // no key, no credential header
    const m = await j(await h.call("GET", "/api/connect/connections/ollama/models", { cookie: h.sam }));
    expect(m.models.map((x: any) => x.id)).toEqual(["llama3.2", "qwen2.5"]);
  });

  it("keeps a hosted key sealed, never returns it, and redacts it from provider errors", async () => {
    const key = "gsk_hosted_0123456789abcdefghij";
    expect((await add({ catalog: "groq" })).status).toBe(400); // key required
    const r = await add({ catalog: "groq", apiKey: key });
    expect(r.status).toBe(201);
    const body = await r.text();
    expect(body).not.toContain(key);
    expect(body).toContain("hij"); // last four only
    expect(stateText()).not.toContain(key);
    expect(JSON.stringify(await j(await h.call("GET", "/api/connect/connections", { cookie: h.sam })))).not.toContain(key);
    // The hosted address can't be moved; point a custom one at the fake that echoes bad keys.
    expect((await h.call("PATCH", "/api/connect/connections/groq", { cookie: h.sam }, { baseUrl: b.base })).status).toBe(400);
    expect((await add({ catalog: "openai-compatible", id: "gateway", baseUrl: b.base, apiKey: "wrong-key-0123456789abcdefghij" })).status).toBe(201);
    const t = await j(await h.call("POST", "/api/connect/connections/gateway/test", { cookie: h.sam }));
    expect(t.connection.ok).toBe(false);
    expect(JSON.stringify(t)).not.toContain("wrong-key-0123456789abcdefghij");
    expect((await h.call("PUT", "/api/connect/connections/gateway/key", { cookie: h.sam }, { apiKey: "gsk_hosted_0123456789abcdefghij" })).status).toBe(200);
    h.clock.t += 4000;
    expect((await j(await h.call("POST", "/api/connect/connections/gateway/test", { cookie: h.sam }))).connection.ok).toBe(true);
  });

  it("says plainly when a local server can't be reached", async () => {
    await add({ catalog: "ollama", baseUrl: "http://127.0.0.1:9/v1" });
    const t = await j(await h.call("POST", "/api/connect/connections/ollama/test", { cookie: h.sam }));
    expect(t.connection.ok).toBe(false);
    expect(t.connection.error).toMatch(/Couldn't reach Ollama at 127\.0\.0\.1:9\. Is it running/);
    h.clock.t += 100;
    expect((await h.call("POST", "/api/connect/connections/ollama/test", { cookie: h.sam })).status).toBe(429); // one test every few seconds
  });

  it("validates everything and lets only administrators change anything", async () => {
    expect((await add({ catalog: "ollama", baseUrl: a.base }, h.lee)).status).toBe(403);
    expect((await add({ catalog: "nope" })).status).toBe(400);
    expect((await add({ catalog: "anthropic", apiKey: "sk-ant-0123456789abcdefghij" })).status).toBe(400); // built in
    expect((await add({ catalog: "ollama", baseUrl: "http://example.com/v1" })).status).toBe(400);
    expect((await add({ catalog: "ollama", baseUrl: a.base, sneaky: 1 })).status).toBe(400);
    expect((await add({ catalog: "ollama", id: "Bad Id", baseUrl: a.base })).status).toBe(409);
    expect((await add({ catalog: "ollama", baseUrl: a.base })).status).toBe(201);
    expect((await add({ catalog: "ollama", baseUrl: a.base })).status).toBe(201); // gets the next free name
    const names = (await j(await h.call("GET", "/api/connect/connections", { cookie: h.lee }))).connections.map((c: any) => c.id);
    expect(names).toEqual(expect.arrayContaining(["ollama", "ollama-2", "anthropic"]));
    expect((await h.call("PATCH", "/api/connect/connections/ollama", { cookie: h.lee }, { enabled: false })).status).toBe(403);
    expect((await h.call("PATCH", "/api/connect/connections/ollama", { cookie: h.sam }, { price: { inPerM: -1, outPerM: 1 } })).status).toBe(400);
    expect((await h.call("PATCH", "/api/connect/connections/ollama", { cookie: h.sam }, { model: "bad model!" })).status).toBe(400);
    expect((await h.call("PATCH", "/api/connect/connections/ollama", { cookie: h.sam }, { orgs: ["../x"] })).status).toBe(400);
    expect((await h.call("PATCH", "/api/connect/connections/ollama", { cookie: h.sam }, { orgs: ["co_1"], pin: true })).status).toBe(200);
    const noHeader = await fetch(`${h.base}/api/connect/connections/ollama`, { method: "DELETE", headers: { Cookie: h.sam } });
    expect(noHeader.status).toBe(403);
    expect((await h.call("DELETE", "/api/connect/connections/ollama-2", { cookie: h.sam })).status).toBe(200);
  });

  it("removes the key with the connection", async () => {
    await add({ catalog: "groq", apiKey: "gsk_hosted_0123456789abcdefghij" });
    expect(JSON.parse(stateText()).secrets["connection.groq.apiKey"]).toBeTruthy();
    await h.call("DELETE", "/api/connect/connections/groq", { cookie: h.sam });
    expect(JSON.parse(stateText()).secrets["connection.groq.apiKey"]).toBeUndefined();
  });
});

describe("Pin and the connections", () => {
  it("chats through a local model, records usage and shows a cost when a price is set", async () => {
    await add({ catalog: "ollama", baseUrl: a.base, model: "llama3.2" });
    expect((await h.call("PUT", "/api/pin/settings", { cookie: h.sam }, { provider: "x:ollama", model: "llama3.2" })).status).toBe(200);
    const models = await j(await h.call("GET", "/api/pin/models?provider=x:ollama", { cookie: h.sam }));
    expect(models.models.map((m: any) => m.id)).toContain("qwen2.5");
    const ev = await chat();
    expect(ev.filter((e) => e.event === "delta").map((e) => e.data.text).join("")).toBe("Hello from the local model.");
    expect(ev.at(-1)!.event).toBe("done");
    const asked = JSON.parse(a.st.asked.filter((x) => x.url.includes("chat")).at(-1)!.body);
    expect(asked).toMatchObject({ model: "llama3.2", stream: true, max_tokens: 2048 });
    expect(asked.max_completion_tokens).toBeUndefined();
    let u = await j(await h.call("GET", "/api/connect/usage?days=7", { cookie: h.lee }));
    expect(u.byConnection).toEqual([expect.objectContaining({ id: "x:ollama", calls: 1, tokensIn: 120, tokensOut: 30, costUsd: null, priced: false })]);
    await h.call("PATCH", "/api/connect/connections/ollama", { cookie: h.sam }, { price: { inPerM: 2, outPerM: 10 } });
    u = await j(await h.call("GET", "/api/connect/usage?days=7", { cookie: h.sam }));
    expect(u.byConnection[0].costUsd).toBeCloseTo((120 * 2 + 30 * 10) / 1e6, 6);
    expect(u.perDay).toHaveLength(1);
    expect((await h.call("GET", "/api/connect/usage?days=999", { cookie: h.sam })).status).toBe(400);
  });

  it("follows the fallback chain when the chosen service can't answer, before anything is shown", async () => {
    await add({ catalog: "ollama", baseUrl: a.base, model: "llama3.2" });
    await add({ catalog: "lmstudio", baseUrl: b.base.replace("/v1", "/v1"), model: "qwen2.5", apiKey: "gsk_hosted_0123456789abcdefghij" });
    expect((await h.call("PUT", "/api/connect/fallbacks", { cookie: h.sam }, { order: ["x:lmstudio"] })).status).toBe(200);
    await h.call("PUT", "/api/pin/settings", { cookie: h.sam }, { provider: "x:ollama", model: "llama3.2" });
    // The chosen service is asked three times (once, then two retries) before the chain is followed.
    a.st.fail = 3;
    const ev = await chat();
    expect(ev.find((e) => e.event === "error")).toBeUndefined();
    expect(ev.at(-1)).toMatchObject({ event: "done", data: { via: "LM Studio" } });
    expect(JSON.parse(b.st.asked.filter((x) => x.url.includes("chat")).at(-1)!.body).model).toBe("qwen2.5");
    // Without a chain the error is shown, in words.
    await h.call("PUT", "/api/connect/fallbacks", { cookie: h.sam }, { order: [] });
    a.st.fail = 3;
    const ev2 = await chat();
    expect(ev2.find((e) => e.event === "error")!.data.code).toBe("provider_overloaded");
    // A single hiccup never reaches the person: the service answers on the retry.
    a.st.fail = 1;
    expect((await chat()).find((e) => e.event === "error")).toBeUndefined();
  });

  it("only accepts a fallback that has a default model, and only known connections", async () => {
    await add({ catalog: "ollama", baseUrl: a.base });
    expect((await h.call("PUT", "/api/connect/fallbacks", { cookie: h.sam }, { order: ["x:ollama"] })).status).toBe(400);
    expect((await h.call("PUT", "/api/connect/fallbacks", { cookie: h.sam }, { order: ["x:nothing"] })).status).toBe(400);
    expect((await h.call("PUT", "/api/connect/fallbacks", { cookie: h.lee }, { order: [] })).status).toBe(403);
  });

  it("respects who may use a connection", async () => {
    await add({ catalog: "ollama", baseUrl: a.base, model: "llama3.2" });
    await h.call("PATCH", "/api/connect/connections/ollama", { cookie: h.sam }, { pin: false });
    expect((await h.call("PUT", "/api/pin/settings", { cookie: h.sam }, { provider: "x:ollama" })).status).toBe(400);
    await h.call("PATCH", "/api/connect/connections/ollama", { cookie: h.sam }, { pin: true, enabled: false });
    expect((await h.call("PUT", "/api/pin/settings", { cookie: h.sam }, { provider: "x:ollama" })).status).toBe(400);
    await h.call("PATCH", "/api/connect/connections/ollama", { cookie: h.sam }, { enabled: true });
    expect((await h.call("PUT", "/api/pin/settings", { cookie: h.sam }, { provider: "x:ollama" })).status).toBe(200);
  });
});
