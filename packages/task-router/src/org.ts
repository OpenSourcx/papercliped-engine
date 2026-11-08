import { createTaskRouter } from "./router.ts";
import { DEFAULT_ROUTING_TABLE, parseRoutingTable, type RoutingTable } from "./table.ts";
import type { JevSettings } from "./settings.ts";
import type { RouteDecision, RunReport, TaskContract } from "./types.ts";

export interface TableStore { get(companyId: string): Promise<unknown | undefined> }

/**
 * The entry point the host calls when a task is created: this organization's table, and Jev only if the
 * organization turned it on. An invalid stored table falls back to the default and says so in the decision.
 */
export function createOrgRouter(deps: { tables: TableStore; jev: Pick<JevSettings, "providerFor"> }) {
  async function tableFor(companyId: string): Promise<{ table: RoutingTable; error?: string }> {
    const stored = await deps.tables.get(companyId);
    if (stored === undefined) return { table: DEFAULT_ROUTING_TABLE };
    try { return { table: parseRoutingTable(stored) }; } catch (e) { return { table: DEFAULT_ROUTING_TABLE, error: `Routing table ignored: ${(e as Error).message}` }; }
  }
  return {
    async route(companyId: string, task: TaskContract): Promise<RouteDecision> {
      const { table, error } = await tableFor(companyId);
      const d = await createTaskRouter({ table, jev: await deps.jev.providerFor(companyId) }).route(task);
      return error ? { ...d, reasons: [...d.reasons, error] } : d;
    },
    /** After a run: the next decision up this organization's chain on "escalate", otherwise null. */
    async next(companyId: string, current: RouteDecision, report: RunReport): Promise<RouteDecision | null> {
      return createTaskRouter({ table: (await tableFor(companyId)).table }).next(current, report);
    },
  };
}
