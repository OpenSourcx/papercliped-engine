// Shared by the engine-*.test.tsx files: a fake fetch, a fake socket and a way to render a live organization's pages.
import { vi } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { EngineProvider } from "../src/data/store.tsx";
import { OrgRoute } from "../src/pages/org/live/common.tsx";
import { Activity, Agents, Artifacts, Chat, Costs, Decisions, Inbox, OrgSettings, Routines, Skills, Tasks, Workspaces } from "../src/pages/org/OrgPages.tsx";
import { LiveRoutineDetail } from "../src/pages/org/live/LiveRoutines.tsx";
import { LiveAgentDetail } from "../src/pages/org/live/LiveAgents.tsx";
import { LiveTaskDetail } from "../src/pages/org/live/LiveTasks.tsx";
import { LiveWorkspaceDetail } from "../src/pages/org/live/LiveArtifacts.tsx";

export type Handler = (body: unknown, url: URL) => [number, unknown];
export interface Call { method: string; path: string; search: string; body: unknown; headers: Record<string, string> }

export const state: { routes: Record<string, Handler>; calls: Call[] } = { routes: {}, calls: [] };

export const company = (id: string, name: string, issuePrefix: string, extra: object = {}) => ({ id, name, issuePrefix, description: null, status: "active", budgetMonthlyCents: 0, spentMonthlyCents: 0, ...extra });
export const agent = (id: string, companyId: string, name: string, status = "idle", extra: object = {}) => ({ id, companyId, name, role: "engineer", title: null, status, reportsTo: null, adapterType: "process", adapterConfig: {}, budgetMonthlyCents: 0, spentMonthlyCents: 0, lastHeartbeatAt: null, permissions: { canCreateAgents: false, canCreateSkills: false }, capabilities: null, updatedAt: "2026-10-01T00:00:00Z", ...extra });
export const issue = (id: string, n: number, title: string, status = "todo", extra: object = {}) => ({ id, identifier: `ACME-${n}`, title, status, priority: "medium", description: null, assigneeAgentId: null, assigneeUserId: null, projectId: null, labelIds: [], labels: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...extra });

export function installFetch() {
  state.calls = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://pve.lan");
    const method = init.method ?? "GET";
    const raw = init.body;
    const body = typeof raw === "string" ? JSON.parse(raw) : raw instanceof FormData ? Object.fromEntries(raw.entries()) : undefined;
    state.calls.push({ method, path: url.pathname, search: url.search, body, headers: (init.headers ?? {}) as Record<string, string> });
    const h = state.routes[`${method} ${url.pathname}`];
    const [status, data] = h ? h(body, url) : [404, { error: "Not found" }];
    const text = typeof data === "string" ? data : JSON.stringify(data);
    return new Response(text, { status, headers: { "content-type": typeof data === "string" ? "text/plain" : "application/json" } });
  });
}

export const baseRoutes = (): Record<string, Handler> => ({
  "GET /api/host": () => [200, { node: "pve", version: "9", status: null, resources: [], storage: [] }],
  "GET /api/engine/status": () => [200, { installed: true, reachable: true, ready: true, version: "x", bootstrap: "ready" }],
  "GET /engine/api/cli-auth/me": () => [200, { userId: "u1", user: { id: "u1", name: "Ana", email: "ana@x" }, isInstanceAdmin: true, companyIds: ["c1"], memberships: [], source: "session" }],
  "GET /engine/api/companies": () => [200, [company("c1", "Acme Works", "ACME")]],
  "GET /engine/api/companies/c1": () => [200, company("c1", "Acme Works", "ACME", { description: "Seed org", budgetMonthlyCents: 50000, spentMonthlyCents: 1250 })],
  "GET /engine/api/companies/c1/agents": () => [200, [agent("a1", "c1", "Forge", "idle"), agent("a2", "c1", "Sage", "idle")]],
  "GET /engine/api/companies/c1/members": () => [200, { members: [{ id: "m1", companyId: "c1", principalType: "user", principalId: "u1", membershipRole: "owner", status: "active", createdAt: "2026-10-01T00:00:00Z", user: { id: "u1", name: "Ana", email: "ana@x" } }], access: { currentUserRole: "owner", canManageMembers: true, canInviteUsers: true } }],
  "GET /engine/api/companies/c1/sidebar-badges": () => [200, { inbox: 0, approvals: 0, failedRuns: 0, joinRequests: 0 }],
  "GET /engine/api/companies/c1/attention": () => [200, { companyId: "c1", generatedAt: "2026-10-01T00:00:00Z", totalCount: 0, deskBadgeCount: 0, nextCursor: null, countsBySourceKind: {}, items: [] }],
  "GET /engine/api/companies/c1/issues": () => [200, []],
  "GET /api/resource-groups": () => [200, { groups: [{ companyId: "c1", name: "Acme Works", pool: "epc-acme-works", cores: 4, memoryMb: 8192, diskGb: 40, maxGuests: 3 }] }],
});

export class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: ((e: Event) => unknown) | null = null;
  onmessage: ((e: MessageEvent) => unknown) | null = null;
  onclose: ((e: CloseEvent) => unknown) | null = null;
  onerror: ((e: Event) => unknown) | null = null;
  closed = false;
  url: string;
  constructor(url: string) { this.url = url; FakeSocket.all.push(this); }
  close() { this.closed = true; }
  /** Delivers one engine event, as the live-events socket would. */
  emit(e: { companyId: string; type: string; payload?: unknown }) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(e) })); }
}

export function setup() {
  state.routes = baseRoutes();
  installFetch();
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  localStorage.clear();
}

/** Renders a live organization's pages at `path`, the way the console's router does. */
export function renderOrg(path: string, extra?: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <EngineProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/:device/:org" element={<OrgRoute />}>
              <Route path="inbox" element={<Inbox />} />
              <Route path="decisions" element={<Decisions />} />
              <Route path="tasks" element={<Tasks />} />
              <Route path="tasks/:taskId" element={<LiveTaskDetail />} />
              <Route path="routines" element={<Routines />} />
              <Route path="routines/:routineId" element={<LiveRoutineDetail />} />
              <Route path="agents" element={<Agents />} />
              <Route path="agents/:agentId" element={<LiveAgentDetail />} />
              <Route path="chat" element={<Chat />} />
              <Route path="costs" element={<Costs />} />
              <Route path="activity" element={<Activity />} />
              <Route path="settings" element={<OrgSettings />} />
              <Route path="skills" element={<Skills />} />
              <Route path="artifacts" element={<Artifacts />} />
              <Route path="workspaces" element={<Workspaces />} />
              <Route path="workspaces/:workspaceId" element={<LiveWorkspaceDetail />} />
              {extra}
            </Route>
            <Route path="*" element={<p>elsewhere</p>} />
          </Routes>
        </MemoryRouter>
      </EngineProvider>
    </QueryClientProvider>,
  );
  return { ...view, qc };
}

export const callsTo = (method: string, path: string) => state.calls.filter((c) => c.method === method && c.path === path);
