import { afterEach, describe, expect, it, vi } from "vitest";
import { adoptOnline, control, newWorker, startHost, until, type Host, type Worker } from "./fabric-harness.ts";
const hs: Host[] = [], ws: Worker[] = [];
afterEach(async () => { for (const w of ws.splice(0)) w.client.stop(); for (const h of hs.splice(0)) await h.close(); });
async function setup(memMb = 16384, hbMs = 3000, now?: () => number) {
  const h = await startHost({ hbMs, now }); hs.push(h);
  const w = newWorker({ caps: { memMb } }); ws.push(w);
  const id = await adoptOnline(h, w);
  return { h, w, id };
}
const request = (agentId: string, memoryMb = 512) => ({ agentId, runId: agentId, environmentId: "env", requirements: { memoryMb } });

describe("worker resource admission", () => {
  it("defaults Orion to one run and preserves thread workspace after release", async () => {
    const { h } = await setup(7475);
    expect(h.hub.workers()[0]!.shellSlots).toBe(1);
    const first = await h.hub.acquire("co", { ...request("a"), workspaceKey: "thread-1", reuse: true });
    await expect(h.hub.acquire("co", request("b"))).rejects.toMatchObject({ code: "no_capacity" });
    await h.hub.release("co", first.id);
    const resumed = await h.hub.acquire("co", { ...request("a"), runId: "a2", workspaceKey: "thread-1", reuse: true });
    expect(resumed.workspace).toBe(first.workspace);
    expect(h.hub.workers()[0]!.usage.reservedMemoryMb).toBe(512);
  });
  it("atomically reserves memory before asynchronous workspace preparation", async () => {
    const { h } = await setup();
    const results = await Promise.allSettled([h.hub.acquire("co", request("a", 9000)), h.hub.acquire("co", request("b", 9000))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(h.hub.workers()[0]!.usage.reservedMemoryMb).toBe(9000);
    const lease = h.hub.leases()[0]!;
    await h.hub.release("co", lease.id);
    await h.hub.acquire("co", request("c", 9000));
    await expect(h.hub.resume("co", lease.id)).rejects.toMatchObject({ code: "no_capacity" });
  });
  it("preserves a memory reservation through the real control API", async () => {
    const { h } = await setup();
    const token = h.hub.issueControlToken("co");
    const result = await control(h, token, "/control/v1/leases", request("api", 9000));
    expect(result.status).toBe(201);
    expect(h.hub.leases()[0]!.memoryMb).toBe(9000);
    expect((await control(h, token, "/control/v1/leases", request("api2", 9000))).status).toBe(409);
  });
  it("reclaims a failed acquire and failed resume reservation", async () => {
    const { h } = await setup();
    const call = h.hub.call.bind(h.hub);
    const spy = vi.spyOn(h.hub, "call").mockImplementationOnce(async () => { throw new Error("workspace failed"); });
    await expect(h.hub.acquire("co", request("a", 9000))).rejects.toThrow(/workspace failed/);
    expect(h.hub.workers()[0]!.usage.reservedMemoryMb).toBe(0);
    spy.mockRestore();
    const lease = await h.hub.acquire("co", request("b", 9000));
    await h.hub.release("co", lease.id);
    vi.spyOn(h.hub, "call").mockImplementationOnce(async () => { throw new Error("resume failed"); });
    await expect(h.hub.resume("co", lease.id)).rejects.toThrow(/resume failed/);
    expect(h.hub.workers()[0]!.usage.reservedMemoryMb).toBe(0);
    vi.spyOn(h.hub, "call").mockImplementation(call);
  });
  it("keeps reservations through an offline release, clearing them on reconnect", async () => {
    const { h, w } = await setup();
    const lease = await h.hub.acquire("co", request("a", 9000));
    w.client.stop();
    await until(() => !h.hub.workers()[0]!.online);
    await h.hub.release("co", lease.id);
    expect(h.hub.workers()[0]!.usage.reservedMemoryMb).toBe(9000);
    const back = newWorker({ dir: w.dir }); ws.push(back); await back.client.start();
    await until(() => h.hub.workers()[0]!.online && h.hub.workers()[0]!.usage.reservedMemoryMb === 0);
  });
  it("does not treat streamed output as fresh memory telemetry", async () => {
    let now = 1_000_000;
    const { h } = await setup(16384, 100_000, () => now);
    const lease = await h.hub.acquire("co", request("a"));
    now += 300_001;
    await h.hub.exec("co", lease.id, { command: "echo", args: ["alive"] }, () => {} ).catch(() => {});
    // exec cannot start while offline; a capabilities reply is a live channel frame, but not a heartbeat.
    await h.hub.call(lease.workerId, "ws.ensure", { path: lease.workspace });
    const probe = h.hub.probe("co", {});
    expect(probe.sel).toMatchObject({ ok: false, reasons: [{ reasons: ["fresh available-memory telemetry is required"] }] });
  });
});
