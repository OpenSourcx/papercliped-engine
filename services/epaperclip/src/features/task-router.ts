import { RoutingTableError, DEFAULT_ROUTING_TABLE, type TaskContract } from "@papercliped-engine/task-router";
import type { EngineGateway } from "../engine.ts";
import { HttpError } from "../http.ts";
import type { Session } from "../sessions.ts";
import { createTaskAssigner, type EngineAgentView, type IssueRef, type TaskAssigner } from "../task-router-assign.ts";
import { createJevSettings, createOrgRouter, getDecision, getTable, getTierAgents, JEV_CARD, listDecisions, newDecisionId, recordDecision, saveTable, saveTierAgents, SettingsError, stateJevPorts, type JevSettings } from "../task-router-jev.ts";
import type { StateStore } from "../state.ts";
import { appendAudit } from "./access-tokens.ts";
import type { FeatureCtx } from "./index.ts";

/**
 * Task routing for an organization (docs/CONNECTORS.md, "Task routing with Jev"). Reading is for the organization's
 * members; changing routing settings (Jev, its key, the table, the tier -> agent mapping) is for its owners and admins.
 * Assigning a task and reporting how its run went are normal organization work, so members may do those. The TypeSafe
 * key is write-only: it is sealed in the vault and never returned.
 *
 *   GET    /api/task-router/orgs/:id/jev           { enabled, hasKey, consentSendTaskText, active, disclosure, card }
 *   PUT    /api/task-router/orgs/:id/jev           { enabled?, consentSendTaskText? }
 *   PUT    /api/task-router/orgs/:id/jev/key       { apiKey }
 *   DELETE /api/task-router/orgs/:id/jev/key
 *   POST   /api/task-router/orgs/:id/jev/test      one fixed question, no task text
 *   GET|PUT /api/task-router/orgs/:id/table        the organization's routing table
 *   GET|PUT /api/task-router/orgs/:id/agents       tier -> engine agent (optional delegation mapping)
 *   POST   /api/task-router/orgs/:id/route         { goal, filesAllowed, ... } -> the decision (kept in the log)
 *   POST   /api/task-router/orgs/:id/assign        route and create the engine task assigned to the selected agent
 *   GET    /api/task-router/orgs/:id/decisions     the decisions kept on this device, newest first
 *   GET    /api/task-router/orgs/:id/decisions/:decisionId
 *   POST   /api/task-router/orgs/:id/decisions/:decisionId/report  { status, note? } -> escalation result
 */

const COMPANY = /^[A-Za-z0-9_-]{1,64}$/;
const PATH = /^\/api\/task-router\/orgs\/([A-Za-z0-9_-]{1,64})\/(jev|jev\/key|jev\/test|table|route|assign|agents|decisions|decisions\/[A-Za-z0-9_-]{1,64}(?:\/report)?)$/;
const DECISION_ONE = /^decisions\/([A-Za-z0-9_-]{1,64})$/;
const DECISION_REPORT = /^decisions\/([A-Za-z0-9_-]{1,64})\/report$/;

const books = new WeakMap<StateStore, JevSettings>();
/** One settings object per host service; tests can replace it to use a fake TypeSafe. */
export const jevSettingsOf = (state: StateStore, fetchImpl?: typeof fetch): JevSettings => {
  let b = books.get(state);
  if (!b) books.set(state, (b = createJevSettings({ ...stateJevPorts(state), fetch: fetchImpl })));
  return b;
};
export const setJevSettings = (state: StateStore, s: JevSettings) => void books.set(state, s);

async function membership(gw: EngineGateway | null, s: Session, companyId: string): Promise<"admin" | "member"> {
  if (!gw) throw new HttpError(503, "engine_unavailable", "The engine isn't set up on this host.");
  const m = await gw.membership(s, companyId);
  if (!m) throw new HttpError(403, "not_member", "You aren't a member of that organization.");
  return m.role === "owner" || m.role === "admin" ? "admin" : "member";
}

