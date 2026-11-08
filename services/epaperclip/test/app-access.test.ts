import { describe, expect, it } from "vitest";
import { AppAccessManager } from "../src/app-access.ts";
import type { EngineCall } from "../src/pin-apps.ts";

const body = (extra = {}) => ({ preserveExistingAccess: false, access: { agentIds: ["a1"] }, enabledCatalogEntryIds: ["read", "write"], askFirstCatalogEntryIds: ["write"], reviewedCatalogEntryIds: [], ...extra });
function engine() {
  const policies: any[] = [];
  const calls: { method: string; path: string; body?: any }[] = [];
  const agents = [{ id: "a1", name: "Ada" }, { id: "a2", name: "Bea" }, { id: "pin", name: "Pin (host)", status: "paused", adapterType: "http", adapterConfig: { url: "http://127.0.0.1:9/pin-host-identity-never-runs" } }];
  let n = 0;
  const state = { profiles: [] as any[], fail: "" };
  const call: EngineCall = async (method, path, b: any) => {
    calls.push({ method, path, body: b });
    if (state.fail === method + " " + path) throw new Error("offline");
    if (method === "GET" && path === "/api/tool-connections/c1") return { companyId: "org" };
    if (method === "GET" && path.endsWith("/catalog")) return { catalog: ["read", "write", "off"].map((id) => ({ id, status: "active" })) };
    if (method === "GET" && path.endsWith("/agents")) return agents;
    if (method === "GET" && path.endsWith("/profiles")) return { profiles: state.profiles };
    if (method === "GET" && path.endsWith("/policies")) return { policies: [...policies] };
    if (method === "POST" && path.endsWith("/policies")) { const p = { id: `p${++n}`, ...b }; policies.push(p); return p; }
    if (method === "DELETE") { policies.splice(policies.findIndex((p) => path.endsWith("/" + p.id)), 1); return {}; }
    if (method === "PATCH") { Object.assign(policies.find((p) => path.endsWith("/" + p.id)), b); return {}; }
    if (method === "POST" && path.endsWith("/finish")) { state.profiles = [{ profileKey: "app:c1", defaultAction: "deny", entries: b.enabledCatalogEntryIds.map((id: string) => ({ selectorType: "catalog_entry", effect: "include", catalogEntryId: id })), bindings: [] }]; return { connectionId: "c1" }; }
    throw new Error(`Unexpected ${method} ${path}`);
  };
  // Models the engine's observed default tools:use grant after the ordered policy scan; live coverage uses the real engine.
  const decide = (agentId: string, catalogEntryId: string, connectionId = "c1") => {
    const p = policies.filter((p) => p.enabled && (!p.selectors.connectionId || p.selectors.connectionId === connectionId) && (!p.selectors.catalogEntryId || p.selectors.catalogEntryId === catalogEntryId) && (!p.selectors.agentId || p.selectors.agentId === agentId) && (!p.selectors.agentIds?.length || p.selectors.agentIds.includes(agentId))).sort((a, b) => a.priority - b.priority)[0];
    return p?.policyType ?? "allow";
  };
  return { call, calls, policies, agents, state, decide, manager: new AppAccessManager() };
}

