import type {
  ActivityEvent,
  Agent,
  AgentRole,
  AgentSkillSnapshot,
  Approval,
  AttentionFeed,
  AttentionItem,
  BudgetIncident,
  BudgetOverview,
  BudgetPolicySummary,
  Company,
  CompanyArtifact,
  CompanyArtifactsResponse,
  CompanySearchResponse,
  CompanySecret,
  CompanySkillDetail,
  CompanySkillFileDetail,
  CompanySkillListItem,
  CostByAgent,
  CostByAgentModel,
  CostByProject,
  CostByProviderModel,
  CostSummary,
  DashboardSummary,
  ExecutionWorkspace,
  Goal,
  GoalLevel,
  GoalStatus,
  HeartbeatRun,
  InboxDismissal,
  Issue,
  IssueAttachment,
  IssueComment,
  IssueLabel,
  IssuePriority,
  IssueStatus,
  IssueWorkProduct,
  Project,
  ProjectStatus,
  Routine,
  RoutineDetail,
  RoutineListItem,
  RoutineRevision,
  RoutineRun,
  RoutineRunSummary,
  RoutineTrigger,
  RoutineTriggerSecretMaterial,
  SidebarBadges,
  WorkspaceOverviewResponse,
} from "@paperclipai/shared";

/**
 * The Paperclip engine's API, as the console reaches it: through the host service at /engine/api, which checks the
 * Proxmox session and forwards the request as that person's engine account. Types are Paperclip's own, from
 * @paperclipai/shared at the pinned engine version. Dates in them arrive as ISO strings over HTTP.
 */
export type {
  ActivityEvent, Agent, AgentRole, AgentSkillSnapshot, Approval, AttentionFeed, AttentionItem, BudgetIncident, BudgetOverview, BudgetPolicySummary, Company, CompanyArtifact, CompanyArtifactsResponse, CompanySearchResponse,
  CompanySecret, CompanySkillDetail, CompanySkillFileDetail, CompanySkillListItem, CostByAgent, CostByAgentModel, CostByProject, CostByProviderModel, CostSummary, DashboardSummary, ExecutionWorkspace, Goal, GoalLevel,
  GoalStatus, HeartbeatRun, InboxDismissal, Issue, IssueAttachment, IssueComment, IssueLabel, IssuePriority, IssueStatus, IssueWorkProduct, Project, ProjectStatus, Routine, RoutineDetail, RoutineListItem,
  RoutineRevision, RoutineRun, RoutineRunSummary, RoutineTrigger, RoutineTriggerSecretMaterial, SidebarBadges, WorkspaceOverviewResponse,
};

/** Paperclip's enums as values, so the console needn't load the shared package at runtime. `satisfies` keeps them in step with its types. */
export const AGENT_ROLES = ["ceo", "cto", "cmo", "cfo", "security", "engineer", "designer", "pm", "qa", "devops", "researcher", "general"] as const satisfies readonly AgentRole[];
export const ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"] as const satisfies readonly IssueStatus[];
export const ISSUE_PRIORITIES = ["critical", "high", "medium", "low"] as const satisfies readonly IssuePriority[];

export interface BoardAccess {
  user: { id: string; name: string | null; email: string } | null;
  userId: string;
  isInstanceAdmin: boolean;
  companyIds: string[];
  memberships: { companyId: string; membershipRole: "owner" | "admin" | "operator" | "viewer" | "member"; status: string }[];
  source: string;
}

export type ActivityEntry = ActivityEvent;
export interface Member { id: string; companyId: string; principalType: string; principalId: string; membershipRole: string | null; status: string; createdAt: string; user: { id: string; name: string | null; email: string | null; image?: string | null } | null }
export interface MembersAnswer { members: Member[]; access: { currentUserRole: string | null; canManageMembers: boolean; canInviteUsers: boolean } }
export interface AdapterInfo { type: string; label: string; source: "builtin" | "external"; modelsCount: number; loaded: boolean; disabled: boolean; [k: string]: unknown }
export interface AdapterModel { id: string; label: string }

