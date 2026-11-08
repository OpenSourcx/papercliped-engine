import { HttpError } from "./http.ts";
import type { EngineCall } from "./pin-apps.ts";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const enc = encodeURIComponent;
const prefix = (connectionId: string) => `ePaperclip app:${connectionId}:`;
interface Policy { id: string; name: string; policyType: string; priority: number; enabled: boolean; selectors: Record<string, unknown>; conditions?: unknown; config?: { source?: string; connectionId?: string; catalogEntryId?: string } | null }
interface Profile { profileKey: string; defaultAction: string; entries: { selectorType: string; effect: string; catalogEntryId?: string; conditions?: unknown }[]; bindings: { targetType: string; targetId: string }[] }
interface Agent { id: string; name: string; status: string; adapterType?: string; adapterConfig?: { url?: string } }
interface Catalog { id: string; status: string }
interface Choices { preserveExistingAccess: false; access: "all_agents" | { agentIds: string[] }; enabledCatalogEntryIds: string[]; askFirstCatalogEntryIds: string[]; reviewedCatalogEntryIds: string[] }

const bad = (message: string): never => { throw new HttpError(400, "bad_request", message); };
const advanced = (): never => { throw new HttpError(409, "advanced_access", "This app has tool access rules this editor cannot preserve. Manage those rules in the engine before saving here."); };
function choices(raw: Record<string, unknown>): Choices {
  if (Object.keys(raw).some((k) => !["preserveExistingAccess", "access", "enabledCatalogEntryIds", "askFirstCatalogEntryIds", "reviewedCatalogEntryIds"].includes(k)) || raw.preserveExistingAccess !== false) bad("Send the complete reviewed access choices.");
  const ids = (v: unknown, max: number): string[] => {
    if (!Array.isArray(v) || v.length > max || v.some((id) => typeof id !== "string" || !ID.test(id))) return bad("Invalid access choices.");
    return [...new Set((v as string[]).map((id) => id.toLowerCase()))];
  };
  const access = raw.access === "all_agents" ? "all_agents" : raw.access && typeof raw.access === "object" && !Array.isArray(raw.access) && Object.keys(raw.access).length === 1 ? { agentIds: ids((raw.access as { agentIds?: unknown }).agentIds, 250) } : bad("Choose the agents that may use this app.");
  const enabledCatalogEntryIds = ids(raw.enabledCatalogEntryIds, 500);
  const askFirstCatalogEntryIds = ids(raw.askFirstCatalogEntryIds, 500);
  if (askFirstCatalogEntryIds.some((id) => !enabledCatalogEntryIds.includes(id))) bad("An approval action must also be enabled.");
  return { preserveExistingAccess: false, access, enabledCatalogEntryIds, askFirstCatalogEntryIds, reviewedCatalogEntryIds: ids(raw.reviewedCatalogEntryIds ?? [], 500) };
}
function concerns(p: Policy, connectionId: string): boolean {
  const s = p.selectors;
  if (typeof s.connectionId === "string" && s.connectionId !== connectionId) return false;
  if (Array.isArray(s.connectionIds) && s.connectionIds.length && !s.connectionIds.includes(connectionId)) return false;
  return true; // A broad or unfamiliar selector may affect this app; never silently override it.
}
function simpleProfile(p: Profile | undefined) {
  if (p && (p.defaultAction !== "deny" || p.bindings.some((b) => !["company", "agent"].includes(b.targetType)) || p.entries.some((e) => e.selectorType !== "catalog_entry" || e.effect !== "include" || !e.catalogEntryId || e.conditions))) advanced();
}
function pinPolicy(p: Policy, agents: Agent[]): boolean {
  // Pin is deliberately separate: its own allow/ask (100) and default block (1000) precede the app editor (2000/3000).
  const a = agents.find((a) => a.id === p.selectors.agentId && a.name === "Pin (host)" && a.status === "paused" && a.adapterType === "http" && a.adapterConfig?.url === "http://127.0.0.1:9/pin-host-identity-never-runs");
  if (!a || !p.name.startsWith("Pin (host): ") || p.conditions) return false;
  if (p.name === "Pin (host): default deny") return p.policyType === "block" && p.priority === 1000 && Object.keys(p.selectors).length === 1;
  return ["allow", "require_approval"].includes(p.policyType) && p.priority === 100 && typeof p.selectors.connectionId === "string" && typeof p.selectors.catalogEntryId === "string" && Object.keys(p.selectors).length === 3;
}
function owned(p: Policy, connectionId: string): boolean {
  if (!p.name.startsWith(prefix(connectionId))) return false;
  const kind = p.name.slice(prefix(connectionId).length);
  const s = p.selectors;
  const keys = Object.keys(s);
  const base = s.connectionId === connectionId && !p.conditions && !p.config;
  if (kind === "saving" || kind === "default") return base && keys.length === 1 && p.policyType === "block" && p.priority === (kind === "saving" ? 0 : 3000);
  const m = kind.match(/^(allow|ask):([A-Za-z0-9_-]{1,64})$/);
  return !!m && base && p.priority === 2000 && p.policyType === (m[1] === "ask" ? "require_approval" : "allow") && s.catalogEntryId === m[2] && keys.every((k) => ["connectionId", "catalogEntryId", "agentIds"].includes(k)) && (s.agentIds === undefined || Array.isArray(s.agentIds) && s.agentIds.length > 0 && s.agentIds.every((id) => typeof id === "string" && ID.test(id)));
}

