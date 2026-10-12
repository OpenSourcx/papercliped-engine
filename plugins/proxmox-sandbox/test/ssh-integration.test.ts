/**
 * End to end over a real OpenSSH server: a throwaway sshd on a spare port of
 * this machine's network address stands in for the container, the fake Proxmox API hands out its
 * address, and the provider's real ssh runner does the rest.
 *
 * Skipped when sshd, ssh or ssh-keygen are not installed.
 */
import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PluginEnvironmentLease } from "@paperclipai/plugin-sdk";
import { createProxmoxSandboxPlugin } from "../src/plugin.js";
import { createSshRunner } from "../src/ssh.js";
import { FakeProxmox } from "./fake-proxmox.js";
import { baseConfig, generateOpenSshKey, hasBinary, noSleep } from "./helpers.js";

const SSHD = ["/usr/sbin/sshd", "/usr/local/sbin/sshd"].find((p) => existsSync(p));
// The provider ignores loopback addresses (a container's eth0 never has one), so sshd listens on a real interface.
const HOST_IP = Object.values(networkInterfaces())
  .flat()
  .find((a) => a && a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254."))?.address;
const AVAILABLE = Boolean(SSHD) && Boolean(HOST_IP) && hasBinary("ssh") && hasBinary("ssh-keygen");

async function sparePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, HOST_IP, () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForPort(port: number, deadlineMs: number): Promise<void> {
  const { connect } = await import("node:net");
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = connect(port, HOST_IP!);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`sshd did not listen on ${port}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!AVAILABLE)("real sshd", () => {
  let dir: string;
  let sshd: ChildProcess;
  let port: number;
  let pve: FakeProxmox;
  let clientKey: string;
  let workspace: string;
  let lease: PluginEnvironmentLease;
  const user = userInfo().username;
  const plugin = createProxmoxSandboxPlugin({ ssh: createSshRunner({ killGraceMs: 500 }), sleep: noSleep, killGraceSeconds: 1 });
  const hooks = plugin.definition;
  const base = { driverKey: "proxmox", companyId: "company-1", environmentId: "env-1" };
  let config: Record<string, unknown>;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "pve-sshd-"));
    chmodSync(dir, 0o700);
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(dir, "host_key")]);
    const client = generateOpenSshKey("ed25519");
    clientKey = client.privateKey;
    writeFileSync(path.join(dir, "authorized_keys"), `${client.publicKey}\n`, { mode: 0o600 });
    port = await sparePort();
    writeFileSync(
      path.join(dir, "sshd_config"),
      [
        `Port ${port}`,
        `ListenAddress ${HOST_IP}`,
        `HostKey ${path.join(dir, "host_key")}`,
        `PidFile ${path.join(dir, "sshd.pid")}`,
        `AuthorizedKeysFile ${path.join(dir, "authorized_keys")}`,
        "StrictModes no",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "UsePAM no",
        "PermitRootLogin prohibit-password",
        `AllowUsers ${user}`,
        "LogLevel ERROR",
      ].join("\n") + "\n",
    );
    // OpenSSH's privilege separation directory, normally created by the package's service unit.
    if (process.getuid?.() === 0 && !existsSync("/run/sshd")) mkdirSync("/run/sshd", { mode: 0o755 });
    sshd = spawn(SSHD!, ["-D", "-e", "-f", path.join(dir, "sshd_config")], { stdio: ["ignore", "ignore", "pipe"] });
    let sshdErr = "";
    sshd.stderr!.on("data", (c) => (sshdErr += String(c)));
    await waitForPort(port, 10_000).catch((error) => {
      throw new Error(`${error.message}: ${sshdErr}`);
    });

    pve = new FakeProxmox();
    await pve.start();
    pve.addTemplate(9000);
    pve.nextIp = HOST_IP!;
    workspace = path.join(dir, "workspace");
    config = baseConfig(pve, clientKey, { sshUser: user, sshPort: port });
    lease = await hooks.onEnvironmentAcquireLease!({ ...base, config, runId: "run-1", requestedCwd: workspace });
  }, 60_000);

  afterAll(async () => {
    sshd?.kill("SIGTERM");
    await pve?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("acquires a lease over real SSH and records the host key", () => {
    expect(lease.metadata).toMatchObject({ ip: HOST_IP, remoteCwd: workspace, sshPort: port });
    const hostPub = readFileSync(path.join(dir, "host_key.pub"), "utf8").split(" ").slice(0, 2).join(" ");
    expect(lease.metadata!.knownHosts).toContain(`epaperclip-pve-101 ${hostPub}`);
    expect(existsSync(workspace)).toBe(true);
  });

  it("executes with hostile env values, cwd and stdin", async () => {
    const hostile = { A: `it's "quoted" $HOME \`id\` $(touch pwned)\nsecond line`, B: "'; touch pwned2; '" };
    const result = await hooks.onEnvironmentExecute!({
      ...base,
      config,
      lease,
      command: "sh",
      args: ["-c", 'printf "%s\\n--\\n%s\\n--\\n" "$A" "$B"; pwd; cat'],
      env: hostile,
      stdin: "piped input",
      timeoutMs: 15_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${hostile.A}\n--\n${hostile.B}\n--\n${workspace}\npiped input`);
    expect(existsSync(path.join(workspace, "pwned"))).toBe(false);
    expect(existsSync(path.join(workspace, "pwned2"))).toBe(false);
  });

  it("kills the remote command on timeout", async () => {
    const pidFile = path.join(dir, "remote.pid");
    const result = await hooks.onEnvironmentExecute!({
      ...base,
      config,
      lease,
      command: "sh",
      args: ["-c", `echo $$ > '${pidFile}'; exec sleep 60`],
      timeoutMs: 1_500,
    });
    expect(result.timedOut).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    const deadline = Date.now() + 5_000;
    let alive = true;
    while (Date.now() < deadline) {
      try {
        const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2];
        if (state === "Z") { alive = false; break; }
      } catch {
        alive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(alive).toBe(false);
  });

  it("refuses a host whose key does not match the recorded one", async () => {
    const other = mkdtempSync(path.join(tmpdir(), "pve-otherkey-"));
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(other, "k")]);
    const wrong = readFileSync(path.join(other, "k.pub"), "utf8").split(" ").slice(0, 2).join(" ");
    rmSync(other, { recursive: true, force: true });
    const result = await hooks.onEnvironmentExecute!({
      ...base,
      config,
      lease: { ...lease, metadata: { ...lease.metadata, knownHosts: `epaperclip-pve-101 ${wrong}\n` } },
      command: "true",
      timeoutMs: 15_000,
    });
    expect(result.exitCode).toBe(255);
    expect(result.stderr).toMatch(/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/);
  });

  it("releases the lease (shutdown and delete through the API)", async () => {
    const receipt = await hooks.onEnvironmentReleaseLease!({ ...base, config, providerLeaseId: lease.providerLeaseId });
    expect(receipt).toEqual({ providerLeaseId: "pve/101", state: "destroyed" });
  });
});
