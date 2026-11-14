import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Runner } from "../src/runner.ts";

// A killed process that nothing has reaped yet is a zombie: it still answers kill(pid, 0) but is dead. Where /proc
// exists, read its state so the test does not depend on the machine's init reaping orphans.
const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return true; }
};

describe("Runner.cancel by owner", () => {
  it("also kills a process the command detached from its group", async () => {
    let out = "";
    const r = new Runner({ out: (_i, _s, d) => { out += d; }, exit: () => {} });
    // The child starts a setsid'd sleeper (like an adapter's bridge server) and prints its pid, then exits.
    r.start({ id: "x1", command: "sh", args: ["-c", "setsid sleep 60 >/dev/null 2>&1 & echo $!"], cwd: "/tmp", env: {}, owner: "lease-test-1" });
    await new Promise((ok) => setTimeout(ok, 500));
    const pid = Number(out.trim());
    expect(pid).toBeGreaterThan(1);
    expect(alive(pid)).toBe(true);
    expect(r.cancel("lease-test-1", "*")).toBeGreaterThanOrEqual(1);
    await new Promise((ok) => setTimeout(ok, 300));
    expect(alive(pid)).toBe(false);
  });
});
