import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectLink, tunnelDelayMs } from "../src/connectLink.ts";
import { StateStore } from "../src/state.ts";
import { fakeConnect, fakeTunnelHelper } from "./fakes-papercliped.ts";

afterEach(() => vi.useRealTimers());

async function paired() {
  const fc = fakeConnect(), th = fakeTunnelHelper();
  const state = new StateStore(null);
  const link = new ConnectLink(state, fc.fetch, "https://connect.test", () => fc.state.now(), { helper: th.helper, random: () => 0 });
  await link.start(); fc.approve("acct_a1"); await link.poll(); await link.confirm("acct_a1", "box");
  return { fc, th, state, link };
}
const nextAt = (link: ConnectLink) => link.status().tunnel!.nextCheckAt!;

describe("tunnel schedule", () => {
  it("polls a provisioning device with capped exponential backoff and re-checks a running one slowly", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map((n) => tunnelDelayMs("not_ready", n, 0))).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
    expect([1, 2, 3, 20].map((n) => tunnelDelayMs("unreachable", n, 0))).toEqual([20_000, 40_000, 80_000, 600_000]);
    expect(tunnelDelayMs("ok", 0, 0)).toBe(900_000);
    expect(tunnelDelayMs("ok", 0, 1)).toBe(1_080_000); // up to +20% jitter
  });
});

