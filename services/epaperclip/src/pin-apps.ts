import { HttpError } from "./http.ts";
import type { StateStore } from "./state.ts";

/**
 * Pin's execution identity for organization apps (Option A).
 *
 * Pin lives on the host and is not an engine agent. To use an organization's connected apps it borrows one engine agent
 * per organization, "Pin (host)", that exists only as a subject for the engine's own tool policy. The agent is left
 * paused, so the engine will never wake it, start a run for it or give it a container: it consumes none of the
 * organization's allocation. Pin calls the engine's board-user test-call route as the signed-in person, naming that agent:
 *
 *   POST /api/tool-connections/{id}/test-calls { agentId, toolName, parameters }
 *
 * and the engine decides, with its own authorization, tool policy and approval path (verified against 2026.1023.0 in
 * docs/PIN-APP-EXECUTION.md):
 *   - the person needs tools:use (or manage_connections) in that organization and tasks:assign over the agent;
 *   - the agent must belong to the connection's organization (another organization's agent is refused);
 *   - allow executes at once, require_approval returns an action request that a person approves in the engine (and the
 *     engine then runs it), block refuses.
 *
 * New engine agents get an unscoped tools:use grant by default, which the engine treats as "allowed", so an Off in the
 * generic app-access editor would not stop them. Pin's identity is therefore governed by policies this class owns instead:
 * `allow` and `require_approval` policies for the actions an administrator chose, and one `block` for everything else of
 * the identity. A new action, a revoked action or an unknown tool is refused by default.
 */

export type EngineCall = (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) => Promise<unknown>;
export type PinAppMode = "off" | "ask" | "allow";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const IDENTITY_NAME = "Pin (host)";
const POLICY_PREFIX = "Pin (host): ";
const DEFAULT_DENY = `${POLICY_PREFIX}default deny`;
const SETTING = "pin.appIdentities";
const MAX_RESULT = 4000;

interface Policy { id: string; name: string; policyType: string; enabled: boolean; selectors: Record<string, unknown> }
const enc = encodeURIComponent;

const idOf = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !ID.test(v)) throw new HttpError(400, "bad_request", `${what} isn't valid`);
  return v;
};

export type CallOutcome =
  | { outcome: "done"; result: string }
  | { outcome: "approval_required"; actionRequestId: string; message: string }
  | { outcome: "denied"; message: string };

export class PinApps {
  private readonly state: StateStore;
  constructor(state: StateStore) {
    this.state = state;
  }

  private ids(): Record<string, string> {
    return this.state.getSetting<Record<string, string>>(SETTING) ?? {};
  }

  /** The identity recorded for an organization, checked against the engine on every use. */
  private async verified(call: EngineCall, companyId: string): Promise<string | null> {
    const agentId = this.ids()[companyId];
    if (!agentId) return null;
    const a = (await call("GET", `/api/agents/${enc(agentId)}`).catch(() => null)) as { id?: string; companyId?: string; status?: string; name?: string } | null;
    if (!a || a.id !== agentId || a.companyId !== companyId || a.status === "terminated") return null;
    return agentId;
  }

  /** Creates (once) the paused identity agent for an organization and its default-deny policy. */
  async enable(call: EngineCall, companyId: string): Promise<{ agentId: string }> {
    idOf(companyId, "companyId");
    let agentId = await this.verified(call, companyId);
    if (!agentId) {
      const made = (await call("POST", `/api/companies/${enc(companyId)}/agents`, {
        name: IDENTITY_NAME,
        role: "general",
        adapterType: "http",
        // Never called: the agent stays paused, so nothing runs. A closed loopback port keeps it harmless if someone resumes it.
        adapterConfig: { url: "http://127.0.0.1:9/pin-host-identity-never-runs" },
        runtimeConfig: { heartbeat: { enabled: false } },
      })) as { id?: string; status?: string };
      if (!made?.id) throw new HttpError(502, "engine_error", "The engine did not create Pin's identity.");
      agentId = made.id;
      const me = this.ids();
      me[companyId] = agentId;
      this.state.setSetting(SETTING, me);
    }
    // Default deny first, before anything can be allowed.
    await this.ensureDefaultDeny(call, companyId, agentId);
    return { agentId };
  }

