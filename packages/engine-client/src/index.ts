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


export interface RoutineBody { title?: string; description?: string | null; assigneeAgentId?: string | null; projectId?: string | null; priority?: IssuePriority; status?: "active" | "paused" | "archived"; concurrencyPolicy?: string; catchUpPolicy?: string }
export type RoutineTriggerBody = { kind: "schedule"; cronExpression: string; timezone?: string; label?: string | null } | { kind: "webhook"; label?: string | null; signingMode?: string } | { kind: "api"; label?: string | null };
export interface RoutineTriggerResult { trigger: RoutineTrigger; secretMaterial: RoutineTriggerSecretMaterial | null }
export interface DecisionVerb { id: string; label: string; description?: string }
export interface IssueInteraction { id: string; kind: string; status: string; title?: string | null; summary?: string | null; payload?: Record<string, unknown>; result?: Record<string, unknown> | null; createdAt: string }
export interface InstanceExperimental { enableAgentChat?: boolean; enableConferenceRoomChat?: boolean; [k: string]: unknown }
export interface InstructionsBundle { agentId: string; mode: string | null; rootPath: string | null; managedRootPath: string | null; entryFile: string; editable: boolean; warnings: string[]; files: { path: string; size: number; language?: string; markdown?: boolean; isEntryFile?: boolean }[] }
export interface InstructionsFile { path: string; size: number; content: string; language?: string; markdown?: boolean; editable?: boolean }
export interface InstructionsRevision { id: string; createdAt: string; summary?: string | null; [k: string]: unknown }
export interface RunLogChunk { content: string; nextOffset?: number; [k: string]: unknown }
export interface RunEvent { id: number; seq: number; eventType: string; stream: string | null; level: string | null; message: string | null; payload: unknown; createdAt: string }
export interface AgentPermissionsBody { canCreateAgents?: boolean; canCreateSkills?: boolean }
export interface BudgetPolicyBody { scopeType: "company" | "agent" | "project"; scopeId: string; amount: number; metric?: string; windowKind?: string; warnPercent?: number; hardStopEnabled?: boolean; notifyEnabled?: boolean; isActive?: boolean }
export interface SearchParams { q: string; scope?: string; limit?: number }
export interface CreateSecretBody { name: string; value: string; description?: string | null; provider?: string }

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
  // Routines
  routine: "/api/routines/{id}",
  routineRuns: "/api/routines/{id}/runs",
  routineRun: "/api/routines/{id}/run",
  routineTriggers: "/api/routines/{id}/triggers",
  routineTrigger: "/api/routine-triggers/{id}",
  routineRotateSecret: "/api/routine-triggers/{id}/rotate-secret",
  routineRevisions: "/api/routines/{id}/revisions",
  routineRestore: "/api/routines/{id}/revisions/{revisionId}/restore",
  // Inbox and decisions
  attention: "/api/companies/{companyId}/attention",
  sidebarBadges: "/api/companies/{companyId}/sidebar-badges",
  inboxDismissals: "/api/companies/{companyId}/inbox-dismissals",
  inboxDismissal: "/api/companies/{companyId}/inbox-dismissals/{itemKey}",
  issueRead: "/api/issues/{id}/read",
  issueInboxArchive: "/api/issues/{id}/inbox-archive",
  approval: "/api/approvals/{id}",
  approvalRequestRevision: "/api/approvals/{id}/request-revision",
  issueInteractions: "/api/issues/{id}/interactions",
  interactionRespond: "/api/issues/{id}/interactions/{interactionId}/respond",
  interactionAccept: "/api/issues/{id}/interactions/{interactionId}/accept",
  interactionReject: "/api/issues/{id}/interactions/{interactionId}/reject",
  // Chat
  chats: "/api/companies/{companyId}/chats",
  instanceExperimental: "/api/instance/settings/experimental",
  // Skills
  skills: "/api/companies/{companyId}/skills",
  skill: "/api/companies/{companyId}/skills/{skillId}",
  skillFiles: "/api/companies/{companyId}/skills/{skillId}/files",
  skillInstallCatalog: "/api/companies/{companyId}/skills/install-catalog",
  skillsCatalog: "/api/skills/catalog",
  skillSources: "/api/companies/{companyId}/skill-sources",
  skillSourceRefresh: "/api/companies/{companyId}/skill-sources/{sourceId}/refresh",
  agentSkills: "/api/agents/{id}/skills",
  agentSkillsSync: "/api/agents/{id}/skills/sync",
  // Artifacts and workspaces
  artifacts: "/api/companies/{companyId}/artifacts",
  issueWorkProducts: "/api/issues/{id}/work-products",
  issueAttachments: "/api/issues/{id}/attachments",
  attachmentUpload: "/api/companies/{companyId}/issues/{issueId}/attachments",
  attachmentContent: "/api/attachments/{attachmentId}/content",
  attachment: "/api/attachments/{attachmentId}",
  executionWorkspaces: "/api/companies/{companyId}/execution-workspaces",
  workspaceOverview: "/api/companies/{companyId}/workspace-overview",
  executionWorkspace: "/api/execution-workspaces/{id}",
  // Organization settings and budgets
  branding: "/api/companies/{companyId}/branding",
  archive: "/api/companies/{companyId}/archive",
  budgets: "/api/companies/{companyId}/budgets",
  budgetsOverview: "/api/companies/{companyId}/budgets/overview",
  budgetPolicies: "/api/companies/{companyId}/budgets/policies",
  budgetIncidentResolve: "/api/companies/{companyId}/budget-incidents/{incidentId}/resolve",
  agentBudgets: "/api/agents/{agentId}/budgets",
  costByProvider: "/api/companies/{companyId}/costs/by-provider",
  costByProject: "/api/companies/{companyId}/costs/by-project",
  costByAgentModel: "/api/companies/{companyId}/costs/by-agent-model",
  secrets: "/api/companies/{companyId}/secrets",
  // Agents
  agentConfiguration: "/api/agents/{id}/configuration",
  agentPermissions: "/api/agents/{id}/permissions",
  instructionsBundle: "/api/agents/{id}/instructions-bundle",
  instructionsFile: "/api/agents/{id}/instructions-bundle/file",
  instructionsHistory: "/api/agents/{id}/instructions-bundle/history",
  instructionsRevision: "/api/agents/{id}/instructions-bundle/revision/{revisionId}",
  instructionsRestore: "/api/agents/{id}/instructions-bundle/restore",
  runLog: "/api/heartbeat-runs/{runId}/log",
  runEvents: "/api/heartbeat-runs/{runId}/events",
  run: "/api/heartbeat-runs/{runId}",
  runCancel: "/api/heartbeat-runs/{runId}/cancel",
  // Tasks
  labels: "/api/companies/{companyId}/labels",
  issueDocuments: "/api/issues/{id}/documents",
  issueApprovals: "/api/issues/{id}/approvals",
  // Search
  search: "/api/companies/{companyId}/search",
} as const;

