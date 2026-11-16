import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { McpTunnels, mcpForwardingScript, mcpProbeScript } from "../src/mcp-tunnel.js";
import { buildSshArgs, type SshTarget } from "../src/ssh.js";

const target: SshTarget = { host: "10.0.0.9", port: 22, user: "root", privateKey: "KEY", hostKeyAlias: "epaperclip-pve-101", knownHosts: "10.0.0.9 ssh-ed25519 AAAA" };

describe("the reverse forward", () => {
  it("is a -N ssh to the container's own loopback port, ending on the host's loopback, with strict host keys", () => {
    const args = buildSshArgs({ target, identityFile: "/k/id", knownHostsFile: "/k/kh", acceptNewHostKey: false, command: "", forward: { remotePort: 3100, localPort: 41000 } });
    expect(args[0]).toBe("-N");
    expect(args).toContain("ExitOnForwardFailure=yes");
    expect(args[args.indexOf("-R") + 1]).toBe("127.0.0.1:3100:127.0.0.1:41000");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args.at(-1)).toBe("10.0.0.9");
    expect(args).not.toContain("-tt");
  });

  it("leaves an ordinary command's arguments as they were", () => {
    const args = buildSshArgs({ target, identityFile: "/k/id", knownHostsFile: "/k/kh", acceptNewHostKey: false, command: "true" });
    expect(args[0]).toBe("-T");
    expect(args).not.toContain("-R");
    expect(args.at(-1)).toBe("true");
  });
});

describe("what sshd is told", () => {
  /** Runs the real script against a copy of the template's sshd file, with stand-ins for sshd and kill. */
  function run(initial: string) {
    const dir = mkdtempSync(path.join(tmpdir(), "mcp-sshd-"));
    const conf = path.join(dir, "10-epaperclip.conf");
    writeFileSync(conf, initial);
    const bin = path.join(dir, "bin"); execFileSync("mkdir", [bin]);
    const log = path.join(dir, "calls");
    writeFileSync(path.join(bin, "sshd"), `#!/bin/sh\necho sshd "$@" >> ${log}\n`); chmodSync(path.join(bin, "sshd"), 0o755);
    writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh\necho systemctl "$@" >> ${log}\n`); chmodSync(path.join(bin, "systemctl"), 0o755);
    const script = mcpForwardingScript(3100).replace("/etc/ssh/sshd_config.d/10-epaperclip.conf", conf);
    const go = () => execFileSync("sh", ["-c", script], { env: { PATH: `${bin}:/usr/bin:/bin` } });
    return { conf, log, go, read: () => readFileSync(conf, "utf8"), calls: () => { try { return readFileSync(log, "utf8"); } catch { return ""; } } };
  }
  const template = "PasswordAuthentication no\nAllowAgentForwarding no\nAllowTcpForwarding no\nPermitTunnel no\n";

  it("allows remote forwarding of the engine's loopback port only, validates, and reloads", () => {
    const t = run(template);
    t.go();
    const text = t.read();
    expect(text).toContain("AllowTcpForwarding remote\n");
    expect(text).not.toContain("AllowTcpForwarding no");
    expect(text).toContain("PermitListen 127.0.0.1:3100\n");
    expect(text).toContain("PermitTunnel no");
    expect(t.calls()).toContain("sshd -t");
    expect(t.calls()).toContain("systemctl reload");
  });

  it("does nothing the second time", () => {
    const t = run(template);
    t.go();
    const first = t.read(), callsAfterFirst = t.calls();
    t.go();
    expect(t.read()).toBe(first);
    expect(t.calls()).toBe(callsAfterFirst);
  });

  it("probes only the container's own loopback", () => {
    expect(mcpProbeScript(3100)).toContain("127.0.0.1/3100");
  });
});

describe("McpTunnels", () => {
  function fakeSpawn() {
    const children: (EventEmitter & { kill: ReturnType<typeof vi.fn>; stderr: EventEmitter })[] = [];
    const spawnFn = vi.fn(() => { const c = Object.assign(new EventEmitter(), { kill: vi.fn(), stderr: new EventEmitter() }); children.push(c); return c; });
    return { children, spawnFn: spawnFn as never };
  }
  it("holds one tunnel per container, and stops it when asked", async () => {
    const { children, spawnFn } = fakeSpawn();
    const t = new McpTunnels({ spawnFn });
    await t.ensure("pve/101", target, 3100, 41000);
    await t.ensure("pve/101", target, 3100, 41000);
    expect(children).toHaveLength(1);
    expect(t.has("pve/101")).toBe(true);
    t.stop("pve/101");
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(t.has("pve/101")).toBe(false);
  });

  it("restarts a tunnel that drops, and gives up when it keeps failing", async () => {
    const { children, spawnFn } = fakeSpawn();
    const t = new McpTunnels({ spawnFn, restartDelayMs: 1, maxQuickFailures: 2 });
    await t.ensure("pve/102", target, 3100, 41000);
    children[0]!.emit("exit", 255);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1]!.emit("exit", 255);
    await vi.waitFor(() => expect(children).toHaveLength(3));
    children[2]!.emit("exit", 255);
    await new Promise((r) => setTimeout(r, 20));
    expect(children).toHaveLength(3);
    expect(t.has("pve/102")).toBe(false);
  });

  it("does not restart a tunnel that was stopped", async () => {
    const { children, spawnFn } = fakeSpawn();
    const t = new McpTunnels({ spawnFn, restartDelayMs: 1 });
    await t.ensure("pve/103", target, 3100, 41000);
    t.stop("pve/103");
    children[0]!.emit("exit", 0);
    await new Promise((r) => setTimeout(r, 15));
    expect(children).toHaveLength(1);
  });
});
