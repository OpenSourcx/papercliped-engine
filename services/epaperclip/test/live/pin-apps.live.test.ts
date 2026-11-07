/**
 * LIVE: runs PinApps against a real Paperclip engine (2026.1023.0) and a local fake MCP provider. Skipped unless
 * EPC_LIVE_ENGINE is set, e.g.  EPC_LIVE_ENGINE=http://127.0.0.1:3199 vitest run test/live
 * The engine must be a disposable one (docs/PIN-APP-EXECUTION.md, "Running the live check") started with
 * PAPERCLIP_TOOL_ACTION_SIGNING_SECRET set. This test creates companies, agents, connections and policies in it.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PinApps, type EngineCall } from "../../src/pin-apps.ts";
import { StateStore } from "../../src/state.ts";

const BASE = process.env.EPC_LIVE_ENGINE ?? "";
const suite = BASE ? describe : describe.skip;

class Person {
  jar = "";
  constructor(readonly email: string) {}
  async raw(method: string, path: string, body?: unknown) {
    const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", Origin: BASE, ...(this.jar ? { Cookie: this.jar } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie?.() ?? [];
    if (sc.length) this.jar = sc.map((c) => c.split(";")[0]).join("; ");
    const t = await r.text();
    let data: any = t; try { data = JSON.parse(t); } catch { /* text */ }
    return { status: r.status, data };
  }
  /** The same shape the host gives PinApps: engine errors become thrown errors. */
  call: EngineCall = async (method, path, body) => {
    const r = await this.raw(method, path, body);
    if (r.status >= 200 && r.status < 300) return r.data;
    throw Object.assign(new Error(r.data?.error ?? `HTTP ${r.status}`), { status: r.status });
  };
}

const provider: { calls: string[]; server?: http.Server } = { calls: [] };
const stamp = Date.now().toString(36);
const admin = new Person("admin@test.invalid");
const outsider = new Person(`outsider-${stamp}@test.invalid`);
let alpha = "", bravo = "", conn = "", bravoConn = "", cat: { id: string; toolName: string }[] = [];
const pin = new PinApps(new StateStore(null));

async function mcpConnection(companyId: string, port: number, name: string) {
  const r = await admin.raw("POST", `/api/companies/${companyId}/tools/apps/connect`, { link: `http://127.0.0.1:${port}/mcp`, name, authMode: "none", grantKind: "organization" });
  expect(r.status).toBe(201);
  const id = r.data.connectionId as string;
  await admin.raw("POST", `/api/tool-connections/${id}/catalog/refresh`, {});
  // Activate the connection without giving any ordinary agent access.
  const f = await admin.raw("POST", `/api/companies/${companyId}/tools/apps/${id}/finish`, { preserveExistingAccess: false, access: { agentIds: [] }, enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [] });
  expect(f.status).toBe(200);
  return id;
}