/** Request bodies, as Paperclip's validators (createCompanySchema, createAgentSchema, createIssueSchema, ...) accept them. */
export interface CreateCompanyBody { name: string; description?: string | null; budgetMonthlyCents?: number }
export interface CreateAgentBody { name: string; role?: AgentRole; title?: string | null; reportsTo?: string | null; capabilities?: string | null; adapterType: string; adapterConfig?: Record<string, unknown>; budgetMonthlyCents?: number }
export interface UpdateAgentBody { name?: string; role?: AgentRole; title?: string | null; reportsTo?: string | null; capabilities?: string | null; budgetMonthlyCents?: number }
export interface CreateIssueBody { title: string; description?: string | null; status?: IssueStatus; priority?: IssuePriority; assigneeAgentId?: string | null; assigneeUserId?: string | null; projectId?: string | null; goalId?: string | null; parentId?: string | null }
export interface UpdateIssueBody { title?: string; description?: string | null; status?: IssueStatus; priority?: IssuePriority; assigneeAgentId?: string | null; assigneeUserId?: string | null; projectId?: string | null; goalId?: string | null; comment?: string }
export interface CreateGoalBody { title: string; description?: string | null; level?: GoalLevel; status?: GoalStatus; parentId?: string | null; ownerAgentId?: string | null }
export interface CreateProjectBody { name: string; description?: string | null; status?: ProjectStatus; leadAgentId?: string | null; targetDate?: string | null; goalIds?: string[] }

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
  heartbeatRuns: "/api/companies/{companyId}/heartbeat-runs",
  adapters: "/api/adapters",
  adapterModels: "/api/companies/{companyId}/adapters/{type}/models",
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
      create: (body: CreateCompanyBody) => call<Company>("POST", P.companies, {}, body),
      update: (companyId: string, body: Partial<Pick<Company, "name" | "description" | "budgetMonthlyCents">>) => call<Company>("PATCH", P.company, { companyId }, body),
      archive: (companyId: string) => call<unknown>("DELETE", P.company, { companyId }),
      dashboard: (companyId: string) => call<DashboardSummary>("GET", P.dashboard, { companyId }),
      members: (companyId: string) => call<MembersAnswer>("GET", P.members, { companyId }),
    },
    agents: {
      list: (companyId: string) => call<Agent[]>("GET", P.agents, { companyId }),
      get: (id: string) => call<Agent>("GET", P.agent, { id }),
      create: (companyId: string, body: CreateAgentBody) => call<Agent>("POST", P.agents, { companyId }, body),
      update: (id: string, body: UpdateAgentBody) => call<Agent>("PATCH", P.agent, { id }, body),
      remove: (id: string) => call<unknown>("DELETE", P.agent, { id }),
      wakeup: (id: string, reason?: string) => call<unknown>("POST", P.agentWakeup, { id }, { source: "on_demand", triggerDetail: "manual", ...(reason ? { reason } : {}) }),
      pause: (id: string) => call<Agent>("POST", P.agentPause, { id }, {}),
      resume: (id: string) => call<Agent>("POST", P.agentResume, { id }, {}),
      runs: (companyId: string, agentId?: string, limit = 20) => call<HeartbeatRun[]>("GET", P.heartbeatRuns, { companyId }, undefined, { agentId, limit }),
    },
    issues: {
      list: (companyId: string, query?: { status?: string; assigneeAgentId?: string; projectId?: string; q?: string }) => call<Issue[]>("GET", P.issues, { companyId }, undefined, query),
      get: (id: string) => call<Issue>("GET", P.issue, { id }),
      create: (companyId: string, body: CreateIssueBody) => call<Issue>("POST", P.issues, { companyId }, body),
      update: (id: string, body: UpdateIssueBody) => call<Issue>("PATCH", P.issue, { id }, body),
      comments: (id: string) => call<IssueComment[]>("GET", P.issueComments, { id }),
      comment: (id: string, body: string) => call<IssueComment>("POST", P.issueComments, { id }, { body }),
    },
    goals: {
      list: (companyId: string) => call<Goal[]>("GET", P.goals, { companyId }),
      create: (companyId: string, body: CreateGoalBody) => call<Goal>("POST", P.goals, { companyId }, body),
    },
    projects: {
      list: (companyId: string) => call<Project[]>("GET", P.projects, { companyId }),
      create: (companyId: string, body: CreateProjectBody) => call<Project>("POST", P.projects, { companyId }, body),
    },
    approvals: {
      list: (companyId: string, status?: string) => call<Approval[]>("GET", P.approvals, { companyId }, undefined, { status }),
      approve: (id: string, decisionNote?: string) => call<Approval>("POST", P.approve, { id }, decisionNote ? { decisionNote } : {}),
      reject: (id: string, decisionNote?: string) => call<Approval>("POST", P.reject, { id }, decisionNote ? { decisionNote } : {}),
    },
    costs: {
      summary: (companyId: string) => call<CostSummary>("GET", P.costSummary, { companyId }),
      byAgent: (companyId: string) => call<CostByAgent[]>("GET", P.costByAgent, { companyId }),
    },
    activity: (companyId: string, limit = 50) => call<ActivityEntry[]>("GET", P.activity, { companyId }, undefined, { limit }),
    routines: (companyId: string) => call<Record<string, unknown>[]>("GET", P.routines, { companyId }),
    liveRuns: (companyId: string) => call<Record<string, unknown>[]>("GET", P.liveRuns, { companyId }),
    adapters: () => call<AdapterInfo[]>("GET", P.adapters),
    adapterModels: (companyId: string, type: string) => call<AdapterModel[]>("GET", P.adapterModels, { companyId, type }),
  };
}

export type EngineClient = ReturnType<typeof createEngineClient>;

/** The live-events WebSocket for one organization, through the host service. */
export const engineEventsUrl = (companyId: string, origin = (globalThis as { location?: { origin: string } }).location?.origin ?? "") =>
  `${origin.replace(/^http/, "ws")}/engine/api/companies/${encodeURIComponent(companyId)}/events/ws`;
