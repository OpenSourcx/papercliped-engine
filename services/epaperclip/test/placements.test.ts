import { describe, expect, it } from "vitest";
import { HttpError } from "../src/http.ts";
import { handlePlacements } from "../src/features/placements.ts";
import { classify, current, MAX_PLACEMENTS, PlacementLedger, placementFromLease, STALE_AFTER_MS } from "../src/placements.ts";
import { StateStore } from "../src/state.ts";

const DEV = "pve";
const T0 = Date.parse("2026-11-14T10:00:00Z");
const lxc = (o: Record<string, unknown> = {}) => ({
  id: "lease-1", companyId: "co-a", heartbeatRunId: "run-1", issueId: "iss-1", status: "active", provider: "proxmox", providerLeaseId: "pve/104",
  acquiredAt: "2026-11-14T10:00:00Z", releasedAt: null, cleanupStatus: null,
  metadata: { provider: "proxmox", node: "pve", vmid: 104, ip: "10.9.0.5", sshUser: "agent", remoteCwd: "/home/agent/work" }, ...o,
});
const worker = (o: Record<string, unknown> = {}) => ({
  id: "lease-w1", companyId: "co-a", heartbeatRunId: "run-w", status: "active", provider: "remote-worker", providerLeaseId: "wl_abc",
  acquiredAt: "2026-11-14T10:05:00Z", metadata: { provider: "remote-worker", workerId: "orion", workerName: "Orion", remoteCwd: "/w" }, ...o,
});
const ledger = (now = () => T0) => new PlacementLedger(new StateStore(null), { now });
const all = () => true;

describe("reading an engine lease", () => {
  it("places a container from its provider lease id and keeps no address or user", () => {
    const p = placementFromLease(DEV, lxc(), T0)!;
    expect(p).toMatchObject({ leaseId: "lease-1", runId: "run-1", companyId: "co-a", provider: "proxmox", state: "active", resource: { kind: "lxc", device: DEV, node: "pve", vmid: 104 } });
    const text = JSON.stringify(p);
    expect(text).not.toContain("10.9.0.5");
    expect(text).not.toContain("agent");
    expect(text).not.toContain("/home");
  });

  it("falls back to the metadata when the lease id isn't node/vmid, and prefers the lease id when both exist", () => {
    expect(placementFromLease(DEV, lxc({ providerLeaseId: "weird" }), T0)!.resource).toEqual({ kind: "lxc", device: DEV, node: "pve", vmid: 104 });
    expect(placementFromLease(DEV, lxc({ providerLeaseId: "pve2/230", metadata: { node: "pve", vmid: 104 } }), T0)!.resource).toEqual({ kind: "lxc", device: DEV, node: "pve2", vmid: 230 });
    // a failed creation handed to the engine uses node_vmid
    expect(placementFromLease(DEV, lxc({ providerLeaseId: "pve_105", status: "pending_cleanup" }), T0)).toMatchObject({ resource: { vmid: 105 }, state: "cleanup_pending" });
  });

  it("places a worker run by the worker id in the metadata", () => {
    expect(placementFromLease(DEV, worker(), T0)).toMatchObject({ provider: "remote-worker", resource: { kind: "worker", device: DEV, workerId: "orion" } });
  });

  it("never infers a resource: no verifiable id leaves it unplaced, and other providers are ignored", () => {
    expect(placementFromLease(DEV, lxc({ providerLeaseId: null, metadata: { name: "ct-104 (agent box)" } }), T0)!.resource).toBeNull();
    expect(placementFromLease(DEV, worker({ metadata: { workerName: "Orion" } }), T0)!.resource).toBeNull();
    expect(placementFromLease(DEV, lxc({ provider: "docker" }), T0)).toBeNull();
    expect(placementFromLease(DEV, { id: "x" }, T0)).toBeNull();
    expect(placementFromLease(DEV, null, T0)).toBeNull();
    expect(placementFromLease(DEV, lxc({ id: "../etc" }), T0)).toBeNull();
  });

  it("maps every engine status", () => {
    const st = (status: string, cleanupStatus: string | null = null, releasedAt: string | null = null) => placementFromLease(DEV, lxc({ status, cleanupStatus, releasedAt }), T0)!.state;
    expect(st("active")).toBe("active");
    expect(st("retained")).toBe("retained");
    expect(st("pending_cleanup")).toBe("cleanup_pending");
    expect(st("failed")).toBe("failed");
    expect(st("released", "success", "2026-11-14T10:09:00Z")).toBe("retired");
    expect(st("expired", "success")).toBe("retired");
    expect(st("released", "pending")).toBe("cleanup_pending");
    expect(st("released", "failed")).toBe("cleanup_pending");
    expect(st("something-new", null, "2026-11-14T10:09:00Z")).toBe("retired");
    expect(st("something-new")).toBe("active");
  });
});

