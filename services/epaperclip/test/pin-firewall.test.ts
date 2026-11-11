import { describe, expect, it } from "vitest";
import { ACT_NAMES, READ_NAMES, runRead } from "../src/features/pin-act.ts";

const host = (data: Record<string, unknown>, seen: string[] = []) => ({
  node: "pve",
  username: "sam@pve",
  pve: async () => ({
    call: async (method: string, path: string) => {
      seen.push(`${method} ${path}`);
      if (path in data) return data[path];
      throw new Error("403 Permission check failed");
    },
  }) as never,
});

describe("Pin's firewall_overview read tool", () => {
  it("is a read tool, not an action, so it never needs approval", () => {
    expect(READ_NAMES).toContain("firewall_overview");
    expect(ACT_NAMES).not.toContain("firewall_overview");
  });

  it("says whether the cluster and node firewalls are on, their default policies and rule counts", async () => {
    const out = await runRead("firewall_overview", {}, host({
      "/cluster/firewall/options": { enable: 1, policy_in: "DROP", policy_out: "ACCEPT" },
      "/cluster/firewall/rules": [{ pos: 0 }, { pos: 1 }],
      "/nodes/pve/firewall/options": { enable: 0 },
      "/nodes/pve/firewall/rules": [],
    }));
    expect(out).toEqual({
      cluster: { enabled: true, policyIn: "DROP", policyOut: "ACCEPT", rules: 2 },
      node: { enabled: false, policyIn: "DROP", policyOut: "ACCEPT", rules: 0 },
    });
  });

  it("reports what it isn't allowed to see as unknown instead of failing or guessing", async () => {
    const out = (await runRead("firewall_overview", {}, host({ "/cluster/firewall/options": { enable: 1 } }))) as any;
    expect(out.cluster).toEqual({ enabled: true, policyIn: "DROP", policyOut: "ACCEPT", rules: null });
    expect(out.node).toEqual({ enabled: null, policyIn: null, policyOut: null, rules: null });
  });

  it("only ever reads", async () => {
    const seen: string[] = [];
    await runRead("firewall_overview", {}, host({}, seen));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.startsWith("GET "))).toBe(true);
  });
});
