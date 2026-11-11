import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Vault, VaultError, type RecoveryFile, type Sealed } from "./vault.ts";

/**
 * The host service's own state, in `EPC_STATE_DIR` (default /var/lib/epaperclip): `vault.key` and `state.json`. The
 * JSON holds plain settings (connector status, Pin settings, resource-group limits, which engine accounts exist) and
 * secrets sealed by the vault. Every change rewrites the file atomically: a temporary file in the same directory is
 * written (0600), flushed to disk, then renamed over the old one, so a crash leaves either the old or the new state.
 *
 * Without a directory (tests, or code that never configured one) the state lives in memory under an ephemeral key.
 */

interface StateFile {
  version: 1;
  settings: Record<string, unknown>;
  secrets: Record<string, Sealed>;
}

const NAME = /^[\w.@:-]{1,200}$/;

function checkName(name: string) {
  if (!NAME.test(name)) throw new Error(`bad state key: ${JSON.stringify(name.slice(0, 40))}`);
}

const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export class StateStore {
  readonly dir: string | null;
  private readonly vault: Vault;
  private data: StateFile;
  private readonly beforeRename?: () => void;

  constructor(dir: string | null, opts: { beforeRename?: () => void } = {}) {
    this.dir = dir;
    this.beforeRename = opts.beforeRename;
    if (!dir) {
      this.vault = Vault.ephemeral();
      this.data = { version: 1, settings: {}, secrets: {} };
      return;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.vault = Vault.open(dir);
    let text: string | null = null;
    try {
      text = readFileSync(join(dir, "state.json"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (text === null) {
      this.data = { version: 1, settings: {}, secrets: {} };
      return;
    }
    // A damaged file is never silently replaced: the secrets in it may be the only copy.
    const parsed = JSON.parse(text) as Partial<StateFile>;
    if (parsed.version !== 1 || typeof parsed.settings !== "object" || typeof parsed.secrets !== "object") throw new Error(`${join(dir, "state.json")} is not ePaperclip state`);
    this.data = { version: 1, settings: parsed.settings ?? {}, secrets: parsed.secrets ?? {} };
  }

  /** The id of the vault key in use, so a recovery file can be matched to what this host has sealed. */
  vaultKeyId(): string {
    return this.vault.kid;
  }

  /** The vault key sealed under a passphrase, to keep off the host. The key itself never leaves this class. */
  vaultRecoveryExport(passphrase: string, now: Date = new Date()): RecoveryFile {
    return this.vault.exportRecovery(passphrase, now);
  }

  /** Key ids that sealed something stored here (secrets and settings, wherever they sit). */
  private sealedKeyIds(): Set<string> {
    const ids = new Set<string>();
    const walk = (o: unknown) => {
      if (!o || typeof o !== "object") return;
      const x = o as Record<string, unknown>;
      if (x.v === 1 && typeof x.kid === "string" && typeof x.iv === "string" && typeof x.ct === "string") return void ids.add(x.kid);
      for (const v of Object.values(x)) walk(v);
    };
    walk(this.data);
    return ids;
  }

  /**
   * Puts a recovered key in place of the one on disk. It must open the file with the passphrase, and (when this host
   * has sealed values) match at least one of them, so a wrong file can't replace a good key. The running service keeps
   * its old key until it restarts; the key it replaces is kept beside `vault.key`.
   */
  vaultRestoreFromRecovery(file: RecoveryFile, passphrase: string, now: number = Date.now()): { kid: string; same: boolean; restartRequired: boolean; backup: string | null } {
    if (!this.dir) throw new VaultError("This host keeps no vault key file, so there is nothing to restore into.");
    const restored = Vault.fromRecovery(file, passphrase);
    if (restored.kid === this.vault.kid) return { kid: restored.kid, same: true, restartRequired: false, backup: null };
    const sealed = this.sealedKeyIds();
    if (sealed.size > 0 && !sealed.has(restored.kid)) throw new VaultError("That recovery file's key doesn't match anything sealed on this host, so restoring it would recover nothing.");
    const { backup } = restored.writeKeyFile(this.dir, now);
    return { kid: restored.kid, same: false, restartRequired: true, backup };
  }

  getSecret(name: string): string | null {
    checkName(name);
    const s = this.data.secrets[name];
    return s ? this.vault.open(name, s) : null;
  }

  setSecret(name: string, value: string) {
    checkName(name);
    this.commit({ ...this.data, secrets: { ...this.data.secrets, [name]: this.vault.seal(name, value) } });
  }

  deleteSecret(name: string) {
    checkName(name);
    if (!(name in this.data.secrets)) return;
    const secrets = { ...this.data.secrets };
    delete secrets[name];
    this.commit({ ...this.data, secrets });
  }

  getSetting<T>(name: string): T | undefined {
    checkName(name);
    return clone(this.data.settings[name] as T | undefined);
  }

  /** Stores a JSON value; `undefined` removes it. */
  setSetting(name: string, value: unknown) {
    checkName(name);
    const settings = { ...this.data.settings };
    if (value === undefined) delete settings[name];
    else settings[name] = clone(value);
    this.commit({ ...this.data, settings });
  }

  /** Writes the new state to disk first; memory changes only once that worked. */
  private commit(next: StateFile) {
    this.write(next);
    this.data = next;
  }

  private write(data: StateFile) {
    if (!this.dir) return;
    const final = join(this.dir, "state.json");
    const tmp = join(this.dir, `.state.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    const fd = openSync(tmp, "wx", 0o600);
    try {
      try {
        writeSync(fd, JSON.stringify(data, null, 1));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      this.beforeRename?.();
      renameSync(tmp, final);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    // Make the rename itself durable. Some filesystems can't fsync a directory; the rename still happened.
    try {
      const dfd = openSync(this.dir, "r");
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      /* best effort */
    }
  }
}

export { VaultError };
