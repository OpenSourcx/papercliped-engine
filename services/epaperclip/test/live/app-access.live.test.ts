/** Disposable real engine only; creates its own company, agents, and loopback MCP provider. */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppAccessManager } from "../../src/app-access.ts";
import { PinApps, type EngineCall } from "../../src/pin-apps.ts";
import { StateStore } from "../../src/state.ts";
const BASE = process.env.EPC_LIVE_ENGINE ?? "";
const suite = BASE ? describe : describe.skip;
let jar = "", company = "", connection = "", selected = "", excluded = "";
let provider: http.Server;
const called: string[] = [];
let catalog: { id: string; toolName: string }[] = [];
const manager = new AppAccessManager();
const pin = new PinApps(new StateStore(null));
async function raw(method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", Origin: BASE, Cookie: jar }, body: body === undefined ? undefined : JSON.stringify(body) });
  const cookies = r.headers.getSetCookie(); if (cookies.length) jar = cookies.map((c) => c.split(";")[0]).join("; ");
  const data = await r.json(); return { status: r.status, data };
}
const call: EngineCall = async (m, p, b) => { const r = await raw(m, p, b); if (r.status >= 200 && r.status < 300) return r.data; throw Object.assign(new Error(`${r.status}: ${JSON.stringify(r.data)}`), { status: r.status }); };
const id = (name: string) => catalog.find((c) => c.toolName === name)!.id;
const choice = (access: "all_agents" | { agentIds: string[] } = { agentIds: [selected] }, enabled = ["read", "write"], ask = ["write"]) => ({ preserveExistingAccess: false, access, enabledCatalogEntryIds: enabled.map(id), askFirstCatalogEntryIds: ask.map(id), reviewedCatalogEntryIds: [] });
const invoke = (agentId: string, toolName: string) => call("POST", `/api/tool-connections/${connection}/test-calls`, { agentId, toolName, parameters: {} }) as Promise<{ decision: string; actionRequestId?: string }>;
const agent = async (name: string) => (await call("POST", `/api/companies/${company}/agents`, { name, role: "general", adapterType: "http", adapterConfig: { url: "http://127.0.0.1:9/never" }, runtimeConfig: { heartbeat: { enabled: false } } }) as { id: string }).id;
suite("app access against the pinned real engine", () => {
  beforeAll(async () => {
    provider = http.createServer((req, res) => {
      let input = ""; req.on("data", (c) => { input += c; }); req.on("end", () => {
        const m = JSON.parse(input || "{}");
        const reply = (result: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result })); };
        if (m.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "app-access-test", version: "1" } });
        if (m.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
        if (m.method === "tools/list") return reply({ tools: ["read", "write", "off"].map((name) => ({ name, description: name, inputSchema: { type: "object" }, annotations: { readOnlyHint: name === "read" } })) });
        if (m.method === "tools/call") { called.push(m.params.name); return reply({ content: [{ type: "text", text: "ok" }] }); }
        res.writeHead(200); res.end("{}");
      });
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    const port = (provider.address() as { port: number }).port;
    expect((await raw("POST", "/api/auth/sign-in/email", { email: "admin@test.invalid", password: "Disposable-pass-12345" })).status).toBe(200);
    company = (await call("POST", "/api/companies", { name: `App permission regression ${Date.now()}` }) as { id: string }).id;
    selected = await agent("Selected"); excluded = await agent("Excluded");
    connection = (await call("POST", `/api/companies/${company}/tools/apps/connect`, { link: `http://127.0.0.1:${port}/mcp`, name: "Permission fixture", authMode: "none", grantKind: "organization" }) as { connectionId: string }).connectionId;
    await call("POST", `/api/tool-connections/${connection}/catalog/refresh`, {});
    catalog = (await call("GET", `/api/tool-connections/${connection}/catalog`) as { catalog: typeof catalog }).catalog;
  }, 60_000);
  afterAll(async () => { if (provider) await new Promise<void>((r) => provider.close(() => r())); });
  it("reproduces upstream Off bypass, then enforces Allow/Ask/Off and selected-agent boundaries", async () => {
    await call("POST", `/api/companies/${company}/tools/apps/${connection}/finish`, choice());
    expect((await invoke(selected, "off")).decision).toBe("allowed");
    await manager.save(call, company.toUpperCase(), connection.toUpperCase(), choice({ agentIds: [selected.toUpperCase()] }));
    const before = called.length;
    expect((await invoke(selected, "read")).decision).toBe("allowed");
    const held = await invoke(selected, "write");
    expect(held.decision).toBe("ask_first");
    expect(held.actionRequestId).toBeTruthy();
    expect((await invoke(selected, "off")).decision).not.toBe("allowed");
    expect((await invoke(excluded, "read")).decision).not.toBe("allowed");
    expect((await invoke(await agent("Future"), "read")).decision).not.toBe("allowed");
    expect(called.slice(before)).toEqual(["read"]);
  }, 60_000);
  it("keeps Pin independent from all-agents choices, and an empty selection revokes ordinary agents", async () => {
    await pin.setAccess(call, company, connection, [{ catalogEntryId: id("write"), mode: "allow" }]);
    await manager.save(call, company, connection, choice("all_agents"));
    const before = called.length;
    expect(await pin.callTool(call, company, connection, "read", {})).toMatchObject({ outcome: "denied" });
    expect(await pin.callTool(call, company, connection, "write", {})).toMatchObject({ outcome: "done" });
    expect((await invoke(await agent("Future allowed"), "read")).decision).toBe("allowed");
    await manager.save(call, company, connection, choice({ agentIds: [] }));
    expect((await invoke(selected, "read")).decision).not.toBe("allowed");
    expect(await pin.callTool(call, company, connection, "write", {})).toMatchObject({ outcome: "done" });
    expect(called.slice(before)).toEqual(["write", "read", "write"]);
  }, 60_000);
  it("retains Ask after a failure during policy creation, so reopening and retrying cannot turn it into Allow", async () => {
    const failed: EngineCall = (m, p, b) => m === "POST" && p.endsWith("/policies") && (b as { name?: string })?.name?.includes(":ask:") ? Promise.reject(new Error("interrupted creating ask")) : call(m, p, b);
    await expect(manager.save(failed, company, connection, choice())).rejects.toMatchObject({ code: "app_access_incomplete" });
    const policies = (await call("GET", `/api/companies/${company}/tools/policies`) as { policies: { policyType: string; config?: { source?: string; connectionId?: string; catalogEntryId?: string } }[] }).policies;
    expect(policies.some((p) => p.policyType === "require_approval" && p.config?.source === "app_gallery_finish" && p.config.connectionId === connection && p.config.catalogEntryId === id("write"))).toBe(true);
    expect((await invoke(selected, "write")).decision).not.toBe("allowed");
    await new AppAccessManager().save(call, company, connection, choice());
    expect((await invoke(selected, "write")).decision).toBe("ask_first");
  }, 60_000);
  it("a failed save stays blocked in the engine until a complete retry succeeds", async () => {
    await manager.save(call, company, connection, choice());
    const failed: EngineCall = (m, p, b) => p.endsWith("/finish") ? Promise.reject(new Error("interrupted")) : call(m, p, b);
    await expect(manager.save(failed, company, connection, choice())).rejects.toMatchObject({ code: "app_access_incomplete" });
    const before = called.length;
    expect((await invoke(selected, "read")).decision).not.toBe("allowed");
    expect(await pin.callTool(call, company, connection, "write", {})).toMatchObject({ outcome: "denied" });
    expect(called).toHaveLength(before);
    await new AppAccessManager().save(call, company, connection, choice());
    expect((await invoke(selected, "read")).decision).toBe("allowed");
  }, 60_000);
});
