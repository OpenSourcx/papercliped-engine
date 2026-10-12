import type { Agent, Approval, Company, Goal, Issue, Project } from "@paperclipai/shared";

/**
 * The Paperclip engine's API, as the console reaches it: through the host service at /engine/api, which checks the
 * Proxmox session and forwards the request as that person's engine account. Types are Paperclip's own, from
 * @paperclipai/shared at the pinned engine version.
 */
export type { Agent, Approval, Company, Goal, Issue, Project };

export interface BoardAccess {
  user: { id: string; name: string | null; email: string } | null;
  userId: string;
  isInstanceAdmin: boolean;
  companyIds: string[];
  memberships: { companyId: string; membershipRole: "owner" | "admin" | "operator" | "viewer" | "member"; status: string }[];
  source: string;
}

export interface IssueComment { id: string; issueId: string; body: string; createdAt: string; authorUserId?: string | null; authorAgentId?: string | null }
export interface ActivityEntry { id: string; action: string; entityType: string; entityId: string; actorType: string; actorId: string; createdAt: string; details?: Record<string, unknown> | null }
export interface CostSummary { [k: string]: unknown }
export interface Member { id: string; principalType: string; principalId: string; membershipRole: string; status: string; user?: { name?: string | null; email?: string | null } | null }
export interface AdapterInfo { type: string; label?: string; builtIn?: boolean; models?: { id: string; label?: string }[]; [k: string]: unknown }

export class EngineError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Every engine path this client calls, as templates. A test checks each one exists in the pinned engine's OpenAPI spec. */
export const ENGINE_PATHS = {
  health: "/api/health",
  me: "/api/cli-auth/me",
  companies: "/api/companies",
  company: "/api/companies/{companyId}",
  dashboard: "/api/companies/{companyId}/dashboard",
  agents: "/api/companies/{companyId}/agents",
  agent: "/api/agents/{id}",
  agentWakeup: "/api/agents/{id}/wakeup",
  agentPause: "/api/agents/{id}/pause",
  agentResume: "/api/agents/{id}/resume",
  issues: "/api/companies/{companyId}/issues",
  issue: "/api/issues/{id}",
  issueComments: "/api/issues/{id}/comments",
  goals: "/api/companies/{companyId}/goals",
  projects: "/api/companies/{companyId}/projects",
  approvals: "/api/companies/{companyId}/approvals",
  approve: "/api/approvals/{id}/approve",
  reject: "/api/approvals/{id}/reject",
  costSummary: "/api/companies/{companyId}/costs/summary",
  costByAgent: "/api/companies/{companyId}/costs/by-agent",
  activity: "/api/companies/{companyId}/activity",
  members: "/api/companies/{companyId}/members",
  routines: "/api/companies/{companyId}/routines",
  liveRuns: "/api/companies/{companyId}/live-runs",
  adapters: "/api/adapters",
} as const;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const fill = (tpl: string, params: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(params[k] ?? ""));

