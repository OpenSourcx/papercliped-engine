import type { Agent } from "./types.ts";

/** True if making `agentId` report to `managerId` would create a reporting loop (or self-reporting). */
export function wouldLoop(agents: Pick<Agent, "id" | "reportsTo">[], agentId: string, managerId: string | null): boolean {
  const seen = new Set<string>();
  for (let cur = managerId; cur;) {
    if (cur === agentId || seen.has(cur)) return true;
    seen.add(cur);
    cur = agents.find((a) => a.id === cur)?.reportsTo ?? null;
  }
  return false;
}

/** Include an entry point for disconnected cycles so damaged hierarchies remain repairable. */
export function forestRoots<T extends Pick<Agent, "id" | "reportsTo">>(agents: T[]): T[] {
  const ids = new Set(agents.map((agent) => agent.id));
  const roots = agents.filter((agent) => !agent.reportsTo || !ids.has(agent.reportsTo));
  const visited = new Set<string>();
  const visit = (root: T) => {
    const pending = [root];
    while (pending.length) {
      const agent = pending.pop()!;
      if (visited.has(agent.id)) continue;
      visited.add(agent.id);
      pending.push(...agents.filter((child) => child.reportsTo === agent.id));
    }
  };
  roots.forEach(visit);
  for (const agent of agents) if (!visited.has(agent.id)) { roots.push(agent); visit(agent); }
  return roots;
}
