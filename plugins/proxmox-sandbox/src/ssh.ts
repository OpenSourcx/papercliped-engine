/**
 * Running commands in a container over `ssh`, and building the shell scripts
 * that are run there.
 *
 * Host keys: every container gets its own known_hosts, captured on the first
 * connection after the container is created (trust on first use) and stored in
 * the lease metadata. Every later connection uses StrictHostKeyChecking=yes
 * against that record, under a HostKeyAlias tied to the container, so a DHCP
 * address change does not break it and a different machine answering on the
 * address is refused.
 */
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export type OutputListener = (stream: "stdout" | "stderr", chunk: string) => void;

export interface RunProcessOptions {
  stdin?: string;
  timeoutMs?: number;
  onOutput?: OutputListener;
  /** Time between SIGTERM and SIGKILL once the timeout fires. */
  killGraceMs?: number;
  /** Environment for the child (default: this process's). */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_KILL_GRACE_MS = 2_000;

/**
 * Spawns a process, collects its output, and enforces a timeout with SIGTERM
 * followed by SIGKILL. Output is decoded as UTF-8 per stream, so a multi-byte
 * character split across chunks is never mangled, and the listener receives
 * exactly the text that ends up in the returned stdout/stderr.
 */
export function runProcess(file: string, args: string[], options: RunProcessOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: options.env, stdio: [options.stdin != null ? "pipe" : "ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const timeoutMs = options.timeoutMs ?? 0;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => child.kill("SIGKILL"), options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
          }, timeoutMs)
        : null;

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
      options.onOutput?.("stdout", chunk);
    });
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
      options.onOutput?.("stderr", chunk);
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode: timedOut ? null : code, signal: signal ?? null, timedOut, stdout, stderr });
    };
    child.on("close", finish);
    child.on("exit", (code, signal) => {
      // After a timeout, a grandchild can keep the output pipes open; do not wait for it.
      if (!timedOut) return;
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code, signal);
      }, 200).unref();
    });
    if (options.stdin != null && child.stdin) {
      // A command that exits without reading its input closes the pipe early; that is not an error.
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.stdin);
    }
  });
}

export interface SshTarget {
  host: string;
  port: number;
  user: string;
  privateKey: string;
  /** Stable name the host key is recorded under (independent of the IP). */
  hostKeyAlias: string;
  /** known_hosts lines recorded for this container, or null before the first connection. */
  knownHosts: string | null;
}

export interface SshCommand {
  target: SshTarget;
  /** The remote command line, run by the login shell of `target.user`. */
  command: string;
  stdin?: string;
  timeoutMs?: number;
  onOutput?: OutputListener;
  /**
   * Accept and record an unknown host key (trust on first use). Only the
   * provider's own first connection to a container it just created sets this.
   */
  acceptNewHostKey?: boolean;
}

export interface SshResult extends ProcessResult {
  /** known_hosts content after the connection (includes a newly learned key). */
  knownHosts: string | null;
}

export type SshRunner = (command: SshCommand) => Promise<SshResult>;

export function buildSshArgs(input: {
  target: SshTarget;
  identityFile: string;
  knownHostsFile: string;
  acceptNewHostKey: boolean;
  command: string;
}): string[] {
  const { target } = input;
  return [
    "-T",
    "-o", "BatchMode=yes",
    "-o", `StrictHostKeyChecking=${input.acceptNewHostKey ? "accept-new" : "yes"}`,
    "-o", `UserKnownHostsFile=${input.knownHostsFile}`,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", `HostKeyAlias=${target.hostKeyAlias}`,
    "-o", "HashKnownHosts=no",
    "-o", "CheckHostIP=no",
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=4",
    "-o", "LogLevel=ERROR",
    "-i", input.identityFile,
    "-p", String(target.port),
    "-l", target.user,
    "--",
    target.host,
    input.command,
  ];
}

/**
 * The real runner: the system `ssh` client with a private key written to a
 * 0600 file in a 0700 temporary directory that is removed afterwards.
 */
