// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";

// Every test here runs the console as a signed-in live session.
vi.mock("../src/auth/session.tsx", () => ({
  useSession: () => ({ session: { mode: "live", user: { username: "ana@pve", name: "Ana", realm: "pve", node: "pve" } }, signOut: async () => {} }),
}));

import { EngineProvider, useEngine } from "../src/data/store.tsx";
import { applyEvent, connectOrgEvents, keysForEvent } from "../src/data/engine/events.ts";
import { qk } from "../src/data/engine/keys.ts";
import { createOrganization, useCreateIssue, useDecide, useIssues, useUpdateIssue, useApprovals } from "../src/data/engine/queries.ts";
import { orgSlug } from "../src/data/engine/map.ts";
import { OrgRoute } from "../src/pages/org/live/common.tsx";
import { Tasks } from "../src/pages/org/OrgPages.tsx";

type Handler = (body: unknown, url: URL) => [number, unknown];
interface Call { method: string; path: string; body: unknown; headers: Record<string, string> }

const company = (id: string, name: string, issuePrefix: string) => ({ id, name, issuePrefix, description: null, status: "active", budgetMonthlyCents: 0, spentMonthlyCents: 0 });
const agent = (id: string, companyId: string, name: string, status = "idle") => ({ id, companyId, name, role: "engineer", title: null, status, reportsTo: null, adapterType: "process", adapterConfig: {}, budgetMonthlyCents: 0, spentMonthlyCents: 0, lastHeartbeatAt: null });
const issue = (id: string, n: number, title: string, status = "todo") => ({ id, identifier: `ACME-${n}`, title, status, priority: "medium", description: null, assigneeAgentId: null, assigneeUserId: null, projectId: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });

let routes: Record<string, Handler>;
let calls: Call[];

function installFetch() {
  calls = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://pve.lan");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body, headers: (init.headers ?? {}) as Record<string, string> });
    const h = routes[`${method} ${url.pathname}`];
    const [status, data] = h ? h(body, url) : [404, { error: "Not found" }];
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  });
}

const baseRoutes = (): Record<string, Handler> => ({
  "GET /api/host": () => [200, { node: "pve", version: "9", status: null, resources: [], storage: [] }],
  "GET /api/engine/status": () => [200, { installed: true, reachable: true, ready: true, version: "x", bootstrap: "ready" }],
  "GET /engine/api/cli-auth/me": () => [200, { userId: "u1", user: { id: "u1", name: "Ana", email: "ana@x" }, isInstanceAdmin: false, companyIds: ["c1"], memberships: [], source: "session" }],
  "GET /engine/api/companies": () => [200, [company("c1", "Acme Works", "ACME"), company("c2", "Pin Labs", "PIN")]],
  "GET /engine/api/companies/c1/agents": () => [200, [agent("a1", "c1", "Forge", "running"), agent("a2", "c1", "Old", "terminated")]],
  "GET /engine/api/companies/c2/agents": () => [200, []],
  // The host service lists the groups of the person's organizations; Pin Labs has none yet.
  "GET /api/resource-groups": () => [200, { groups: [{ companyId: "c1", name: "Acme Works", pool: "epc-acme-works", cores: 4, memoryMb: 8192, diskGb: 40, maxGuests: 3 }] }],
});

class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: ((e: Event) => unknown) | null = null;
  onmessage: ((e: MessageEvent) => unknown) | null = null;
  onclose: ((e: CloseEvent) => unknown) | null = null;
  onerror: ((e: Event) => unknown) | null = null;
  closed = false;
  url: string;
  constructor(url: string) { this.url = url; FakeSocket.all.push(this); }
  close() { this.closed = true; }
}

