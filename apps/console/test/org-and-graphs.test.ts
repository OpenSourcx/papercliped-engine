import { describe, expect, it } from "vitest";
import { wouldLoop } from "../src/data/orgTree.ts";
import { demoRrd } from "../src/data/rrd.ts";

const agents = [
  { id: "ceo", reportsTo: null },
  { id: "eng", reportsTo: "ceo" },
  { id: "qa", reportsTo: "eng" },
  { id: "design", reportsTo: "ceo" },
];

describe("org chart moves", () => {
  it("allows moving an agent under someone outside its own branch", () => {
    expect(wouldLoop(agents, "design", "eng")).toBe(false);
    expect(wouldLoop(agents, "qa", "ceo")).toBe(false);
    expect(wouldLoop(agents, "eng", null)).toBe(false);
  });
  it("refuses loops and self-reporting", () => {
    expect(wouldLoop(agents, "ceo", "qa")).toBe(true);
    expect(wouldLoop(agents, "eng", "qa")).toBe(true);
    expect(wouldLoop(agents, "eng", "eng")).toBe(true);
  });
});

describe("demo usage history", () => {
  const base = { cpu: 0.2, maxcpu: 2, mem: 1e9, maxmem: 2e9, net: 50_000, disk: 100_000, running: true };
  it("returns Proxmox-shaped points on the timeframe's step, ending now", () => {
    const now = 1_760_000_000;
    const pts = demoRrd(9000, "hour", "AVERAGE", base, now);
    expect(pts).toHaveLength(60);
    expect(pts[1].time - pts[0].time).toBe(60);
    expect(now - pts[59].time).toBeLessThan(60);
    for (const p of pts) {
      expect(p.cpu).toBeGreaterThanOrEqual(0);
      expect(p.cpu).toBeLessThanOrEqual(1);
      expect(p.mem).toBeLessThanOrEqual(p.maxmem!);
    }
  });
  it("is deterministic per machine and timeframe, and MAX runs at or above AVERAGE on average", () => {
    const a = demoRrd(9000, "day", "AVERAGE", base, 1_760_000_000);
    expect(demoRrd(9000, "day", "AVERAGE", base, 1_760_000_000)).toEqual(a);
    const m = demoRrd(9000, "day", "MAX", base, 1_760_000_000);
    const avg = (xs: { netin?: number }[]) => xs.reduce((s, p) => s + (p.netin ?? 0), 0) / xs.length;
    expect(avg(m)).toBeGreaterThan(avg(a));
  });
  it("is flat for a stopped machine", () => {
    expect(demoRrd(1, "hour", "AVERAGE", { ...base, running: false }).every((p) => p.cpu === 0 && p.netin === 0)).toBe(true);
  });
});

import { niceMax } from "../src/ui/TimeSeriesChart.tsx";
describe("chart axes", () => {
  it("rounds byte axes in binary units", () => {
    const GiB = 1024 ** 3;
    expect(niceMax(34.4 * GiB, true)).toBe(50 * GiB);
    expect(niceMax(9 * GiB, true)).toBe(10 * GiB);
    expect(niceMax(0.07, false)).toBe(0.1);
  });
});