  private async managed(call: EngineCall, companyId: string, agentId: string): Promise<Policy[]> {
    const r = (await call("GET", `/api/companies/${enc(companyId)}/tools/policies`)) as { policies?: Policy[] };
    return (r.policies ?? []).filter((p) => p.name.startsWith(POLICY_PREFIX) && p.selectors?.agentId === agentId);
  }

  private async ensureDefaultDeny(call: EngineCall, companyId: string, agentId: string): Promise<void> {
    const have = (await this.managed(call, companyId, agentId)).find((p) => p.name === DEFAULT_DENY);
    if (have && have.enabled && have.policyType === "block") return;
    if (have) await call("DELETE", `/api/companies/${enc(companyId)}/tools/policies/${enc(have.id)}`);
    await call("POST", `/api/companies/${enc(companyId)}/tools/policies`, { name: DEFAULT_DENY, description: "Managed by ePaperclip. Pin (host) may use nothing that is not explicitly allowed.", policyType: "block", priority: 1000, enabled: true, selectors: { agentId } });
  }

  /** What Pin may do now: one entry per action an administrator allowed or set to ask. */
  async access(call: EngineCall, companyId: string): Promise<{ enabled: boolean; agentId: string | null; entries: { connectionId: string; catalogEntryId: string; mode: "ask" | "allow" }[] }> {
    idOf(companyId, "companyId");
    const agentId = await this.verified(call, companyId);
    if (!agentId) return { enabled: false, agentId: null, entries: [] };
    const entries: { connectionId: string; catalogEntryId: string; mode: "ask" | "allow" }[] = [];
    for (const p of await this.managed(call, companyId, agentId)) {
      const catalogEntryId = p.selectors.catalogEntryId;
      const connectionId = p.selectors.connectionId;
      if (!p.enabled || typeof catalogEntryId !== "string" || typeof connectionId !== "string") continue;
      if (p.policyType === "allow") entries.push({ connectionId, catalogEntryId, mode: "allow" });
      else if (p.policyType === "require_approval") entries.push({ connectionId, catalogEntryId, mode: "ask" });
    }
    return { enabled: true, agentId, entries };
  }

  /** Replaces what Pin may do for one connection. Off is the absence of a policy, so the default deny applies. */
  async setAccess(call: EngineCall, companyId: string, connectionId: string, choices: { catalogEntryId: string; mode: PinAppMode }[]): Promise<void> {
    idOf(companyId, "companyId"); idOf(connectionId, "connectionId");
    if (!Array.isArray(choices) || choices.length > 500) throw new HttpError(400, "bad_request", "Send up to 500 action choices");
    const conn = (await call("GET", `/api/tool-connections/${enc(connectionId)}`)) as { companyId?: string };
    if (conn?.companyId !== companyId) throw new HttpError(404, "not_found", "That connection isn't in this organization.");
    const { agentId } = await this.enable(call, companyId);
    // Only entries of this connection can be chosen.
    const catalog = ((await call("GET", `/api/tool-connections/${enc(connectionId)}/catalog`)) as { catalog?: { id: string; toolName: string; status: string }[] }).catalog ?? [];
    const known = new Map(catalog.map((c) => [c.id, c]));
    const want = new Map<string, "ask" | "allow">();
    for (const c of choices) {
      idOf(c?.catalogEntryId, "catalogEntryId");
      if (c.mode !== "off" && c.mode !== "ask" && c.mode !== "allow") throw new HttpError(400, "bad_request", "mode is off, ask or allow");
      const entry = known.get(c.catalogEntryId);
      if (!entry) throw new HttpError(400, "bad_request", "That action isn't in this connection's catalog.");
      if (c.mode !== "off" && entry.status === "disabled") throw new HttpError(400, "bad_request", `${entry.toolName} is unavailable at the provider.`);
      if (c.mode !== "off") want.set(c.catalogEntryId, c.mode);
    }
    // Remove what is no longer wanted first, so a downgrade from allow never leaves a window.
    const mine = (await this.managed(call, companyId, agentId)).filter((p) => p.selectors.connectionId === connectionId);
    for (const p of mine) {
      const id = p.selectors.catalogEntryId as string;
      const type = want.get(id) === "allow" ? "allow" : want.get(id) === "ask" ? "require_approval" : null;
      if (p.policyType !== type || !p.enabled) await call("DELETE", `/api/companies/${enc(companyId)}/tools/policies/${enc(p.id)}`);
    }
    const left = new Set((await this.managed(call, companyId, agentId)).filter((p) => p.selectors.connectionId === connectionId).map((p) => p.selectors.catalogEntryId));
    for (const [entryId, mode] of want) {
      if (left.has(entryId)) continue;
      await call("POST", `/api/companies/${enc(companyId)}/tools/policies`, {
        name: `${POLICY_PREFIX}${connectionId.slice(0, 8)} ${known.get(entryId)!.toolName} ${mode}`,
        description: "Managed by ePaperclip for Pin (host).",
        policyType: mode === "allow" ? "allow" : "require_approval",
        priority: 100,
        enabled: true,
        selectors: { agentId, connectionId, catalogEntryId: entryId },
      });
    }
  }

