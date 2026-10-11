/**
 * Automation rules. Pin turns what you say ("if a container uses more than 50% of its memory, shut it down") into one
 * of these. Rules are plain data: they are validated here before they are stored, so a rule a model got wrong is
 * rejected instead of run. Destroying guests is deliberately not an action an automation can take.
 */

export const METRICS = ["memory_percent", "cpu_percent", "disk_percent", "status"] as const;
export const OPS = [">", ">=", "<", "<=", "==", "!="] as const;
export const ACTIONS = ["notify", "shutdown", "stop", "start", "snapshot"] as const;

export type Metric = (typeof METRICS)[number];
export type Op = (typeof OPS)[number];
export type Action = (typeof ACTIONS)[number];

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  when: { metric: Metric; op: Op; value: number | string; forSeconds: number };
  scope: { guestType: "lxc" | "qemu" | "any"; vmids?: number[]; pool?: string; tag?: string };
  then: { action: Action };
  cooldownSeconds: number;
  createdBy: "pin" | "user";
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} _.,:;%()'"/+-]{0,159}$/u;
const POOL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const STATUSES = ["running", "stopped", "paused"];

export type RuleValidation = { ok: true; rule: Rule } | { ok: false; errors: string[] };

const isOneOf = <T extends readonly string[]>(list: T, v: unknown): v is T[number] => typeof v === "string" && (list as readonly string[]).includes(v);

export function validateRule(raw: unknown): RuleValidation {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["rule must be an object"] };
  const r = raw as Record<string, any>;
  const when = r.when ?? {};
  const scope = r.scope ?? {};
  const then = r.then ?? {};

  if (typeof r.id !== "string" || !ID.test(r.id)) errors.push("id must be lowercase letters, digits, - or _ (max 64)");
  if (typeof r.name !== "string" || !NAME.test(r.name)) errors.push("name is missing or has unsupported characters (max 160)");

  if (!isOneOf(METRICS, when.metric)) errors.push(`when.metric must be one of ${METRICS.join(", ")}`);
  if (!isOneOf(OPS, when.op)) errors.push(`when.op must be one of ${OPS.join(" ")}`);
  if (when.metric === "status") {
    if (!isOneOf(["==", "!="] as const, when.op)) errors.push("a status rule compares with == or !=");
    if (!STATUSES.includes(when.value)) errors.push(`a status rule's value must be one of ${STATUSES.join(", ")}`);
  } else if (isOneOf(METRICS, when.metric)) {
    if (typeof when.value !== "number" || !Number.isFinite(when.value) || when.value < 0 || when.value > 100) errors.push("a percent rule's value must be a number from 0 to 100");
  }
  const forSeconds = when.forSeconds ?? 0;
  if (!Number.isInteger(forSeconds) || forSeconds < 0 || forSeconds > 86_400) errors.push("when.forSeconds must be an integer from 0 to 86400");

  const guestType = scope.guestType ?? "any";
  if (!isOneOf(["lxc", "qemu", "any"] as const, guestType)) errors.push("scope.guestType must be lxc, qemu or any");
  if (scope.vmids !== undefined && (!Array.isArray(scope.vmids) || scope.vmids.length > 1000 || !scope.vmids.every((v: unknown) => Number.isInteger(v) && (v as number) >= 100))) {
    errors.push("scope.vmids must be a list of guest IDs");
  }
  if (scope.pool !== undefined && (typeof scope.pool !== "string" || !POOL.test(scope.pool))) errors.push("scope.pool is invalid");
  if (scope.tag !== undefined && (typeof scope.tag !== "string" || !/^[a-z0-9][a-z0-9_+.-]{0,62}$/.test(scope.tag))) errors.push("scope.tag is invalid");

  if (!isOneOf(ACTIONS, then.action)) errors.push(`then.action must be one of ${ACTIONS.join(", ")} (automations cannot destroy guests)`);

  const cooldownSeconds = r.cooldownSeconds ?? 600;
  if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 0 || cooldownSeconds > 7 * 86_400) errors.push("cooldownSeconds must be an integer from 0 to 604800");

  const createdBy = r.createdBy ?? "user";
  if (!isOneOf(["pin", "user"] as const, createdBy)) errors.push("createdBy must be pin or user");

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    rule: {
      id: r.id,
      name: r.name,
      enabled: r.enabled !== false,
      when: { metric: when.metric, op: when.op, value: when.value, forSeconds },
      scope: { guestType, ...(scope.vmids ? { vmids: [...scope.vmids] } : {}), ...(scope.pool ? { pool: scope.pool } : {}), ...(scope.tag ? { tag: scope.tag } : {}) },
      then: { action: then.action },
      cooldownSeconds,
      createdBy,
    },
  };
}

const METRIC_TEXT: Record<Metric, string> = {
  memory_percent: "uses {op} {value}% of its memory",
  cpu_percent: "uses {op} {value}% CPU",
  disk_percent: "uses {op} {value}% of its disk",
  status: "is {op} {value}",
};
const OP_TEXT: Record<Op, string> = { ">": "more than", ">=": "at least", "<": "less than", "<=": "at most", "==": "", "!=": "not" };
const ACTION_TEXT: Record<Action, string> = { notify: "notify me", shutdown: "shut it down", stop: "stop it", start: "start it", snapshot: "take a snapshot" };

/** Plain-language read-back, so Pin can confirm what it understood before saving a rule. */
export function describeRule(rule: Rule): string {
  const who = rule.scope.guestType === "lxc" ? "a container" : rule.scope.guestType === "qemu" ? "a VM" : "a guest";
  const where = [rule.scope.pool && `in pool ${rule.scope.pool}`, rule.scope.tag && `tagged ${rule.scope.tag}`, rule.scope.vmids && `among ${rule.scope.vmids.join(", ")}`].filter(Boolean).join(", ");
  const cond = METRIC_TEXT[rule.when.metric].replace("{op}", OP_TEXT[rule.when.op]).replace("{value}", String(rule.when.value)).replace(/\s+/g, " ");
  const lasting = rule.when.forSeconds > 0 ? ` for ${rule.when.forSeconds} seconds` : "";
  return `If ${who}${where ? ` ${where}` : ""} ${cond}${lasting}, ${ACTION_TEXT[rule.then.action]}.`;
}
