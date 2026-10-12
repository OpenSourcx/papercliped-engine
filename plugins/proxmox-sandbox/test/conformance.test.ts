/**
 * Runs the provider through Paperclip's own environment test harness
 * (`@paperclipai/plugin-sdk/testing`): validate → probe → acquire → realize →
 * execute → release, plus the reuse path (acquire → release keeps → resume →
 * destroy), against the fake Proxmox API and a local shell for SSH.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertEnvironmentEventOrder,
  assertExecutionLifecycle,
  assertLeaseLifecycle,
  assertWorkspaceRealizationLifecycle,
  createEnvironmentTestHarness,
} from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { createProxmoxSandboxPlugin } from "../src/plugin.js";
import { FakeProxmox } from "./fake-proxmox.js";
import { baseConfig, createLocalShell, generatePemKey, noSleep } from "./helpers.js";

let pve: FakeProxmox;
let home: string;

beforeAll(async () => {
  pve = new FakeProxmox();
  await pve.start();
  pve.addTemplate(9000);
  home = mkdtempSync(path.join(tmpdir(), "pve-conformance-"));
});

afterAll(async () => {
  await pve.stop();
  rmSync(home, { recursive: true, force: true });
});

function harnessFor(plugin: ReturnType<typeof createProxmoxSandboxPlugin>) {
  const d = plugin.definition;
  const harness = createEnvironmentTestHarness({
    manifest,
    environmentDriver: {
      driverKey: "proxmox",
      onValidateConfig: d.onEnvironmentValidateConfig,
      onProbe: d.onEnvironmentProbe,
      onAcquireLease: d.onEnvironmentAcquireLease,
      onResumeLease: d.onEnvironmentResumeLease,
      onReleaseLease: d.onEnvironmentReleaseLease,
      onStopLease: d.onEnvironmentStopLease,
      onDestroyLease: d.onEnvironmentDestroyLease,
      onRealizeWorkspace: d.onEnvironmentRealizeWorkspace,
      onExecute: d.onEnvironmentExecute,
    },
  });
  return harness;
}

describe("Paperclip environment harness", () => {
  it("runs the ephemeral lifecycle", async () => {
    const plugin = createProxmoxSandboxPlugin({ ssh: createLocalShell(home).runner, sleep: noSleep });
    const harness = harnessFor(plugin);
    await plugin.definition.setup(harness.ctx);
    const config = baseConfig(pve, generatePemKey());
    const base = { driverKey: "proxmox", companyId: "company-1", environmentId: "env-1", config };

    expect(await harness.validateConfig({ driverKey: "proxmox", config })).toMatchObject({ ok: true });
    expect(await harness.probe(base)).toMatchObject({ ok: true });
    const lease = await harness.acquireLease({ ...base, runId: "run-1" });
    const realized = await harness.realizeWorkspace({ ...base, lease, workspace: { mode: "isolated_workspace" } });
    const executed = await harness.execute({ ...base, lease, command: "sh", args: ["-c", "printf proxmox-ok"], cwd: realized.cwd, timeoutMs: 10_000 });
    expect(executed).toMatchObject({ exitCode: 0, timedOut: false, stdout: "proxmox-ok" });
    expect(await harness.releaseLease({ ...base, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata })).toEqual({
      providerLeaseId: lease.providerLeaseId,
      state: "destroyed",
    });

    assertEnvironmentEventOrder(harness.environmentEvents, ["validateConfig", "probe", "acquireLease", "realizeWorkspace", "execute", "releaseLease"]);
    assertLeaseLifecycle(harness.environmentEvents, "env-1");
    assertWorkspaceRealizationLifecycle(harness.environmentEvents, "env-1");
    assertExecutionLifecycle(harness.environmentEvents, "env-1");
    expect(harness.logs.some((l) => l.message === "Proxmox sandbox provider ready")).toBe(true);
    expect(pve.containers.has(Number(lease.providerLeaseId!.split("/")[1]))).toBe(false);
  });

  it("runs the reusable lifecycle", async () => {
    const plugin = createProxmoxSandboxPlugin({ ssh: createLocalShell(home).runner, sleep: noSleep });
    const harness = harnessFor(plugin);
    const config = baseConfig(pve, generatePemKey(), { reuseLease: true });
    const base = { driverKey: "proxmox", companyId: "company-1", environmentId: "env-2", config };

    const lease = await harness.acquireLease({ ...base, runId: "run-1" });
    expect(await harness.releaseLease({ ...base, providerLeaseId: lease.providerLeaseId })).toBeUndefined();
    const resumed = await harness.resumeLease({ ...base, providerLeaseId: lease.providerLeaseId!, leaseMetadata: lease.metadata });
    expect(resumed.providerLeaseId).toBe(lease.providerLeaseId);
    expect((await harness.execute({ ...base, lease: resumed, command: "true" })).exitCode).toBe(0);
    expect(await harness.destroyLease({ ...base, providerLeaseId: lease.providerLeaseId })).toMatchObject({ state: "destroyed" });
    const gone = await harness.resumeLease({ ...base, providerLeaseId: lease.providerLeaseId! });
    expect(gone).toEqual({ providerLeaseId: null, metadata: { expired: true } });

    assertEnvironmentEventOrder(harness.environmentEvents, ["acquireLease", "releaseLease", "resumeLease", "execute", "destroyLease", "resumeLease"]);
  });
});
