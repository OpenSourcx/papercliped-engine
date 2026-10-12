import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcess, type SshCommand, type SshRunner } from "../src/ssh.js";
import type { FakeProxmox } from "./fake-proxmox.js";

export function hasBinary(name: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A fresh ed25519 key in PKCS#8 PEM form (no ssh-keygen needed). */
export function generatePemKey(): string {
  return generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

/** A key in OpenSSH format via ssh-keygen; returns the private key and the .pub line. */
export function generateOpenSshKey(type: "ed25519" | "rsa" | "ecdsa", passphrase = ""): { privateKey: string; publicKey: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "pve-test-key-"));
  const file = path.join(dir, "id");
  const args = ["-q", "-t", type, "-N", passphrase, "-C", "test", "-f", file];
  if (type === "rsa") args.push("-b", "2048");
  execFileSync("ssh-keygen", args, { stdio: "ignore" });
  return { privateKey: readFileSync(file, "utf8"), publicKey: readFileSync(`${file}.pub`, "utf8").trim(), file };
}

export function baseConfig(pve: FakeProxmox, sshPrivateKey: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiUrl: pve.url,
    node: pve.node,
    apiTokenId: pve.tokenId,
    apiTokenSecret: pve.tokenSecret,
    caCert: pve.caCert,
    template: "9000",
    pool: "epaperclip",
    storage: "local-lvm",
    sshPrivateKey,
    timeoutMs: 20_000,
    ...overrides,
  };
}

export interface LocalShell {
  runner: SshRunner;
  calls: SshCommand[];
  /** Make the next n connections fail like an sshd that is not up yet. */
  failNext(n: number): void;
}

/**
 * Stands in for ssh: runs the remote command line with the local `sh -c`,
 * exactly as sshd hands it to the login shell, with HOME pointed at a
 * temporary directory. It enforces the host-key rule: a connection without a
 * recorded key must be allowed to learn one.
 */
export function createLocalShell(home: string): LocalShell {
  const calls: SshCommand[] = [];
  let failures = 0;
  const runner: SshRunner = async (command) => {
    calls.push(command);
    if (failures > 0) {
      failures -= 1;
      return {
        exitCode: 255,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: `ssh: connect to host ${command.target.host} port ${command.target.port}: Connection refused\n`,
        knownHosts: command.target.knownHosts,
      };
    }
    if (!command.target.knownHosts && !command.acceptNewHostKey) {
      return { exitCode: 255, signal: null, timedOut: false, stdout: "", stderr: "Host key verification failed.\n", knownHosts: null };
    }
    const result = await runProcess("sh", ["-c", command.command], {
      stdin: command.stdin,
      timeoutMs: command.timeoutMs,
      onOutput: command.onOutput,
      killGraceMs: 200,
      env: { ...process.env, HOME: home },
    });
    return { ...result, knownHosts: command.target.knownHosts ?? `${command.target.hostKeyAlias} ssh-ed25519 AAAAC3NzaFakeHostKey\n` };
  };
  return { runner, calls, failNext: (n) => (failures = n) };
}

export const noSleep = async () => undefined;
