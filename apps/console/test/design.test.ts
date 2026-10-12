import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error: a plain .mjs script, shared with `pnpm check:design`
import { checkDesign, parseAllowlist, stripComments } from "../scripts/check-design.mjs";
import { stepSpring } from "../src/ui/spring.ts";
import { islandBox } from "../src/pin/PinIsland.tsx";
import { describeTool, kindOf } from "../src/pin/tools.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("design gates", () => {
  it("finds no hand-typed visual values outside the token layer", () => {
    const { violations } = checkDesign(root) as { violations: { gate: string; file: string; line: number; match: string }[] };
    expect(violations.map((v) => `${v.gate} ${v.file}:${v.line} ${v.match}`)).toEqual([]);
  });

  it("parses the allowlist and ignores comments", () => {
    const list = parseAllowlist("/* DESIGN ALLOWLIST\n * allow src/x.tsx | colour,type | because\n */");
    expect(list).toEqual([{ path: "src/x.tsx", gates: ["colour", "type"], reason: "because" }]);
    expect(stripComments('const a = 1; // lab #109 at 200ms\n/* #fff */ "x"')).not.toMatch(/#109|#fff|200ms/);
  });
});

describe("motion", () => {
  it("springs settle on target and keep velocity when retargeted", () => {
    const p = { stiffness: 400, damping: 34, mass: 1 };
    let x = 0;
    let v = 0;
    for (let i = 0; i < 240; i++) [x, v] = stepSpring(x, v, 100, p, 1 / 240);
    expect(Math.abs(x - 100)).toBeLessThan(2);
    // Interrupt mid-flight: heading for 0 again, the motion carries on smoothly instead of jumping.
    x = 0;
    v = 0;
    for (let i = 0; i < 12; i++) [x, v] = stepSpring(x, v, 100, p, 1 / 240);
    const [x2, v2] = stepSpring(x, v, 0, p, 1 / 240);
    expect(v2).toBeGreaterThan(0);
    expect(Math.abs(x2 - x)).toBeLessThan(5);
    for (let i = 0; i < 960; i++) [x, v] = stepSpring(x, v, 0, p, 1 / 240);
    expect(Math.abs(x)).toBeLessThan(0.5);
  });

  it("gives every island view a shape that fits a phone", () => {
    for (const view of ["rest", "status", "peek", "actions", "open"] as const) {
      const b = islandBox(view, { w: 390, h: 844 }, 80);
      expect(b.width).toBeLessThanOrEqual(390 - 16);
      expect(b.height).toBeLessThanOrEqual(844);
    }
    expect(islandBox("open", { w: 1440, h: 900 }, null)).toEqual({ width: 480, height: 640, radius: 24 });
    expect(islandBox("actions", { w: 1440, h: 900 }, 100).height).toBe(102);
  });
});

describe("Pin's proposals", () => {
  const data = { guests: [{ vmid: 109, name: "lab" }], orgs: [] } as never;
  it("describes the host service's proposals in plain words", () => {
    expect(kindOf({ name: "power_machine", args: { vmid: 109, action: "stop" } })).toBe("power");
    expect(kindOf({ name: "snapshot_machine", args: { vmid: 109, name: "before" } })).toBe("snapshot");
    expect(kindOf({ name: "create_task", args: { companyId: "c1", title: "Write docs" } })).toBe("task");
    const stop = describeTool({ id: "1", name: "power_machine", args: { vmid: 109, action: "stop" }, status: "proposed" }, { data });
    expect(stop).toMatchObject({ title: "Stop lab #109", confirmLabel: "Stop", danger: true, runnable: true });
    const missing = describeTool({ id: "2", name: "power_machine", args: { vmid: 999, action: "start" }, status: "proposed" }, { data });
    expect(missing.runnable).toBe(false);
    const snap = describeTool({ id: "3", name: "snapshot_machine", args: { vmid: 109, name: "1bad" }, status: "proposed" }, { data });
    expect(snap.runnable).toBe(false);
  });
});
