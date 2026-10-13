import { describe, expect, it } from "vitest";
import { describeSpec, nextDue, ruleOf, validateSpec } from "../src/index.ts";

const cond = (over: Record<string, unknown> = {}) => ({
  name: "Memory guard",
  trigger: { type: "condition", when: { metric: "memory_percent", op: ">", value: 50, forSeconds: 60 }, cooldownSeconds: 600, everySeconds: 60 },
  scope: { guestType: "lxc" },
  then: { action: "shutdown" },
  ...over,
});

describe("validateSpec", () => {
  it("accepts a condition automation and reads it back", () => {
    const v = validateSpec(cond());
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(describeSpec(v.spec)).toBe("If a container uses more than 50% of its memory for 60 seconds, shut it down, checking every minute.");
      expect(ruleOf("a1", true, v.spec)?.then.action).toBe("shutdown");
    }
  });

  it("accepts a daily schedule and reads it back", () => {
    const v = validateSpec({ name: "Nightly snapshot", trigger: { type: "schedule", dailyAt: "02:30" }, scope: { guestType: "any", tag: "prod" }, then: { action: "snapshot" } });
    expect(v.ok).toBe(true);
    if (v.ok) expect(describeSpec(v.spec)).toBe("Every day at 02:30, take a snapshot of every machine tagged prod.");
  });

  it("refuses what it can't run: destroy, fast polling, bad times, both schedule kinds, unknown fields", () => {
    expect(validateSpec(cond({ then: { action: "destroy" } })).ok).toBe(false);
    expect(validateSpec(cond({ trigger: { ...(cond().trigger as object), everySeconds: 5 } })).ok).toBe(false);
    const bad = (trigger: unknown) => validateSpec({ name: "x", trigger, scope: {}, then: { action: "start" } });
    expect(bad({ type: "schedule", dailyAt: "25:00" }).ok).toBe(false);
    expect(bad({ type: "schedule", dailyAt: "01:00", everySeconds: 600 }).ok).toBe(false);
    expect(bad({ type: "schedule", everySeconds: 60 }).ok).toBe(false);
    expect(bad({ type: "cron" }).ok).toBe(false);
    expect(validateSpec({ ...cond(), extra: 1 }).ok).toBe(false);
  });
});

describe("nextDue", () => {
  const at = (h: number, m: number) => new Date(2026, 9, 13, h, m, 0, 0).getTime();
  it("polls from the last run", () => {
    expect(nextDue({ type: "condition", when: { metric: "status", op: "==", value: "running", forSeconds: 0 }, cooldownSeconds: 0, everySeconds: 60 }, 1000, 5000)).toBe(61_000);
    expect(nextDue({ type: "schedule", everySeconds: 600 }, null, 5000)).toBe(5000);
  });
  it("runs a daily time once, not retroactively and not once per missed day", () => {
    const t = { type: "schedule", dailyAt: "02:30" } as const;
    expect(nextDue(t, null, at(1, 0))).toBe(at(2, 30));
    expect(nextDue(t, null, at(9, 0))).toBe(at(2, 30) + 86_400_000);
    expect(nextDue(t, at(2, 30), at(9, 0))).toBe(at(2, 30) + 86_400_000);
    // Down for three days: the next due time is in the past, so it runs once when the host is back.
    expect(nextDue(t, at(2, 30) - 3 * 86_400_000, at(9, 0))).toBeLessThan(at(9, 0));
  });
});
