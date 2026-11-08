import { afterEach, describe, expect, it } from "vitest";
import { adoptOnline, newWorker, startHost, until, type Host, type Worker } from "./fabric-harness.ts";
import { HISTORY_MAX, RECENT_MAX, StatsStore, cleanStats } from "../src/fabric/stats.ts";

const hosts: Host[] = [];
const workers: Worker[] = [];
afterEach(async () => {
  for (const w of workers.splice(0)) w.client.stop();
  for (const h of hosts.splice(0)) await h.close();
});

const sample = (at: number, over: Record<string, unknown> = {}) => cleanStats({ uptimeS: 5, load: [1, 2, 3], cpu: { pct: 12.5, cores: 6, tempC: 50 }, mem: { totalMb: 8000, usedMb: 2000, availMb: 6000, swapTotalMb: 0, swapUsedMb: 0 }, disk: [{ path: "/", totalGb: 900, freeGb: 800 }], gpu: { kind: "jetson", name: "Orin", utilPct: 3, tempC: 52, memUsedMb: null, memTotalMb: null, source: "sysfs" }, temps: { "gpu-thermal": 52 }, services: { worker: "active", ollama: "active", tailscale: "active" }, ollama: { up: true, version: "0.40", loaded: [], available: [{ name: "m:1b", sizeMb: 900 }], running: 0, queued: 0 }, pulls: [], ...over }, at)!;

describe("stats store", () => {
  it("clamps and caps what a worker sends", () => {
    const s = cleanStats({ cpu: { pct: 900, cores: -1 }, temps: { a: 9999, b: 40 }, services: { worker: "weird" }, disk: new Array(50).fill({ path: "/", totalGb: 1, freeGb: 1 }), mem: {} }, 7)!;
    expect(s.cpu.pct).toBeNull();
    expect(s.temps).toEqual({ b: 40 });
    expect(s.services.worker).toBe("unknown");
    expect(s.disk).toHaveLength(4);
    expect(cleanStats("x", 1)).toBeNull();
  });
  it("is bounded: a short ring and 24 h of history, one history point per five minutes", () => {
    const st = new StatsStore();
    let added = 0;
    for (let i = 0; i < 6000; i++) if (st.add("w", sample(1_000_000 + i * 15_000))) added++;
    const g = st.get("w");
    expect(g.recent).toHaveLength(RECENT_MAX);
    expect(g.history).toHaveLength(HISTORY_MAX);
    expect(added).toBe(Math.ceil((6000 * 15_000) / 300_000));
    expect(g.latest?.at).toBe(1_000_000 + 5999 * 15_000);
    st.drop("w");
    expect(st.get("w").latest).toBeNull();
  });
});

describe("worker statistics and management over the real channel", () => {
  it("stores samples a connected worker sends and keeps history across a host restart", async () => {
    const h = await startHost();
    hosts.push(h);
    const w = newWorker();
    workers.push(w);
    const id = await adoptOnline(h, w, "stat-a");
    const got = await until(() => h.hub.stats(id).latest, 5000, "first sample");
    expect(got.mem.totalMb).toBeGreaterThan(0);
    expect(got.cpu.cores).toBeGreaterThan(0);
    await until(() => h.hub.stats(id).recent.length >= 3, 5000, "three samples");
    expect(h.hub.stats(id).history.length).toBe(1);
    // a new hub on the same state sees the saved history
    const { FabricHub } = await import("../src/fabric/hub.ts");
    const again = new FabricHub({ state: h.state });
    expect(again.stats(id).history.length).toBe(1);
  });

  it("management: signed request is accepted by the worker; failures and successes are audited with who asked", async () => {
    const h = await startHost();
    hosts.push(h);
    const w = newWorker();
    workers.push(w);
    const id = await adoptOnline(h, w, "stat-b");
    await until(() => w.files.config().workerId === id, 5000, "worker saved its id");
    const r = (await h.hub.manage("alice", id, "stats")) as { stats: { mem: { totalMb: number } } };
    expect(r.stats.mem.totalMb).toBeGreaterThan(0);
    // this test machine has no epw-admin helper, so a restart is refused with a plain reason (after the signature passed)
    await expect(h.hub.manage("alice", id, "restart-worker")).rejects.toThrow(/helper/);
    await expect(h.hub.manage("alice", id, "model-pull", { name: "bad name; rm" })).rejects.toThrow(/valid model name/);
    await expect(h.hub.manage("alice", id, "shell", {})).rejects.toThrow(/Unknown management action/);
    await expect(h.hub.manage("alice", id, "update", { url: "http://x", sha256: "z" })).rejects.toThrow(/https/);
    const a = h.hub.auditList({ workerId: id }).events.filter((e) => e.action.startsWith("manage."));
    expect(a.map((e) => `${e.actor} ${e.action} ${e.detail?.split(" ")[0]}`)).toEqual(["alice manage.stats ok", "alice manage.restart-worker failed"]);
  });

  it("a worker refuses a request signed by some other key", async () => {
    const h = await startHost();
    hosts.push(h);
    const w = newWorker();
    workers.push(w);
    const id = await adoptOnline(h, w, "stat-c");
    await until(() => w.files.config().workerId === id, 5000, "worker saved its id");
    const c = w.files.config();
    c.hostKey = (await import("@papercliped-engine/worker-fabric")).generateIdentity().publicKey; // pretend we pinned a different host
    w.files.saveConfig(c);
    await expect(h.hub.manage("alice", id, "stats")).rejects.toThrow(/not signed by the host/);
  });
});
