/**
 * The provider gives each container the engine's MCP port before it runs a command there, and takes it away when the container goes.
 * The commands that would change sshd or probe a port are recorded, never run on this machine.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createEnvironmentTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { createProxmoxSandboxPlugin, engineBaseUrl } from "../src/plugin.js";
import { McpTunnels } from "../src/mcp-tunnel.js";
import type { SshCommand, SshRunner } from "../src/ssh.js";
import { FakeProxmox } from "./fake-proxmox.js";
import { baseConfig, createLocalShell, generatePemKey, noSleep } from "./helpers.js";

let pve: FakeProxmox;
let home: string;
beforeAll(async () => { pve = new FakeProxmox(); await pve.start(); pve.addTemplate(9000); home = mkdtempSync(path.join(tmpdir(), "pve-mcp-")); });
afterAll(async () => { await pve.stop(); rmSync(home, { recursive: true, force: true }); });

function setup(engineUrl: string, probeOk = true) {
  const inner = createLocalShell(home).runner;
  const recorded: string[] = [];
  const ssh: SshRunner = async (cmd: SshCommand) => {
    if (cmd.command.includes("PermitListen") || cmd.command.includes("/dev/tcp/127.0.0.1/")) {
      recorded.push(cmd.command);
      const probe = cmd.command.includes("/dev/tcp/");
      return { exitCode: probe && !probeOk ? 1 : 0, signal: null, timedOut: false, stdout: "", stderr: "", knownHosts: null };
    }
    return inner(cmd);
  };
  const tunnels = { ensure: vi.fn(async () => undefined), stop: vi.fn(), has: vi.fn(() => false), stopAll: vi.fn() } as unknown as McpTunnels;
  const startRelay = vi.fn(async (_o: { target: string }) => ({ port: 43210, close: async () => undefined }));
  const plugin = createProxmoxSandboxPlugin({ ssh, sleep: noSleep, mcp: { engineUrl, tunnels, startRelay } });
  const d = plugin.definition;
  const harness = createEnvironmentTestHarness({ manifest, environmentDriver: { driverKey: "proxmox", onValidateConfig: d.onEnvironmentValidateConfig, onProbe: d.onEnvironmentProbe, onAcquireLease: d.onEnvironmentAcquireLease, onResumeLease: d.onEnvironmentResumeLease, onReleaseLease: d.onEnvironmentReleaseLease, onStopLease: d.onEnvironmentStopLease, onDestroyLease: d.onEnvironmentDestroyLease, onRealizeWorkspace: d.onEnvironmentRealizeWorkspace, onExecute: d.onEnvironmentExecute } });
  return { plugin, harness, recorded, tunnels: tunnels as unknown as { ensure: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }, startRelay };
}

describe("MCP access for containers", () => {
  it("prepares sshd, opens the tunnel to the relay with the engine's own port, and removes it when the lease is destroyed", async () => {
    const s = setup("http://127.0.0.1:3100");
    await s.plugin.definition.setup(s.harness.ctx);
    const base = { driverKey: "proxmox", companyId: "company-1", environmentId: "env-1", config: baseConfig(pve, generatePemKey()) };
    const lease = await s.harness.acquireLease({ ...base, runId: "run-1" });
    const run = () => s.harness.execute({ ...base, lease, command: "sh", args: ["-c", "printf ok"], timeoutMs: 10_000 });
    expect(await run()).toMatchObject({ exitCode: 0, stdout: "ok" });
    expect(await run()).toMatchObject({ exitCode: 0 });
    expect(s.startRelay).toHaveBeenCalledTimes(1);
    expect(s.startRelay.mock.calls[0]![0]).toMatchObject({ target: "http://127.0.0.1:3100" });
    expect(s.recorded.filter((c) => c.includes("PermitListen"))).toHaveLength(1);
    expect(s.recorded.some((c) => c.includes("PermitListen 127.0.0.1:3100"))).toBe(true);
    expect(s.tunnels.ensure).toHaveBeenCalledWith(lease.providerLeaseId, expect.objectContaining({ hostKeyAlias: expect.stringContaining("epaperclip-") }), 3100, 43210);
    await s.harness.destroyLease({ ...base, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata });
    expect(s.tunnels.stop).toHaveBeenCalledWith(lease.providerLeaseId);
  });

  it("still runs the command when the tunnel can't be prepared, and says why", async () => {
    const s = setup("http://127.0.0.1:3100");
    s.tunnels.ensure.mockRejectedValueOnce(new Error("ssh refused"));
    await s.plugin.definition.setup(s.harness.ctx);
    const base = { driverKey: "proxmox", companyId: "company-1", environmentId: "env-2", config: baseConfig(pve, generatePemKey()) };
    const lease = await s.harness.acquireLease({ ...base, runId: "run-1" });
    expect(await s.harness.execute({ ...base, lease, command: "sh", args: ["-c", "printf fine"], timeoutMs: 10_000 })).toMatchObject({ exitCode: 0, stdout: "fine" });
    expect(s.harness.logs.some((l) => l.message.includes("MCP") && l.level === "warn")).toBe(true);
    await s.harness.destroyLease({ ...base, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata });
  });

  it("does nothing when the engine isn't on host loopback (containers can reach it the normal way)", async () => {
    const s = setup("http://10.1.2.3:3100");
    await s.plugin.definition.setup(s.harness.ctx);
    const base = { driverKey: "proxmox", companyId: "company-1", environmentId: "env-3", config: baseConfig(pve, generatePemKey()) };
    const lease = await s.harness.acquireLease({ ...base, runId: "run-1" });
    await s.harness.execute({ ...base, lease, command: "true" });
    expect(s.startRelay).not.toHaveBeenCalled();
    expect(s.tunnels.ensure).not.toHaveBeenCalled();
    await s.harness.destroyLease({ ...base, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata });
  });

  it("reads the engine address the way Paperclip builds the MCP ones", () => {
    expect(engineBaseUrl({})).toBe("http://127.0.0.1:3100");
    expect(engineBaseUrl({ PAPERCLIP_API_URL: "http://127.0.0.1:3100/api/" } as never)).toBe("http://127.0.0.1:3100");
  });
});