describe("organization app permission enforcement", () => {
  it("denies Off, excluded and future agents, and future actions despite the default tools:use grant", async () => {
    const e = engine();
    expect(e.decide("a1", "off")).toBe("allow"); // reproduce upstream profile-only gap
    await e.manager.save(e.call, "ORG", "C1", body({ access: { agentIds: ["A1"] } }));
    expect(e.decide("a1", "read")).toBe("allow");
    expect(e.decide("a1", "write")).toBe("require_approval");
    for (const [a, t] of [["a1", "off"], ["a2", "read"], ["future", "read"], ["a1", "new_action"]]) expect(e.decide(a!, t!)).toBe("block");
    expect(e.decide("a1", "read", "another-app")).toBe("allow");
    expect(e.calls.find((c) => c.path.endsWith("/finish"))?.body.askFirstCatalogEntryIds).toEqual(["write"]);
  });
  it("all-agents includes future ordinary agents while Pin keeps its independent Off/Ask/Allow choices", async () => {
    const e = engine();
    e.policies.push({ id: "pin0", name: "Pin (host): default deny", enabled: true, priority: 1000, policyType: "block", selectors: { agentId: "pin" } }, { id: "pin1", name: "Pin (host): c1 write allow", enabled: true, priority: 100, policyType: "allow", selectors: { agentId: "pin", connectionId: "c1", catalogEntryId: "write" } });
    await e.manager.save(e.call, "org", "c1", body({ access: "all_agents" }));
    expect(e.decide("future", "read")).toBe("allow");
    expect(e.decide("future", "write")).toBe("require_approval");
    expect(e.decide("pin", "read")).toBe("block");
    expect(e.decide("pin", "write")).toBe("allow");
    expect(e.policies.filter((p) => p.name.startsWith("Pin"))).toHaveLength(2);
  });
  it("an empty assignment denies everyone and never emits agentIds:[] (which the engine treats as everyone)", async () => {
    const e = engine();
    await e.manager.save(e.call, "org", "c1", body({ access: { agentIds: [] } }));
    expect(e.decide("a1", "read")).toBe("block");
    expect(e.policies.map((p) => p.policyType)).toEqual(["block"]);
  });
  it("downgrades and revocations take effect, and repeated saves leave no duplicate policies", async () => {
    const e = engine();
    await e.manager.save(e.call, "org", "c1", body());
    await e.manager.save(e.call, "org", "c1", body({ enabledCatalogEntryIds: ["read"], askFirstCatalogEntryIds: ["read"] }));
    expect(e.decide("a1", "read")).toBe("require_approval");
    expect(e.decide("a1", "write")).toBe("block");
    await e.manager.save(e.call, "org", "c1", body({ enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [] }));
    expect(e.decide("a1", "read")).toBe("block");
    expect(e.policies).toHaveLength(1);
  });
  it("persists a block after a failed save, and a fresh manager safely retries after a restart", async () => {
    const e = engine();
    await e.manager.save(e.call, "org", "c1", body());
    e.state.fail = "POST /api/companies/org/tools/apps/c1/finish";
    await expect(e.manager.save(e.call, "org", "c1", body())).rejects.toMatchObject({ code: "app_access_incomplete" });
    expect(e.decide("a1", "read")).toBe("block");
    e.state.fail = "";
    await new AppAccessManager().save(e.call, "org", "c1", body());
    expect(e.decide("a1", "read")).toBe("allow");
    expect(e.policies).toHaveLength(3);
  });
  it("refuses unreadable or foreign scopes, invalid choices, and custom policies without mutating them", async () => {
    for (const b of [body({ access: { agentIds: ["pin"] } }), body({ access: { agentIds: ["foreign"] } }), body({ enabledCatalogEntryIds: ["unknown"] }), body({ preserveExistingAccess: true })]) {
      const e = engine();
      await expect(e.manager.save(e.call, "org", "c1", b)).rejects.toBeTruthy();
      expect(e.calls.filter((c) => c.method !== "GET")).toEqual([]);
    }
    const e = engine();
    e.policies.push({ id: "custom", name: "Administrator rule", enabled: true, priority: 10, policyType: "allow", selectors: {} });
    await expect(e.manager.save(e.call, "org", "c1", body())).rejects.toMatchObject({ code: "advanced_access" });
    expect(e.calls.filter((c) => c.method !== "GET")).toEqual([]);
    e.policies.length = 0;
    await expect(e.manager.save(e.call, "foreign", "c1", body())).rejects.toMatchObject({ status: 404 });
    e.state.fail = "GET /api/companies/org/tools/policies";
    await expect(e.manager.save(e.call, "org", "c1", body())).rejects.toBeTruthy();
    expect(e.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
  it("serializes concurrent saves so the final complete choice wins", async () => {
    const e = engine();
    await Promise.all([e.manager.save(e.call, "org", "c1", body()), e.manager.save(e.call, "org", "c1", body({ access: { agentIds: [] } }))]);
    expect(e.decide("a1", "read")).toBe("block");
    expect(e.policies).toHaveLength(1);
  });
});
