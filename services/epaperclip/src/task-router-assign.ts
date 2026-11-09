/**
 * Wiring a task into the engine (docs/CONNECTORS.md, "Task routing with Jev"). The router decides a tier and a target;
 * this module turns that into a real task assignment: it picks the organization's agent that runs the target adapter
 * (and, when it can, the target environment), creates the engine issue assigned to that agent, and keeps the decision
 * on this device. Escalation uses the router's own `next()` and moves the same issue up the chain.
 *
 * Nothing here calls TypeSafe: the provider (with its per-organization consent gate) lives in `task-router-jev.ts`.
 */
import type { RouteDecision, RunReport, TaskContract, Tier } from "@papercliped-engine/task-router";
import type { DecisionRecord, TierAgents } from "./task-router-jev.ts";

/** The engine fields this needs; anything else the engine returns is ignored. */
export interface EngineAgentView {
  id: string;
  name: string;
  adapterType: string;
  defaultEnvironmentId?: string | null;
  status?: string;
}

export interface IssueDraft {
  title: string;
  description: string;
  assigneeAgentId: string;
  status: "todo";
}
export interface IssueRef { id: string; identifier?: string | null }
export interface IssuePort {
  create(companyId: string, draft: IssueDraft): Promise<IssueRef>;
  /** Moves an existing issue to another agent when a run escalates. */
  reassign(issueId: string, agentId: string): Promise<void>;
}

export type DelegationStatus = "assigned" | "planned" | "unassigned";
export interface DelegationView {
  status: DelegationStatus;
  /** The agent the task was delegated to, if any. */
  agentId?: string;
  agentName?: string;
  /** The adapter the decision selected (from the organization's table). */
  adapterType: string;
  /** The agent's execution environment, when the engine reports one. */
  environmentId?: string | null;
  issueId?: string;
  /** Why no agent could take it, in words the console can show. */
  reason?: string;
}

export interface AssignmentView {
  decision: RouteDecision;
  delegation: DelegationView;
  record: DecisionRecord;
}

export interface EscalationView {
  previous: DecisionRecord;
  /** The next decision, or null at the end of the chain / after a success or plain failure. */
  decision: RouteDecision | null;
  delegation: DelegationView | null;
  record: DecisionRecord;
}

export interface TaskAssignerPorts {
  route(companyId: string, task: TaskContract): Promise<RouteDecision>;
  next(companyId: string, current: RouteDecision, report: RunReport): Promise<RouteDecision | null>;
  agents(companyId: string): Promise<EngineAgentView[]>;
  tierAgents(companyId: string): TierAgents;
  issues: IssuePort;
  record(record: DecisionRecord): void;
  decision(companyId: string, id: string): DecisionRecord | undefined;
  now(): number;
  newId(): string;
}

export interface TaskAssigner {
  assign(companyId: string, task: TaskContract, opts?: { createIssue?: boolean }): Promise<AssignmentView>;
  report(companyId: string, decisionId: string, report: RunReport): Promise<EscalationView | null>;
}

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

/** The issue title: the first meaningful line of the goal, bounded to what the engine accepts. */
export function titleOf(goal: string): string {
  const first = goal.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return (clean(first) || "Routed task").slice(0, 200);
}

/** What the assigned agent reads: the task as given, with the routing facts attached (never file contents). */
export function describeTask(task: TaskContract): string {
  const parts = [task.goal.trim()];
  if (task.filesAllowed.length) parts.push(`Files allowed: ${task.filesAllowed.join(", ")}`);
  if (task.expectedDiffLines !== undefined) parts.push(`Expected change: ${task.expectedDiffLines} line${task.expectedDiffLines === 1 ? "" : "s"}`);
  if (task.testCommand) parts.push(`Test: ${task.testCommand}`);
  if (task.riskTags?.length) parts.push(`Risk tags: ${task.riskTags.join(", ")}`);
  return parts.join("\n\n").slice(0, 8000);
}

const envScore = (a: EngineAgentView, environment: string | undefined) => (environment && a.defaultEnvironmentId === environment ? 1 : 0);

/**
 * Picks one agent, deterministically: an explicit tier -> agent mapping wins; otherwise agents whose adapter matches
 * the decision's target, preferring one already in the target environment, then by name and id. A terminated agent is
 * never chosen. No match is reported, not guessed.
 */
