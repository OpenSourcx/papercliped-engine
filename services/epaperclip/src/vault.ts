import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
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
