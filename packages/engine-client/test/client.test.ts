import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENGINE_PATHS, ENGINE_PATHS_UNDOCUMENTED, EngineError, safeEnginePath, MAX_ATTACHMENT_BYTES, createEngineClient, engineEventsUrl } from "../src/index.ts";

const spec = JSON.parse(readFileSync(new URL("../spec/openapi.json", import.meta.url), "utf8")) as { paths: Record<string, Record<string, unknown>> };

describe("the engine client", () => {
  it("only calls paths the pinned engine actually has", () => {
    for (const [name, path] of Object.entries(ENGINE_PATHS)) expect(spec.paths[path], `${name}: ${path}`).toBeDefined();
  });

  it("lists the routes the engine serves but does not document, and they are not in the spec yet", () => {
    for (const [name, path] of Object.entries(ENGINE_PATHS_UNDOCUMENTED)) expect(spec.paths[path], `${name}: ${path}`).toBeUndefined();
  });

  it("calls the routines, inbox, chat and settings routes with the bodies Paperclip's validators accept", async () => {
    const seen: { method?: string; url: string; body: unknown }[] = [];
    const c = createEngineClient({ fetch: async (url, init) => { seen.push({ method: init?.method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined }); return new Response("{}", { status: 200 }); } });
    await c.routines.addTrigger("r1", { kind: "schedule", cronExpression: "0 9 * * 1-5", timezone: "UTC" });
    await c.routines.rotateSecret("t1");
    await c.routines.run("r1");
    await c.inbox.attention("c1", { limit: 20 });
    await c.inbox.dismiss("c1", "attention:approval:a1");
    await c.inbox.restore("c1", "attention:approval:a1");
    await c.inbox.markRead("i1");
    await c.inbox.respond("i1", "x1", { answers: [] });
    await c.chat.open("c1", "forge");
    await c.chat.enable();
    await c.settings.budget("c1", 5000);
    await c.search("c1", { q: "pay roll" });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "POST /engine/api/routines/r1/triggers",
      "POST /engine/api/routine-triggers/t1/rotate-secret",
      "POST /engine/api/routines/r1/run",
      "GET /engine/api/companies/c1/attention?limit=20",
      "POST /engine/api/companies/c1/inbox-dismissals",
      "DELETE /engine/api/companies/c1/inbox-dismissals/attention%3Aapproval%3Aa1",
      "POST /engine/api/issues/i1/read",
      "POST /engine/api/issues/i1/interactions/x1/respond",
      "POST /engine/api/companies/c1/chats/forge",
      "PATCH /engine/api/instance/settings/experimental",
      "PATCH /engine/api/companies/c1/budgets",
      "GET /engine/api/companies/c1/search?q=pay+roll&limit=8".replace("pay+roll", "pay%20roll"),
    ]);
    expect(seen[0].body).toEqual({ kind: "schedule", cronExpression: "0 9 * * 1-5", timezone: "UTC" });
    expect(seen[9].body).toEqual({ enableAgentChat: true });
    expect(seen[10].body).toEqual({ budgetMonthlyCents: 5000 });
  });

  it("goes through the host service with the request header on writes and encodes ids", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const c = createEngineClient({ fetch: async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify({ id: "x" }), { status: 200 }); } });
    await c.companies.list();
    await c.issues.create("co/1", { title: "Do it" });
    await c.issues.list("co1", { status: "todo", q: undefined });
    expect(seen[0].url).toBe("/engine/api/companies");
    expect((seen[0].init?.headers as Record<string, string>)["X-EPC-Request"]).toBeUndefined();
    expect(seen[1].url).toBe("/engine/api/companies/co%2F1/issues");
    expect((seen[1].init?.headers as Record<string, string>)["X-EPC-Request"]).toBe("1");
    expect(seen[2].url).toBe("/engine/api/companies/co1/issues?status=todo");
  });

  it("sends the bodies Paperclip's validators accept", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const c = createEngineClient({ fetch: async (url, init) => { seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined }); return new Response("{}", { status: 200 }); } });
    await c.agents.create("co1", { name: "Forge", role: "engineer", adapterType: "process", adapterConfig: { command: "echo" } });
    await c.agents.wakeup("a1");
    await c.agents.runs("co1", "a1", 5);
    await c.issues.update("i1", { status: "done" });
    await c.approvals.reject("ap1", "Not now");
    await c.adapterModels("co1", "codex_local");
    expect(seen[0]).toEqual({ url: "/engine/api/companies/co1/agents", body: { name: "Forge", role: "engineer", adapterType: "process", adapterConfig: { command: "echo" } } });
    expect(seen[1].body).toEqual({ source: "on_demand", triggerDetail: "manual" });
    expect(seen[2].url).toBe("/engine/api/companies/co1/heartbeat-runs?agentId=a1&limit=5");
    expect(seen[3]).toEqual({ url: "/engine/api/issues/i1", body: { status: "done" } });
    expect(seen[4]).toEqual({ url: "/engine/api/approvals/ap1/reject", body: { decisionNote: "Not now" } });
    expect(seen[5].url).toBe("/engine/api/companies/co1/adapters/codex_local/models");
  });

  it("turns engine errors into EngineError with the engine's message", async () => {
    const c = createEngineClient({ fetch: async () => new Response(JSON.stringify({ error: "Board access required", code: "forbidden" }), { status: 403 }) });
    const e = await c.companies.list().catch((x) => x);
    expect(e).toBeInstanceOf(EngineError);
    expect(e).toMatchObject({ status: 403, message: "Board access required", code: "forbidden" });
  });

  it("builds the events socket address on the same origin", () => {
    expect(engineEventsUrl("abc", "https://pve.lan")).toBe("wss://pve.lan/engine/api/companies/abc/events/ws");
  });

  it("only follows engine file addresses that stay under /api/", () => {
    expect(safeEnginePath("/api/attachments/abc/content")).toBe(true);
    expect(safeEnginePath("/api/attachments/abc/content?download=1")).toBe(true);
    for (const bad of ["https://evil.example/api/x", "//evil.example/api/x", "/api/../auth/x", "/other/x", "/api/a\\b", "/api/"]) expect(safeEnginePath(bad), bad).toBe(false);
    expect(MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
  });

  it("uploads a file as multipart with the request header and reports a too-large answer in words", async () => {
    const seen: RequestInit[] = [];
    const c = createEngineClient({ fetch: async (_u, init) => { seen.push(init ?? {}); return new Response(JSON.stringify({ error: "Uploads are limited to 10 MiB" }), { status: 413 }); } });
    const e = await c.artifacts.upload("c1", "i1", new File(["x"], "a.txt")).catch((x) => x);
    expect(e).toMatchObject({ status: 413, message: "Uploads are limited to 10 MiB" });
    expect((seen[0].headers as Record<string, string>)["X-EPC-Request"]).toBe("1");
    expect(seen[0].body).toBeInstanceOf(FormData);
    expect(() => c.artifacts.fetchPath("https://evil.example/x")).toThrow();
  });

  it("hires an agent through the approval route when the organization refuses direct creation, and unwraps the agent", async () => {
    const seen: string[] = [];
    const refusal = { error: "Direct agent creation requires board approval. Use POST /api/companies/:companyId/agent-hires to create a pending hire approval." };
    const c = createEngineClient({
      fetch: async (url, init) => {
        seen.push(`${init?.method} ${url}`);
        return url.endsWith("/agent-hires") ? new Response(JSON.stringify({ agent: { id: "a1", status: "pending_approval" }, approval: { id: "p1" } }), { status: 201 }) : new Response(JSON.stringify(refusal), { status: 409 });
      },
    });
    expect(await c.agents.create("c1", { name: "Scout", adapterType: "x" })).toMatchObject({ id: "a1", status: "pending_approval" });
    expect(seen).toEqual(["POST /engine/api/companies/c1/agents", "POST /engine/api/companies/c1/agent-hires"]);
    // Any other refusal is not retried.
    const other = createEngineClient({ fetch: async (url, init) => { seen.push(`${init?.method} ${url}`); return new Response(JSON.stringify({ error: "Name taken" }), { status: 409 }); } });
    seen.length = 0;
    await expect(other.agents.create("c1", { name: "Scout", adapterType: "x" })).rejects.toMatchObject({ status: 409, message: "Name taken" });
    expect(seen).toEqual(["POST /engine/api/companies/c1/agents"]);
  });
});
