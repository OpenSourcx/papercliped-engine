/** Disposable real engine only. Adversarial checks of the app-access enforcement (PR #17) that its own live tests do not cover. */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppAccessManager } from "../../src/app-access.ts";
import { PinApps, type EngineCall } from "../../src/pin-apps.ts";
import { StateStore } from "../../src/state.ts";
import { enforcedConnections, readAppAccess } from "../../../../apps/console/src/pages/org/live/appAccess.ts";

const BASE = process.env.EPC_LIVE_ENGINE ?? "";
const suite = BASE ? describe : describe.skip;
let jar = "";
const tools = ["read", "write"];
const called: string[] = [];
let provider: http.Server;
async function raw(method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", Origin: BASE, Cookie: jar }, body: body === undefined ? undefined : JSON.stringify(body) });
  const c = r.headers.getSetCookie(); if (c.length) jar = c.map((x) => x.split(";")[0]).join("; ");
  const t = await r.text(); let data: any = t; try { data = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, data };
}
const call: EngineCall = async (m, p, b) => { const r = await raw(m, p, b); if (r.status >= 200 && r.status < 300) return r.data; throw Object.assign(new Error(`${r.status}: ${JSON.stringify(r.data)}`), { status: r.status, data: r.data }); };
const agent = async (company: string, name: string) => (await call("POST", `/api/companies/${company}/agents`, { name, role: "general", adapterType: "http", adapterConfig: { url: "http://127.0.0.1:9/never" }, runtimeConfig: { heartbeat: { enabled: false } } }) as { id: string }).id;
const connect = async (company: string, port: number, name: string) => {
  const id = (await call("POST", `/api/companies/${company}/tools/apps/connect`, { link: `http://127.0.0.1:${port}/mcp`, name, authMode: "none", grantKind: "organization" }) as { connectionId: string }).connectionId;
  await call("POST", `/api/tool-connections/${id}/catalog/refresh`, {});
  // Activate it the way the engine's own finish does (no ePaperclip enforcement): a connection that existed before this fix.
  await call("POST", `/api/companies/${company}/tools/apps/${id}/finish`, { preserveExistingAccess: false, access: { agentIds: [] }, enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [] });
  return id;
};
const catalog = async (conn: string) => (await call("GET", `/api/tool-connections/${conn}/catalog`) as { catalog: { id: string; toolName: string }[] }).catalog;
const invoke = (conn: string, agentId: string, toolName: string) => call("POST", `/api/tool-connections/${conn}/test-calls`, { agentId, toolName, parameters: {} }) as Promise<{ decision: string }>;
const manager = new AppAccessManager();
let port = 0, alpha = "", bravo = "", a1 = "", b1 = "", ordinary = "", ordinaryB = "", other = "";