describe("the ledger", () => {
  it("keeps the placement of a finished run after its container is gone", () => {
    const l = ledger();
    l.sync(DEV, [lxc()], { complete: true });
    l.sync(DEV, [lxc({ status: "released", cleanupStatus: "success", releasedAt: "2026-11-14T10:20:00Z" })], { complete: true });
    const r = l.forRun("run-1", all);
    expect(r.placements).toHaveLength(1);
    expect(r.placements[0]).toMatchObject({ state: "retired", releasedAt: Date.parse("2026-11-14T10:20:00Z"), resource: { vmid: 104 } });
    expect(current(r.placements)).toBeNull(); // history, not a live machine
  });

  it("never changes a resource once set, never moves a placement to another company, and never goes back from a later state", () => {
    const l = ledger();
    l.sync(DEV, [lxc()], { complete: true });
    l.sync(DEV, [lxc({ providerLeaseId: "pve/999", metadata: {}, companyId: "co-b" })], { complete: true });
    expect(l.forRun("run-1", all).placements[0]).toMatchObject({ companyId: "co-a", resource: { vmid: 104 } });
    l.sync(DEV, [lxc({ status: "released", cleanupStatus: "success", releasedAt: "2026-11-14T10:20:00Z" })], { complete: true });
    l.sync(DEV, [lxc({ status: "active" })], { complete: true }); // a stale or replayed row
    expect(l.forRun("run-1", all).placements[0]!.state).toBe("retired");
  });

  it("fills a resource in later if the first sighting had none, and keeps the first release time", () => {
    const l = ledger();
    l.sync(DEV, [lxc({ providerLeaseId: null, metadata: {} })], { complete: true });
    expect(l.forRun("run-1", all).placements[0]!.resource).toBeNull();
    l.sync(DEV, [lxc({ status: "released", cleanupStatus: "success", releasedAt: "2026-11-14T10:20:00Z" })], { complete: true });
    l.sync(DEV, [lxc({ status: "released", cleanupStatus: "success", releasedAt: "2026-11-14T11:00:00Z" })], { complete: true });
    expect(l.forRun("run-1", all).placements[0]).toMatchObject({ resource: { vmid: 104 }, releasedAt: Date.parse("2026-11-14T10:20:00Z") });
  });

  it("keeps a reused VMID as separate placements with their own windows", () => {
    const l = ledger();
    l.sync(DEV, [
      lxc({ id: "l-old", heartbeatRunId: "run-old", status: "released", cleanupStatus: "success", releasedAt: "2026-11-14T09:00:00Z", acquiredAt: "2026-11-14T08:00:00Z" }),
      lxc({ id: "l-new", heartbeatRunId: "run-new", companyId: "co-b", acquiredAt: "2026-11-14T10:00:00Z" }),
    ], { complete: true });
    const ref = { kind: "lxc", device: DEV, node: "pve", vmid: 104 } as const;
    const both = l.forResource(ref, all).placements;
    expect(both.map((p) => p.runId)).toEqual(["run-old", "run-new"]);
    expect(current(both)!.runId).toBe("run-new");
    expect(both[0]!.releasedAt).toBeLessThan(both[1]!.acquiredAt);
    // the other company's older run is not attributed to the new owner of the id, nor the reverse
    expect(l.forRun("run-old", all).placements[0]!.companyId).toBe("co-a");
  });

  it("withholds what the caller can't see, returning only a count", () => {
    const l = ledger();
    l.sync(DEV, [lxc(), lxc({ id: "l2", heartbeatRunId: "run-2", companyId: "co-b", providerLeaseId: "pve/104" })], { complete: true });
    const ref = { kind: "lxc", device: DEV, node: "pve", vmid: 104 } as const;
    const mine = l.forResource(ref, (c) => c === "co-a");
    expect(mine.placements.map((p) => p.runId)).toEqual(["run-1"]);
    expect(mine.hidden).toBe(1);
    expect(JSON.stringify(mine)).not.toContain("run-2");
    expect(JSON.stringify(mine)).not.toContain("co-b");
    expect(l.forRun("run-2", (c) => c === "co-a")).toEqual({ placements: [], hidden: 1 });
  });

  it("marks the device synced only after a complete read", () => {
    let t = T0;
    const l = ledger(() => t);
    l.sync(DEV, [lxc()], { complete: false });
    expect(l.lastSync(DEV)).toBeNull();
    t += 1000;
    l.sync(DEV, [lxc()], { complete: true });
    expect(l.lastSync(DEV)).toBe(T0 + 1000);
  });

  it("keeps live placements and drops the oldest finished ones past the limit", () => {
    const l = new PlacementLedger(new StateStore(null), { now: () => T0, max: 5 });
    const done = (i: number) => lxc({ id: `d${i}`, heartbeatRunId: `r${i}`, providerLeaseId: `pve/${200 + i}`, status: "released", cleanupStatus: "success", releasedAt: "2026-11-14T10:01:00Z", acquiredAt: new Date(T0 + i * 1000).toISOString() });
    l.sync(DEV, [lxc({ id: "live", heartbeatRunId: "rl", providerLeaseId: "pve/150", acquiredAt: "2026-11-14T01:00:00Z" }), ...[1, 2, 3, 4, 5, 6].map(done)], { complete: true });
    expect(l.forRun("rl", all).placements).toHaveLength(1);
    expect(l.forRun("r1", all).placements).toHaveLength(0); // oldest finished dropped
    expect(l.forRun("r6", all).placements).toHaveLength(1);
    expect(MAX_PLACEMENTS).toBeGreaterThan(1000);
  });
});

