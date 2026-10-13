import { ACTIONS, describeRule, validateRule, type Action, type Rule } from "./rules.ts";

/**
 * Automations as the host runs them. A rule (rules.ts) says "when this holds, do that"; an automation wraps the same
 * parts with how often to look (a condition automation) or when to act (a scheduled one). Everything is plain data,
 * validated here before it is stored, so a definition a model got wrong is rejected instead of run.
 */

export type Trigger =
  | { type: "condition"; when: Rule["when"]; cooldownSeconds: number; everySeconds: number }
  | { type: "schedule"; everySeconds?: number; dailyAt?: string };

export interface AutomationSpec {
  name: string;
  trigger: Trigger;
  scope: Rule["scope"];
  then: { action: Action };
  createdBy: "pin" | "user";
}

export type SpecValidation = { ok: true; spec: AutomationSpec } | { ok: false; errors: string[] };

const DAILY = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const MIN_CHECK_SECONDS = 30;
export const MIN_SCHEDULE_SECONDS = 300;
export const MAX_INTERVAL_SECONDS = 7 * 86_400;

/** Checks a whole definition. Rule parts go through validateRule, so the rules about metrics, scope and actions stay in one place. */
export function validateSpec(raw: unknown): SpecValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["automation must be an object"] };
  const r = raw as Record<string, any>;
  const t = r.trigger;
  if (!t || typeof t !== "object") return { ok: false, errors: ["trigger is required"] };
  const errors: string[] = [];
  const known = new Set(["name", "trigger", "scope", "then", "createdBy"]);
  for (const k of Object.keys(r)) if (!known.has(k)) errors.push(`unknown field ${k}`);
  const interval = (v: unknown, min: number, what: string) => {
    if (!Number.isInteger(v) || (v as number) < min || (v as number) > MAX_INTERVAL_SECONDS) errors.push(`${what} must be a whole number of seconds from ${min} to ${MAX_INTERVAL_SECONDS}`);
  };
  if (t.type === "condition") {
    const everySeconds = t.everySeconds ?? 60;
    interval(everySeconds, MIN_CHECK_SECONDS, "trigger.everySeconds");
    const v = validateRule({ id: "x", name: r.name, enabled: true, when: t.when, scope: r.scope, then: r.then, cooldownSeconds: t.cooldownSeconds, createdBy: r.createdBy });
    if (!v.ok) return { ok: false, errors: [...errors, ...v.errors.filter((e) => !e.startsWith("id "))] };
    if (errors.length) return { ok: false, errors };
    const rule = v.rule;
    return { ok: true, spec: { name: rule.name, trigger: { type: "condition", when: rule.when, cooldownSeconds: rule.cooldownSeconds, everySeconds }, scope: rule.scope, then: rule.then, createdBy: rule.createdBy } };
  }
  if (t.type === "schedule") {
    if ((t.everySeconds === undefined) === (t.dailyAt === undefined)) errors.push("a schedule needs exactly one of everySeconds or dailyAt");
    if (t.everySeconds !== undefined) interval(t.everySeconds, MIN_SCHEDULE_SECONDS, "trigger.everySeconds");
    if (t.dailyAt !== undefined && (typeof t.dailyAt !== "string" || !DAILY.test(t.dailyAt))) errors.push("trigger.dailyAt must look like 02:30");
    // Reuse the rule checks for name, scope and action, with a harmless condition.
    const v = validateRule({ id: "x", name: r.name, enabled: true, when: { metric: "status", op: "!=", value: "paused", forSeconds: 0 }, scope: r.scope, then: r.then, createdBy: r.createdBy });
    if (!v.ok) errors.push(...v.errors.filter((e) => !e.startsWith("id ")));
    if (errors.length || !v.ok) return { ok: false, errors };
    const rule = v.rule;
    return { ok: true, spec: { name: rule.name, trigger: t.dailyAt !== undefined ? { type: "schedule", dailyAt: t.dailyAt } : { type: "schedule", everySeconds: t.everySeconds }, scope: rule.scope, then: rule.then, createdBy: rule.createdBy } };
  }
  return { ok: false, errors: ["trigger.type must be condition or schedule"] };
}

/** The rule a condition automation evaluates with. */
export function ruleOf(id: string, enabled: boolean, spec: AutomationSpec): Rule | null {
  if (spec.trigger.type !== "condition") return null;
  return { id, name: spec.name, enabled, when: spec.trigger.when, scope: spec.scope, then: spec.then, cooldownSeconds: spec.trigger.cooldownSeconds, createdBy: spec.createdBy };
}

/** Plain-language read-back of a whole definition. */
export function describeSpec(spec: AutomationSpec): string {
  if (spec.trigger.type === "condition") return describeRule(ruleOf("x", true, spec)!).replace(/\.$/, `, checking every ${human(spec.trigger.everySeconds)}.`);
  const who = spec.scope.guestType === "lxc" ? "every container" : spec.scope.guestType === "qemu" ? "every VM" : "every machine";
  const where = [spec.scope.pool && `in pool ${spec.scope.pool}`, spec.scope.tag && `tagged ${spec.scope.tag}`, spec.scope.vmids && `among ${spec.scope.vmids.join(", ")}`].filter(Boolean).join(", ");
  const when = spec.trigger.dailyAt ? `every day at ${spec.trigger.dailyAt}` : `every ${human(spec.trigger.everySeconds!)}`;
  const verb = { notify: "notify me about", shutdown: "shut down", stop: "stop", start: "start", snapshot: "take a snapshot of" }[spec.then.action];
  return `${when[0].toUpperCase()}${when.slice(1)}, ${verb} ${who}${where ? ` ${where}` : ""}.`;
}

function human(s: number): string {
  if (s % 86_400 === 0) return s === 86_400 ? "day" : `${s / 86_400} days`;
  if (s % 3600 === 0) return s === 3600 ? "hour" : `${s / 3600} hours`;
  if (s % 60 === 0) return s === 60 ? "minute" : `${s / 60} minutes`;
  return `${s} seconds`;
}

/** When a definition is next due, in epoch milliseconds, given when it last ran (null: never) and the host's local clock. */
export function nextDue(trigger: Trigger, lastRunAt: number | null, now: number): number {
  const every = trigger.type === "condition" ? trigger.everySeconds : trigger.everySeconds;
  if (every !== undefined) return lastRunAt === null ? now : lastRunAt + every * 1000;
  const [h, m] = (trigger as { dailyAt: string }).dailyAt.split(":").map(Number);
  const at = new Date(now);
  at.setHours(h, m, 0, 0);
  let due = at.getTime();
  // Never ran: due at the next occurrence, not retroactively for a time already past today.
  if (lastRunAt === null) return due > now ? due : due + 86_400_000;
  while (due <= lastRunAt) due += 86_400_000;
  // Missed while the host was down: run once when it is back, not once per missed day.
  return due;
}

export { ACTIONS };