  /** Revokes everything: removes the identity's allow/ask policies and leaves default deny. */
  async revokeAll(call: EngineCall, companyId: string): Promise<void> {
    const agentId = await this.verified(call, companyId);
    if (!agentId) return;
    for (const p of await this.managed(call, companyId, agentId)) if (p.name !== DEFAULT_DENY) await call("DELETE", `/api/companies/${enc(companyId)}/tools/policies/${enc(p.id)}`);
  }

  /** One call, as the person, under Pin's identity. The engine decides; this never approves anything. */
  async callTool(call: EngineCall, companyId: string, connectionId: string, toolName: string, parameters: Record<string, unknown>): Promise<CallOutcome> {
    idOf(companyId, "companyId"); idOf(connectionId, "connectionId");
    if (typeof toolName !== "string" || !toolName || toolName.length > 200) throw new HttpError(400, "bad_request", "toolName isn't valid");
    const agentId = await this.verified(call, companyId);
    if (!agentId) throw new HttpError(403, "pin_not_enabled", "Pin has no access to apps in this organization. An organization administrator enables it in Organization apps.");
    const conn = (await call("GET", `/api/tool-connections/${enc(connectionId)}`)) as { companyId?: string };
    if (conn?.companyId !== companyId) throw new HttpError(404, "not_found", "That connection isn't in this organization.");
    const r = (await call("POST", `/api/tool-connections/${enc(connectionId)}/test-calls`, { agentId, toolName, parameters })) as { decision?: string; actionRequestId?: string; result?: { content?: unknown }; error?: { message?: string } };
    if (r.decision === "allowed") return { outcome: "done", result: summarize(r.result?.content) };
    if (r.decision === "ask_first" && typeof r.actionRequestId === "string") return { outcome: "approval_required", actionRequestId: r.actionRequestId, message: "This action needs approval. A person with access approves or declines it in the organization's approvals; Pin cannot." };
    return { outcome: "denied", message: r.error?.message ?? "The organization's policy does not allow Pin to do this." };
  }

  /** Where an approval-held call stands. Read only. */
  async callStatus(call: EngineCall, companyId: string, connectionId: string, actionRequestId: string): Promise<{ phase: string; result?: string }> {
    idOf(companyId, "companyId"); idOf(connectionId, "connectionId"); idOf(actionRequestId, "actionRequestId");
    const conn = (await call("GET", `/api/tool-connections/${enc(connectionId)}`)) as { companyId?: string };
    if (conn?.companyId !== companyId) throw new HttpError(404, "not_found", "That connection isn't in this organization.");
    const s = (await call("GET", `/api/tool-connections/${enc(connectionId)}/test-calls/${enc(actionRequestId)}`)) as { phase?: string; result?: { content?: unknown } };
    return { phase: typeof s.phase === "string" ? s.phase : "unknown", ...(s.result ? { result: summarize(s.result.content) } : {}) };
  }
}

const summarize = (content: unknown): string => (typeof content === "string" ? content : JSON.stringify(content ?? "")).slice(0, MAX_RESULT);