function contractFrom(b: Record<string, unknown>): TaskContract {
  const bad = (m: string) => new HttpError(400, "bad_request", m);
  if (typeof b.goal !== "string" || !b.goal.trim() || b.goal.length > 4000) throw bad("goal must be text, up to 4000 characters.");
  if (!Array.isArray(b.filesAllowed) || b.filesAllowed.length > 200 || b.filesAllowed.some((f) => typeof f !== "string" || !f || f.length > 300)) throw bad("filesAllowed must be a list of up to 200 file paths.");
  if (b.testCommand !== undefined && (typeof b.testCommand !== "string" || b.testCommand.length > 500)) throw bad("testCommand must be text.");
  if (b.expectedDiffLines !== undefined && (!Number.isInteger(b.expectedDiffLines) || (b.expectedDiffLines as number) < 0 || (b.expectedDiffLines as number) > 1e6)) throw bad("expectedDiffLines must be a whole number.");
  if (b.riskTags !== undefined && (!Array.isArray(b.riskTags) || b.riskTags.length > 50 || b.riskTags.some((t) => typeof t !== "string" || t.length > 40))) throw bad("riskTags must be a list of short words.");
  return { goal: b.goal, filesAllowed: b.filesAllowed as string[], testCommand: b.testCommand as string | undefined, expectedDiffLines: b.expectedDiffLines as number | undefined, riskTags: b.riskTags as string[] | undefined };
}

/** The engine agents this organization has, reduced to the fields routing needs. */
async function engineAgents(gw: EngineGateway, s: Session, companyId: string): Promise<EngineAgentView[]> {
  const raw = await gw.userJson<unknown>(s, "GET", `/api/companies/${encodeURIComponent(companyId)}/agents`);
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { agents?: unknown } | null)?.agents) ? (raw as { agents: unknown[] }).agents : [];
  const out: EngineAgentView[] = [];
  for (const item of list) {
    const a = item as Record<string, unknown>;
    if (typeof a.id !== "string" || !a.id) continue;
    out.push({
      id: a.id,
      name: typeof a.name === "string" ? a.name : a.id,
      adapterType: typeof a.adapterType === "string" ? a.adapterType : "",
      defaultEnvironmentId: typeof a.defaultEnvironmentId === "string" ? a.defaultEnvironmentId : null,
      status: typeof a.status === "string" ? a.status : undefined,
    });
  }
  return out;
}

/** A task assignment for one request: the organization's router, the engine's agents, and its issues. */
function assignerFor(ctx: FeatureCtx, s: Session, jev: JevSettings): TaskAssigner {
  const gw = ctx.gateway;
  if (!gw) throw new HttpError(503, "engine_unavailable", "The engine isn't set up on this host.");
  const orgRouter = createOrgRouter(ctx.state, jev);
  const issueBase = (companyId: string) => `/api/companies/${encodeURIComponent(companyId)}/issues`;
  return createTaskAssigner({
    route: (c, task) => orgRouter.route(c, task),
    next: (c, current, report) => orgRouter.next(c, current, report),
    agents: (c) => engineAgents(gw, s, c),
    tierAgents: (c) => getTierAgents(ctx.state, c),
    issues: {
      async create(companyId, draft): Promise<IssueRef> {
        const issue = await gw.userJson<{ id?: unknown; identifier?: unknown }>(s, "POST", issueBase(companyId), draft);
        if (!issue || typeof issue.id !== "string") throw new HttpError(502, "engine_error", "The engine created the task but didn't return its id.");
        return { id: issue.id, identifier: typeof issue.identifier === "string" ? issue.identifier : null };
      },
      async reassign(issueId, agentId) {
        await gw.userJson(s, "PATCH", `/api/issues/${encodeURIComponent(issueId)}`, { assigneeAgentId: agentId });
      },
    },
    record: (rec) => { recordDecision(ctx.state, rec.companyId, rec); },
    decision: (c, id) => getDecision(ctx.state, c, id),
    now: ctx.now,
    newId: newDecisionId,
  });
}

