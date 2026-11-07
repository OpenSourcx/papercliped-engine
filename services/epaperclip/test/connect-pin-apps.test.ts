import { describe, expect, it } from "vitest";
import { MCP_TOOLS, type ToolEnv } from "../src/features/connect-tools.ts";
import { PinApps } from "../src/pin-apps.ts";
import { StateStore } from "../src/state.ts";
import { fakeEngine } from "./fakes-pin-apps.ts";

const tool = (name: string) => MCP_TOOLS.find((t) => t.name === name)!;
function env(over: { direct?: boolean; orgs?: string[] | null } = {}) {
  const e = fakeEngine();
  const state = new StateStore(null);
  const gateway = { userJson: (_s: unknown, m: string, p: string, b?: unknown) => e.call(m as never, p, b) };
  const toolEnv = { grant: { direct: over.direct ?? true, orgs: over.orgs === undefined ? ["co-a"] : over.orgs, clientName: "Claude" }, username: "sam@pve", node: "pve", pve: {}, gateway, session: {}, state, now: () => 1, allowFetch: false } as unknown as ToolEnv;
  return { ...e, state, toolEnv, pin: new PinApps(state), engineCall: e.call };
}

describe("call_app_tool over the remote MCP surface", () => {
  it("is a Full-control tool, hinted destructive, with a strict schema; the reads are read-only", () => {
    expect(tool("call_app_tool")).toMatchObject({ access: "control", destructive: true });
    expect(tool("call_app_tool").inputSchema).toMatchObject({ additionalProperties: false, required: ["companyId", "connectionId", "tool"] });
    for (const n of ["list_app_tools", "app_tool_status", "list_app_action_requests"]) expect(tool(n).access).toBe("read");
  });

  it("allowed, approval-required and denied come back as the engine's own decisions", async () => {
    const x = env();
    await x.pin.setAccess(x.engineCall, "co-a", "conn-a", [{ catalogEntryId: "e-read", mode: "allow" }, { catalogEntryId: "e-write", mode: "ask" }]);
    const call = (t: string) => tool("call_app_tool").run({ companyId: "co-a", connectionId: "conn-a", tool: t, parameters: {} }, x.toolEnv);
    expect(await call("read_note")).toEqual({ status: "done", result: "ok read_note" });
    expect(await call("write_note")).toMatchObject({ status: "approval_required", actionRequestId: "ar-1", approveIn: expect.stringContaining("Held app actions") });
    expect(await call("delete_note")).toMatchObject({ status: "denied" });
    expect(x.calls.some((c) => /approve|decline/.test(c.path))).toBe(false);
  });

  it("without 'act without asking' it only proposes a plan and calls nothing", async () => {
    const x = env({ direct: false });
    await x.pin.setAccess(x.engineCall, "co-a", "conn-a", [{ catalogEntryId: "e-read", mode: "allow" }]);
    const before = x.calls.length;
    const r = (await tool("call_app_tool").run({ companyId: "co-a", connectionId: "conn-a", tool: "read_note" }, x.toolEnv)) as { status: string; planId: string; note: string };
    expect(r.status).toBe("proposed");
    expect(r.note).toMatch(/NOTHING has run/);
    expect(x.calls.length).toBe(before);
  });

  it("is limited to the organizations the person chose for the app, and to the connection's own organization", async () => {
    const x = env({ orgs: ["co-b"] });
    await x.pin.setAccess(x.engineCall, "co-a", "conn-a", [{ catalogEntryId: "e-read", mode: "allow" }]);
    const before = x.calls.length;
    await expect(tool("call_app_tool").run({ companyId: "co-a", connectionId: "conn-a", tool: "read_note" }, x.toolEnv)).rejects.toMatchObject({ code: "not_allowed" });
    expect(x.calls.length).toBe(before);
    const y = env();
    await y.pin.setAccess(y.engineCall, "co-a", "conn-a", [{ catalogEntryId: "e-read", mode: "allow" }]);
    await expect(tool("call_app_tool").run({ companyId: "co-a", connectionId: "conn-b", tool: "read_note" }, y.toolEnv)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses until Pin is enabled in the organization, and revoking takes effect at once", async () => {
    const x = env();
    await expect(tool("call_app_tool").run({ companyId: "co-a", connectionId: "conn-a", tool: "read_note" }, x.toolEnv)).rejects.toMatchObject({ code: "pin_not_enabled" });
    await x.pin.setAccess(x.engineCall, "co-a", "conn-a", [{ catalogEntryId: "e-read", mode: "allow" }]);
    expect(await tool("call_app_tool").run({ companyId: "co-a", connectionId: "conn-a", tool: "read_note" }, x.toolEnv)).toMatchObject({ status: "done" });
    await x.pin.revokeAll(x.engineCall, "co-a");
    expect(await tool("call_app_tool").run({ companyId: "co-a", connectionId: "conn-a", tool: "read_note" }, x.toolEnv)).toMatchObject({ status: "denied" });
  });

  it("rejects unknown arguments and bad ids before anything is called", async () => {
    const x = env();
    await expect(tool("call_app_tool").run({ companyId: "co-a", connectionId: "conn-a", tool: "t", extra: 1 }, x.toolEnv)).rejects.toMatchObject({ code: "bad_args" });
    await expect(tool("call_app_tool").run({ companyId: "../x", connectionId: "conn-a", tool: "t" }, x.toolEnv)).rejects.toMatchObject({ code: "bad_args" });
    expect(x.calls).toEqual([]);
  });
});