/**
 * Routes the engine serves (checked in its source and by running it) that its OpenAPI document leaves out. A test
 * checks they are NOT in the spec, so when a later engine documents them they move into ENGINE_PATHS.
 */
export const ENGINE_PATHS_UNDOCUMENTED = {
  chatWith: "/api/companies/{companyId}/chats/{agentRef}",
} as const;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** An engine-relative file address the console may fetch: under /api/, no dot segments, no scheme or host, no backslashes. */
export const safeEnginePath = (p: string) => /^\/api\/[A-Za-z0-9_\-./%?=&]+$/.test(p) && !p.split("?")[0].split("/").some((seg) => seg === ".." || seg === ".");

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

  /** A binary or text download as a Response, through the same proxy (credentials stay on this origin). */
  const raw = (tpl: string, params: Record<string, string>) => f(`${base}${fill(tpl, params)}`, { method: "GET", credentials: "same-origin" });
  /** The address of an engine file, for a download link. */
  const href = (tpl: string, params: Record<string, string>) => `${base}${fill(tpl, params)}`;
  /** A multipart upload; the host service caps its size and answers 413 with the limit in words. */
  async function upload<T>(tpl: string, params: Record<string, string>, form: FormData): Promise<T> {
    const res = await f(`${base}${fill(tpl, params)}`, { method: "POST", credentials: "same-origin", headers: { Accept: "application/json", "X-EPC-Request": "1" }, body: form });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const d = (data ?? {}) as { error?: string; code?: string };
      throw new EngineError(res.status, d.error ?? (res.status === 413 ? "That file is too large to upload." : `The engine answered ${res.status}`), d.code ?? null);
    }
    return data as T;
  }

  const P = ENGINE_PATHS;
  return {
    raw,
    href,
    health: () => call<{ status: string; bootstrapStatus?: string; deploymentMode?: string }>("GET", P.health),
    me: () => call<BoardAccess>("GET", P.me),
    companies: {
      list: () => call<Company[]>("GET", P.companies),
      get: (companyId: string) => call<Company>("GET", P.company, { companyId }),
      create: (body: CreateCompanyBody) => call<Company>("POST", P.companies, {}, body),
      update: (companyId: string, body: Partial<Pick<Company, "name" | "description" | "budgetMonthlyCents">> & { status?: "active" | "paused" | "archived"; requireBoardApprovalForNewAgents?: boolean }) => call<Company>("PATCH", P.company, { companyId }, body),
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
    routines: {
      list: (companyId: string) => call<RoutineListItem[]>("GET", P.routines, { companyId }),
      get: (id: string) => call<RoutineDetail>("GET", P.routine, { id }),
      create: (companyId: string, body: RoutineBody) => call<Routine>("POST", P.routines, { companyId }, body),
      update: (id: string, body: RoutineBody) => call<Routine>("PATCH", P.routine, { id }, body),
      runs: (id: string, limit = 25) => call<RoutineRunSummary[]>("GET", P.routineRuns, { id }, undefined, { limit }),
      run: (id: string) => call<RoutineRun>("POST", P.routineRun, { id }, {}),
      addTrigger: (id: string, body: RoutineTriggerBody) => call<RoutineTriggerResult>("POST", P.routineTriggers, { id }, body),
      updateTrigger: (id: string, body: { enabled?: boolean; label?: string | null; cronExpression?: string | null; timezone?: string | null }) => call<RoutineTrigger>("PATCH", P.routineTrigger, { id }, body),
      removeTrigger: (id: string) => call<unknown>("DELETE", P.routineTrigger, { id }),
      rotateSecret: (id: string) => call<RoutineTriggerResult>("POST", P.routineRotateSecret, { id }, {}),
      revisions: (id: string) => call<RoutineRevision[]>("GET", P.routineRevisions, { id }),
      restore: (id: string, revisionId: string) => call<unknown>("POST", P.routineRestore, { id, revisionId }, {}),
    },
    liveRuns: (companyId: string) => call<Record<string, unknown>[]>("GET", P.liveRuns, { companyId }),
    inbox: {
      attention: (companyId: string, query?: { limit?: number; includeDismissed?: string }) => call<AttentionFeed>("GET", P.attention, { companyId }, undefined, query),
      badges: (companyId: string) => call<SidebarBadges>("GET", P.sidebarBadges, { companyId }),
      dismissals: (companyId: string) => call<InboxDismissal[]>("GET", P.inboxDismissals, { companyId }),
      dismiss: (companyId: string, itemKey: string) => call<InboxDismissal>("POST", P.inboxDismissals, { companyId }, { itemKey }),
      restore: (companyId: string, itemKey: string) => call<unknown>("DELETE", P.inboxDismissal, { companyId, itemKey }),
      markRead: (issueId: string) => call<unknown>("POST", P.issueRead, { id: issueId }, {}),
      markUnread: (issueId: string) => call<unknown>("DELETE", P.issueRead, { id: issueId }),
      archive: (issueId: string) => call<unknown>("POST", P.issueInboxArchive, { id: issueId }, {}),
      unarchive: (issueId: string) => call<unknown>("DELETE", P.issueInboxArchive, { id: issueId }),
      approval: (id: string) => call<Approval>("GET", P.approval, { id }),
      requestRevision: (id: string, decisionNote?: string) => call<Approval>("POST", P.approvalRequestRevision, { id }, decisionNote ? { decisionNote } : {}),
      interactions: (issueId: string) => call<IssueInteraction[]>("GET", P.issueInteractions, { id: issueId }),
      respond: (issueId: string, interactionId: string, body: Record<string, unknown>) => call<unknown>("POST", P.interactionRespond, { id: issueId, interactionId }, body),
      accept: (issueId: string, interactionId: string, body: Record<string, unknown> = {}) => call<unknown>("POST", P.interactionAccept, { id: issueId, interactionId }, body),
      reject: (issueId: string, interactionId: string, body: Record<string, unknown> = {}) => call<unknown>("POST", P.interactionReject, { id: issueId, interactionId }, body),
      touchedByMe: (companyId: string, limit = 50) => call<Issue[]>("GET", P.issues, { companyId }, undefined, { touchedByUserId: "me", limit }),
    },
    chat: {
      settings: () => call<InstanceExperimental>("GET", P.instanceExperimental),
      enable: () => call<InstanceExperimental>("PATCH", P.instanceExperimental, {}, { enableAgentChat: true }),
      list: (companyId: string) => call<Issue[]>("GET", P.chats, { companyId }),
      get: (companyId: string, agentRef: string) => call<Issue | null>("GET", ENGINE_PATHS_UNDOCUMENTED.chatWith, { companyId, agentRef }),
      open: (companyId: string, agentRef: string) => call<Issue>("POST", ENGINE_PATHS_UNDOCUMENTED.chatWith, { companyId, agentRef }, {}),
    },
    skills: {
      list: (companyId: string) => call<CompanySkillListItem[]>("GET", P.skills, { companyId }),
      get: (companyId: string, skillId: string) => call<CompanySkillDetail>("GET", P.skill, { companyId, skillId }),
      file: (companyId: string, skillId: string, path: string) => call<CompanySkillFileDetail>("GET", P.skillFiles, { companyId, skillId }, undefined, { path }),
      catalog: () => call<Record<string, unknown>[]>("GET", P.skillsCatalog),
      installCatalog: (companyId: string, body: Record<string, unknown>) => call<unknown>("POST", P.skillInstallCatalog, { companyId }, body),
      sources: (companyId: string) => call<Record<string, unknown>[]>("GET", P.skillSources, { companyId }),
      refreshSource: (companyId: string, sourceId: string) => call<unknown>("POST", P.skillSourceRefresh, { companyId, sourceId }, {}),
      forAgent: (agentId: string) => call<AgentSkillSnapshot>("GET", P.agentSkills, { id: agentId }),
      syncAgent: (agentId: string, mode: "add" | "remove" | "replace", desiredSkills: string[]) => call<AgentSkillSnapshot>("POST", P.agentSkillsSync, { id: agentId }, { mode, desiredSkills }),
    },
    artifacts: {
      list: (companyId: string, query?: { kind?: string; q?: string; limit?: number; cursor?: string }) => call<CompanyArtifactsResponse>("GET", P.artifacts, { companyId }, undefined, query),
      workProducts: (issueId: string) => call<IssueWorkProduct[]>("GET", P.issueWorkProducts, { id: issueId }),
      attachments: (issueId: string) => call<IssueAttachment[]>("GET", P.issueAttachments, { id: issueId }),
      upload: (companyId: string, issueId: string, file: File) => { const form = new FormData(); form.append("file", file); return upload<IssueAttachment>(P.attachmentUpload, { companyId, issueId }, form); },
      content: (attachmentId: string) => raw(P.attachmentContent, { attachmentId }),
      /** Fetches an engine file by the path the engine gave (contentPath). Only /api/ paths without tricks are followed. */
      fetchPath: (path: string) => { if (!safeEnginePath(path)) throw new EngineError(400, "That file address isn't one the console will open."); return f(`${base}${path}`, { method: "GET", credentials: "same-origin" }); },
      pathUrl: (path: string) => (safeEnginePath(path) ? `${base}${path}` : null),
      contentUrl: (attachmentId: string) => href(P.attachmentContent, { attachmentId }),
      removeAttachment: (attachmentId: string) => call<unknown>("DELETE", P.attachment, { attachmentId }),
    },
    workspaces: {
      list: (companyId: string, status?: string) => call<ExecutionWorkspace[]>("GET", P.executionWorkspaces, { companyId }, undefined, { status }),
      overview: (companyId: string) => call<WorkspaceOverviewResponse>("GET", P.workspaceOverview, { companyId }),
      get: (id: string) => call<ExecutionWorkspace>("GET", P.executionWorkspace, { id }),
    },
    settings: {
      branding: (companyId: string, body: { name?: string; description?: string | null }) => call<Company>("PATCH", P.branding, { companyId }, body),
      archive: (companyId: string) => call<Company>("POST", P.archive, { companyId }, {}),
      budget: (companyId: string, budgetMonthlyCents: number) => call<Company>("PATCH", P.budgets, { companyId }, { budgetMonthlyCents }),
      secrets: (companyId: string) => call<CompanySecret[]>("GET", P.secrets, { companyId }),
      createSecret: (companyId: string, body: CreateSecretBody) => call<CompanySecret>("POST", P.secrets, { companyId }, body),
    },
    budgets: {
      overview: (companyId: string) => call<BudgetOverview>("GET", P.budgetsOverview, { companyId }),
      upsertPolicy: (companyId: string, body: BudgetPolicyBody) => call<BudgetPolicySummary>("POST", P.budgetPolicies, { companyId }, body),
      resolveIncident: (companyId: string, incidentId: string, body: { action: "keep_paused" | "raise_budget_and_resume"; amount?: number; decisionNote?: string | null }) => call<BudgetIncident>("POST", P.budgetIncidentResolve, { companyId, incidentId }, body),
      setAgent: (agentId: string, budgetMonthlyCents: number) => call<Agent>("PATCH", P.agentBudgets, { agentId }, { budgetMonthlyCents }),
    },
    costBreakdown: {
      byProvider: (companyId: string) => call<CostByProviderModel[]>("GET", P.costByProvider, { companyId }),
      byProject: (companyId: string) => call<CostByProject[]>("GET", P.costByProject, { companyId }),
      byAgentModel: (companyId: string) => call<CostByAgentModel[]>("GET", P.costByAgentModel, { companyId }),
    },
    agentConfig: {
      get: (id: string) => call<Record<string, unknown>>("GET", P.agentConfiguration, { id }),
      permissions: (id: string, body: AgentPermissionsBody) => call<Agent>("PATCH", P.agentPermissions, { id }, body),
      bundle: (id: string) => call<InstructionsBundle>("GET", P.instructionsBundle, { id }),
      file: (id: string, path: string) => call<InstructionsFile>("GET", P.instructionsFile, { id }, undefined, { path }),
      saveFile: (id: string, path: string, content: string) => call<unknown>("PUT", P.instructionsFile, { id }, { path, content }),
      history: (id: string) => call<InstructionsRevision[]>("GET", P.instructionsHistory, { id }),
      revision: (id: string, revisionId: string) => call<Record<string, unknown>>("GET", P.instructionsRevision, { id, revisionId }),
      restore: (id: string, revisionId: string) => call<unknown>("POST", P.instructionsRestore, { id }, { revisionId }),
    },
    runs: {
      get: (runId: string) => call<HeartbeatRun>("GET", P.run, { runId }),
      log: (runId: string, offset = 0, limitBytes = 65536) => call<RunLogChunk>("GET", P.runLog, { runId }, undefined, { offset, limitBytes }),
      events: (runId: string, afterSeq = 0, limit = 200) => call<RunEvent[]>("GET", P.runEvents, { runId }, undefined, { afterSeq, limit }),
      cancel: (runId: string) => call<unknown>("POST", P.runCancel, { runId }, {}),
    },
    tasks: {
      labels: (companyId: string) => call<IssueLabel[]>("GET", P.labels, { companyId }),
      documents: (issueId: string) => call<Record<string, unknown>[]>("GET", P.issueDocuments, { id: issueId }),
      approvals: (issueId: string) => call<Approval[]>("GET", P.issueApprovals, { id: issueId }),
      children: (companyId: string, parentId: string) => call<Issue[]>("GET", P.issues, { companyId }, undefined, { parentId }),
    },
    search: (companyId: string, p: SearchParams) => call<CompanySearchResponse>("GET", P.search, { companyId }, undefined, { q: p.q, scope: p.scope, limit: p.limit ?? 8 }),
    adapters: () => call<AdapterInfo[]>("GET", P.adapters),
    adapterModels: (companyId: string, type: string) => call<AdapterModel[]>("GET", P.adapterModels, { companyId, type }),
  };
}

export type EngineClient = ReturnType<typeof createEngineClient>;

/** The live-events WebSocket for one organization, through the host service. */
export const engineEventsUrl = (companyId: string, origin = (globalThis as { location?: { origin: string } }).location?.origin ?? "") =>
  `${origin.replace(/^http/, "ws")}/engine/api/companies/${encodeURIComponent(companyId)}/events/ws`;