beforeEach(() => {
  routes = baseRoutes();
  installFetch();
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function Probe() {
  const { data } = useEngine();
  return <pre data-testid="orgs">{JSON.stringify(data.orgs.map((o) => ({ slug: o.slug, name: o.name, agents: o.agents.map((a) => `${a.name}:${a.status}`), rg: o.engine?.resourceGroup, cores: o.resourceGroup.cores })))}</pre>;
}

describe("live organizations", () => {
  it("come from the engine, with their agents and resource groups, and nothing from the demo", async () => {
    render(<EngineProvider><Probe /></EngineProvider>);
    await waitFor(() => expect(JSON.parse(screen.getByTestId("orgs").textContent!)).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId("orgs").textContent).toContain("Forge"));
    await waitFor(() => expect(screen.getByTestId("orgs").textContent).toContain("missing"));
    const orgs = JSON.parse(screen.getByTestId("orgs").textContent!);
    expect(orgs[0]).toEqual({ slug: "acme", name: "Acme Works", agents: ["Forge:working"], rg: "set", cores: 4 });
    // "pin" is a system page, so that organization's address gets a suffix.
    expect(orgs[1]).toMatchObject({ slug: "pin-org", name: "Pin Labs", agents: [], rg: "missing", cores: 0 });
    expect(screen.getByTestId("orgs").textContent).not.toContain("Northwind");
  });

  it("shows none, and asks the engine nothing, while the engine isn't ready", async () => {
    routes["GET /api/engine/status"] = () => [200, { installed: false, reachable: false, ready: false, version: null, bootstrap: "pending" }];
    render(<EngineProvider><Probe /></EngineProvider>);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/engine/status")).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId("orgs").textContent).toBe("[]");
    expect(calls.some((c) => c.path.startsWith("/engine/api/"))).toBe(false);
  });

  it("are addressed by issue prefix", () => {
    expect(orgSlug({ id: "x", issuePrefix: "NW" })).toBe("nw");
    expect(orgSlug({ id: "x", issuePrefix: "HOME" })).toBe("home-org");
  });
});

describe("creating an organization", () => {
  it("creates it in the engine, then sets up its resource group", async () => {
    routes["POST /engine/api/companies"] = (b) => [201, { ...company("c9", (b as { name: string }).name, "NEW") }];
    routes["PUT /api/resource-groups/c9"] = (b) => [200, { group: { companyId: "c9", pool: "epc-new-co", ...(b as object) } }];
    const r = await createOrganization({ name: "  New Co ", description: "", size: { cores: 2, memoryMb: 2048, diskGb: 20, maxGuests: 2 } });
    expect(r).toEqual({ companyId: "c9", slugSource: { id: "c9", issuePrefix: "NEW" }, resourceGroupError: null });
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: "/engine/api/companies", body: { name: "New Co", description: null } });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put).toMatchObject({ path: "/api/resource-groups/c9", body: { name: "New Co", cores: 2, memoryMb: 2048, diskGb: 20, maxGuests: 2 } });
    expect(put.headers["X-EPC-Request"]).toBe("1");
  });

  it("keeps the organization and reports the resource group failure on its own", async () => {
    routes["POST /engine/api/companies"] = () => [201, company("c9", "New Co", "NEW")];
    routes["PUT /api/resource-groups/c9"] = () => [502, { error: "Proxmox refused to create the pool", code: "proxmox" }];
    const r = await createOrganization({ name: "New Co", size: { cores: 1, memoryMb: 1024, diskGb: 8, maxGuests: 1 } });
    expect(r.companyId).toBe("c9");
    expect(r.resourceGroupError).toBe("Proxmox refused to create the pool");
  });

  it("fails as a whole when the engine refuses, with the engine's words", async () => {
    routes["POST /engine/api/companies"] = () => [403, { error: "Instance admin required" }];
    await expect(createOrganization({ name: "X", size: { cores: 1, memoryMb: 1024, diskGb: 8, maxGuests: 1 } })).rejects.toThrow("Instance admin required");
    expect(calls.some((c) => c.path.startsWith("/api/resource-groups"))).toBe(false);
  });
});

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { qc, Wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> };
}

describe("tasks and decisions", () => {
  it("creating and updating a task sends Paperclip's bodies and refreshes the list", async () => {
    let list = [issue("i1", 1, "First")];
    routes["GET /engine/api/companies/c1/issues"] = () => [200, list];
    routes["POST /engine/api/companies/c1/issues"] = (b) => {
      const created = issue("i2", 2, (b as { title: string }).title);
      list = [...list, created];
      return [201, created];
    };
    routes["PATCH /engine/api/issues/i1"] = (b) => {
      list = list.map((t) => (t.id === "i1" ? { ...t, ...(b as object) } : t));
      return [200, list[0]];
    };
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => ({ issues: useIssues("c1"), create: useCreateIssue("c1"), update: useUpdateIssue("c1") }), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.issues.data).toHaveLength(1));
    await act(() => result.current.create.mutateAsync({ title: "Second", status: "todo", priority: "high", assigneeAgentId: "a1" }));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ title: "Second", status: "todo", priority: "high", assigneeAgentId: "a1" });
    await waitFor(() => expect(result.current.issues.data).toHaveLength(2));
    await act(() => result.current.update.mutateAsync({ id: "i1", body: { status: "done" } }));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ status: "done" });
    await waitFor(() => expect(result.current.issues.data?.[0].status).toBe("done"));
  });

  it("approving with a note sends it and refreshes the pending list", async () => {
    let approvals = [{ id: "ap1", type: "hire_agent", status: "pending", payload: { name: "Quinn" }, requestedByAgentId: "a1", requestedByUserId: null, decisionNote: null as string | null, createdAt: "2026-10-01T00:00:00Z" }];
    routes["GET /engine/api/companies/c1/approvals"] = () => [200, approvals];
    routes["POST /engine/api/approvals/ap1/approve"] = (b) => {
      approvals = approvals.map((a) => ({ ...a, status: "approved", decisionNote: (b as { decisionNote?: string }).decisionNote ?? null }));
      return [200, approvals[0]];
    };
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => ({ list: useApprovals("c1"), decide: useDecide("c1") }), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.list.data?.[0].status).toBe("pending"));
    await act(() => result.current.decide.mutateAsync({ id: "ap1", approve: true, note: "Go ahead" }));
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: "/engine/api/approvals/ap1/approve", body: { decisionNote: "Go ahead" } });
    await waitFor(() => expect(result.current.list.data?.[0].status).toBe("approved"));
  });
});

