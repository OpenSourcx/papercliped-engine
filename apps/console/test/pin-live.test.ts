import { describe, expect, it } from "vitest";
import { fixFor, pinApi, streamChat, toStreamEvent, type PinStreamEvent } from "../src/pin/live.ts";

/** A tiny stand-in for the host service: answers by path, records what it was sent. */
function fakeHost(routes: Record<string, (init: RequestInit) => Response>) {
  const calls: { path: string; init: RequestInit }[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input);
    calls.push({ path, init });
    const key = Object.keys(routes).find((k) => path === k || path.startsWith(`${k}?`));
    if (!key) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    return routes[key](init);
  }) as typeof fetch;
  return { f, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function sse(chunks: string[]) {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("Pin's host API", () => {
  it("reads the host service's connectors, settings and models", async () => {
    const { f, calls } = fakeHost({
      "/api/connectors": () => json({ connectors: [{ id: "anthropic", kind: "model", label: "Anthropic", configured: true, last4: "abcd", ok: true }, { id: "openai", kind: "model", label: "OpenAI", configured: false }], canManage: true }),
      "/api/pin/settings": (init) => (init.method === "PUT" ? json(JSON.parse(String(init.body))) : json({ provider: "anthropic", model: "model-a", mode: "agent", permission: "ask", connectors: ["github"] })),
      "/api/pin/models": () => json({ provider: "anthropic", models: [{ id: "model-a", label: "Model A" }, { id: "model-b", label: "Model B" }] }),
    });
    const api = pinApi(f);
    expect(await api.connectors()).toEqual([
      { id: "anthropic", kind: "model", name: "Anthropic", configured: true, last4: "abcd", ok: true },
      { id: "openai", kind: "model", name: "OpenAI", configured: false },
    ]);
    expect(await api.settings()).toEqual({ provider: "anthropic", model: "model-a", mode: "agent", permission: "ask", connectors: ["github"] });
    expect(await api.models("anthropic")).toEqual([{ id: "model-a", name: "Model A" }, { id: "model-b", name: "Model B" }]);
    expect(calls.at(-1)!.path).toBe("/api/pin/models?provider=anthropic");

    const saved = await api.saveSettings({ provider: "anthropic", model: "model-b", mode: "assistant", permission: "ask", connectors: [] });
    expect(saved.model).toBe("model-b");
    const put = calls.at(-1)!;
    expect(put.init.method).toBe("PUT");
    expect((put.init.headers as Record<string, string>)["X-EPC-Request"]).toBe("1");
  });

  it("turns a host error into a readable message", async () => {
    const { f } = fakeHost({ "/api/pin/models": () => json({ code: "provider_auth", error: "The key was rejected." }, 400) });
    await expect(pinApi(f).models("anthropic")).rejects.toThrow("The key was rejected.");
  });
});

describe("Pin's chat stream", () => {
  it("parses delta, tool, done and error events", () => {
    expect(toStreamEvent({ event: "delta", data: '{"text":"Hi"}' })).toEqual({ type: "delta", text: "Hi" });
    expect(toStreamEvent({ event: "tool", data: '{"id":"call_1","name":"power_machine","args":{"vmid":101,"action":"stop"},"status":"proposed"}' })).toEqual({
      type: "tool",
      tool: { id: "call_1", name: "power_machine", args: { vmid: 101, action: "stop" }, status: "proposed" },
    });
    expect(toStreamEvent({ event: "tool", data: '{"id":"t2","name":"list_machines","args":{},"status":"error"}' })).toMatchObject({ tool: { status: "failed" } });
    expect(toStreamEvent({ event: "done", data: '{"stopReason":"end"}' })).toEqual({ type: "done" });
    expect(toStreamEvent({ event: "error", data: '{"code":"provider_auth","message":"Anthropic rejected the key."}' })).toEqual({
      type: "error",
      error: { message: "Anthropic rejected the key.", code: "provider_auth", fix: { label: "Check the provider's key in Connectors", to: "?settings=connectors" } },
    });
    expect(toStreamEvent({ event: "ping", data: "" })).toBeNull();
  });

  it("names the fix for errors people can solve", () => {
    expect(fixFor("no_provider", "")?.label).toBe("Add a model provider in Connectors");
    expect(fixFor("no_model", "")?.to).toBe("pin?tab=settings");
    expect(fixFor("provider_overloaded", "Busy, try again")).toBeUndefined();
    for (const code of ["provider_rate_limited", "provider_no_credit", "provider_no_tools", "provider_empty", "provider_rejected"]) expect(fixFor(code, "x")).toEqual({ label: "Choose another model in Pin's settings", to: "pin?tab=settings" });
  });

  it("streams a conversation and sends the page context", async () => {
    const { f, calls } = fakeHost({
      "/api/pin/chat": () => sse(['event: delta\ndata: {"text":"pve is "}\n\n', 'event: delta\ndata: {"text":"healthy."}\n', '\nevent: tool\ndata: {"id":"c1","name":"power_machine","args":{"vmid":109,"action":"reboot"},"status":"proposed"}\n\nevent: done\ndata: {}\n\n']),
    });
    const events: PinStreamEvent[] = [];
    await streamChat({ messages: [{ role: "user", content: "How is my server?" }], context: { page: "/pve/home", device: "pve" } }, (e) => events.push(e), { fetch: f });
    expect(events.map((e) => e.type)).toEqual(["delta", "delta", "tool", "done"]);
    expect(events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("")).toBe("pve is healthy.");
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent.context).toEqual({ page: "/pve/home", device: "pve" });
    expect((calls[0].init.headers as Record<string, string>)["X-EPC-Request"]).toBe("1");
  });

  it("reports a refusal before the stream as one error with its fix", async () => {
    const { f } = fakeHost({ "/api/pin/chat": () => json({ code: "no_provider", error: "Pin needs a model provider. An administrator can add an API key in Connectors." }, 400) });
    const events: PinStreamEvent[] = [];
    await streamChat({ messages: [], context: { page: "/", device: "pve" } }, (e) => events.push(e), { fetch: f });
    expect(events).toEqual([{ type: "error", error: { message: "Pin needs a model provider. An administrator can add an API key in Connectors.", code: "no_provider", fix: { label: "Add a model provider in Connectors", to: "?settings=connectors" } } }]);
  });

  it("ends quietly when stopped", async () => {
    const ctl = new AbortController();
    const f = (async (_: RequestInfo | URL, init: RequestInit = {}) => {
      if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return sse([]);
    }) as typeof fetch;
    ctl.abort();
    const events: PinStreamEvent[] = [];
    await streamChat({ messages: [], context: { page: "/", device: "pve" } }, (e) => events.push(e), { fetch: f, signal: ctl.signal });
    expect(events).toEqual([]);
  });

  it("closes a stream that ended without done", async () => {
    const { f } = fakeHost({ "/api/pin/chat": () => sse(['event: delta\ndata: {"text":"Hi"}\n\n']) });
    const events: PinStreamEvent[] = [];
    await streamChat({ messages: [], context: { page: "/", device: "pve" } }, (e) => events.push(e), { fetch: f });
    expect(events.at(-1)).toEqual({ type: "done" });
  });
});

describe("Pin's starting data", () => {
  it("has made-up activity in the demo only, never on a live device", async () => {
    const { defaultPinData } = await import("../src/data/pin.ts");
    expect(defaultPinData().log.length).toBeGreaterThan(0);
    expect(defaultPinData(true).log.length).toBeGreaterThan(0);
    expect(defaultPinData(false).log).toEqual([]);
  });
});
