import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertEnvironmentEventOrder, assertExecutionLifecycle, assertLeaseLifecycle, assertWorkspaceRealizationLifecycle, createEnvironmentTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { createRemoteWorkerPlugin } from "../src/plugin.js";
import { checkConfig, parseConfig } from "../src/config.js";
import { FakeControl } from "./fake-control.js";

let fc: FakeControl;
beforeAll(async () => { fc = new FakeControl(); await fc.start(); });
afterAll(async () => { await fc.stop(); });

const cfg = (over: Record<string, unknown> = {}) => ({ controlUrl: fc.url, controlToken: fc.token, ...over });
function harness() {
  const plugin = createRemoteWorkerPlugin();
  const d = plugin.definition;
  const h = createEnvironmentTestHarness({
    manifest,
    environmentDriver: {
      driverKey: "remote-worker", onValidateConfig: d.onEnvironmentValidateConfig, onProbe: d.onEnvironmentProbe, onAcquireLease: d.onEnvironmentAcquireLease, onResumeLease: d.onEnvironmentResumeLease,
      onReleaseLease: d.onEnvironmentReleaseLease, onStopLease: d.onEnvironmentStopLease, onDestroyLease: d.onEnvironmentDestroyLease, onRealizeWorkspace: d.onEnvironmentRealizeWorkspace, onExecute: d.onEnvironmentExecute,
    },
  });
  return { plugin, h };
}
const base = (config: Record<string, unknown>, env = "env-1") => ({ driverKey: "remote-worker", companyId: "co1", environmentId: env, config });

describe("config", () => {
  it("requires a token and refuses to send it in clear text off the machine", () => {
    expect(checkConfig(parseConfig({})).errors.join(" ")).toMatch(/controlToken/);
    expect(checkConfig(parseConfig({ controlToken: "x", controlUrl: "http://10.0.0.5:3130" })).errors.join(" ")).toMatch(/https/);
    expect(checkConfig(parseConfig({ controlToken: "x", controlUrl: "https://fabric.example:3130" })).errors).toEqual([]);
    expect(checkConfig(parseConfig({ controlToken: "x" })).errors).toEqual([]);
    expect(checkConfig(parseConfig({ controlToken: "x", timeoutMs: 5 })).errors.join(" ")).toMatch(/timeoutMs/);
  });
});