describe("live events", () => {
  it("map each event to the data it touches", () => {
    expect(keysForEvent("c1", { companyId: "c1", type: "activity.logged", payload: { entityType: "issue", entityId: "i1", action: "issue.updated" } })).toEqual(expect.arrayContaining([qk.issues("c1"), qk.anyIssue("c1"), qk.anyComments("c1"), qk.activity("c1")]));
    expect(keysForEvent("c1", { companyId: "c1", type: "agent.status", payload: { agentId: "a1" } })).toEqual([qk.agents("c1"), qk.dashboard("c1"), qk.agent("c1", "a1")]);
    expect(keysForEvent("c1", { companyId: "c1", type: "heartbeat.run.log", payload: {} })).toEqual([]);
  });

  it("refresh a task list when the engine says a task changed, and ignore other organizations", async () => {
    let n = 0;
    routes["GET /engine/api/companies/c1/issues"] = () => [200, [issue("i1", 1, `v${++n}`)]];
    const { qc, Wrapper } = wrapper();
    const { result } = renderHook(() => useIssues("c1"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data?.[0].title).toBe("v1"));
    applyEvent(qc, "c1", { companyId: "c2", type: "activity.logged", payload: { entityType: "issue" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(result.current.data?.[0].title).toBe("v1");
    applyEvent(qc, "c1", { companyId: "c1", type: "activity.logged", payload: { entityType: "issue", action: "issue.created" } });
    await waitFor(() => expect(result.current.data?.[0].title).toBe("v2"));
  });

  it("share one socket per organization, apply its messages, and reconnect with backoff", async () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const opts = { open: (url: string) => new FakeSocket(url), url: (id: string) => `ws://pve.lan/engine/api/companies/${id}/events/ws`, maxDelayMs: 4000 };
    const stopA = connectOrgEvents(qc, "c1", opts);
    const stopB = connectOrgEvents(qc, "c1", opts);
    expect(FakeSocket.all).toHaveLength(1);
    const s = FakeSocket.all[0];
    s.onopen?.(new Event("open"));
    s.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ companyId: "c1", type: "agent.status", payload: { agentId: "a1" } }) }));
    expect(spy).toHaveBeenCalledWith({ queryKey: qk.agents("c1") });
    s.onclose?.(new CloseEvent("close"));
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(FakeSocket.all).toHaveLength(2);
    stopA();
    expect(FakeSocket.all[1].closed).toBe(false);
    stopB();
    expect(FakeSocket.all[1].closed).toBe(true);
  });
});

describe("a live organization's pages", () => {
  it("show the engine's tasks, never the demo's", async () => {
    routes["GET /engine/api/companies/c1/issues"] = () => [200, [issue("i1", 1, "Ship the installer")]];
    routes["GET /engine/api/companies/c1/members"] = () => [200, { members: [], access: { currentUserRole: "owner", canManageMembers: true, canInviteUsers: true } }];
    render(
      <EngineProvider>
        <MemoryRouter initialEntries={["/pve/acme/tasks"]}>
          <Routes>
            <Route path="/:device/:org" element={<OrgRoute />}>
              <Route path="tasks" element={<Tasks />} />
            </Route>
            <Route path="*" element={<p>elsewhere</p>} />
          </Routes>
        </MemoryRouter>
      </EngineProvider>,
    );
    expect(await screen.findByText("Ship the installer")).toBeTruthy();
    expect(screen.getByText("ACME-1")).toBeTruthy();
    expect(screen.queryByText("Weekly plan for Q4")).toBeNull();
    expect(screen.queryByText("Fix flaky deploy check")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Closed" }));
    expect(await screen.findByText("No tasks match this filter.")).toBeTruthy();
  });

  it("explain calmly when the engine isn't installed", async () => {
    routes["GET /api/engine/status"] = () => [200, { installed: false, reachable: false, ready: false, version: null, bootstrap: "pending" }];
    render(
      <EngineProvider>
        <MemoryRouter initialEntries={["/pve/acme/tasks"]}>
          <Routes>
            <Route path="/:device/:org" element={<OrgRoute />}>
              <Route path="tasks" element={<Tasks />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </EngineProvider>,
    );
    expect(await screen.findByText("The engine isn't installed")).toBeTruthy();
  });
});

describe("who can create organizations", () => {
  it("is decided by the engine: only instance admins (Proxmox node administrators)", async () => {
    const { useCanCreateOrgs } = await import("../src/data/engine/queries.ts");
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useCanCreateOrgs(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current).toBe(false));
    routes["GET /engine/api/cli-auth/me"] = () => [200, { userId: "u1", isInstanceAdmin: true, companyIds: [], memberships: [], source: "session" }];
    const second = wrapper();
    const admin = renderHook(() => useCanCreateOrgs(), { wrapper: second.Wrapper });
    await waitFor(() => expect(admin.result.current).toBe(true));
  });
});