export function chooseAgent(agents: EngineAgentView[], target: { adapterType: string; environment?: string }, mapped?: string): { agent?: EngineAgentView; reason?: string } {
  const usable = agents.filter((a) => a.status !== "terminated");
  if (mapped) {
    const hit = usable.find((a) => a.id === mapped);
    return hit ? { agent: hit } : { reason: `This organization maps that tier to agent ${mapped}, but the engine has no such active agent.` };
  }
  const matches = usable
    .filter((a) => a.adapterType === target.adapterType)
    .sort((a, b) => envScore(b, target.environment) - envScore(a, target.environment) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  if (matches.length) return { agent: matches[0]! };
  return { reason: `No active agent in this organization runs the "${target.adapterType}" adapter${target.environment ? ` in environment "${target.environment}"` : ""}.` };
}

function delegationFor(pick: { agent?: EngineAgentView; reason?: string }, target: { adapterType: string }, status: DelegationStatus): DelegationView {
  return pick.agent
    ? { status, agentId: pick.agent.id, agentName: pick.agent.name, adapterType: target.adapterType, environmentId: pick.agent.defaultEnvironmentId ?? null }
    : { status: "unassigned", adapterType: target.adapterType, reason: pick.reason ?? "No agent could take this task." };
}

export function createTaskAssigner(ports: TaskAssignerPorts): TaskAssigner {
  return {
    async assign(companyId, task, opts = {}) {
      const decision = await ports.route(companyId, task);
      const pick = chooseAgent(await ports.agents(companyId), decision.target, ports.tierAgents(companyId)[decision.tier as Tier]);
      const planned = opts.createIssue === false;
      const record: DecisionRecord = {
        id: ports.newId(), companyId, at: ports.now(), task, decision,
        agentId: pick.agent?.id ?? null, environmentId: pick.agent?.defaultEnvironmentId ?? null,
      };
      let delegation = delegationFor(pick, decision.target, planned ? "planned" : "assigned");
      const keep = () => {
        record.delegationStatus = delegation.status;
        if (delegation.reason) record.delegationReason = delegation.reason;
        return ports.record(record);
      };

      // The decision is written before the engine is touched, so a failed delegation is still auditable.
      keep();
      if (pick.agent && !planned) {
        try {
          const issue = await ports.issues.create(companyId, { title: titleOf(task.goal), description: describeTask(task), assigneeAgentId: pick.agent.id, status: "todo" });
          record.issueId = issue.id;
          delegation = { ...delegation, issueId: issue.id };
          keep();
        } catch (e) {
          record.delegationError = (e as Error).message;
          delegation = { status: "unassigned", adapterType: decision.target.adapterType, reason: `The engine didn't create the task: ${(e as Error).message}` };
          keep();
          throw e;
        }
      }
      return { decision, delegation, record };
    },

    async report(companyId, decisionId, report) {
      const current = ports.decision(companyId, decisionId);
      if (!current) return null;
      const at = ports.now();
      // A decision is reported once. Replaying a report must not spend more money or move the issue twice.
      if (current.escalation) return { previous: current, decision: null, delegation: null, record: current };

      const previous: DecisionRecord = { ...current, escalation: { status: report.status, ...(report.note ? { note: report.note } : {}), at } };
      ports.record(previous);
      if (report.status !== "escalate") return { previous, decision: null, delegation: null, record: previous };

      const next = await ports.next(companyId, current.decision, report);
      if (!next) return { previous, decision: null, delegation: null, record: previous };

      const pick = chooseAgent(await ports.agents(companyId), next.target, ports.tierAgents(companyId)[next.tier as Tier]);
      const record: DecisionRecord = {
        id: ports.newId(), companyId, at, task: current.task, decision: next, previousId: current.id,
        issueId: current.issueId, agentId: pick.agent?.id ?? null, environmentId: pick.agent?.defaultEnvironmentId ?? null,
      };
      let delegation = delegationFor(pick, next.target, pick.agent ? (current.issueId ? "assigned" : "planned") : "unassigned");
      const keep = () => {
        record.delegationStatus = delegation.status;
        if (delegation.reason) record.delegationReason = delegation.reason;
        return ports.record(record);
      };
      keep();

      // The same task moves to the next tier's agent; a missing mapping leaves the old assignee, and says so.
      if (current.issueId && pick.agent) {
        try {
          await ports.issues.reassign(current.issueId, pick.agent.id);
          delegation = { ...delegation, issueId: current.issueId };
          keep();
        } catch (e) {
          record.delegationError = (e as Error).message;
          delegation = { status: "unassigned", adapterType: next.target.adapterType, reason: `The engine didn't move the task: ${(e as Error).message}` };
          keep();
        }
      }
      return { previous, decision: next, delegation, record };
    },
  };
}
