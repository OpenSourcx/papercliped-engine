import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StatsCollector, parseCpuStat, parseMeminfo, parseNvidiaSmi, readOllama } from "../src/stats.ts";

const FX = join(import.meta.dirname, "fixtures/orion");
const fx = (f: string) => readFileSync(join(FX, f), "utf8");

// Fixtures are recorded from the real reference node (a Jetson Orin Nano Super, Ubuntu 24.04, L4T R39). See fixtures/orion/README.txt.
const fetchFixture: typeof fetch = async (u) => {
  const url = String(u);
  const body = url.endsWith("/api/tags") ? fx("ollama-tags.json") : url.endsWith("/api/ps") ? fx("ollama-ps.json") : url.endsWith("/api/version") ? fx("ollama-version.json") : null;
  return body ? new Response(body) : new Response("no", { status: 404 });
};
const execFixture = async (cmd: string, args: string[]) => (cmd === "systemctl" ? (args[1] === "tailscaled" || args[1] === "ollama" ? "active" : "inactive") : cmd === "nvidia-smi" ? fx("nvidia-smi.txt").trim() : null);

describe("parsers", () => {
  it("cpu jiffies", () => {
    const c = parseCpuStat(fx("root/proc/stat"))!;
    expect(c.total).toBeGreaterThan(c.busy);
    expect(parseCpuStat("nothing")).toBeNull();
  });
  it("meminfo in MB", () => {
    const m = parseMeminfo(fx("root/proc/meminfo"))!;
    expect(m.totalMb).toBe(7485);
    expect(m.availMb).toBeGreaterThan(5000);
    expect(m.usedMb + m.availMb).toBe(m.totalMb);
    expect(m.swapTotalMb).toBe(0);
  });
  it("nvidia-smi with N/A fields (Orin) and a real discrete GPU line", () => {
    expect(parseNvidiaSmi(fx("nvidia-smi.txt"))).toMatchObject({ name: "Orin (nvgpu)", utilPct: null, tempC: null });
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 4090, 37, 51, 1200, 24564")).toEqual({ name: "NVIDIA GeForce RTX 4090", utilPct: 37, tempC: 51, memUsedMb: 1200, memTotalMb: 24564 });
    expect(parseNvidiaSmi("")).toBeNull();
  });
});

describe("collector on the Orin fixtures", () => {
  it("reads a Jetson without root", async () => {
    const c = new StatsCollector({ root: join(FX, "root"), exec: execFixture, fetchFn: fetchFixture, now: () => 1 }, () => ({ workspaceRoot: "/", ollamaUrls: ["http://100.64.0.1:11434"], gate: () => ({ running: 0, queued: 2 }), pulls: () => [] }));
    const s = await c.collect();
    expect(s.cpu.pct).toBeNull(); // first sample has nothing to diff against
    expect(s.cpu.tempC).toBeCloseTo(52.2, 1);
    expect(s.temps["gpu-thermal"]).toBeCloseTo(52.5, 1);
    expect(Object.keys(s.temps)).not.toContain("cv0-thermal");
    expect(s.gpu).toMatchObject({ kind: "jetson", utilPct: 0, source: "sysfs" });
    expect(s.gpu?.name).toMatch(/Orin/);
    expect(s.mem.totalMb).toBe(7485);
    expect(s.load).toEqual([0, 0.01, 0]);
    expect(s.uptimeS).toBe(53132);
    expect(s.services).toEqual({ worker: "inactive", ollama: "active", tailscale: "active" });
    expect(s.ollama).toMatchObject({ up: true, running: 0, queued: 2, loaded: [] });
    expect(s.ollama?.available[0]).toMatchObject({ name: "qwen2.5-coder:3b", sizeMb: 1841 });
    expect(JSON.stringify(s).length).toBeLessThan(4000);
  });
  it("cpu percent is a delta between two samples", async () => {
    const c = new StatsCollector({ root: "/", exec: async () => null, fetchFn: fetchFixture }, () => ({ workspaceRoot: "/", ollamaUrls: [], gate: () => null, pulls: () => [] }));
    await c.collect();
    await new Promise((r) => setTimeout(r, 30));
    const s = await c.collect();
    expect(s.cpu.pct === null || (s.cpu.pct >= 0 && s.cpu.pct <= 100)).toBe(true);
    expect(s.ollama).toBeNull();
  });
  it("readOllama falls through dead addresses", async () => {
    const f: typeof fetch = async (u) => (String(u).startsWith("http://dead") ? Promise.reject(new Error("refused")) : fetchFixture(u));
    expect((await readOllama(["http://dead:1", "http://ok:1"], f))?.url).toBe("http://ok:1");
    expect(await readOllama(["http://dead:1"], f)).toBeNull();
  });
});
