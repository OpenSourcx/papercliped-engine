import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * The host service's vault. One 32-byte key in `vault.key` (0600, created on first use) encrypts every secret the
 * service keeps: managed engine passwords and connector API keys. Each secret is sealed with AES-256-GCM under a fresh
 * random IV, and its name is bound in as associated data, so a sealed value can't be swapped onto another name. The
 * key id travels with each sealed value so a later key rotation can tell old and new apart.
 *
 * Nothing here logs or returns a secret except `open`, to the code that asked for it by name.
 */

export interface Sealed {
  v: 1; // format version
  kid: string; // which key sealed it
  iv: string;
  tag: string;
  ct: string;
}

export class VaultError extends Error {}

/**
 * A recovery file: the vault key sealed under a passphrase the administrator chooses (scrypt, then AES-256-GCM), so the
 * key can be kept off the host. Without it a lost or damaged `vault.key` makes every sealed secret unrecoverable.
 */
export interface RecoveryFile {
  v: 1;
  kind: "epaperclip-vault-key";
  kid: string;
  created: string;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  iv: string;
  tag: string;
  ct: string;
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1 } as const;
export const MIN_PASSPHRASE = 12;
const recoveryAad = (kid: string) => Buffer.from(`epaperclip-vault-recovery/1/${kid}`, "utf8");
const derive = (passphrase: string, salt: Buffer, N: number, r: number, p: number) => scryptSync(passphrase.normalize("NFKC"), salt, 32, { N, r, p, maxmem: 128 * N * r + 1024 * 1024 });

const KEY_BYTES = 32;

export class Vault {
  private readonly key: Buffer;
  readonly kid: string;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) throw new VaultError("vault key must be 32 bytes");
    this.key = key;
    this.kid = createHash("sha256").update(key).digest("hex").slice(0, 16);
  }

  /** Reads `vault.key` from the state directory, creating it (0600, 32 random bytes) the first time. */
  static open(dir: string): Vault {
    const path = join(dir, "vault.key");
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, randomBytes(KEY_BYTES));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    // Someone loosened the key's mode by hand: put it back rather than run with a readable key.
    if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
    const key = readFileSync(path);
    if (key.length !== KEY_BYTES) throw new VaultError(`${path} is not a vault key (expected ${KEY_BYTES} bytes)`);
    return new Vault(key);
  }

  /** The key sealed under `passphrase`, to be kept somewhere other than this host. */
  exportRecovery(passphrase: string, now: Date = new Date()): RecoveryFile {
    if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE) throw new VaultError(`The recovery passphrase needs at least ${MIN_PASSPHRASE} characters.`);
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", derive(passphrase, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p), iv);
    c.setAAD(recoveryAad(this.kid));
    const ct = Buffer.concat([c.update(this.key), c.final()]);
    return { v: 1, kind: "epaperclip-vault-key", kid: this.kid, created: now.toISOString(), kdf: { name: "scrypt", ...SCRYPT, salt: salt.toString("base64") }, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
  }

  /** Opens a recovery file. A wrong passphrase and a damaged file are indistinguishable by design. */
  static fromRecovery(file: RecoveryFile, passphrase: string): Vault {
    const f = file as Partial<RecoveryFile> | null;
    if (!f || f.v !== 1 || f.kind !== "epaperclip-vault-key" || typeof f.kid !== "string" || !f.kdf || f.kdf.name !== "scrypt" || typeof f.iv !== "string" || typeof f.tag !== "string" || typeof f.ct !== "string") throw new VaultError("That isn't an ePaperclip vault recovery file.");
    const { N, r, p, salt } = f.kdf;
    // Bounds keep a hostile file from asking for gigabytes of memory or minutes of CPU.
    if (![N, r, p].every(Number.isInteger) || N < 1 << 14 || N > 1 << 17 || (N & (N - 1)) !== 0 || r < 8 || r > 16 || p < 1 || p > 4 || typeof salt !== "string") throw new VaultError("That recovery file uses settings this host won't accept.");
    if (typeof passphrase !== "string" || !passphrase.length) throw new VaultError("Enter the recovery passphrase.");
    try {
      const d = createDecipheriv("aes-256-gcm", derive(passphrase, Buffer.from(salt, "base64"), N, r, p), Buffer.from(f.iv, "base64"));
      d.setAAD(recoveryAad(f.kid));
      d.setAuthTag(Buffer.from(f.tag, "base64"));
      const key = Buffer.concat([d.update(Buffer.from(f.ct, "base64")), d.final()]);
      const v = new Vault(key);
      if (v.kid !== f.kid) throw new Error("kid");
      return v;
    } catch {
      throw new VaultError("The passphrase is wrong, or the recovery file is damaged.");
    }
  }

  /**
   * Writes this key as `vault.key` in `dir` (0600), keeping the key it replaces next to it as `vault.key.replaced-<time>`
   * so a mistaken restore can be undone by hand. The running service keeps its old key until it restarts.
   */
  writeKeyFile(dir: string, now: number = Date.now()): { backup: string | null } {
    const path = join(dir, "vault.key");
    let backup: string | null = null;
    if (existsSync(path)) {
      backup = `${path}.replaced-${now}`;
      copyFileSync(path, backup);
      chmodSync(backup, 0o600);
    }
    const tmp = `${path}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, this.key);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    return { backup };
  }

  /** A key that lives only in memory: for tests and for running without a state directory. */
  static ephemeral(): Vault {
    return new Vault(randomBytes(KEY_BYTES));
  }

  seal(name: string, plaintext: string): Sealed {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(name, "utf8"));
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return { v: 1, kid: this.kid, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
  }

  open(name: string, s: Sealed): string {
    if (!s || s.v !== 1) throw new VaultError(`secret ${name} has an unknown format`);
    if (s.kid !== this.kid) throw new VaultError(`secret ${name} was sealed with another vault key`);
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(s.iv, "base64"));
      d.setAAD(Buffer.from(name, "utf8"));
      d.setAuthTag(Buffer.from(s.tag, "base64"));
      return Buffer.concat([d.update(Buffer.from(s.ct, "base64")), d.final()]).toString("utf8");
    } catch {
      throw new VaultError(`secret ${name} failed its integrity check`);
    }
  }
}