export function createSshRunner(options: { sshBinary?: string; killGraceMs?: number } = {}): SshRunner {
  const sshBinary = options.sshBinary ?? "ssh";
  return async (command) => {
    const dir = await mkdtemp(path.join(tmpdir(), "epaperclip-proxmox-ssh-"));
    try {
      await chmod(dir, 0o700);
      const identityFile = path.join(dir, "id");
      const knownHostsFile = path.join(dir, "known_hosts");
      const key = command.target.privateKey.endsWith("\n") ? command.target.privateKey : `${command.target.privateKey}\n`;
      await writeFile(identityFile, key, { mode: 0o600 });
      await chmod(identityFile, 0o600);
      await writeFile(knownHostsFile, command.target.knownHosts ?? "", { mode: 0o600 });
      const result = await runProcess(
        sshBinary,
        buildSshArgs({
          target: command.target,
          identityFile,
          knownHostsFile,
          acceptNewHostKey: command.acceptNewHostKey === true,
          command: command.command,
        }),
        { stdin: command.stdin, timeoutMs: command.timeoutMs, onOutput: command.onOutput, killGraceMs: options.killGraceMs },
      );
      const knownHosts = await readFile(knownHostsFile, "utf8").catch(() => "");
      return { ...result, knownHosts: knownHosts.trim().length > 0 ? knownHosts : null };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** POSIX single-quote quoting: safe for any byte string except NUL. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

/** Where a running command's process id is kept so a timeout can kill it. */
export function execPidFile(execId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(execId)) throw new Error("invalid exec id");
  return `/tmp/.epaperclip-exec-${execId}.pid`;
}

/**
 * The script run in the container for one execute call. Every value from the
 * caller (command, arguments, cwd, environment values) is single-quoted, and
 * environment keys must be plain identifiers, so nothing in them is ever
 * interpreted by the shell.
 *
 * The command runs as a background child in its own session (setsid) with the
 * caller's stdin, and its pid is recorded so that a timeout can terminate the
 * whole process group with a second, independent ssh call: closing the ssh
 * connection alone does not stop a remote command that has no terminal.
 */
export function buildExecScript(input: {
  command: string;
  args: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  execId: string;
}): string {
  const env = input.env ?? {};
  for (const key of Object.keys(env)) {
    if (!isValidEnvKey(key)) throw new Error(`Invalid environment variable name: ${JSON.stringify(key)}`);
  }
  const commandLine = [input.command, ...input.args].map(shellQuote).join(" ");
  const pidFile = shellQuote(execPidFile(input.execId));
  const lines = [
    // Load the login profile so PATH matches an interactive login (the template puts node and the agent CLIs on it).
    "if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi",
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
  ];
  if (input.cwd) lines.push(`cd ${shellQuote(input.cwd)} || exit 1`);
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    lines.push(`${key}=${shellQuote(value)}; export ${key}`);
  }
  lines.push(
    // A non-interactive shell points a background job's stdin at /dev/null before
    // any redirection, so `<&0` would not work in dash: pass stdin through fd 3.
    "exec 3<&0",
    `if command -v setsid >/dev/null 2>&1; then setsid ${commandLine} <&3 3<&- & else ${commandLine} <&3 3<&- & fi`,
    "exec 3<&-",
    `epc_pid=$!; echo "$epc_pid" > ${pidFile} 2>/dev/null || true`,
    'wait "$epc_pid"; epc_status=$?',
    `rm -f ${pidFile}`,
    'exit "$epc_status"',
  );
  return lines.join("\n");
}

/** Kills the process group of a timed-out command: SIGTERM, then SIGKILL after a grace period. */
export function buildKillScript(execId: string, graceSeconds = 2): string {
  const pidFile = shellQuote(execPidFile(execId));
  return [
    `[ -f ${pidFile} ] || exit 0`,
    `p=$(cat ${pidFile}) || exit 0`,
    'case "$p" in ""|*[!0-9]*) exit 0 ;; esac',
    'kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null',
    `sleep ${graceSeconds}`,
    'kill -KILL -- "-$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null',
    `rm -f ${pidFile}`,
    "exit 0",
  ].join("\n");
}

/** Wraps a script for the remote login shell: `sh -c '<script>'`. */
export function shCommand(script: string): string {
  return `sh -c ${shellQuote(script)}`;
}

/** Prints the home directory and whether bash exists, one per line. */
export const DETECT_CONTEXT_SCRIPT =
  'home="${HOME:-}"; if [ -z "$home" ]; then home="$(pwd)"; fi; ' +
  'if command -v bash >/dev/null 2>&1; then shell=bash; else shell=sh; fi; ' +
  'printf "%s\\n%s\\n" "$home" "$shell"';

export function mkdirScript(dir: string): string {
  return `mkdir -p -- ${shellQuote(dir)}`;
}