suite("app access enforcement: boundaries, custom rules, new actions, reopen (real engine)", () => {
  beforeAll(async () => {
    provider = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        const m = JSON.parse(b || "{}"); const reply = (result: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result })); };
        if (m.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "t", version: "1" } });
        if (m.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
        if (m.method === "tools/list") return reply({ tools: tools.map((name) => ({ name, description: name, inputSchema: { type: "object" } })) });
        if (m.method === "tools/call") { called.push(m.params.name); return reply({ content: [{ type: "text", text: "ok" }] }); }
        res.writeHead(200); res.end("{}");
      });
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r)); port = (provider.address() as { port: number }).port;
    expect((await raw("POST", "/api/auth/sign-in/email", { email: "admin@test.invalid", password: "Disposable-pass-12345" })).status).toBe(200);
    const stamp = Date.now().toString(36);
    alpha = (await call("POST", "/api/companies", { name: `Boundary A ${stamp}` }) as { id: string }).id;
    bravo = (await call("POST", "/api/companies", { name: `Boundary B ${stamp}` }) as { id: string }).id;
    a1 = await connect(alpha, port, "Primary"); other = await connect(alpha, port, "Untouched sibling"); b1 = await connect(bravo, port, "Other org");
    ordinary = await agent(alpha, "Ordinary"); ordinaryB = await agent(bravo, "Ordinary B");
  }, 90_000);
  afterAll(async () => { await new Promise((r) => provider?.close(r)); });
  const choice = async (conn: string, agents: string[], enabled: string[], ask: string[] = []) => { const cat = await catalog(conn); const id = (n: string) => cat.find((c) => c.toolName === n)!.id; return { preserveExistingAccess: false, access: { agentIds: agents }, enabledCatalogEntryIds: enabled.map(id), askFirstCatalogEntryIds: ask.map(id), reviewedCatalogEntryIds: [] }; };

  it("a newly discovered action is denied for an agent that has access to the others", async () => {
    await manager.save(call, alpha, a1, await choice(a1, [ordinary], ["read"]));
    expect((await invoke(a1, ordinary, "read")).decision).toBe("allowed");
    tools.push("brand_new");
    await call("POST", `/api/tool-connections/${a1}/catalog/refresh`, {});
    expect((await catalog(a1)).some((c) => c.toolName === "brand_new")).toBe(true);
    expect((await invoke(a1, ordinary, "brand_new")).decision).not.toBe("allowed");
    expect((await invoke(a1, ordinary, "write")).decision).not.toBe("allowed");
  }, 60_000);

  it("saving one connection changes nothing for another connection or another organization", async () => {
    // Before: the default engine grant lets every agent use everything on the untouched connections.
    expect((await invoke(other, ordinary, "read")).decision).toBe("allowed");
    const bravoBefore = (await call("GET", `/api/companies/${bravo}/tools/policies`) as { policies: unknown[] }).policies.length;
    await manager.save(call, alpha, a1, await choice(a1, [], []));
    expect((await invoke(a1, ordinary, "read")).decision).not.toBe("allowed");
    // The console's "not enforced yet" flag, computed from the real policies: only the saved connection is enforced.
    const enforced = enforcedConnections(((await call("GET", `/api/companies/${alpha}/tools/policies`)) as { policies: never[] }).policies);
    expect(enforced.has(a1)).toBe(true);
    expect(enforced.has(other)).toBe(false);
    expect((await invoke(other, ordinary, "read")).decision).toBe("allowed"); // sibling untouched (not enforced: the migration gap)
    expect((await invoke(b1, ordinaryB, "read")).decision).toBe("allowed"); // other organization untouched
    expect(((await call("GET", `/api/companies/${bravo}/tools/policies`)) as { policies: unknown[] }).policies.length).toBe(bravoBefore);
    // The editor cannot be pointed at another organization's connection.
    await expect(manager.save(call, alpha, b1, await choice(b1, [], []))).rejects.toMatchObject({ status: 404 });
    // Nor an agent of another organization.
    await expect(manager.save(call, alpha, a1, { ...(await choice(a1, [], [])), access: { agentIds: [ordinaryB] } })).rejects.toBeTruthy();
  }, 60_000);

  it("a custom rule an administrator wrote is refused, never overwritten, and survives", async () => {
    const custom = (await call("POST", `/api/companies/${alpha}/tools/policies`, { name: "Custom: block writes", policyType: "block", priority: 50, enabled: true, selectors: { connectionId: a1, toolName: "write" } }) as { id: string }).id;
    await expect(manager.save(call, alpha, a1, await choice(a1, [ordinary], ["read"]))).rejects.toMatchObject({ code: "advanced_access" });
    const still = (await call("GET", `/api/companies/${alpha}/tools/policies`) as { policies: { id: string; enabled: boolean }[] }).policies.find((p) => p.id === custom);
    expect(still).toMatchObject({ enabled: true });
    await call("DELETE", `/api/companies/${alpha}/tools/policies/${custom}`);
  }, 60_000);

  it("after a failed save the editor's reading of the real policies still shows Ask (not Allow), the app stays blocked, and a retry restores it", async () => {
    const cat = await catalog(a1); const id = (n: string) => cat.find((c) => c.toolName === n)!.id;
    const c = await choice(a1, [ordinary], ["read", "write"], ["write"]);
    const failing: EngineCall = (m, p, b) => m === "POST" && p.endsWith("/policies") && (b as { name?: string })?.name?.includes(":ask:") ? Promise.reject(new Error("interrupted")) : call(m, p, b);
    await expect(manager.save(failing, alpha, a1, c)).rejects.toMatchObject({ code: "app_access_incomplete" });
    const profiles = (await call("GET", `/api/companies/${alpha}/tools/profiles`) as { profiles: never[] }).profiles;
    const policies = (await call("GET", `/api/companies/${alpha}/tools/policies`) as { policies: never[] }).policies;
    const reopened = readAppAccess(a1, profiles, policies);
    expect(reopened.saving).toBe(true);
    expect(reopened.askFirst).toContain(id("write"));
    expect(reopened.askFirst).not.toContain(id("read"));
    expect((await invoke(a1, ordinary, "read")).decision).not.toBe("allowed"); // incomplete save blocks everyone
    await new AppAccessManager().save(call, alpha, a1, c);
    expect((await invoke(a1, ordinary, "read")).decision).toBe("allowed");
    expect((await invoke(a1, ordinary, "write")).decision).toBe("ask_first");
    const again = readAppAccess(a1, (await call("GET", `/api/companies/${alpha}/tools/profiles`) as { profiles: never[] }).profiles, (await call("GET", `/api/companies/${alpha}/tools/policies`) as { policies: never[] }).policies);
    expect(again).toMatchObject({ saving: false, advanced: null });
    expect(again.askFirst).toEqual([id("write")]);
  }, 90_000);

  it("Pin's permissions stay independent through every one of those saves", async () => {
    const pin = new PinApps(new StateStore(null));
    const cat = await catalog(a1); const id = (n: string) => cat.find((c) => c.toolName === n)!.id;
    await pin.setAccess(call, alpha, a1, [{ catalogEntryId: id("write"), mode: "allow" }]);
    const before = called.length;
    await manager.save(call, alpha, a1, { ...(await choice(a1, [], ["read"])), access: "all_agents" });
    expect(await pin.callTool(call, alpha, a1, "write", {})).toMatchObject({ outcome: "done" });
    expect(await pin.callTool(call, alpha, a1, "read", {})).toMatchObject({ outcome: "denied" }); // all-agents Allow does not extend to Pin
    await manager.save(call, alpha, a1, await choice(a1, [], []));
    expect(await pin.callTool(call, alpha, a1, "write", {})).toMatchObject({ outcome: "done" });
    expect(called.slice(before)).toEqual(["write", "write"]);
    // The editor lists no Pin agent as a choice and refuses to assign it.
    const pinAgent = (await pin.access(call, alpha)).agentId!;
    await expect(manager.save(call, alpha, a1, { ...(await choice(a1, [], [])), access: { agentIds: [pinAgent] } })).rejects.toBeTruthy();
  }, 90_000);
});
