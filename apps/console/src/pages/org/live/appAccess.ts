import type { ToolPolicy, ToolProfileWithDetails } from "@papercliped-engine/engine-client";

/** What the app gallery's own finish step wrote for one connection, read back so reopening Agent access starts from it. */
export interface AppAccess {
  /** True when a company-wide binding exists: every agent, including future ones. */
  allAgents: boolean;
  agentIds: string[];
  enabled: string[];
  askFirst: string[];
  /** Set when the grants use anything the simple editor cannot round-trip (other selectors, conditions, exclusions, other binding targets). Saving would erase them, so the editor must not save. */
  advanced: string | null;
  saving: boolean;
  /** The host's default-deny rule for this connection exists, so Off, excluded agents and new actions are really refused. Connections set up before this was added are not enforced until an administrator saves their access. */
  enforced: boolean;
}

/** Reads the gallery-managed profile `app:<connectionId>` and its managed ask-first policies. Absent profile means no access yet. */
export function readAppAccess(connectionId: string, profiles: ToolProfileWithDetails[], policies: ToolPolicy[]): AppAccess {
  const out: AppAccess = { allAgents: false, agentIds: [], enabled: [], askFirst: [], advanced: null, saving: false, enforced: false };
  const profile = profiles.find((p) => p.profileKey === `app:${connectionId}`);
  if (profile) {
    for (const b of profile.bindings) {
      if (b.targetType === "company") out.allAgents = true;
      else if (b.targetType === "agent") out.agentIds.push(b.targetId);
      else out.advanced ??= `a ${b.targetType} binding`;
    }
    for (const e of profile.entries) {
      if (e.selectorType === "catalog_entry" && e.effect === "include" && e.catalogEntryId && !e.conditions) out.enabled.push(e.catalogEntryId);
      else out.advanced ??= `a ${e.effect} rule on ${e.selectorType.replace("_", " ")}`;
    }
    if (profile.defaultAction !== "deny") out.advanced ??= "a non-default profile action";
  }
  for (const p of policies) {
    if (p.enabled && p.name === `ePaperclip app:${connectionId}:saving`) out.saving = true;
    if (p.enabled && p.policyType === "block" && p.name === `ePaperclip app:${connectionId}:default`) out.enforced = true;
    if (p.enabled && p.policyType === "require_approval" && typeof p.selectors?.catalogEntryId === "string" && p.name === `ePaperclip app:${connectionId}:ask:${p.selectors.catalogEntryId}` && p.selectors.connectionId === connectionId && typeof p.selectors.catalogEntryId === "string") out.askFirst.push(p.selectors.catalogEntryId);
    const selectors = p.selectors ?? {};
    const otherConnection = typeof selectors.connectionId === "string" && selectors.connectionId !== connectionId || Array.isArray(selectors.connectionIds) && selectors.connectionIds.length > 0 && !selectors.connectionIds.includes(connectionId);
    const nativeAsk = p.policyType === "require_approval" && (p.config as { source?: string; connectionId?: string } | null)?.source === "app_gallery_finish" && (p.config as { connectionId?: string }).connectionId === connectionId;
    if (p.enabled && !otherConnection && !nativeAsk && !p.name?.startsWith(`ePaperclip app:${connectionId}:`) && !p.name?.startsWith("Pin (host): ")) out.advanced ??= "a custom tool policy";
    const c = p.config as { source?: string; connectionId?: string; catalogEntryId?: string } | null;
    if (!p.enabled || p.policyType !== "require_approval" || c?.source !== "app_gallery_finish" || c.connectionId !== connectionId) continue;
    if (c.catalogEntryId) out.askFirst.push(c.catalogEntryId);
  }
  out.askFirst = [...new Set(out.askFirst)].filter((id) => out.enabled.includes(id));
  return out;
}

/** Connections (ids) whose Off is enforced, from the company's policies. */
export function enforcedConnections(policies: ToolPolicy[]): Set<string> {
  const out = new Set<string>();
  for (const p of policies) {
    const m = /^ePaperclip app:([A-Za-z0-9_-]{1,64}):default$/.exec(p.name ?? "");
    if (m && p.enabled && p.policyType === "block" && (p.selectors as { connectionId?: unknown } | null)?.connectionId === m[1]) out.add(m[1]!);
  }
  return out;
}
