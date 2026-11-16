/**
 * Gives a container the engine's loopback port, ending at the MCP relay (mcp-relay.ts), for as long as the provider holds the
 * container's lease. One `ssh -N -R` per container, kept by the provider's own SSH key, restarted if it drops.
 *
 * Inside the container the port is bound to its loopback only (`PermitListen 127.0.0.1:<port>` in sshd), so nothing else on
 * the network can use it, and `AllowTcpForwarding remote` lets only the connecting side (this host) ask for it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSshArgs, shellQuote, type SshTarget } from "./ssh.js";

type Log = (level: "info" | "warn", message: string, meta?: Record<string, unknown>) => void;

/** Run as root in the container, once per lease: let sshd accept one remote forward, on loopback, and nothing else. Safe to repeat. */
export function mcpForwardingScript(port: number): string {
  const f = "/etc/ssh/sshd_config.d/10-epaperclip.conf";
  const line = `PermitListen 127.0.0.1:${port}`;
  return [
    "set -eu",
    `f=${shellQuote(f)}`,
    `if ! grep -qxF ${shellQuote(line)} "$f" 2>/dev/null; then`,
    `  if grep -q '^AllowTcpForwarding ' "$f"; then sed -i 's/^AllowTcpForwarding .*/AllowTcpForwarding remote/' "$f"; else echo 'AllowTcpForwarding remote' >> "$f"; fi`,
    `  sed -i '/^PermitListen /d' "$f"; echo ${shellQuote(line)} >> "$f"`,
    "  sshd -t",
    "  if [ -s /run/sshd.pid ]; then kill -HUP \"$(cat /run/sshd.pid)\"; else systemctl reload ssh 2>/dev/null || systemctl reload sshd; fi",
    "fi",
  ].join("\n");
}

/** Run in the container: succeeds when something accepts a connection on its own loopback port. */
export function mcpProbeScript(port: number): string {
  return `timeout 3 bash -c '</dev/tcp/127.0.0.1/${port}'`;
}

interface Tunnel { child: ChildProcess | null; dir: string | null; stopped: boolean; failures: number; timer: NodeJS.Timeout | null }

export interface McpTunnelOptions {
  sshBinary?: string;
  log?: Log;
  /** Test seam. */
  spawnFn?: typeof spawn;
  restartDelayMs?: number;
  maxQuickFailures?: number;
}

export class McpTunnels {
  private readonly tunnels = new Map<string, Tunnel>();
  private readonly ssh: string;
  private readonly log: Log;
  private readonly spawnFn: typeof spawn;
  private readonly delay: number;
  private readonly maxFailures: number;

  constructor(private readonly options: McpTunnelOptions = {}) {
    this.ssh = options.sshBinary ?? "ssh";
    this.log = options.log ?? (() => undefined);
    this.spawnFn = options.spawnFn ?? spawn;
    this.delay = options.restartDelayMs ?? 2_000;
    this.maxFailures = options.maxQuickFailures ?? 5;
  }

  has(key: string): boolean {
    const t = this.tunnels.get(key);
    return !!t && !t.stopped && t.child !== null;
  }

  /** Start the tunnel for `key` unless one is already running. Does not wait for it to be ready; probe from the container for that. */
  async ensure(key: string, target: SshTarget, remotePort: number, localPort: number): Promise<void> {
    if (this.has(key)) return;
    const existing = this.tunnels.get(key);
    if (existing?.timer) clearTimeout(existing.timer);
    const t: Tunnel = { child: null, dir: null, stopped: false, failures: existing?.failures ?? 0, timer: null };
    this.tunnels.set(key, t);
    await this.launch(key, t, target, remotePort, localPort);
  }

  private async launch(key: string, t: Tunnel, target: SshTarget, remotePort: number, localPort: number): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "epaperclip-mcp-tunnel-"));
    t.dir = dir;
    await chmod(dir, 0o700);
    const identityFile = path.join(dir, "id");
    const knownHostsFile = path.join(dir, "known_hosts");
    await writeFile(identityFile, target.privateKey.endsWith("\n") ? target.privateKey : `${target.privateKey}\n`, { mode: 0o600 });
    await writeFile(knownHostsFile, target.knownHosts ?? "", { mode: 0o600 });
    const args = buildSshArgs({ target, identityFile, knownHostsFile, acceptNewHostKey: false, command: "", forward: { remotePort, localPort } });
    const startedAt = Date.now();
    const child = this.spawnFn(this.ssh, args, { stdio: ["ignore", "ignore", "pipe"] });
    t.child = child;
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => { if (stderr.length < 2000) stderr += c.toString("utf8"); });
    child.on("exit", () => {
      t.child = null;
      void rm(dir, { recursive: true, force: true }).catch(() => undefined);
      if (t.stopped) return;
      t.failures = Date.now() - startedAt > 30_000 ? 1 : t.failures + 1;
      if (t.failures > this.maxFailures) {
        this.log("warn", "MCP tunnel to a container keeps failing; giving up until the next run", { key, error: stderr.trim().slice(0, 300) });
        this.tunnels.delete(key);
        return;
      }
      this.log("warn", "MCP tunnel to a container ended; restarting", { key, attempt: t.failures, error: stderr.trim().slice(0, 300) });
      t.timer = setTimeout(() => { if (!t.stopped) void this.launch(key, t, target, remotePort, localPort).catch(() => undefined); }, this.delay * t.failures);
    });
    child.on("error", (error) => this.log("warn", "Could not start ssh for the MCP tunnel", { key, error: error.message }));
  }

  stop(key: string): void {
    const t = this.tunnels.get(key);
    if (!t) return;
    t.stopped = true;
    if (t.timer) clearTimeout(t.timer);
    t.child?.kill("SIGTERM");
    this.tunnels.delete(key);
  }

  stopAll(): void {
    for (const key of [...this.tunnels.keys()]) this.stop(key);
  }
}
