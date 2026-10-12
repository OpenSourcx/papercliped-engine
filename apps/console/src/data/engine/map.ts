import type { Agent as EngineAgent, Company } from "@papercliped-engine/engine-client";
import { RESERVED, type Agent, type AgentStatus, type Guest, type Org } from "../types.ts";
import type { ResourceGroupState } from "./host.ts";

/**
 * Maps the engine's answers onto the console's shapes. Pure, so it is easy to test. Paperclip calls an organization a
 * company and a task an issue; the console keeps its own words.
 */

/**
 * An organization's address under /<device>/: its issue prefix in lower case (ACME's tasks are ACME-1, ACME-2, so it
 * lives at /pve/acme). A prefix that would shadow a system page gets "-org" added; prefixes are letters only, so the
 * result can't collide with another organization's.
 */
export function orgSlug(company: Pick<Company, "issuePrefix" | "id">): string {
  const base = (company.issuePrefix || company.id).toLowerCase();
  return (RESERVED as readonly string[]).includes(base) ? `${base}-org` : base;
}

/** A stable tint from the id, so an organization keeps its colour across reloads. */
export function hueFor(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

export const AGENT_ROLE_LABEL: Record<string, string> = { ceo: "CEO", cto: "CTO", cmo: "CMO", cfo: "CFO", security: "Security", engineer: "Engineer", designer: "Designer", pm: "PM", qa: "QA", devops: "DevOps", researcher: "Researcher", general: "General" };

export function agentStatus(s: string): AgentStatus {
  if (s === "running") return "working";
  if (s === "paused" || s === "pending_approval") return "paused";
  if (s === "error") return "error";
  return "idle";
}

export function mapAgent(a: EngineAgent): Agent {
  return {
    id: a.id,
    name: a.name,
    role: a.title || AGENT_ROLE_LABEL[a.role] || a.role,
    adapter: a.adapterType,
    engine: "container",
    status: agentStatus(a.status),
    task: null,
    reportsTo: a.reportsTo,
    spendUsd: a.spentMonthlyCents / 100,
    budgetUsd: a.budgetMonthlyCents ? a.budgetMonthlyCents / 100 : undefined,
  };
}

const NO_GROUP = { pool: "", cores: 0, memoryMb: 0, diskGb: 0, maxGuests: 0 };

/**
 * One live organization. `rg` is its resource group: the state when known, null when it has none, undefined while
 * unknown. Usage is added later from the machines actually in its pool.
 */
export function mapCompany(c: Company, agents: EngineAgent[] | undefined, rg: ResourceGroupState | null | undefined): Org {
  return {
    slug: orgSlug(c),
    name: c.name,
    hue: hueFor(c.id),
    createdBy: "user",
    resourceGroup: rg ? { pool: rg.pool, cores: rg.cores, memoryMb: rg.memoryMb, diskGb: rg.diskGb, maxGuests: rg.maxGuests } : NO_GROUP,
    usage: { cpuCores: 0, memoryMb: 0, diskGb: 0, guests: 0 },
    memory: "postgres",
    agents: (agents ?? []).filter((a) => a.status !== "terminated").map(mapAgent),
    tasks: [],
    goals: [],
    projects: [],
    routines: [],
    approvals: [],
    inbox: [],
    activity: [],
    engine: {
      companyId: c.id,
      prefix: c.issuePrefix,
      description: c.description,
      status: c.status,
      budgetMonthlyCents: c.budgetMonthlyCents,
      spentMonthlyCents: c.spentMonthlyCents,
      resourceGroup: rg ? "set" : rg === null ? "missing" : "unknown",
    },
  };
}

/** Adds what each organization's machines really use, from the live guest list. */
export function withUsage(orgs: Org[], guests: Guest[]): Org[] {
  return orgs.map((o) => {
    const mine = guests.filter((g) => g.org === o.slug && !g.template);
    if (!mine.length) return o;
    return {
      ...o,
      usage: {
        cpuCores: mine.reduce((s, g) => s + (g.cpuPct / 100) * g.cores, 0),
        memoryMb: mine.reduce((s, g) => s + g.memUsed, 0) / 1024 ** 2,
        diskGb: mine.reduce((s, g) => s + (g.diskUsed ?? 0), 0) / 1e9,
        guests: mine.length,
      },
    };
  });
}

/** "2h ago" style times for engine timestamps, which arrive as ISO strings. */
export function ago(at: string | Date | null | undefined): string {
  if (!at) return "never";
  const s = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}

export const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
