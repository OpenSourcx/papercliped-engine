import { X509Certificate, createPrivateKey } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Keeps the certificate this service serves on 443 in step with the node's. The installer points EPC_TLS_CERT at
 * /etc/pve/local/pve-ssl.pem, but Proxmox's own proxy serves /etc/pve/local/pveproxy-ssl.pem (and .key) instead when
 * a custom or ACME certificate exists, so we follow the same rule. When the files change (an upload, an ACME order,
 * the daily automatic renewal) the new pair is validated and swapped into the running server with setSecureContext;
 * a pair that doesn't parse or doesn't match is ignored and the old certificate keeps being served.
 */

export interface SecureServer {
  setSecureContext(options: { cert: string; key: string; minVersion?: "TLSv1.2" }): void;
}

export interface TlsStatus {
  reloaded: boolean;
  changed: boolean;
  /** Why nothing was swapped, in words. */
  reason?: string;
  fingerprint?: string;
  files?: { cert: string; key: string };
}

export function tlsFiles(env: Record<string, string | undefined> = process.env): { cert: string; key: string } {
  const cert = env.EPC_TLS_CERT ?? "/etc/pve/local/pve-ssl.pem";
  const key = env.EPC_TLS_KEY ?? "/etc/pve/local/pve-ssl.key";
  if (basename(cert) === "pve-ssl.pem" && dirname(cert) === dirname(key)) {
    const c = join(dirname(cert), "pveproxy-ssl.pem");
    const k = join(dirname(cert), "pveproxy-ssl.key");
    if (existsSync(c) && existsSync(k)) return { cert: c, key: k };
  }
  return { cert, key };
}

export class TlsReloader {
  private server: SecureServer | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private current: string | null = null;
  private seen = "";
  private readonly env: () => Record<string, string | undefined>;
  private readonly every: number;

  constructor(opts: { env?: () => Record<string, string | undefined>; watchMs?: number } = {}) {
    this.env = opts.env ?? (() => process.env);
    this.every = opts.watchMs ?? 30_000;
  }

  /** Remembers the server and starts watching the files. Safe to call on every request. */
  attach(server: SecureServer | null | undefined) {
    if (!server || this.server === server) return;
    this.server = server;
    const f = tlsFiles(this.env());
    this.seen = this.stamp(f);
    this.current = this.fingerprintOf(f);
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      const now = this.stamp(tlsFiles(this.env()));
      if (now !== this.seen) this.reload();
    }, this.every);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.server = null;
  }

  private stamp(f: { cert: string; key: string }): string {
    try {
      return [f.cert, f.key].map((p) => `${p}:${statSync(p).mtimeMs}:${statSync(p).size}`).join("|");
    } catch {
      return "missing";
    }
  }

  private fingerprintOf(f: { cert: string; key: string }): string | null {
    try {
      return new X509Certificate(readFileSync(f.cert)).fingerprint256;
    } catch {
      return null;
    }
  }

  /** Re-reads the pair now. Never throws and never logs key material. */
  reload(): TlsStatus {
    const files = tlsFiles(this.env());
    this.seen = this.stamp(files);
    if (!this.server) return { reloaded: false, changed: false, reason: "This service is not serving TLS itself (plain HTTP), so there is nothing to reload.", files };
    try {
      const cert = readFileSync(files.cert, "utf8");
      const key = readFileSync(files.key, "utf8");
      const x = new X509Certificate(cert);
      if (!x.checkPrivateKey(createPrivateKey(key))) return { reloaded: false, changed: false, reason: "The certificate and key on disk don't belong together; still serving the previous certificate.", files };
      if (Date.parse(x.validTo) < Date.now()) return { reloaded: false, changed: false, reason: "The certificate on disk has expired; still serving the previous certificate.", files };
      if (x.fingerprint256 === this.current) return { reloaded: false, changed: false, fingerprint: x.fingerprint256, files };
      this.server.setSecureContext({ cert, key, minVersion: "TLSv1.2" });
      this.current = x.fingerprint256;
      return { reloaded: true, changed: true, fingerprint: x.fingerprint256, files };
    } catch {
      return { reloaded: false, changed: false, reason: "Couldn't read the certificate files; still serving the previous certificate.", files };
    }
  }

  /** Re-reads now and again shortly after, because Proxmox writes the files a moment before it restarts its proxy. */
  reloadSoon(): void {
    for (const ms of [3_000, 15_000]) setTimeout(() => this.reload(), ms).unref();
  }

  get fingerprint(): string | null {
    return this.current;
  }
}

/** The TLS server a request arrived on, or null for plain HTTP. */
export const serverOf = (req: { socket: unknown }): SecureServer | null => {
  const s = (req.socket as { server?: Partial<SecureServer> }).server;
  return s && typeof s.setSecureContext === "function" ? (s as SecureServer) : null;
};
