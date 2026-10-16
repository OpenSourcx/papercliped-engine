/**
 * The engine routes the browser may reach through `/engine/api/*`. Anything else is a 404, so a new or forgotten engine
 * route (including ones that touch the managed account, bootstrap or CLI authentication) is closed until it is listed
 * here. The list is the console's own client (packages/engine-client ENGINE_PATHS and ENGINE_PATHS_UNDOCUMENTED); a
 * test keeps the two in step, and the E2E harness (docs/E2E.md) exercises every page against the real engine.
 *
 * A template segment `{name}` stands for exactly one non-empty path segment. Matching is case-insensitive, like the
 * engine's own router.
 */
export const ENGINE_ALLOWED: readonly string[] = [
  "/api/health",
  "/api/cli-auth/me",
  "/api/companies",
  "/api/companies/{companyId}",
  "/api/companies/{companyId}/dashboard",
  "/api/companies/{companyId}/agents",
  "/api/companies/{companyId}/agent-hires",
  "/api/agents/{id}",
  "/api/agents/{id}/wakeup",
  "/api/agents/{id}/pause",
  "/api/agents/{id}/resume",
  "/api/companies/{companyId}/issues",
  "/api/issues/{id}",
  "/api/issues/{id}/comments",
  "/api/companies/{companyId}/goals",
  "/api/companies/{companyId}/projects",
  "/api/companies/{companyId}/approvals",
  "/api/approvals/{id}/approve",
  "/api/approvals/{id}/reject",
  "/api/companies/{companyId}/costs/summary",
  "/api/companies/{companyId}/costs/by-agent",
  "/api/companies/{companyId}/activity",
  "/api/companies/{companyId}/members",
  "/api/companies/{companyId}/routines",
  "/api/companies/{companyId}/live-runs",
  "/api/companies/{companyId}/heartbeat-runs",
  "/api/adapters",
  "/api/companies/{companyId}/adapters/{type}/models",
  "/api/companies/{companyId}/environments/capabilities",
  "/api/routines/{id}",
  "/api/routines/{id}/runs",
  "/api/routines/{id}/run",
  "/api/routines/{id}/triggers",
  "/api/routine-triggers/{id}",
  "/api/routine-triggers/{id}/rotate-secret",
  "/api/routines/{id}/revisions",
  "/api/routines/{id}/revisions/{revisionId}/restore",
  "/api/companies/{companyId}/attention",
  "/api/companies/{companyId}/sidebar-badges",
  "/api/companies/{companyId}/inbox-dismissals",
  "/api/companies/{companyId}/inbox-dismissals/{itemKey}",
  "/api/issues/{id}/read",
  "/api/issues/{id}/inbox-archive",
  "/api/approvals/{id}",
  "/api/approvals/{id}/request-revision",
  "/api/issues/{id}/interactions",
  "/api/issues/{id}/interactions/{interactionId}/respond",
  "/api/issues/{id}/interactions/{interactionId}/accept",
  "/api/issues/{id}/interactions/{interactionId}/reject",
  "/api/companies/{companyId}/chats",
  "/api/companies/{companyId}/chats/{agentRef}",
  "/api/instance/settings/experimental",
  "/api/companies/{companyId}/skills",
  "/api/companies/{companyId}/skills/{skillId}",
  "/api/companies/{companyId}/skills/{skillId}/files",
  "/api/companies/{companyId}/skills/install-catalog",
  "/api/skills/catalog",
  "/api/companies/{companyId}/skill-sources",
  "/api/companies/{companyId}/skill-sources/{sourceId}/refresh",
  "/api/agents/{id}/skills",
  "/api/agents/{id}/skills/sync",
  "/api/companies/{companyId}/artifacts",
  "/api/issues/{id}/work-products",
  "/api/issues/{id}/attachments",
  "/api/companies/{companyId}/issues/{issueId}/attachments",
  "/api/attachments/{attachmentId}/content",
  "/api/attachments/{attachmentId}",
  "/api/companies/{companyId}/execution-workspaces",
  "/api/companies/{companyId}/workspace-overview",
  "/api/execution-workspaces/{id}",
  "/api/companies/{companyId}/branding",
  "/api/companies/{companyId}/archive",
  "/api/companies/{companyId}/budgets",
  "/api/companies/{companyId}/budgets/overview",
  "/api/companies/{companyId}/budgets/policies",
  "/api/companies/{companyId}/budget-incidents/{incidentId}/resolve",
  "/api/agents/{agentId}/budgets",
  "/api/companies/{companyId}/costs/by-provider",
  "/api/companies/{companyId}/costs/by-project",
  "/api/companies/{companyId}/costs/by-agent-model",
  "/api/companies/{companyId}/secrets",
  "/api/agents/{id}/configuration",
  "/api/agents/{id}/permissions",
  "/api/agents/{id}/instructions-bundle",
  "/api/agents/{id}/instructions-bundle/file",
  "/api/agents/{id}/instructions-bundle/history",
  "/api/agents/{id}/instructions-bundle/revision/{revisionId}",
  "/api/agents/{id}/instructions-bundle/restore",
  "/api/heartbeat-runs/{runId}/log",
  "/api/heartbeat-runs/{runId}/events",
  "/api/heartbeat-runs/{runId}",
  "/api/heartbeat-runs/{runId}/cancel",
  "/api/companies/{companyId}/labels",
  "/api/issues/{id}/documents",
  "/api/issues/{id}/approvals",
  "/api/companies/{companyId}/search",
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Compiles route templates to anchored, case-insensitive matchers. A trailing slash is tolerated. */
export function compileAllow(templates: readonly string[]): RegExp[] {
  return templates.map((t) => new RegExp(`^${t.split("/").map((seg) => (/^\{\w+\}$/.test(seg) ? "[^/]+" : escape(seg))).join("/")}/?$`, "i"));
}

export const ENGINE_ALLOW: RegExp[] = compileAllow(ENGINE_ALLOWED);

/** Whether a decoded engine path (no query string) is one the browser may reach. */
export const engineAllowed = (decodedPath: string, extra: readonly RegExp[] = []): boolean => ENGINE_ALLOW.some((re) => re.test(decodedPath)) || extra.some((re) => re.test(decodedPath));
