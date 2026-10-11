import { describe, expect, it } from "vitest";
import { AutomationEngine, describeRule, validateRule, type GuestSnapshot, type Rule } from "../src/index.ts";

const GiB = 1024 ** 3;
const memRule = (over: Partial<Record<string, unknown>> = {}): Rule => {
  const v = validateRule({
    id: "mem-guard",
    name: "Shut down containers over 50% memory",
    when: { metric: "memory_percent", op: ">", value: 50, forSeconds: 60 },
    scope: { guestType: "lxc" },
    then: { action: "shutdown" },
    cooldownSeconds: 600,
    ...over,
  });
  if (!v.ok) throw new Error(v.errors.join("; "));
  return v.rule;
};
const ct = (vmid: number, memGiB: number, extra: Partial<GuestSnapshot> = {}): GuestSnapshot => ({ vmid, type: "lxc", node: "pve", status: "running", mem: memGiB * GiB, maxmem: 2 * GiB, name: `ct${vmid}`, ...extra });

describe("validateRule", () => {
  it("accepts the memory example and reads it back in plain language", () => {
    expect(describeRule(memRule())).toBe("If a container uses more than 50% of its memory for 60 seconds, shut it down.");
  });

  it("refuses actions automations must never take, and out-of-range values", () => {
    const bad = validateRule({ id: "x", name: "x", when: { metric: "memory_percent", op: ">", value: 150 }, then: { action: "destroy" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.join(" ")).toMatch(/0 to 100/);
      expect(bad.errors.join(" ")).toMatch(/cannot destroy/);
    }
  });

  it("only lets status rules compare for equality with a known status", () => {
    expect(validateRule({ id: "s", name: "s", when: { metric: "status", op: ">", value: "running" }, then: { action: "notify" } }).ok).toBe(false);
    expect(validateRule({ id: "s", name: "s", when: { metric: "status", op: "==", value: "stopped" }, then: { action: "start" } }).ok).toBe(true);
  });

  it("rejects malformed ids and scopes", () => {
    expect(validateRule({ ...memRule(), id: "Bad Id" }).ok).toBe(false);
    expect(validateRule({ ...memRule(), scope: { guestType: "lxc", vmids: ["105"] } }).ok).toBe(false);
  });
});

describe("AutomationEngine", () => {
  it("waits for the condition to hold for forSeconds before acting", () => {
    const e = new AutomationEngine({ mode: "agent" });
    const rule = memRule();
    expect(e.evaluate([rule], [ct(101, 1.5)], 0)).toEqual([]);
    expect(e.evaluate([rule], [ct(101, 1.5)], 30_000)).toEqual([]);
    const d = e.evaluate([rule], [ct(101, 1.5)], 60_000);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ vmid: 101, action: "shutdown", kind: "execute", observed: 75 });
  });

  it("resets when the condition stops holding", () => {
    const e = new AutomationEngine({ mode: "agent" });
    const rule = memRule();
    e.evaluate([rule], [ct(101, 1.5)], 0);
    e.evaluate([rule], [ct(101, 0.5)], 30_000);
    expect(e.evaluate([rule], [ct(101, 1.5)], 61_000)).toEqual([]);
  });

  it("does not fire again within the cooldown", () => {
    const e = new AutomationEngine({ mode: "agent" });
    const rule = memRule({ when: { metric: "memory_percent", op: ">", value: 50, forSeconds: 0 } });
    expect(e.evaluate([rule], [ct(101, 1.5)], 0)).toHaveLength(1);
    expect(e.evaluate([rule], [ct(101, 1.5)], 300_000)).toEqual([]);
    expect(e.evaluate([rule], [ct(101, 1.5)], 600_000)).toHaveLength(1);
  });

  it("turns actions into proposals in Assistant mode", () => {
    const e = new AutomationEngine({ mode: "assistant" });
    const rule = memRule({ when: { metric: "memory_percent", op: ">", value: 50, forSeconds: 0 } });
    expect(e.evaluate([rule], [ct(101, 1.5)], 0)[0].kind).toBe("propose");
    e.setMode("agent");
    expect(e.evaluate([rule], [ct(102, 1.5)], 0)[0].kind).toBe("execute");
  });

  it("only notifies for protected guests", () => {
    const e = new AutomationEngine({ mode: "agent", protectedVmids: [106] });
    const rule = memRule({ when: { metric: "memory_percent", op: ">", value: 50, forSeconds: 0 } });
    const [d] = e.evaluate([rule], [ct(106, 1.9)], 0);
    expect(d.kind).toBe("notify");
    expect(d.reason).toMatch(/protected/);
  });

  it("respects scope, skips templates and VMs for a container rule, and skips pointless actions", () => {
    const e = new AutomationEngine({ mode: "agent" });
    const rule = memRule({ when: { metric: "memory_percent", op: ">", value: 50, forSeconds: 0 }, scope: { guestType: "lxc", pool: "acme" } });
    const guests = [
      ct(201, 1.9, { pool: "acme" }),
      ct(202, 1.9, { pool: "other" }),
      ct(203, 1.9, { pool: "acme", template: 1 }),
      ct(204, 1.9, { pool: "acme", type: "qemu" }),
      ct(205, 1.9, { pool: "acme", status: "stopped" }),
    ];
    expect(e.evaluate([rule], guests, 0).map((d) => d.vmid)).toEqual([201]);
  });

  it("ignores disabled rules and guests without metrics", () => {
    const e = new AutomationEngine({ mode: "agent" });
    const rule = { ...memRule({ when: { metric: "memory_percent", op: ">", value: 50, forSeconds: 0 } }) };
    expect(e.evaluate([{ ...rule, enabled: false }], [ct(101, 1.9)], 0)).toEqual([]);
    expect(e.evaluate([rule], [{ vmid: 101, type: "lxc", status: "running" }], 0)).toEqual([]);
  });
});
