import { describe, expect, it } from "vitest";
import { deviceCondition } from "../src/lib/deviceStatus.ts";

const calm = { cpuPct: 10, memUsed: 1, memTotal: 10 };
const ct = (o: object) => ({ state: "ready" as const, job: null, ...o });

describe("deviceCondition (ERR-CON-001)", () => {
  it("says running smoothly only when nothing applies", () => {
    expect(deviceCondition(calm, ct({}))).toBe("is running smoothly");
    expect(deviceCondition(calm, null)).toBe("is running smoothly");
  });
  it("reports Agent Containers in error, a failed setup, or an incomplete one", () => {
    expect(deviceCondition(calm, ct({ state: "error" }))).toMatch(/in error/);
    expect(deviceCondition(calm, ct({ job: { id: "j", status: "failed" } }))).toMatch(/setup failed/);
    expect(deviceCondition(calm, ct({ templateAttempts: 5 }))).toMatch(/setup failed/);
    expect(deviceCondition(calm, ct({ state: "partial" }))).toMatch(/incomplete/);
  });
  it("reports memory and CPU pressure", () => {
    expect(deviceCondition({ ...calm, memUsed: 95, memTotal: 100 }, null)).toBe("is low on memory");
    expect(deviceCondition({ ...calm, cpuPct: 80 }, null)).toBe("is busy");
  });
});