export async function taskRouterRoutes(ctx: FeatureCtx): Promise<boolean> {
  const m = ctx.path.match(PATH);
  if (!m) return false;
  const [, companyId, what] = m;
  const E = ctx.HttpError;
  const s = ctx.session();
  if (s.apiToken) throw new E(403, "ticket_only", "Task routing is managed in the console by a signed-in person, not with an API token.");
  if (!COMPANY.test(companyId)) throw new E(400, "bad_request", "Unknown organization");
  const role = await membership(ctx.gateway, s, companyId);
  const jev = jevSettingsOf(ctx.state);
  const audit = (action: string) => { try { appendAudit(ctx.state, ctx.now, { actor: s.username, action, target: companyId }); } catch { /* best effort */ } };
  const change = () => {
    ctx.sameSite();
    if (role !== "admin") throw new E(403, "forbidden", "Only the organization's owners and admins can change task routing.");
  };
  try {
    if (what === "jev" && ctx.method === "GET") return ctx.json(200, { ...(await jev.view(companyId)), card: JEV_CARD }), true;
    if (what === "jev" && ctx.method === "PUT") {
      change();
      const b = await ctx.readJson();
      const view = await jev.update(companyId, b);
      audit(`task-router.jev.${view.enabled ? "on" : "off"}`);
      return ctx.json(200, view), true;
    }
    if (what === "jev/key" && ctx.method === "PUT") {
      change();
      const view = await jev.setKey(companyId, (await ctx.readJson()).apiKey);
      audit("task-router.jev.key-set");
      return ctx.json(200, view), true;
    }
    if (what === "jev/key" && ctx.method === "DELETE") {
      change();
      const view = await jev.removeKey(companyId);
      audit("task-router.jev.key-removed");
      return ctx.json(200, view), true;
    }
    if (what === "jev/test" && ctx.method === "POST") {
      change();
      return ctx.json(200, await jev.test(companyId)), true;
    }
    if (what === "table" && ctx.method === "GET") return ctx.json(200, { table: getTable(ctx.state, companyId) ?? DEFAULT_ROUTING_TABLE, isDefault: getTable(ctx.state, companyId) === undefined }), true;
    if (what === "table" && ctx.method === "PUT") {
      change();
      const table = saveTable(ctx.state, companyId, (await ctx.readJson()).table);
      audit("task-router.table-set");
      return ctx.json(200, { table, isDefault: false }), true;
    }
    if (what === "route" && ctx.method === "POST") {
      ctx.sameSite();
      const task = contractFrom(await ctx.readJson());
      const decision = await createOrgRouter(ctx.state, jev).route(companyId, task);
      const record = recordDecision(ctx.state, companyId, { id: newDecisionId(), companyId, at: ctx.now(), task, decision });
      return ctx.json(200, { decision, record: { id: record.id, at: record.at } }), true;
    }
    if (what === "assign" && ctx.method === "POST") {
      ctx.sameSite();
      const b = await ctx.readJson();
      if (b.createIssue !== undefined && typeof b.createIssue !== "boolean") throw new E(400, "bad_request", "createIssue must be true or false.");
      const result = await assignerFor(ctx, s, jev).assign(companyId, contractFrom(b), { createIssue: b.createIssue !== false });
      audit("task-router.assign");
      return ctx.json(200, { decision: result.decision, delegation: result.delegation, recordId: result.record.id, issueId: result.record.issueId ?? null }), true;
    }
    if (what === "agents" && ctx.method === "GET") {
      return ctx.json(200, { tierAgents: getTierAgents(ctx.state, companyId), agents: await engineAgents(ctx.gateway!, s, companyId) }), true;
    }
    if (what === "agents" && ctx.method === "PUT") {
      change();
      const b = await ctx.readJson();
      const tierAgents = saveTierAgents(ctx.state, companyId, b.tierAgents ?? b);
      audit("task-router.agents-set");
      return ctx.json(200, { tierAgents }), true;
    }
    if (what === "decisions" && ctx.method === "GET") {
      const limit = Number(ctx.url.searchParams.get("limit") ?? 50);
      return ctx.json(200, { decisions: listDecisions(ctx.state, companyId, limit) }), true;
    }
    if (DECISION_ONE.test(what) && ctx.method === "GET") {
      const rec = getDecision(ctx.state, companyId, what.slice("decisions/".length));
      if (!rec) throw new E(404, "not_found", "No such routing decision.");
      return ctx.json(200, { decision: rec }), true;
    }
    if (DECISION_REPORT.test(what) && ctx.method === "POST") {
      ctx.sameSite();
      const b = await ctx.readJson();
      if (b.status !== "ok" && b.status !== "escalate" && b.status !== "failed") throw new E(400, "bad_request", "status must be ok, escalate or failed.");
      if (b.note !== undefined && (typeof b.note !== "string" || b.note.length > 500)) throw new E(400, "bad_request", "note must be text, up to 500 characters.");
      const decisionId = what.slice("decisions/".length, -"/report".length);
      const result = await assignerFor(ctx, s, jev).report(companyId, decisionId, { status: b.status, ...(typeof b.note === "string" ? { note: b.note } : {}) });
      if (!result) throw new E(404, "not_found", "No such routing decision.");
      if (result.decision) audit("task-router.escalate");
      return ctx.json(200, { previous: result.previous, decision: result.decision, delegation: result.delegation, recordId: result.record.id }), true;
    }
  } catch (e) {
    if (e instanceof SettingsError) throw new E(e.status, e.status === 409 ? "conflict" : e.status === 502 ? "typesafe_error" : "bad_request", e.message);
    if (e instanceof RoutingTableError) throw new E(400, "bad_request", e.message);
    throw e;
  }
  throw new E(405, "method_not_allowed", "That method isn't supported here.");
}