suite("Pin's identity against the real engine", () => {
  beforeAll(async () => {
    provider.server = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        const m = JSON.parse(b || "{}");
        const reply = (result: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result })); };
        if (m.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
        if (m.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
        if (m.method === "tools/list") return reply({ tools: [
          { name: "read_note", description: "Read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
          { name: "write_note", description: "Write", inputSchema: { type: "object" } },
          { name: "delete_note", description: "Delete", inputSchema: { type: "object" }, annotations: { destructiveHint: true } }] });
        if (m.method === "tools/call") { provider.calls.push(m.params.name); return reply({ content: [{ type: "text", text: `ok ${m.params.name}` }] }); }
        res.writeHead(200); res.end("{}");
      });
    });
    await new Promise<void>((r) => provider.server!.listen(3187, "127.0.0.1", r));
    expect((await admin.raw("POST", "/api/auth/sign-in/email", { email: "admin@test.invalid", password: "Disposable-pass-12345" })).status).toBe(200);
    await outsider.raw("POST", "/api/auth/sign-up/email", { email: outsider.email, password: "Disposable-pass-12345", name: "Outsider" });
    alpha = (await admin.raw("POST", "/api/companies", { name: `Live Alpha ${stamp}` })).data.id;
    bravo = (await admin.raw("POST", "/api/companies", { name: `Live Bravo ${stamp}` })).data.id;
    conn = await mcpConnection(alpha, 3187, `Notes A ${stamp}`);
    bravoConn = await mcpConnection(bravo, 3187, `Notes B ${stamp}`);
    cat = (await admin.raw("GET", `/api/tool-connections/${conn}/catalog`)).data.catalog;
  }, 60_000);
  afterAll(async () => { await new Promise((r) => provider.server?.close(r)); });
  const id = (n: string) => cat.find((c) => c.toolName === n)!.id;

  it("nothing is possible before an administrator enables Pin; enabling alone still refuses every action", async () => {
    await expect(pin.callTool(admin.call, alpha, conn, "read_note", {})).rejects.toMatchObject({ code: "pin_not_enabled" });
    await pin.enable(admin.call, alpha);
    expect(await pin.callTool(admin.call, alpha, conn, "read_note", {})).toMatchObject({ outcome: "denied" });
    expect(provider.calls).toEqual([]);
  }, 60_000);

  it("allowed runs at the provider, approval-required waits and runs only after a person approves, denied never reaches the provider", async () => {
    await pin.setAccess(admin.call, alpha, conn, [{ catalogEntryId: id("read_note"), mode: "allow" }, { catalogEntryId: id("write_note"), mode: "ask" }, { catalogEntryId: id("delete_note"), mode: "off" }]);
    expect(await pin.callTool(admin.call, alpha, conn, "read_note", { id: "1" })).toEqual({ outcome: "done", result: expect.stringContaining("ok read_note") });
    expect(provider.calls).toEqual(["read_note"]);
    const held = await pin.callTool(admin.call, alpha, conn, "write_note", { id: "1", text: "x" });
    expect(held).toMatchObject({ outcome: "approval_required" });
    expect(provider.calls).toEqual(["read_note"]); // not executed yet
    const arId = (held as { actionRequestId: string }).actionRequestId;
    expect(await pin.callStatus(admin.call, alpha, conn, arId)).toMatchObject({ phase: "waiting" });
    // The engine's own approval path (a person, not Pin).
    expect((await admin.raw("POST", `/api/tool-gateway/action-requests/${arId}/approve`, { companyId: alpha })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1000));
    expect(await pin.callStatus(admin.call, alpha, conn, arId)).toMatchObject({ phase: "done" });
    expect(provider.calls).toEqual(["read_note", "write_note"]);
    expect(await pin.callTool(admin.call, alpha, conn, "delete_note", {})).toMatchObject({ outcome: "denied" });
    expect(provider.calls).toEqual(["read_note", "write_note"]);
  }, 60_000);

  it("revoking an action (and then everything) refuses the next call", async () => {
    await pin.setAccess(admin.call, alpha, conn, [{ catalogEntryId: id("write_note"), mode: "ask" }]);
    expect(await pin.callTool(admin.call, alpha, conn, "read_note", {})).toMatchObject({ outcome: "denied" });
    await pin.setAccess(admin.call, alpha, conn, [{ catalogEntryId: id("read_note"), mode: "allow" }]);
    expect(await pin.callTool(admin.call, alpha, conn, "read_note", {})).toMatchObject({ outcome: "done" });
    await pin.revokeAll(admin.call, alpha);
    expect(await pin.callTool(admin.call, alpha, conn, "read_note", {})).toMatchObject({ outcome: "denied" });
  }, 60_000);

  it("never crosses organizations: another organization's connection, identity, or a person outside the organization", async () => {
    await pin.setAccess(admin.call, alpha, conn, [{ catalogEntryId: id("read_note"), mode: "allow" }]);
    const before = provider.calls.length;
    // Alpha's identity against Bravo's connection (host check), and raw against the engine (engine check).
    await expect(pin.callTool(admin.call, alpha, bravoConn, "read_note", {})).rejects.toMatchObject({ status: 404 });
    const agentId = (await pin.access(admin.call, alpha)).agentId!;
    const raw = await admin.raw("POST", `/api/tool-connections/${bravoConn}/test-calls`, { agentId, toolName: "read_note", parameters: {} });
    expect(raw.status).toBe(403); // "This agent is not available for testing": agent is in another organization
    // Bravo has no identity until enabled; it does not inherit Alpha's.
    await expect(pin.callTool(admin.call, bravo, bravoConn, "read_note", {})).rejects.toMatchObject({ code: "pin_not_enabled" });
    // A person who is not a member of Alpha cannot use or even see Alpha's connection, with Pin's identity or otherwise.
    const out = await outsider.raw("POST", `/api/tool-connections/${conn}/test-calls`, { agentId, toolName: "read_note", parameters: {} });
    expect([403, 404]).toContain(out.status);
    await expect(new PinApps(new StateStore(null)).enable(outsider.call, alpha)).rejects.toBeTruthy();
    expect(provider.calls.length).toBe(before);
  }, 60_000);

  it("the identity is paused and has no execution environment: a wake-up never starts it, so it takes no worker or container", async () => {
    const agentId = (await pin.access(admin.call, alpha)).agentId!;
    const a = (await admin.raw("GET", `/api/agents/${agentId}`)).data;
    expect(a.status).toBe("paused");
    expect(a.defaultEnvironmentId ?? null).toBeNull();
    expect(a.adapterType).toBe("http"); // no local process, no sandbox lane
    // The engine accepts a manual wake-up of a paused agent as a queued request, but never starts it.
    await admin.raw("POST", `/api/agents/${agentId}/wakeup`, {});
    await new Promise((r) => setTimeout(r, 2500));
    const runs = (await admin.raw("GET", `/api/companies/${alpha}/heartbeat-runs?agentId=${agentId}`)).data as { status: string }[];
    expect(runs.every((r) => r.status === "queued")).toBe(true);
    expect((await admin.raw("GET", `/api/agents/${agentId}`)).data.status).toBe("paused");
  }, 60_000);
});
