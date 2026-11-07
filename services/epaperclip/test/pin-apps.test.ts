import { describe, expect, it } from "vitest";
import { PinApps, type EngineCall } from "../src/pin-apps.ts";
import { StateStore } from "../src/state.ts";
import { ACTS } from "../src/features/pin-act.ts";

/** A small stand-in for the engine routes PinApps uses, recording every call. Decisions mirror what the real 2026.1023.0 engine returned in docs/PIN-APP-EXECUTION.md. */
function fakeEngine() {
  const calls: { method: string; path: string; body?: any }[] = [];
  const policies: any[] = [];
  const agents = new Map<string, any>();
  const conns = new Map<string, any>([["conn-a", { id: "conn-a", companyId: "co-a" }], ["conn-b", { id: "conn-b", companyId: "co-b" }]]);
  const catalog = [{ id: "e-read", toolName: "read_note", status: "active" }, { id: "e-write", toolName: "write_note", status: "active" }, { id: "e-del", toolName: "delete_note", status: "active" }, { id: "e-gone", toolName: "gone", status: "disabled" }];
  let n = 0;
  const call: EngineCall = async (method, path, body: any) => {
    calls.push({ method, path, body });
    let m: RegExpMatchArray | null;
    if (method === "POST" && (m = path.match(/^\/api\/companies\/([\w-]+)\/agents$/))) { const a = { id: `agent-${++n}`, companyId: m[1], status: "paused", name: body.name }; agents.set(a.id, a); return a; }
    if (method === "GET" && (m = path.match(/^\/api\/agents\/([\w-]+)$/))) { const a = agents.get(m[1]); if (!a) throw new Error("404"); return a; }
    if (method === "GET" && path.endsWith("/tools/policies")) return { policies: [...policies] };
    if (method === "POST" && path.endsWith("/tools/policies")) { const p = { id: `p-${++n}`, ...body }; policies.push(p); return p; }
    if (method === "DELETE" && (m = path.match(/\/tools\/policies\/([\w-]+)$/))) { policies.splice(policies.findIndex((p) => p.id === m![1]), 1); return {}; }
    if (method === "GET" && (m = path.match(/^\/api\/tool-connections\/([\w-]+)$/))) return conns.get(m[1]);
    if (method === "GET" && path.endsWith("/catalog")) return { catalog };
    if (method === "POST" && path.endsWith("/test-calls")) {
      const entry = catalog.find((c) => c.toolName === body.toolName);
      const mine = policies.filter((p) => p.selectors.agentId === body.agentId && (p.selectors.catalogEntryId === entry?.id || !p.selectors.catalogEntryId)).sort((x, y) => x.priority - y.priority);
      const first = mine[0];
      if (first?.policyType === "allow") return { decision: "allowed", result: { content: `ok ${body.toolName}` } };
      if (first?.policyType === "require_approval") return { decision: "ask_first", actionRequestId: "ar-1" };
      return { decision: "off", error: { message: "Tool access is blocked by policy." } };
    }
    if (method === "GET" && path.includes("/test-calls/")) return { phase: "waiting" };
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { call, calls, policies, agents };
}
const mk = () => { const e = fakeEngine(); return { ...e, pin: new PinApps(new StateStore(null)) }; };

describe("Pin's identity for organization apps", () => {
  it("refuses everything until an administrator enables it, and enabling creates a paused identity with default deny", async () => {
    const { pin, call, agents, policies } = mk();
    await expect(pin.callTool(call, "co-a", "conn-a", "read_note", {})).rejects.toMatchObject({ code: "pin_not_enabled" });
    const { agentId } = await pin.enable(call, "co-a");
    expect(agents.get(agentId)).toMatchObject({ status: "paused", name: "Pin (host)" });
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ policyType: "block", priority: 1000, selectors: { agentId } });
    await pin.enable(call, "co-a");
    expect(policies).toHaveLength(1); // idempotent
    expect([...agents.values()]).toHaveLength(1);
    // Nothing was chosen, so a call is refused (denied), not run.
    expect(await pin.callTool(call, "co-a", "conn-a", "read_note", {})).toMatchObject({ outcome: "denied" });
  });

  it("allowed, approval-required and denied actions come back as the engine decided, and Pin never approves", async () => {
    const { pin, call, calls } = mk();
    await pin.setAccess(call, "co-a", "conn-a", [{ catalogEntryId: "e-read", mode: "allow" }, { catalogEntryId: "e-write", mode: "ask" }, { catalogEntryId: "e-del", mode: "off" }]);
    expect(await pin.callTool(call, "co-a", "conn-a", "read_note", { id: "1" })).toEqual({ outcome: "done", result: "ok read_note" });
    expect(await pin.callTool(call, "co-a", "conn-a", "write_note", {})).toMatchObject({ outcome: "approval_required", actionRequestId: "ar-1" });
    expect(await pin.callTool(call, "co-a", "conn-a", "delete_note", {})).toMatchObject({ outcome: "denied" });
    expect(await pin.callTool(call, "co-a", "conn-a", "never_listed", {})).toMatchObject({ outcome: "denied" });
    expect(calls.some((c) => /approve|decline/.test(c.path))).toBe(false);
    expect(await pin.callStatus(call, "co-a", "conn-a", "ar-1")).toEqual({ phase: "waiting" });
  });

  it("revoking an action or everything takes effect on the next call", async () => {
    const { pin, call, policies } = mk();
    await pin.setAccess(call, "co-a", "conn-a", [{ catalogEntryId: "e-read", mode: "allow" }, { catalogEntryId: "e-write", mode: "allow" }]);
    expect((await pin.access(call, "co-a")).entries.map((e) => e.mode)).toEqual(["allow", "allow"]);
    await pin.setAccess(call, "co-a", "conn-a", [{ catalogEntryId: "e-read", mode: "allow" }, { catalogEntryId: "e-write", mode: "off" }]);
    expect(await pin.callTool(call, "co-a", "conn-a", "write_note", {})).toMatchObject({ outcome: "denied" });
    // allow -> ask changes the policy type, never leaving the action allowed in between
    await pin.setAccess(call, "co-a", "conn-a", [{ catalogEntryId: "e-read", mode: "ask" }]);
    expect(await pin.callTool(call, "co-a", "conn-a", "read_note", {})).toMatchObject({ outcome: "approval_required" });
    await pin.revokeAll(call, "co-a");
    expect(policies.filter((p) => p.policyType !== "block")).toEqual([]);
    expect(await pin.callTool(call, "co-a", "conn-a", "read_note", {})).toMatchObject({ outcome: "denied" });
  });

  it("works only inside one organization: another organization's connection or identity is never used", async () => {
    const { pin, call } = mk();
    await pin.setAccess(call, "co-a", "conn-a", [{ catalogEntryId: "e-read", mode: "allow" }]);
    await expect(pin.callTool(call, "co-a", "conn-b", "read_note", {})).rejects.toMatchObject({ status: 404 });
    await expect(pin.setAccess(call, "co-a", "conn-b", [{ catalogEntryId: "e-read", mode: "allow" }])).rejects.toMatchObject({ status: 404 });
    // Organization B has no identity of its own yet, so Organization A's identity cannot be borrowed.
    await expect(pin.callTool(call, "co-b", "conn-b", "read_note", {})).rejects.toMatchObject({ code: "pin_not_enabled" });
    await expect(pin.callStatus(call, "co-a", "conn-b", "ar-1")).rejects.toMatchObject({ status: 404 });
  });

  it("stops using an identity the engine no longer shows for that organization", async () => {
    const { pin, call, agents } = mk();
    await pin.setAccess(call, "co-a", "conn-a", [{ catalogEntryId: "e-read", mode: "allow" }]);
    const id = [...agents.keys()][0]!;
    agents.get(id).status = "terminated";
    await expect(pin.callTool(call, "co-a", "conn-a", "read_note", {})).rejects.toMatchObject({ code: "pin_not_enabled" });
    agents.set(id, { ...agents.get(id), status: "paused", companyId: "co-b" });
    await expect(pin.callTool(call, "co-a", "conn-a", "read_note", {})).rejects.toMatchObject({ code: "pin_not_enabled" });
  });

  it("rejects bad input and unavailable or unknown actions before changing anything", async () => {
    const { pin, call, policies } = mk();
    await expect(pin.setAccess(call, "../x", "conn-a", [])).rejects.toMatchObject({ status: 400 });
    await expect(pin.setAccess(call, "co-a", "conn-a", [{ catalogEntryId: "nope", mode: "allow" }])).rejects.toMatchObject({ status: 400 });
    await expect(pin.setAccess(call, "co-a", "conn-a", [{ catalogEntryId: "e-gone", mode: "allow" }])).rejects.toMatchObject({ status: 400 });
    await expect(pin.setAccess(call, "co-a", "conn-a", [{ catalogEntryId: "e-read", mode: "root" as never }])).rejects.toMatchObject({ status: 400 });
    expect(policies.filter((p) => p.policyType !== "block")).toEqual([]);
    await expect(pin.callTool(call, "co-a", "conn-a", "", {})).rejects.toMatchObject({ status: 400 });
  });

  it("the Pin action asks the person first in ask and plan modes, runs only through the identity, and is never 'safe'", async () => {
    const def = ACTS.call_app_tool!;
    expect(def.risk({})).toBe("disruptive");
    expect(() => def.parse({ companyId: "co-a", connectionId: "conn-a", tool: "x", extra: 1 })).toThrow();
    expect(() => def.parse({ companyId: "../x", connectionId: "conn-a", tool: "x" })).toThrow();
    const parsed = def.parse({ companyId: "co-a", connectionId: "conn-a", tool: "read_note", parameters: { id: "1" } });
    const { pin, call } = mk();
    await pin.setAccess(call, "co-a", "conn-a", [{ catalogEntryId: "e-read", mode: "allow" }, { catalogEntryId: "e-write", mode: "ask" }]);
    const host = { node: "pve", username: "sam", pve: async () => ({}) as never, apps: { pin, call } };
    expect((await def.run(host, parsed)).result).toMatch(/^Done: ok read_note/);
    expect((await def.run(host, { ...parsed, tool: "write_note" })).result).toMatch(/Waiting for approval.*Nothing has been done yet/);
    await expect(def.run(host, { ...parsed, tool: "delete_note" })).rejects.toThrow(/Refused/);
    await expect(def.run({ ...host, apps: undefined }, parsed)).rejects.toThrow(/engine isn't set up/);
  });
});
