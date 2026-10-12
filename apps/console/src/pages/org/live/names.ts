import { useMemo } from "react";
import type { ActivityEntry, Agent } from "@papercliped-engine/engine-client";
import { AGENT_ROLE_LABEL } from "../../../data/engine/map.ts";
import { useAgents, useMe, useMembers } from "../../../data/engine/queries.ts";

/** Turns the engine's ids into names: agents by name, people by name (you as "You"). */
export function useNames(companyId: string) {
  const agents = useAgents(companyId);
  const members = useMembers(companyId);
  const me = useMe();
  return useMemo(() => {
    const byId = new Map((agents.data ?? []).map((a) => [a.id, a]));
    const people = new Map((members.data?.members ?? []).map((m) => [m.principalId, m.user?.name || m.user?.email || "Someone"]));
    const user = (id: string | null | undefined) => (!id ? "Someone" : id === me.data?.userId ? "You" : people.get(id) ?? "Someone");
    return {
      agent: (id: string | null | undefined) => (id ? byId.get(id)?.name ?? "An agent" : "Unassigned"),
      user,
      role: (a: Pick<Agent, "title" | "role">) => a.title || AGENT_ROLE_LABEL[a.role] || a.role,
      actor: (e: Pick<ActivityEntry, "actorType" | "actorId">) => (e.actorType === "agent" ? byId.get(e.actorId)?.name ?? "An agent" : e.actorType === "user" ? user(e.actorId) : e.actorType === "plugin" ? "A plugin" : "The engine"),
    };
  }, [agents.data, members.data, me.data]);
}

/** "created ACME-4", "approved a hire": the engine's action codes in plain words. */
export function describeActivity(e: Pick<ActivityEntry, "action" | "entityType" | "details">): string {
  const d = (e.details ?? {}) as Record<string, unknown>;
  const ref = (typeof d.identifier === "string" && d.identifier) || (typeof d.issueIdentifier === "string" && d.issueIdentifier) || (typeof d.title === "string" && `"${d.title}"`) || (typeof d.name === "string" && d.name) || null;
  const [, verb = e.action] = e.action.split(".");
  const thing = { issue: "a task", agent: "an agent", approval: "a decision", goal: "a goal", project: "a project", company: "the organization", comment: "a comment" }[e.entityType] ?? e.entityType.replace(/_/g, " ");
  const words: Record<string, string> = { created: "created", updated: "updated", deleted: "deleted", commented: "commented on", comment_added: "commented on", approved: "approved", rejected: "rejected", paused: "paused", resumed: "resumed", hired: "hired", terminated: "terminated", checked_out: "picked up", released: "released", status_changed: "changed the status of", assigned: "assigned" };
  const said = words[verb] ?? verb.replace(/_/g, " ");
  return `${said} ${ref ?? thing}`;
}
