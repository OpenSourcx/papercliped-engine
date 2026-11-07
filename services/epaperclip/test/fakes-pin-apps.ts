import type { EngineCall } from "../src/pin-apps.ts";

/** A small stand-in for the engine routes PinApps uses, recording every call. Decisions mirror what the real 2026.1023.0 engine returned in docs/PIN-APP-EXECUTION.md. */
export function fakeEngine() {
  const calls: { method: string; path: string; body?: any }[] = [];
  const policies: any[] = [];
  const agents = new Map<string, any>();
  const conns = new Map<string, any>([["conn-a", { id: "conn-a", companyId: "co-a" }], ["conn-b", { id: "conn-b", companyId: "co-b" }]]);
  const catalog = [{ id: "e-read", toolName: "read_note", status: "active" }, { id: "e-write", toolName: "write_note", status: "active" }, { id: "e-del", toolName: "delete_note", status: "active" }, { id: "e-gone", toolName: "gone", status: "disabled" }, { id: "e-broken", toolName: "broken_tool", status: "active" }];
  let n = 0;
  const call: EngineCall = async (method, path, body: any) => {
    calls.push({ method, path, body });
    let m: RegExpMatchArray | null;
    if (method === "POST" && (m = path.match(/^\/api\/companies\/([\w-]+)\/agents$/))) { const a = { id: `agent-${++n}`, companyId: m[1], status: "paused", name: body.name, adapterType: body.adapterType, adapterConfig: body.adapterConfig }; agents.set(a.id, a); return a; }
    if (method === "GET" && (m = path.match(/^\/api\/companies\/([\w-]+)\/agents$/))) return [...agents.values()].filter((a) => a.companyId === m![1]);
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
      if (first?.policyType === "allow") return body.toolName === "broken_tool" ? { decision: "allowed", result: { content: "boom", data: { isError: true } } } : { decision: "allowed", result: { content: `ok ${body.toolName}` } };
      if (first?.policyType === "require_approval") return { decision: "ask_first", actionRequestId: "ar-1" };
      return { decision: "off", error: { message: "Tool access is blocked by policy." } };
    }
    if (method === "GET" && path.includes("/test-calls/")) return { phase: "waiting" };
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { call, calls, policies, agents };
}
