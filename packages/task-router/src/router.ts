import { classifyTask, DEFAULT_CLASSIFIER, type ClassifierConfig } from "./classifier.ts";
import type { JevProvider } from "./jev.ts";
import { DEFAULT_ROUTING_TABLE, entryTier, nextTier, targetFor, type RoutingTable } from "./table.ts";
import { maxTier, type RouteDecision, type RunReport, type TaskContract, type Tier } from "./types.ts";

export interface TaskRouterOptions {
  table?: RoutingTable;
  classifier?: ClassifierConfig;
  /** Present only when the organization turned Jev on. Without it, the rules decide and nothing leaves the host. */
  jev?: JevProvider;
}

export interface TaskRouter {
  route(task: TaskContract): Promise<RouteDecision>;
  /**
   * After a run. "escalate" returns the decision for the next tier in the chain (or null at the end of the chain);
   * "ok" and "failed" return null: success needs nothing more, and a plain failure is not a reason to spend more.
   */
  next(current: RouteDecision, report: RunReport): RouteDecision | null;
}

export function createTaskRouter(o: TaskRouterOptions = {}): TaskRouter {
  const table = o.table ?? DEFAULT_ROUTING_TABLE;
  const cfg = o.classifier ?? DEFAULT_CLASSIFIER;
  const make = (wanted: Tier, source: RouteDecision["source"], reasons: string[], jevError?: string): RouteDecision => {
    const tier = entryTier(table, wanted);
    return { tier, target: targetFor(table, tier), source, reasons, ...(jevError ? { jevError } : {}) };
  };
  return {
    async route(task) {
      const rules = classifyTask(task, cfg);
      // Risky or unbounded work never reaches Jev: code already knows the answer, and the text stays home.
      if (!o.jev || rules.floor === "claude") return make(rules.tier, "rules", rules.reasons);
      try {
        const j = await o.jev.judge(task);
        return make(maxTier(j.tier, rules.floor), "jev", [`jev: ${j.why}`]);
      } catch (e) {
        return make(rules.tier, "rules-fallback", rules.reasons, (e as Error).message);
      }
    },
    next(current, report) {
      if (report.status !== "escalate") return null;
      const t = nextTier(table, current.tier);
      return t ? { tier: t, target: targetFor(table, t), source: current.source, reasons: [`escalated from ${current.tier}${report.note ? `: ${report.note}` : ""}`] } : null;
    },
  };
}