describe("Paperclip environment harness", () => {
  it("runs the lifecycle: validate, probe, acquire, realize, execute, release", async () => {
    const { plugin, h } = harness();
    await plugin.definition.setup(h.ctx);
    const config = cfg({ reuseLease: false });
    expect(await h.validateConfig({ driverKey: "remote-worker", config })).toMatchObject({ ok: true });
    expect(await h.probe(base(config))).toMatchObject({ ok: true });
    const lease = await h.acquireLease({ ...base(config), runId: "run-1", agentId: "agent-1" });
    expect(lease.providerLeaseId).toMatch(/^wl_/);
    const ws = await h.realizeWorkspace({ ...base(config), lease, workspace: { mode: "isolated_workspace" } });
    expect(ws.cwd).toBe("/workspaces/co1/agent-1/run-1");
    const out = await h.execute({ ...base(config), lease, command: "make", args: ["test"], cwd: ws.cwd });
    expect(out).toMatchObject({ exitCode: 0, timedOut: false });
    expect(out.stdout).toContain("ran make in /workspaces/co1/agent-1/run-1");
    expect(out.stderr).toContain("warn");
    // Output also streams through ctx.execution.log while the command runs.
    expect(h.logs.some((l) => l.message === "Remote worker provider ready")).toBe(true);
    expect(await h.releaseLease({ ...base(config), providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata })).toEqual({ providerLeaseId: lease.providerLeaseId, state: "destroyed" });
    assertEnvironmentEventOrder(h.environmentEvents, ["validateConfig", "probe", "acquireLease", "realizeWorkspace", "execute", "releaseLease"]);
    assertLeaseLifecycle(h.environmentEvents, "env-1");
    assertWorkspaceRealizationLifecycle(h.environmentEvents, "env-1");
    assertExecutionLifecycle(h.environmentEvents, "env-1");
  });

  it("runs the reusable lifecycle: release keeps the workspace, resume brings it back, destroy removes it", async () => {
    const { plugin, h } = harness();
    await plugin.definition.setup(h.ctx);
    const config = cfg({ reuseLease: true });
    const b = base(config, "env-2");
    const lease = await h.acquireLease({ ...b, runId: "run-1", agentId: "agent-1" });
    expect(await h.releaseLease({ ...b, providerLeaseId: lease.providerLeaseId })).toBeUndefined();
    expect(fc.leases.get(lease.providerLeaseId!)!.state).toBe("released");
    const resumed = await h.resumeLease({ ...b, providerLeaseId: lease.providerLeaseId!, leaseMetadata: lease.metadata });
    expect(resumed.providerLeaseId).toBe(lease.providerLeaseId);
    expect(fc.leases.get(lease.providerLeaseId!)!.state).toBe("active");
    expect((await h.execute({ ...b, lease: resumed, command: "true" })).exitCode).toBe(0);
    expect(await h.stopLease({ ...b, providerLeaseId: lease.providerLeaseId })).toEqual({ providerLeaseId: lease.providerLeaseId, state: "stopped" });
    expect(await h.destroyLease({ ...b, providerLeaseId: lease.providerLeaseId })).toMatchObject({ state: "destroyed" });
    expect(await h.resumeLease({ ...b, providerLeaseId: lease.providerLeaseId! })).toEqual({ providerLeaseId: null, metadata: { expired: true } });
    // Destroying again is not an error.
    expect(await h.destroyLease({ ...b, providerLeaseId: lease.providerLeaseId })).toMatchObject({ state: "destroyed" });
    assertEnvironmentEventOrder(h.environmentEvents, ["acquireLease", "releaseLease", "resumeLease", "execute", "stopLease", "destroyLease", "resumeLease", "destroyLease"]);
  });

  it("never asks the Fabric to touch a node: only lease paths are ever called", async () => {
    const { plugin, h } = harness();
    await plugin.definition.setup(h.ctx);
    fc.paths.length = 0;
    const config = cfg({ reuseLease: false });
    const b = base(config, "env-3");
    await h.probe(b);
    const lease = await h.acquireLease({ ...b, runId: "r", agentId: "a" });
    await h.execute({ ...b, lease, command: "true" });
    await h.stopLease({ ...b, providerLeaseId: lease.providerLeaseId });
    await h.releaseLease({ ...b, providerLeaseId: lease.providerLeaseId });
    await h.destroyLease({ ...b, providerLeaseId: lease.providerLeaseId });
    expect(fc.paths.length).toBeGreaterThan(4);
    for (const p of fc.paths) expect(p).toMatch(/^\/control\/v1\/(probe|leases(\/wl_\d+\/(resume|workspace|exec|release|stop|destroy))?)$/);
    expect(fc.worker).toEqual({ id: "wrk_1", name: "orion", online: true });
  });

  it("fails clearly: a bad token, an unreachable fabric and a failing worker", async () => {
    const { plugin, h } = harness();
    await plugin.definition.setup(h.ctx);
    const bad = base(cfg({ controlToken: "fct_wrong" }), "env-4");
    const probe = await h.probe(bad);
    expect(probe.ok).toBe(false);
    expect(probe.summary).toMatch(/rejected the control token/);
    await expect(h.acquireLease({ ...bad, runId: "r", agentId: "a" })).rejects.toThrow(/control token|unauthor|no/i);
    const down = base(cfg({ controlUrl: "http://127.0.0.1:1" }), "env-5");
    expect((await h.probe(down)).ok).toBe(false);
    fc.failProbe = true;
    const nope = await h.probe(base(cfg(), "env-6"));
    fc.failProbe = false;
    expect(nope.ok).toBe(false);
    const good = base(cfg(), "env-7");
    const lease = await h.acquireLease({ ...good, runId: "r", agentId: "a" });
    expect(await h.execute({ ...good, lease, command: "false" })).toMatchObject({ exitCode: 1 });
    await h.destroyLease({ ...good, providerLeaseId: lease.providerLeaseId });
    const after = await h.execute({ ...good, lease, command: "true" });
    expect(after.exitCode).toBe(1);
    expect(after.stderr).toMatch(/remote-worker/);
  });
});
