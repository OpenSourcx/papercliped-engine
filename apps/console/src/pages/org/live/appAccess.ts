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
}

/** Reads the gallery-managed profile `app:<connectionId>` and its managed ask-first policies. Absent profile means no access yet. */
export function readAppAccess(connectionId: string, profiles: ToolProfileWithDetails[], policies: ToolPolicy[]): AppAccess {
  const out: AppAccess = { allAgents: false, agentIds: [], enabled: [], askFirst: [], advanced: null };
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
    const c = p.config as { source?: string; connectionId?: string; catalogEntryId?: string } | null;
    if (!p.enabled || p.policyType !== "require_approval" || c?.source !== "app_gallery_finish" || c.connectionId !== connectionId) continue;
    if (c.catalogEntryId) out.askFirst.push(c.catalogEntryId);
  }
  return out;
}