describe("how a placement reads", () => {
  const p = placementFromLease(DEV, lxc(), T0)!;
  it("distinguishes unplaced, live, stale, retired and unavailable", () => {
    expect(classify(null, { now: T0, lastSync: T0 })).toBe("unplaced");
    expect(classify(null, { now: T0, lastSync: null, sourceDown: true })).toBe("unavailable");
    expect(classify(placementFromLease(DEV, lxc({ providerLeaseId: null, metadata: {} }), T0)!, { now: T0, lastSync: T0 })).toBe("unplaced");
    expect(classify(p, { now: T0 + 1000, lastSync: T0 })).toBe("active");
    expect(classify(p, { now: T0 + STALE_AFTER_MS + 1, lastSync: T0 })).toBe("stale");
    expect(classify(p, { now: T0, lastSync: null })).toBe("stale");
    expect(classify(p, { now: T0, lastSync: T0, sourceDown: true })).toBe("unavailable");
    const retired = placementFromLease(DEV, lxc({ status: "released", cleanupStatus: "success" }), T0)!;
    expect(classify(retired, { now: T0 + 10 * STALE_AFTER_MS, lastSync: null })).toBe("retired"); // history never goes stale
  });
});

describe("the routes", () => {
  const sessionUser = { username: "ana@pve" };
  function ctx(path: string, o: { query?: string; method?: string; mine?: string[]; gateway?: boolean; state?: StateStore; t?: number } = {}) {
    const state = o.state ?? new StateStore(null);
    let out: { status: number; body: any } | null = null;
    const c: any = {
      path, method: o.method ?? "GET", url: new URL(`https://h${path}${o.query ?? ""}`), node: DEV, state, now: () => o.t ?? T0 + 1000, HttpError,
      session: () => sessionUser,
      gateway: o.gateway === false ? null : { userJson: async () => (o.mine ?? ["co-a"]).map((id) => ({ id })) },
      json: (status: number, body: unknown) => { out = { status, body }; },
    };
    return { c, out: () => out };
  }
  const seeded = () => {
    const state = new StateStore(null);
    new PlacementLedger(state, { now: () => T0 }).sync(DEV, [lxc(), worker(), lxc({ id: "l-b", heartbeatRunId: "run-b", companyId: "co-b", providerLeaseId: "pve/105" })], { complete: true });
    return state;
  };

  it("follows a run to its container, and the container back to its runs", async () => {
    const state = seeded();
    const a = ctx("/api/placements/runs/run-1", { state });
    expect(await handlePlacements(a.c)).toBe(true);
    expect(a.out()!.body).toMatchObject({ runId: "run-1", status: "active", hidden: 0, placements: [{ resource: { kind: "lxc", node: "pve", vmid: 104 }, companyId: "co-a" }] });
    const b = ctx("/api/placements/resources", { state, query: "?kind=lxc&node=pve&vmid=104" });
    await handlePlacements(b.c);
    expect(b.out()!.body.placements.map((p: any) => p.runId)).toEqual(["run-1"]);
    const w = ctx("/api/placements/resources", { state, query: "?kind=worker&workerId=orion" });
    await handlePlacements(w.c);
    expect(w.out()!.body).toMatchObject({ status: "active", placements: [{ runId: "run-w" }] });
  });

  it("shows another organization's run as restricted, with nothing about it", async () => {
    const r = ctx("/api/placements/runs/run-b", { state: seeded() });
    await handlePlacements(r.c);
    expect(r.out()!.body).toEqual({ runId: "run-b", status: "restricted", placements: [], hidden: 1, lastSyncAt: T0 });
    const res = ctx("/api/placements/resources", { state: seeded(), query: "?kind=lxc&node=pve&vmid=105" });
    await handlePlacements(res.c);
    expect(res.out()!.body).toMatchObject({ status: "restricted", placements: [], hidden: 1 });
    expect(JSON.stringify(res.out()!.body)).not.toContain("run-b");
  });

  it("reports a run the ledger has never seen as unplaced, or unavailable before the first sync", async () => {
    const a = ctx("/api/placements/runs/nope", { state: seeded() });
    await handlePlacements(a.c);
    expect(a.out()!.body.status).toBe("unplaced");
    const b = ctx("/api/placements/runs/nope");
    await handlePlacements(b.c);
    expect(b.out()!.body.status).toBe("unavailable");
  });

  it("reports a live placement the engine hasn't confirmed lately as stale", async () => {
    const r = ctx("/api/placements/runs/run-1", { state: seeded(), t: T0 + STALE_AFTER_MS + 1 });
    await handlePlacements(r.c);
    expect(r.out()!.body.status).toBe("stale");
  });

  it("validates input, allows only GET, and needs the engine", async () => {
    await expect(handlePlacements(ctx("/api/placements/runs/a%20b").c)).rejects.toMatchObject({ status: 400 });
    await expect(handlePlacements(ctx("/api/placements/resources", { query: "?kind=lxc&node=pve&vmid=abc" }).c)).rejects.toMatchObject({ status: 400 });
    await expect(handlePlacements(ctx("/api/placements/resources", { query: "?kind=lxc&node=../x&vmid=104" }).c)).rejects.toMatchObject({ status: 400 });
    await expect(handlePlacements(ctx("/api/placements/resources", { query: "?kind=vm" }).c)).rejects.toMatchObject({ status: 400 });
    await expect(handlePlacements(ctx("/api/placements/runs/run-1", { method: "POST" }).c)).rejects.toMatchObject({ status: 405 });
    await expect(handlePlacements(ctx("/api/placements/runs/run-1", { gateway: false }).c)).rejects.toMatchObject({ status: 503 });
    expect(await handlePlacements(ctx("/api/other").c)).toBe(false);
  });
});

