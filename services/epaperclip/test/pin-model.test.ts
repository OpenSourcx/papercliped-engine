import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sseEvents } from "../src/pin.ts";
import { fakeProviders } from "./fakes.ts";
import { startPinApp } from "./fakes-pin.ts";

const KEY = "sk-test-0123456789abcdefWXYZ";
let h: Awaited<ReturnType<typeof startPinApp>>;
let prov: Awaited<ReturnType<typeof fakeProviders>>;
let sam: string;
const j = (r: Response): Promise<any> => r.json();

beforeEach(async () => {
  prov = await fakeProviders();
  h = await startPinApp({ providers: prov.fetch });
  sam = await h.signIn("sam");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.close();
  await prov.close();
});

const put = (path: string, body: unknown, cookie = sam) => h.call("PUT", path, { cookie }, body);
async function configure(model = "m-1") {
  expect((await put("/api/connectors/anthropic/credential", { apiKey: KEY })).status).toBe(200);
  await put("/api/pin/settings", { provider: "anthropic", model });
}

describe("model and connector settings, end to end", () => {
  it("keys are write-only: nothing a route returns, or the log, ever holds the key", async () => {
    const logs: string[] = [];
    for (const m of ["log", "warn", "error", "info"] as const) vi.spyOn(console, m).mockImplementation((...a) => void logs.push(a.join(" ")));
    await configure();
    prov.set((_r, res) => (res.writeHead(401, { "Content-Type": "application/json" }), res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}. Also sk-proj-****abcd and Bearer ${KEY}` } }))));
    const bodies = [
      await j(await h.call("GET", "/api/connectors", { cookie: sam })),
      await j(await h.call("POST", "/api/connectors/anthropic/test", { cookie: sam })),
      await j(await h.call("GET", "/api/pin/settings", { cookie: sam })),
      await j(await h.call("POST", "/api/pin/settings/test", { cookie: sam }, {})),
      await (await h.call("GET", "/api/pin/models?provider=anthropic", { cookie: sam })).json(),
    ];
    const all = JSON.stringify(bodies) + logs.join("\n");
    expect(all).not.toContain(KEY);
    expect(all).not.toContain("sk-proj");
    expect(all).not.toContain("0123456789abcdef");
    expect(bodies[0].connectors.find((c: any) => c.id === "anthropic")).toMatchObject({ configured: true, last4: "WXYZ" });
    expect(bodies[1].connector).toMatchObject({ ok: false });
    expect(bodies[1].connector.error).toMatch(/rejected the API key/);
    // The chat stream's errors are clean too.
    const r = await h.call("POST", "/api/pin/chat", { cookie: sam }, { messages: [{ role: "user", content: "hi" }], context: {} });
    const text: string[] = [];
    for await (const e of sseEvents(r.body as unknown as AsyncIterable<Uint8Array>)) text.push(e.data);
    expect(text.join("")).not.toContain(KEY);
  });

  it("only administrators change keys; bad keys are refused in words", async () => {
    const lee = await h.signIn("lee");
    expect((await put("/api/connectors/anthropic/credential", { apiKey: KEY }, lee)).status).toBe(403);
    const bad = await put("/api/connectors/anthropic/credential", { apiKey: "short" });
    expect(bad.status).toBe(400);
    expect((await j(bad)).error).toMatch(/Paste the whole key/);
  });

  it("tests the chosen model with one tiny request and reports each failure in words", async () => {
    await configure();
    prov.set((_r, res) => res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }] })));
    h.clock.t += 5000;
    expect(await j(await h.call("POST", "/api/pin/settings/test", { cookie: sam }, {}))).toMatchObject({ ok: true, provider: "anthropic", model: "m-1" });
    const sent = JSON.parse(prov.asked.at(-1)!.body);
    expect(sent).toMatchObject({ model: "m-1", max_tokens: 8 });
    expect(prov.asked.at(-1)!.headers["x-api-key"]).toBe(KEY);

    h.rt.now = () => h.clock.t;
    h.clock.t += 5000;
    prov.set((_r, res) => (res.writeHead(404, { "Content-Type": "application/json" }), res.end(JSON.stringify({ error: { message: "model: m-1" } }))));
    const gone = await j(await h.call("POST", "/api/pin/settings/test", { cookie: sam }, {}));
    expect(gone).toMatchObject({ ok: false, code: "provider_rejected" });
    expect(gone.error).toMatch(/doesn't know that model/);

    h.clock.t += 5000;
    prov.set((_r, res) => (res.writeHead(429), res.end("{}")));
    expect((await j(await h.call("POST", "/api/pin/settings/test", { cookie: sam }, {}))).code).toBe("provider_rate_limited");
    // Too soon after the last one.
    expect((await h.call("POST", "/api/pin/settings/test", { cookie: sam }, {})).status).toBe(429);
  });

  it("says what is missing before it tries", async () => {
    const none = await h.call("POST", "/api/pin/settings/test", { cookie: sam }, {});
    expect(none.status).toBe(400);
    expect((await j(none)).code).toBe("no_provider");
    expect(prov.asked).toHaveLength(0);
  });
});

describe("Agent mode in the conversation", () => {
  const tool = (name: string, input: unknown) => {
    prov.set((req, res) => {
      const body = JSON.parse(req.body);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const ev = (e: string, d: unknown) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
      const done = body.messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === "tool_result"));
      if (done) {
        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I wrote the plan down." } });
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } });
      } else {
        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name, input: {} } });
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } });
      }
      res.end();
    });
  };
  const chat = async () => {
    const r = await h.call("POST", "/api/pin/chat", { cookie: sam }, { messages: [{ role: "user", content: "Back up then stop the web server" }], context: {} });
    const out: { event: string; data: any }[] = [];
    for await (const e of sseEvents(r.body as unknown as AsyncIterable<Uint8Array>)) out.push({ event: e.event, data: JSON.parse(e.data) });
    return out;
  };

  it("offers propose_plan only in Agent mode, and a plan it writes runs nothing", async () => {
    await configure();
    tool("propose_plan", { title: "Stop web", steps: [{ kind: "snapshot", vmid: 101, name: "before-stop" }, { kind: "power", vmid: 101, action: "stop" }] });
    await chat();
    expect(JSON.parse(prov.asked.at(-2)!.body).tools.map((t: any) => t.name)).not.toContain("propose_plan");
    await put("/api/pin/settings", { mode: "agent" });
    const ev = await chat();
    expect(JSON.parse(prov.asked.at(-2)!.body).tools.map((t: any) => t.name)).toContain("propose_plan");
    const proposed = ev.find((e) => e.event === "tool" && e.data.name === "propose_plan")!;
    expect(proposed.data.status).toBe("proposed");
    expect(proposed.data.args.steps.map((s: any) => s.label)).toEqual(["Take snapshot before-stop of machine 101 (web)", "Stop machine 101 (web)"]);
    expect(proposed.data.args.steps[1].destructive).toBe(true);
    expect(h.pve.guests.get(101)!.status).toBe("running");
    expect(h.pve.snapshots.get(101)).toBeUndefined();
    expect((await j(await h.call("GET", "/api/pin/plans", { cookie: sam }))).waiting).toBe(1);
  });

  it("a plan naming a machine the person can't see is refused to the model, not stored", async () => {
    await configure();
    await put("/api/pin/settings", { mode: "agent" });
    tool("propose_plan", { title: "x", steps: [{ kind: "power", vmid: 999, action: "start" }] });
    const ev = await chat();
    expect(ev.find((e) => e.event === "tool")!.data).toMatchObject({ status: "error", error: expect.stringMatching(/no machine 999/) });
    expect((await j(await h.call("GET", "/api/pin/plans", { cookie: sam }))).plans).toHaveLength(0);
  });
});
