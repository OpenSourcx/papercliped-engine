import { TIERS, tierRank, type RouteTarget, type Tier } from "./types.ts";

/** One organization's routing: where each tier runs, and the order a task climbs when a run says "escalate". */
export interface RoutingTable {
  targets: Partial<Record<Tier, RouteTarget>>;
  /** Cheapest first. Every tier named here needs a target. */
  chain: Tier[];
}

/**
 * Starting values only. Model names are placeholders until `model-eval` has measured real ones; an organization
 * replaces them in its own table. `auto` lets the Router (docs/ROUTER.md) pick the connection.
 */
export const DEFAULT_ROUTING_TABLE: RoutingTable = {
  targets: {
    "local-small": { adapterType: "opencode_local", model: "auto", environment: "worker-fabric" },
    "free-cloud": { adapterType: "opencode_local", model: "auto" },
    claude: { adapterType: "claude_local", model: "claude-sonnet-5-5" },
  },
  chain: ["local-small", "free-cloud", "claude"],
};

export class RoutingTableError extends Error {}

/** Checks an untrusted table (from settings storage or an API body). Throws a sentence a person can act on. */
export function parseRoutingTable(raw: unknown): RoutingTable {
  const o = raw as { targets?: Record<string, unknown>; chain?: unknown } | null;
  if (!o || typeof o !== "object" || !o.targets || typeof o.targets !== "object" || !Array.isArray(o.chain)) throw new RoutingTableError("A routing table needs `targets` and `chain`.");
  const chain = o.chain as unknown[];
  if (!chain.length) throw new RoutingTableError("The fallback chain is empty.");
  for (const t of chain) if (!TIERS.includes(t as Tier)) throw new RoutingTableError(`Unknown tier "${String(t)}" in the chain.`);
  const tiers = chain as Tier[];
  if (new Set(tiers).size !== tiers.length) throw new RoutingTableError("A tier appears twice in the chain.");
  if (tiers.some((t, i) => i > 0 && tierRank(t) < tierRank(tiers[i - 1]))) throw new RoutingTableError("The chain must go from cheapest to most capable.");
  const targets: RoutingTable["targets"] = {};
  for (const t of tiers) {
    const v = o.targets[t] as Partial<RouteTarget> | undefined;
    if (!v || typeof v.adapterType !== "string" || !v.adapterType.trim()) throw new RoutingTableError(`Tier "${t}" needs an adapterType.`);
    for (const k of ["model", "environment"] as const) if (v[k] !== undefined && typeof v[k] !== "string") throw new RoutingTableError(`Tier "${t}": ${k} must be text.`);
    targets[t] = { adapterType: v.adapterType.trim(), ...(v.model ? { model: v.model } : {}), ...(v.environment ? { environment: v.environment } : {}) };
  }
  return { targets, chain: tiers };
}

/**
 * The tier a task will actually start on: the first chain tier at or above the wanted one. A task is never moved
 * to a cheaper tier than wanted, so a table without `claude` cannot take a risky task.
 */
export function entryTier(table: RoutingTable, wanted: Tier): Tier {
  const t = table.chain.find((c) => tierRank(c) >= tierRank(wanted));
  if (!t) throw new RoutingTableError(`This organization's chain has no "${wanted}" tier (or a stronger one), and the task needs it.`);
  return t;
}

/** The tier after `current` in the chain, or null at the end. */
export function nextTier(table: RoutingTable, current: Tier): Tier | null {
  const i = table.chain.indexOf(current);
  return i >= 0 && i + 1 < table.chain.length ? table.chain[i + 1] : null;
}

export function targetFor(table: RoutingTable, tier: Tier): RouteTarget {
  const t = table.targets[tier];
  if (!t) throw new RoutingTableError(`No target for tier "${tier}".`);
  return t;
}
