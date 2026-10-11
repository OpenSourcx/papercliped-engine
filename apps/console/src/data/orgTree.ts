import type { Agent } from "./types.ts";

/** True if making `agentId` report to `managerId` would create a reporting loop (or self-reporting). */
export function wouldLoop(agents: Pick<Agent, "id" | "reportsTo">[], agentId: string, managerId: string | null): boolean {
  for (let cur = managerId, guard = 0; cur && guard < 1000; guard++) {
    if (cur === agentId) return true;
    cur = agents.find((a) => a.id === cur)?.reportsTo ?? null;
  }
  return false;
}
