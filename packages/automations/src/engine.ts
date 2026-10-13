import type { Action, Metric, Op, Rule } from "./rules.ts";

/**
 * The automations engine. Each tick it reads a snapshot of the host's guests (the Proxmox cluster resource list),
 * checks every enabled rule, and returns decisions. It does not act itself; the caller hands decisions to the broker.
 *
 * Pin's mode is enforced here, in code: in Assistant mode every action other than notify becomes a proposal that
 * waits for the user's approval. Protected guests only ever produce a notification.
 */

export type Mode = "assistant" | "agent";

export interface GuestSnapshot {
  vmid?: number;
  type: string;
  node?: string;
  pool?: string;
  tags?: string;
  name?: string;
  status?: string;
  template?: number;
  mem?: number;
  maxmem?: number;
  cpu?: number;
  disk?: number;
  maxdisk?: number;
}

export interface Decision {
  ruleId: string;
  ruleName: string;
  vmid: number;
  guestType: "lxc" | "qemu";
  node: string | null;
  name: string | null;
  action: Action;
  /** execute: run it now. propose: ask the user first (Assistant mode). notify: tell the user only. */
  kind: "execute" | "propose" | "notify";
  reason: string;
  observed: number | string;
}

export interface EngineOptions {
  mode: Mode;
  protectedVmids?: number[];
}

const splitTags = (t?: string) => (t ? t.split(/[;, ]+/).filter(Boolean) : []);

export function metricOf(g: GuestSnapshot, metric: Metric): number | string | undefined {
  const pct = (used?: number, max?: number) => (typeof used === "number" && typeof max === "number" && max > 0 ? (used / max) * 100 : undefined);
  switch (metric) {
    case "memory_percent":
      return pct(g.mem, g.maxmem);
    case "disk_percent":
      return pct(g.disk, g.maxdisk);
    case "cpu_percent":
      return typeof g.cpu === "number" ? g.cpu * 100 : undefined;
    case "status":
      return g.status;
  }
}

function compare(observed: number | string, op: Op, value: number | string): boolean {
  switch (op) {
    case ">":
      return observed > value;
    case ">=":
      return observed >= value;
    case "<":
      return observed < value;
    case "<=":
      return observed <= value;
    case "==":
      return observed === value;
    case "!=":
      return observed !== value;
  }
}

function inScope(rule: Rule, g: GuestSnapshot & { vmid: number }): boolean {
  if (rule.scope.guestType !== "any" && rule.scope.guestType !== g.type) return false;
  if (rule.scope.vmids && !rule.scope.vmids.includes(g.vmid)) return false;
  if (rule.scope.pool && g.pool !== rule.scope.pool) return false;
  if (rule.scope.tag && !splitTags(g.tags).includes(rule.scope.tag)) return false;
  return true;
}

/** An action that would change nothing (stopping a stopped guest) is skipped rather than proposed. */
function pointless(action: Action, status?: string): boolean {
  if (action === "shutdown" || action === "stop") return status !== "running";
  if (action === "start") return status === "running";
  return false;
}

export class AutomationEngine {
  private mode: Mode;
  private readonly protectedVmids: Set<number>;
  private readonly since = new Map<string, number>(); // rule:vmid -> when the condition first held
  private readonly lastFired = new Map<string, number>(); // rule:vmid -> when it last fired

  constructor(opts: EngineOptions) {
    this.mode = opts.mode;
    this.protectedVmids = new Set(opts.protectedVmids ?? []);
  }

  setMode(mode: Mode) {
    this.mode = mode;
  }

  get currentMode(): Mode {
    return this.mode;
  }

  evaluate(rules: Rule[], guests: GuestSnapshot[], now: number): Decision[] {
    const decisions: Decision[] = [];
    const seen = new Set<string>();
    const live = guests.filter((g): g is GuestSnapshot & { vmid: number; type: "lxc" | "qemu" } => typeof g.vmid === "number" && (g.type === "lxc" || g.type === "qemu") && !g.template);

    for (const rule of rules) {
      if (!rule.enabled) continue;
      for (const g of live) {
        if (!inScope(rule, g)) continue;
        const key = `${rule.id}:${g.vmid}`;
        seen.add(key);
        const observed = metricOf(g, rule.when.metric);
        if (observed === undefined || !compare(observed, rule.when.op, rule.when.value)) {
          this.since.delete(key);
          continue;
        }
        const first = this.since.get(key) ?? now;
        this.since.set(key, first);
        if (now - first < rule.when.forSeconds * 1000) continue;
        const last = this.lastFired.get(key);
        if (last !== undefined && now - last < rule.cooldownSeconds * 1000) continue;
        if (pointless(rule.then.action, g.status)) continue;

        this.lastFired.set(key, now);
        const shown = typeof observed === "number" ? Math.round(observed * 10) / 10 : observed;
        let kind: Decision["kind"] = rule.then.action === "notify" ? "notify" : this.mode === "agent" ? "execute" : "propose";
        let reason = `${rule.when.metric} ${rule.when.op} ${rule.when.value} (observed ${shown})`;
        if (this.protectedVmids.has(g.vmid) && rule.then.action !== "notify") {
          kind = "notify";
          reason += "; guest is protected, so only notifying";
        }
        decisions.push({ ruleId: rule.id, ruleName: rule.name, vmid: g.vmid, guestType: g.type, node: g.node ?? null, name: g.name ?? null, action: rule.then.action, kind, reason, observed: shown });
      }
    }
    // Forget guests and rules that no longer exist, so a recreated guest starts fresh.
    for (const key of [...this.since.keys()]) if (!seen.has(key)) this.since.delete(key);
    for (const key of [...this.lastFired.keys()]) if (!seen.has(key)) this.lastFired.delete(key);
    return decisions;
  }
}

export { inScope, pointless };