describe("through the real app", () => {
  it("is signed-in only and reaches the feature (no engine configured: 503, never 404)", async () => {
    const { startAccessApp } = await import("./access-harness.ts");
    const h = await startAccessApp();
    try {
      expect((await h.call("GET", "/api/placements/runs/run-1")).status).toBe(401);
      expect((await h.call("GET", "/api/placements/resources?kind=lxc&node=pve&vmid=104")).status).toBe(401);
      const cookie = await h.signIn("kim");
      const r = await h.call("GET", "/api/placements/runs/run-1", { cookie });
      expect(r.status).toBe(503);
      expect((await r.json() as { code?: string }).code).toBe("engine_unavailable");
      expect((await h.call("GET", "/api/placements/runs/a%20b", { cookie })).status).toBe(400);
    } finally {
      await h.close();
    }
  });
});

describe("reading the engine's leases for the ledger", () => {
  async function containers(routes: Record<string, unknown>) {
    const { AgentContainers: AC } = await import("../src/containers.ts");
    const calls: string[] = [];
    const gateway: any = {
      serviceJson: async (_m: string, path: string) => {
        calls.push(path);
        const r = routes[path.split("?")[0]!];
        if (r instanceof Error) throw r;
        if (r === undefined) throw new HttpError(404, "not_found", "no route");
        return r;
      },
    };
    return { c: new AC({ gateway, state: new StateStore(null), node: "pve", pveUrl: "https://127.0.0.1:8006" }), calls };
  }

  it("collects every environment's leases from every active organization, and says the read was complete", async () => {
    const { c, calls } = await containers({
      "/api/companies": [{ id: "co-a", status: "active" }, { id: "co-old", status: "archived" }, { id: "co-b", status: "active" }],
      "/api/companies/co-a/environments": [{ id: "env-1" }, { id: "env-2" }],
      "/api/companies/co-b/environments": [{ id: "env-3" }],
      "/api/environments/env-1/leases": [lxc({ id: "l1" })],
      "/api/environments/env-2/leases": [worker({ id: "l2" })],
      "/api/environments/env-3/leases": [lxc({ id: "l3", companyId: "co-b", providerLeaseId: "pve/110" })],
    });
    const r = await c.leaseRows();
    expect(r.complete).toBe(true);
    expect(r.rows.map((x: any) => x.id).sort()).toEqual(["l1", "l2", "l3"]);
    expect(calls.some((p: string) => p.includes("co-old"))).toBe(false); // archived organizations are not read
    const led = ledger();
    expect(led.sync(DEV, r.rows, { complete: r.complete }).recorded).toBe(3);
    expect(led.lastSync(DEV)).toBe(T0);
  });

  it("is not complete when an environment can't be read, but keeps what it did read", async () => {
    const { c } = await containers({
      "/api/companies": [{ id: "co-a", status: "active" }],
      "/api/companies/co-a/environments": [{ id: "env-1" }, { id: "env-2" }],
      "/api/environments/env-1/leases": [lxc({ id: "l1" })],
      "/api/environments/env-2/leases": new Error("engine hiccup"),
    });
    const r = await c.leaseRows();
    expect(r.complete).toBe(false);
    expect(r.rows).toHaveLength(1);
    const led = ledger();
    led.sync(DEV, r.rows, { complete: r.complete });
    expect(led.lastSync(DEV)).toBeNull(); // a partial read never makes older placements look confirmed
  });

  it("is not complete, and empty, when the engine can't list organizations", async () => {
    const { c } = await containers({ "/api/companies": new Error("down") });
    expect(await c.leaseRows()).toEqual({ rows: [], complete: false });
  });

  it("ignores a lease list that isn't a list", async () => {
    const { c } = await containers({ "/api/companies": [{ id: "co-a" }], "/api/companies/co-a/environments": [{ id: "env-1" }], "/api/environments/env-1/leases": { oops: true } });
    expect(await c.leaseRows()).toEqual({ rows: [], complete: false });
  });
});
