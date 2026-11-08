import { describe, expect, it } from "vitest";
import { PinApps, type EngineCall } from "../src/pin-apps.ts";
import { StateStore } from "../src/state.ts";
import { fakeEngine } from "./fakes-pin-apps.ts";
import { ACTS } from "../src/features/pin-act.ts";

const mk = () => { const e = fakeEngine(); return { ...e, pin: new PinApps(new StateStore(null)) }; };

describe("Pin's identity for organization apps", () => {
  it("refuses everything until an administrator enables it, and enabling creates a paused identity with default deny", async () => {
    const { pin, call, agents, policies } = mk();
    await expect(pin.callTool(call, "co-a", "conn-a", "read_note", {})).rejects.toMatchObject({ code: "pin_not_enabled" });
    const { agentId } = await pin.enable(call, "co-a");
    expect(agents.get(agentId)).toMatchObject({ status: "paused", name: "Pin (host)" });
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ policyType: "block", priority: 1000, selectors: { agentId } });
    await pin.enable(call, "co-a");
    expect(policies).toHaveLength(1); // idempotent
    expect([...agents.values()]).toHaveLength(1);
    // Nothing was chosen, so a call is refused (denied), not run.
    expect(await pin.callTool(call, "co-a", "conn-a", "read_note", {})).toMatchObject({ outcome: "denied" });
  });

  it("adopts its own identity after state was lost, but never an agent that merely has the same name", async () => {
    const { pin, call, agents } = mk();
    const { agentId } = await pin.enable(call, "co-a");
    const fresh = new PinApps(new StateStore(null)); // state lost
    expect((await fresh.enable(call, "co-a")).agentId).toBe(agentId);
    expect([...agents.values()]).toHaveLength(1);
    // An impostor with the same name but another adapter is not adopted.
    const e2 = mk();
    e2.agents.set("imp", { id: "imp", companyId: "co-a", status: "paused", name: "Pin (host)", adapterType: "claude_local", adapterConfig: {} });
    const made = await e2.pin.enable(e2.call, "co-a");
    expect(made.agentId).not.toBe("imp");
  });

  it("allowed, approval-required and denied actions come back as the engine decided, and Pin never approves", async () => {
    const { pin, call, calls } = mk();
    await pin.setAccess(call, "co-a", "conn-a", [{ catalogEntryId: "e-read", mode: "allow" }, { catalogEntryId: "e-write", mode: "ask" }, { catalogEntryId: "e-del", mode: "off" }]);
    expect(await pin.callTool(call, "co-a", "conn-a", "read_note", { id: "1" })).toEqual({ outcome: "done", result: "ok read_note" });
    expect(await pin.callTool(call, "co-a", "conn-a", "write_note", {})).toMatchObject({ outcome: "approval_required", actionRequestId: "ar-1" });
    expect(await pin.callTool(call, "co-a", "conn-a", "delete_note", {})).toMatchObject({ outcome: "denied" });
    expect(await pin.callTool(call, "co-a", "conn-a", "never_listed", {})).toMatchObject({ outcome: "denied" });
    expect(calls.some((c) => /approve|decline/.test(c.path))).toBe(false);
    expect(await pin.callStatus(call, "co-a", "conn-a", "ar-1")).toEqual({ phase: "waiting" });
  });

  it("reports a provider error under an allowed policy as failed, not done", async () => {
    const { pin, call } = mk();
    await pin.setAccess(call, "co-a", "conn-a", [{ catalogEntryId: "e-broken", mode: "allow" }]);
    expect(await pin.callTool(call, "co-a", "conn-a", "broken_tool", {})).toEqual({ outcome: "failed", message: "boom" });
  });

  it("revoking an action or everything takes effect on the next call", async () => {
    const { pin, call, policies } = mk();
    await pin.setAccess(call, "co-a", "conn-a", [{ catalogEntryId: "e-read", mode: "allow" }, { catalogEntryId: "e-write", mode: "allow" }]);
    expect((await pin.access(call, "co-a")).entries.map((e) => e.mode)).toEqual(["allow", "allow"]);
    await pin.setAccess(call, "co-a", "conn-a", [{ catalogEntryId: "e-read", mode: "allow" }, { catalogEntryId: "e-write", mode: "off" }]);
    expect(await pin.callTool(call, "co-a", "conn-a", "write_note", {})).toMatchObject({ outcome: "denied" });
    // allow -> ask changes the policy type, never leaving the action allowed in between
    await pin.setAccess(call, "co-a", "conn-a", [{ catalogEntryId: "e-read", mode: "ask" }]);
    expect(await pin.callTool(call, "co-a", "conn-a", "read_note", {})).toMatchObject({ outcome: "approval_required" });
    await pin.revokeAll(call, "co-a");
    expect(policies.filter((p) => p.policyType !== "block")).toEqual([]);
    expect(await pin.callTool(call, "co-a", "conn-a", "read_note", {})).toMatchObject({ outcome: "denied" });
  });

  it("works only inside one organization: another organization's connection or identity is never used", async () => {
    const { pin, call } = mk();
    await pin.setAccess(call, "co-a", "conn-a", [{ catalogEntryId: "e-read", mode: "allow" }]);
    await expect(pin.callTool(call, "co-a", "conn-b", "read_note", {})).rejects.toMatchObject({ status: 404 });
    await expect(pin.setAccess(call, "co-a", "conn-b", [{ catalogEntryId: "e-read", mode: "allow" }])).rejects.toMatchObject({ status: 404 });
    // Organization B has no identity of its own yet, so Organization A's identity cannot be borrowed.
    await expect(pin.callTool(call, "co-b", "conn-b", "read_note", {})).rejects.toMatchObject({ code: "pin_not_enabled" });
    await expect(pin.callStatus(call, "co-a", "conn-b", "ar-1")).rejects.toMatchObject({ status: 404 });
  });

  it("stops using an identity the engine no longer shows for that organization", async () => {
    const { pin, call, agents } = mk();
    await pin.setAccess(call, "co-a", "conn-a", [{ catalogEntryId: "e-read", mode: "allow" }]);
    const id = [...agents.keys()][0]!;
    agents.get(id).status = "terminated";
    await expect(pin.callTool(call, "co-a", "conn-a", "read_note", {})).rejects.toMatchObject({ code: "pin_not_enabled" });
    agents.set(id, { ...agents.get(id), status: "paused", companyId: "co-b" });
    await expect(pin.callTool(call, "co-a", "conn-a", "read_note", {})).rejects.toMatchObject({ code: "pin_not_enabled" });
  });

  it("rejects bad input and unavailable or unknown actions before changing anything", async () => {
    const { pin, call, policies } = mk();
    await expect(pin.setAccess(call, "../x", "conn-a", [])).rejects.toMatchObject({ status: 400 });
    await expect(pin.setAccess(call, "co-a", "conn-a", [{ catalogEntryId: "nope", mode: "allow" }])).rejects.toMatchObject({ status: 400 });
    await expect(pin.setAccess(call, "co-a", "conn-a", [{ catalogEntryId: "e-gone", mode: "allow" }])).rejects.toMatchObject({ status: 400 });
    await expect(pin.setAccess(call, "co-a", "conn-a", [{ catalogEntryId: "e-read", mode: "root" as never }])).rejects.toMatchObject({ status: 400 });
    expect(policies.filter((p) => p.policyType !== "block")).toEqual([]);
    await expect(pin.callTool(call, "co-a", "conn-a", "", {})).rejects.toMatchObject({ status: 400 });
  });

  it("the Pin action asks the person first in ask and plan modes, runs only through the identity, and is never 'safe'", async () => {
    const def = ACTS.call_app_tool!;
    expect(def.risk({})).toBe("disruptive");
    expect(() => def.parse({ companyId: "co-a", connectionId: "conn-a", tool: "x", extra: 1 })).toThrow();
    expect(() => def.parse({ companyId: "../x", connectionId: "conn-a", tool: "x" })).toThrow();
    const parsed = def.parse({ companyId: "co-a", connectionId: "conn-a", tool: "read_note", parameters: { id: "1" } });
    const { pin, call } = mk();
    await pin.setAccess(call, "co-a", "conn-a", [{ catalogEntryId: "e-read", mode: "allow" }, { catalogEntryId: "e-write", mode: "ask" }]);
    const host = { node: "pve", username: "sam", pve: async () => ({}) as never, apps: { pin, call } };
    expect((await def.run(host, parsed)).result).toMatch(/^Done: ok read_note/);
    expect((await def.run(host, { ...parsed, tool: "write_note" })).result).toMatch(/Waiting for approval.*Nothing has been done yet/);
    await expect(def.run(host, { ...parsed, tool: "delete_note" })).rejects.toThrow(/Refused/);
    await expect(def.run({ ...host, apps: undefined }, parsed)).rejects.toThrow(/engine isn't set up/);
  });
});
