import { RoutingTableError, DEFAULT_ROUTING_TABLE, type TaskContract } from "@papercliped-engine/task-router";
import type { EngineGateway } from "../engine.ts";
import { HttpError } from "../http.ts";
import type { Session } from "../sessions.ts";
import { createJevSettings, createOrgRouter, JEV_CARD, getTable, saveTable, SettingsError, stateJevPorts, type JevSettings } from "../task-router-jev.ts";
import type { StateStore } from "../state.ts";
import { appendAudit } from "./access-tokens.ts";
import type { FeatureCtx } from "./index.ts";

/**
 * Task routing for an organization (docs/CONNECTORS.md, "Task routing with Jev"). Reading is for the organization's
 * members; changing anything is for its owners and admins. The TypeSafe key is write-only: it is sealed in the vault
 * and never returned.
 *
 *   GET    /api/task-router/orgs/:id/jev           { enabled, hasKey, consentSendTaskText, active, disclosure, card }
 *   PUT    /api/task-router/orgs/:id/jev           { enabled?, consentSendTaskText? }
 *   PUT    /api/task-router/orgs/:id/jev/key       { apiKey }
 *   DELETE /api/task-router/orgs/:id/jev/key
 *   POST   /api/task-router/orgs/:id/jev/test      one fixed question, no task text
 *   GET|PUT /api/task-router/orgs/:id/table        the organization's routing table
 *   POST   /api/task-router/orgs/:id/route         { goal, filesAllowed, ... } -> the decision
 */

const COMPANY = /^[A-Za-z0-9_-]{1,64}$/;
const PATH = /^\/api\/task-router\/orgs\/([A-Za-z0-9_-]{1,64})\/(jev|jev\/key|jev\/test|table|route)$/;

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
      return ctx.json(200, { decision: await createOrgRouter(ctx.state, jev).route(companyId, contractFrom(await ctx.readJson())) }), true;
    }
  } catch (e) {
    if (e instanceof SettingsError) throw new E(e.status, e.status === 409 ? "conflict" : e.status === 502 ? "typesafe_error" : "bad_request", e.message);
    if (e instanceof RoutingTableError) throw new E(400, "bad_request", e.message);
    throw e;
  }
  throw new E(405, "method_not_allowed", "That method isn't supported here.");
}