/** One writer per connection on this host. The durable engine block also survives a failed request or host restart. */
export class AppAccessManager {
  private readonly flights = new Map<string, Promise<unknown>>();
  async save(call: EngineCall, companyId: string, connectionId: string, raw: Record<string, unknown>): Promise<unknown> {
    if (!ID.test(companyId) || !ID.test(connectionId)) bad("Invalid organization or connection.");
    companyId = companyId.toLowerCase(); connectionId = connectionId.toLowerCase();
    const input = choices(raw);
    const key = `${companyId}/${connectionId}`;
    const prior = this.flights.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this.replace(call, companyId, connectionId, input));
    this.flights.set(key, next);
    try { return await next; } finally { if (this.flights.get(key) === next) this.flights.delete(key); }
  }
  private async replace(call: EngineCall, companyId: string, connectionId: string, input: Choices): Promise<unknown> {
    const root = `/api/companies/${enc(companyId)}/tools`;
    const connection = await call("GET", `/api/tool-connections/${enc(connectionId)}`) as { companyId?: string };
    if (connection?.companyId !== companyId) throw new HttpError(404, "not_found", "That app is not in this organization.");
    const [catalog, profiles, policies, agents] = await Promise.all([
      call("GET", `/api/tool-connections/${enc(connectionId)}/catalog`) as Promise<{ catalog: Catalog[] }>,
      call("GET", `${root}/profiles`) as Promise<{ profiles: Profile[] }>,
      call("GET", `${root}/policies`) as Promise<{ policies: Policy[] }>,
      call("GET", `/api/companies/${enc(companyId)}/agents`) as Promise<Agent[]>,
    ]);
    simpleProfile(profiles.profiles.find((p) => p.profileKey === `app:${connectionId}`));
    for (const id of [...input.enabledCatalogEntryIds, ...input.reviewedCatalogEntryIds]) {
      const entry = catalog.catalog.find((c) => c.id === id);
      if (!entry || entry.status === "disabled" || entry.status === "removed") return bad("An action is no longer available. Refresh the actions before saving.");
      if (input.enabledCatalogEntryIds.includes(id) && entry.status === "quarantined" && !input.reviewedCatalogEntryIds.includes(id)) bad("Review changed actions before enabling them.");
    }
    if (input.access !== "all_agents" && input.access.agentIds.some((id) => !agents.some((a) => a.id === id && a.name !== "Pin (host)"))) bad("Choose organization agents. Pin has its own access settings.");
    const mine = policies.policies.filter((p) => owned(p, connectionId));
    for (const p of policies.policies) {
      if (!p.enabled || !concerns(p, connectionId) || mine.includes(p) || pinPolicy(p, agents)) continue;
      if (p.policyType === "require_approval" && p.config?.source === "app_gallery_finish" && p.config.connectionId === connectionId && !p.conditions) continue;
      advanced();
    }
    const policyRoot = `${root}/policies`;
    const make = (name: string, policyType: string, priority: number, selectors: Record<string, unknown>) => call("POST", policyRoot, { name: prefix(connectionId) + name, policyType, priority, enabled: true, selectors, description: "Managed by ePaperclip organization app access." });
    // Refuse all calls while replacing several native rows. On any error leave this persisted block and report failure;
    // a retry rebuilds the complete selection, then removes the block last. Never report a partial save as success.
    let barrier = mine.find((p) => p.name === prefix(connectionId) + "saving");
    if (barrier) await call("PATCH", `${policyRoot}/${enc(barrier.id)}`, { enabled: true });
    else barrier = await make("saving", "block", 0, { connectionId }) as Policy;
    try {
      // Keep native ask rules until the replacement is complete. They are a durable record for reopen-and-retry if a
      // later API call fails. Removing them early would make the editor mistake an unfinished Ask choice for Allow.
      const result = await call("POST", `${root}/apps/${enc(connectionId)}/finish`, input);
      for (const p of mine) if (p.id !== barrier.id) await call("DELETE", `${policyRoot}/${enc(p.id)}`);
      await make("default", "block", 3000, { connectionId });
      if (input.access === "all_agents" || input.access.agentIds.length) {
        for (const catalogEntryId of input.enabledCatalogEntryIds) {
          const ask = input.askFirstCatalogEntryIds.includes(catalogEntryId);
          await make(`${ask ? "ask" : "allow"}:${catalogEntryId}`, ask ? "require_approval" : "allow", 2000, { connectionId, catalogEntryId, ...(input.access === "all_agents" ? {} : { agentIds: input.access.agentIds }) });
        }
      }
      // Native asks precede Pin's policies when a company-wide profile matches. Only remove them once every scoped
      // replacement exists, still behind the barrier, so Pin retains its independently chosen permissions.
      const updated = await call("GET", policyRoot) as { policies: Policy[] };
      for (const p of updated.policies) if (p.config?.source === "app_gallery_finish" && p.config.connectionId === connectionId) await call("DELETE", `${policyRoot}/${enc(p.id)}`);
      await call("DELETE", `${policyRoot}/${enc(barrier.id)}`);
      return result;
    } catch {
      throw new HttpError(503, "app_access_incomplete", "Access could not be saved completely. This app remains blocked, including for Pin. Save access again to finish safely.");
    }
  }
}