export function createEngineClient(opts: { base?: string; fetch?: Fetch } = {}) {
  const base = opts.base ?? "/engine";
  const f: Fetch = opts.fetch ?? ((i, init) => fetch(i, init));

  async function call<T>(method: string, tpl: string, params: Record<string, string> = {}, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
    const q = query ? Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&") : "";
    const res = await f(`${base}${fill(tpl, params)}${q ? `?${q}` : ""}`, {
      method,
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(method === "GET" ? {} : { "Content-Type": "application/json", "X-EPC-Request": "1" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const d = (data ?? {}) as { error?: string; code?: string };
      throw new EngineError(res.status, d.error ?? `The engine answered ${res.status}`, d.code ?? null);
    }
    return data as T;
  }

  const P = ENGINE_PATHS;
  return {
    health: () => call<{ status: string; bootstrapStatus?: string; deploymentMode?: string }>("GET", P.health),
    me: () => call<BoardAccess>("GET", P.me),
    companies: {
      list: () => call<Company[]>("GET", P.companies),
      get: (companyId: string) => call<Company>("GET", P.company, { companyId }),
      create: (body: { name: string; description?: string | null; budgetMonthlyCents?: number }) => call<Company>("POST", P.companies, {}, body),
      update: (companyId: string, body: Partial<Pick<Company, "name" | "description" | "budgetMonthlyCents">>) => call<Company>("PATCH", P.company, { companyId }, body),
      archive: (companyId: string) => call<unknown>("DELETE", P.company, { companyId }),
      dashboard: (companyId: string) => call<Record<string, unknown>>("GET", P.dashboard, { companyId }),
      members: (companyId: string) => call<Member[]>("GET", P.members, { companyId }),
    },
    agents: {
      list: (companyId: string) => call<Agent[]>("GET", P.agents, { companyId }),
      get: (id: string) => call<Agent>("GET", P.agent, { id }),
      create: (companyId: string, body: { name: string; role?: string; title?: string | null; reportsTo?: string | null; adapterType: string; adapterConfig?: Record<string, unknown>; capabilities?: string | null; budgetMonthlyCents?: number }) => call<Agent>("POST", P.agents, { companyId }, body),
      update: (id: string, body: Partial<Agent>) => call<Agent>("PATCH", P.agent, { id }, body),
      remove: (id: string) => call<unknown>("DELETE", P.agent, { id }),
      wakeup: (id: string, reason?: string) => call<unknown>("POST", P.agentWakeup, { id }, reason ? { reason } : {}),
      pause: (id: string) => call<Agent>("POST", P.agentPause, { id }, {}),
      resume: (id: string) => call<Agent>("POST", P.agentResume, { id }, {}),
    },
    issues: {
      list: (companyId: string, query?: { status?: string; assigneeAgentId?: string; projectId?: string; q?: string }) => call<Issue[]>("GET", P.issues, { companyId }, undefined, query),
      get: (id: string) => call<Issue>("GET", P.issue, { id }),
      create: (companyId: string, body: { title: string; description?: string | null; status?: string; priority?: string; assigneeAgentId?: string | null; projectId?: string | null; goalId?: string | null; parentId?: string | null }) => call<Issue>("POST", P.issues, { companyId }, body),
      update: (id: string, body: Record<string, unknown>) => call<Issue>("PATCH", P.issue, { id }, body),
      comments: (id: string) => call<IssueComment[]>("GET", P.issueComments, { id }),
      comment: (id: string, body: string) => call<IssueComment>("POST", P.issueComments, { id }, { body }),
    },
    goals: {
      list: (companyId: string) => call<Goal[]>("GET", P.goals, { companyId }),
      create: (companyId: string, body: { title: string; description?: string | null; level?: string; parentId?: string | null }) => call<Goal>("POST", P.goals, { companyId }, body),
    },
    projects: {
      list: (companyId: string) => call<Project[]>("GET", P.projects, { companyId }),
      create: (companyId: string, body: { name: string; description?: string | null; goalId?: string | null }) => call<Project>("POST", P.projects, { companyId }, body),
    },
    approvals: {
      list: (companyId: string, status?: string) => call<Approval[]>("GET", P.approvals, { companyId }, undefined, { status }),
      approve: (id: string, decisionNote?: string) => call<Approval>("POST", P.approve, { id }, decisionNote ? { decisionNote } : {}),
      reject: (id: string, decisionNote?: string) => call<Approval>("POST", P.reject, { id }, decisionNote ? { decisionNote } : {}),
    },
    costs: {
      summary: (companyId: string) => call<CostSummary>("GET", P.costSummary, { companyId }),
      byAgent: (companyId: string) => call<CostSummary[]>("GET", P.costByAgent, { companyId }),
    },
    activity: (companyId: string, limit = 50) => call<ActivityEntry[]>("GET", P.activity, { companyId }, undefined, { limit }),
    routines: (companyId: string) => call<Record<string, unknown>[]>("GET", P.routines, { companyId }),
    liveRuns: (companyId: string) => call<Record<string, unknown>[]>("GET", P.liveRuns, { companyId }),
    adapters: () => call<AdapterInfo[]>("GET", P.adapters),
  };
}

export type EngineClient = ReturnType<typeof createEngineClient>;

/** The live-events WebSocket for one organization, through the host service. */
export const engineEventsUrl = (companyId: string, origin = (globalThis as { location?: { origin: string } }).location?.origin ?? "") =>
  `${origin.replace(/^http/, "ws")}/engine/api/companies/${encodeURIComponent(companyId)}/events/ws`;
