import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The SSH side of the guided "Agent containers" setup: a key pair for the engine, and a small runner that uses the
 * host's own `ssh` client to provision the template container.
 *
 * Key format: an unencrypted OpenSSH private key ("BEGIN OPENSSH PRIVATE KEY"). The ssh client reads that on every
 * version; PKCS#8 for ed25519 is refused by OpenSSH (checked with 9.6), and the Proxmox sandbox plugin derives its public
 * key from either format.
 */

export interface SshKeyPair {
  /** OpenSSH private key, PEM armoured, ending in a newline. A secret: it goes to the vault and nowhere else. */
  privateKey: string;
  /** One `authorized_keys` line: `ssh-ed25519 AAAA… comment`. */
  publicKey: string;
}

const sshString = (v: Buffer | string): Buffer => {
  const data = typeof v === "string" ? Buffer.from(v, "utf8") : v;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, data]);
};

/** A fresh ed25519 key pair, built with node:crypto and encoded the way `ssh-keygen` writes it (no passphrase). */
export function generateSshKey(comment = "epaperclip-agent-containers"): SshKeyPair {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as { d?: string; x?: string };
  if (!jwk.d || !jwk.x) throw new Error("couldn't read the generated key");
  const seed = Buffer.from(jwk.d, "base64url");
  const pub = Buffer.from(jwk.x, "base64url");
  const publicBlob = Buffer.concat([sshString("ssh-ed25519"), sshString(pub)]);
  const check = randomBytes(4);
  let priv = Buffer.concat([check, check, sshString("ssh-ed25519"), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(comment)]);
  // Padded to the cipher block size (8 for "none") with 1, 2, 3 ...
  for (let i = 1; priv.length % 8 !== 0; i++) priv = Buffer.concat([priv, Buffer.from([i])]);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(1);
  const raw = Buffer.concat([Buffer.from("openssh-key-v1\0", "latin1"), sshString("none"), sshString("none"), sshString(""), count, sshString(publicBlob), sshString(priv)]);
  const b64 = raw.toString("base64").replace(/(.{70})/g, "$1\n").replace(/\n$/, "");
  return { privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`, publicKey: `ssh-ed25519 ${publicBlob.toString("base64")} ${comment}` };
}

export interface SshTarget {
  host: string;
  user: string;
  /** The private key, as PEM text. Written to a 0600 file in a private directory for the length of one call. */
  privateKey: string;
}

export type SshAvailability = { ok: true; version: string } | { ok: false; reason: string };

export interface SshRunner {
  /** Whether this host can run ssh at all (binary present, allowed to start). */
  available(): Promise<SshAvailability>;
  /** Whether a login works: true once the container's sshd accepts the key. */
  probe(target: SshTarget, timeoutMs: number): Promise<{ ok: boolean; error?: string }>;
  /** Runs `script` with bash on the target. Output lines (both streams) go to `onLine`. */
  run(target: SshTarget, script: string, onLine: (line: string) => void, timeoutMs: number): Promise<{ exitCode: number | null; timedOut: boolean }>;
}

const SSH_USER = /^[a-z_][a-z0-9_-]{0,31}$/;

/**
 * `ssh` options, all explicit so nothing in the service user's environment matters: no config file, key only, a throwaway
 * known_hosts (the container is new and its host key is unknown; the setup talks to it once, over the private bridge),
 * keep-alives so a stuck container ends the call.
 */
function sshArgs(dir: string, key: string, target: SshTarget): string[] {
  return [
    "-F", "/dev/null",
    "-i", key,
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${join(dir, "known_hosts")}`,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=8",
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "ControlMaster=no",
    "-o", "LogLevel=ERROR",
    "-T",
    `${target.user}@${target.host}`,
  ];
}

async function withKey<T>(target: SshTarget, fn: (dir: string, key: string) => Promise<T>): Promise<T> {
  if (isIP(target.host) === 0 || !SSH_USER.test(target.user)) throw new Error("bad ssh target");
  // A private directory (0700, made by mkdtemp), the key inside it 0600; both removed afterwards.
  const dir = await mkdtemp(join(tmpdir(), "epc-ssh-"));
  try {
    await chmod(dir, 0o700);
    const key = join(dir, "id");
    await writeFile(key, target.privateKey, { mode: 0o600 });
    await writeFile(join(dir, "known_hosts"), "", { mode: 0o600 });
    return await fn(dir, key);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Runs the host's ssh. The environment is nearly empty: no agent socket, no proxy, no locale. */
export function realSsh(opts: { binary?: string } = {}): SshRunner {
  const binary = opts.binary ?? "ssh";
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C" };

  const exec = (args: string[], stdin: string | null, onLine: (l: string) => void, timeoutMs: number) =>
    new Promise<{ exitCode: number | null; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(binary, args, { env, stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"] });
      let timedOut = false;
      let kill: NodeJS.Timeout | null = null;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        kill = setTimeout(() => child.kill("SIGKILL"), 3000);
      }, timeoutMs);
      const lines = (stream: NodeJS.ReadableStream) => {
        let rest = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => {
          rest += chunk;
          let nl: number;
          while ((nl = rest.indexOf("\n")) >= 0) {
            onLine(rest.slice(0, nl));
            rest = rest.slice(nl + 1);
          }
          if (rest.length > 8192) {
            onLine(rest);
            rest = "";
          }
        });
        stream.on("end", () => rest && onLine(rest));
      };
      lines(child.stdout!);
      lines(child.stderr!);
      child.on("error", (e) => {
        clearTimeout(timer);
        if (kill) clearTimeout(kill);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (kill) clearTimeout(kill);
        resolve({ exitCode: code, timedOut });
      });
      if (stdin !== null) {
        child.stdin!.on("error", () => {});
        child.stdin!.end(stdin);
      }
    });

  return {
    async available() {
      try {
        let out = "";
        const r = await exec(["-V"], null, (l) => (out += l), 10_000);
        if (r.exitCode !== 0) return { ok: false, reason: `ssh didn't run (exit ${r.exitCode ?? "none"}). The host service needs the OpenSSH client (apt-get install openssh-client).` };
        return { ok: true, version: out.trim().split(",")[0] };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        return { ok: false, reason: code === "ENOENT" ? "The ssh command isn't installed on this host, and agent containers are provisioned with it. Install it: apt-get install openssh-client." : `The host service can't start ssh (${code ?? (e as Error).message}). Its systemd unit may be blocking it; see the hardening notes in epaperclip.service.` };
      }
    },
    probe: (target, timeoutMs) =>
      withKey(target, async (dir, key) => {
        let last = "";
        const r = await exec([...sshArgs(dir, key, target), "true"], null, (l) => (last = l), timeoutMs);
        return r.exitCode === 0 ? { ok: true } : { ok: false, error: r.timedOut ? "timed out" : last.slice(0, 200) || `exit ${r.exitCode ?? "none"}` };
      }),
    run: (target, script, onLine, timeoutMs) => withKey(target, (dir, key) => exec([...sshArgs(dir, key, target), "bash", "-s"], script, onLine, timeoutMs)),
  };
}
