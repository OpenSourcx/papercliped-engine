import { describe, expect, it } from "vitest";
import { ConnectLink } from "../src/connectLink.ts";
import { StateStore } from "../src/state.ts";
import { fakeConnect, fakeTunnelHelper } from "./fakes-papercliped.ts";

const make = () => {
  const fc = fakeConnect();
  const state = new StateStore(null);
  const link = new ConnectLink(state, fc.fetch, "https://connect.test", () => fc.state.now(), { helper: fakeTunnelHelper().helper });
  return { fc, state, link };
};

describe("Papercliped Connect pairing (device side)", () => {
  it("pairs end to end: proof, owner approval, administrator confirmation, device-signed completion", async () => {
    const { fc, link, state } = make();
    expect(link.status()).toEqual({ mode: "local", paired: false });
    const s = await link.start();
    expect(s.pairing).toMatchObject({ state: "pending" });
    expect(s.pairing!.approvalUrl).toBe(`https://console.papercliped.co/devices/pair?pairing_id=${s.pairing!.id}`);
    expect(JSON.stringify(s)).not.toMatch(/token/i);
    expect((await link.poll()).pairing!.state).toBe("pending");
    fc.approve("acct_one");
    const polled = await link.poll();
    expect(polled.pairing).toMatchObject({ state: "approved", selectedOwner: "acct_one" });
    await expect(link.confirm("acct_other", "lab")).rejects.toMatchObject({ code: "owner_mismatch" });
    const done = await link.confirm("acct_one", " lab-node ");
    expect(done.paired).toBe(true);
    expect(done.device).toMatchObject({ accountId: "acct_one", name: "lab-node" });
    expect(done.pairing).toBeUndefined();
    expect(state.getSecret("connect.pairing.token")).toBeNull(); // challenge token is gone
    await expect(link.start()).rejects.toMatchObject({ code: "already_paired" });
  });

  it("cannot confirm before approval, and an expired pairing is reported and refused", async () => {
    const { fc, link } = make();
    await link.start();
    await expect(link.confirm("acct_one", "lab")).rejects.toMatchObject({ code: "not_approved" });
    fc.approve("acct_one"); await link.poll();
    fc.state.now = () => Date.now() + 3_600_000;
    expect(link.status().pairing!.state).toBe("expired");
    await expect(link.confirm("acct_one", "lab")).rejects.toMatchObject({ code: "expired" });
  });

  it("fails closed when Connect is down and never changes local state", async () => {
    const { fc, link } = make();
    fc.state.down = true;
    await expect(link.start()).rejects.toMatchObject({ status: 502, code: "connect_unreachable" });
    expect(link.status()).toEqual({ mode: "local", paired: false });
  });

  it("reports a refusal at once instead of waiting for the pairing to expire", async () => {
    const { fc, link, state } = make();
    await link.start();
    fc.deny();
    const s = await link.poll();
    expect(s.pairing!.state).toBe("denied");
    expect(s.paired).toBe(false);
    expect(state.getSecret("connect.pairing.token")).toBeNull();
    await expect(link.confirm("acct_one", "lab")).rejects.toMatchObject({ code: "not_approved" });
  });

  it("modes are exclusive: remote modes switch only via local-only, and Connect needs a pairing", async () => {
    const { fc, link } = make();
    expect((await link.setMode("cloudflare-self")).mode).toBe("cloudflare-self");
    await expect(link.setMode("connect")).rejects.toThrow(/local-only first|Pair/);
    await link.setMode("local");
    await expect(link.setMode("connect")).rejects.toThrow(/Pair this machine/);
    await expect(link.setMode("bogus")).rejects.toThrow(/Mode must be/);
    await link.start(); fc.approve("acct_a1"); await link.poll(); await link.confirm("acct_a1", "box");
    expect((await link.setMode("connect")).mode).toBe("connect");
    expect(() => link.assertSelfManagedAllowed()).toThrow(/Connect is managing/);
    await expect(link.setMode("cloudflare-self")).rejects.toThrow(/local-only first/);
    expect(await link.unpair()).toEqual({ mode: "local", paired: false });
    expect(() => link.assertSelfManagedAllowed()).not.toThrow();
  });

  it("refuses a non-https Connect URL except on loopback", () => {
    const st = new StateStore(null);
    expect(() => new ConnectLink(st, fakeConnect().fetch, "http://connect.example")).toThrow(/https/);
    expect(() => new ConnectLink(st, fakeConnect().fetch, "http://127.0.0.1:9")).not.toThrow();
  });
});