describe("Connect tunnel (device side)", () => {
  it("fetches credentials with a real device signature and hands the token to the helper only", async () => {
    const { fc, th, link, state } = await paired();
    const s = await link.setMode("connect");
    expect(s.tunnel).toMatchObject({ state: "running", hostname: fc.state.hostname, lastResult: "ok", helper: { owner: "connect", active: true } });
    expect(th.h.token).toBe(fc.state.token);
    expect(link.publicUrl()).toBe("https://" + fc.state.hostname);
    expect(JSON.stringify(s)).not.toContain(fc.state.token);
    expect(JSON.stringify(state.getSetting("connect.link"))).not.toContain(fc.state.token);
    // unchanged credentials on the next check: no second install, service already running
    th.h.calls.length = 0;
    await link.reconcile();
    expect(th.h.calls).toEqual([]);
    // rotated token: installed again
    fc.state.token = "eyJhIjoiYWNjdCIsInQiOiJyb3RhdGVkIiwicyI6IngifQ==";
    await link.reconcile();
    expect(th.h.calls).toEqual(["install:connect"]);
    expect(th.h.token).toBe(fc.state.token);
  });

  it("waits through 409 not_ready with backoff, then comes up", async () => {
    const { fc, th, link } = await paired();
    fc.state.tunnel = "not_ready";
    let s = await link.setMode("connect");
    expect(s.tunnel).toMatchObject({ state: "waiting", lastResult: "not_ready" });
    const t1 = nextAt(link) - fc.state.now();
    await link.reconcile(); await link.reconcile();
    expect(nextAt(link) - fc.state.now()).toBeGreaterThan(t1 * 2);
    expect(th.h.owner).toBeNull();
    expect(link.publicUrl()).toBeUndefined();
    fc.state.tunnel = "ok";
    s = await link.reconcile();
    expect(s.tunnel).toMatchObject({ state: "running" });
  });

  it("403 no_entitlement stops the tunnel and says a subscription is needed; recovers when it returns", async () => {
    const { fc, th, link } = await paired();
    await link.setMode("connect");
    expect(th.h.active).toBe(true);
    fc.state.tunnel = "no_entitlement";
    const s = await link.reconcile();
    expect(s.tunnel).toMatchObject({ state: "subscription_needed" });
    expect(s.tunnel!.message).toMatch(/Subscription needed/);
    expect(th.h).toMatchObject({ owner: null, token: null, active: false });
    expect(link.publicUrl()).toBeUndefined();
    expect(s.mode).toBe("connect"); // still the chosen mode; local use is untouched
    fc.state.tunnel = "ok";
    expect((await link.reconcile()).tunnel).toMatchObject({ state: "running" });
  });

  it("not_available only stops the tunnel after repeated refusals (a skewed clock looks the same)", async () => {
    const { fc, th, link } = await paired();
    await link.setMode("connect");
    fc.state.tunnel = "not_available";
    await link.reconcile(); await link.reconcile();
    expect(th.h.active).toBe(true);
    const s = await link.reconcile();
    expect(s.tunnel).toMatchObject({ state: "unavailable" });
    expect(th.h.active).toBe(false);
  });

  it("a Connect outage or bad answer keeps the last known state and never throws", async () => {
    const { fc, th, link } = await paired();
    await link.setMode("connect");
    fc.state.down = true;
    let s = await link.reconcile();
    expect(s.tunnel).toMatchObject({ state: "running", lastResult: "unreachable" });
    expect(th.h.active).toBe(true);
    expect(link.publicUrl()).toBe("https://" + fc.state.hostname);
    fc.state.down = false; fc.state.tunnel = "error";
    expect((await link.reconcile()).tunnel!.lastResult).toBe("unreachable"); // 5xx
    fc.state.tunnel = "garbage";
    s = await link.reconcile();
    expect(s.tunnel).toMatchObject({ state: "error", lastResult: "invalid" });
    expect(th.h.token).toBe(fc.state.token); // untouched
  });

  it("refuses to run while the administrator's own Cloudflare tunnel holds the service", async () => {
    const { th, link } = await paired();
    await th.helper.install("self", "selfmanaged-token-0123456789");
    const s = await link.setMode("connect");
    expect(s.tunnel).toMatchObject({ state: "error", lastResult: "conflict" });
    expect(th.h).toMatchObject({ owner: "self", token: "selfmanaged-token-0123456789" });
    expect(link.publicUrl()).toBeUndefined();
  });

  it("a broken helper is reported as an error without breaking anything", async () => {
    const { th, link } = await paired();
    th.h.fail = true;
    const s = await link.setMode("connect");
    expect(s.tunnel).toMatchObject({ state: "error", lastResult: "helper_error" });
    expect(s.tunnel!.helper).toMatchObject({ error: expect.any(String) });
    th.h.fail = false;
    expect((await link.reconcile()).tunnel!.state).toBe("running");
  });

  it("leaving Connect (mode change or unpair) removes the Connect tunnel; a stuck helper is retried", async () => {
    const { th, link } = await paired();
    await link.setMode("connect");
    th.h.fail = true;
    await link.setMode("local"); // helper can't remove right now: mode still changes
    expect(link.mode()).toBe("local");
    expect(link.publicUrl()).toBeUndefined();
    expect(th.h.owner).toBe("connect");
    th.h.fail = false;
    await link.reconcile(); // later: cleaned up
    expect(th.h).toMatchObject({ owner: null, token: null });
    await link.setMode("connect");
    expect(th.h.owner).toBe("connect");
    expect((await link.unpair()).paired).toBe(false);
    expect(th.h).toMatchObject({ owner: null, token: null, active: false });
  });

  it("unpairing also asks Connect to remove the device, with a real signature; an outage keeps it pending until it succeeds", async () => {
    const { fc, link } = await paired();
    const deviceId = link.status().device!.deviceId;
    fc.state.revoke = "error";
    expect((await link.unpair()).paired).toBe(false);                 // local unpair is immediate
    expect(fc.state.revokedDevices).toEqual([]);
    fc.state.revoke = "ok";
    await link.reconcile();                                           // retried later
    expect(fc.state.revokedDevices).toEqual([deviceId]);
    await link.reconcile();
    expect(fc.state.revokedDevices).toEqual([deviceId]);              // not repeated once confirmed
  });

  it("never touches the other mode\'s tunnel when leaving", async () => {
    const { th, link } = await paired();
    await link.setMode("cloudflare-self");
    await th.helper.install("self", "selfmanaged-token-0123456789");
    await link.setMode("local");
    await link.reconcile();
    expect(th.h.owner).toBe("self");
  });

  it("the background timer re-checks on schedule and stops when told", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const { fc, link } = await paired();
    fc.state.tunnel = "not_ready";
    await link.setMode("connect");
    link.watch();
    await vi.advanceTimersByTimeAsync(1);
    const before = fc.state.tunnelCalls;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fc.state.tunnelCalls).toBeGreaterThan(before);
    link.unwatch();
    const stopped = fc.state.tunnelCalls;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fc.state.tunnelCalls).toBe(stopped);
  });
});
