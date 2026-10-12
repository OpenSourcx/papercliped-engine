/**
 * Derives the OpenSSH public key line (`ssh-ed25519 AAAA…`) from a private key,
 * so the operator only has to paste one secret. The public key goes into new
 * containers through Proxmox's `ssh-public-keys` create option.
 *
 * Two formats are understood without shelling out to ssh-keygen:
 *  - OpenSSH's own format (`-----BEGIN OPENSSH PRIVATE KEY-----`, what
 *    ssh-keygen writes by default), whose header carries the public key in the
 *    clear, and
 *  - PEM/PKCS#8 keys (RSA, Ed25519, ECDSA), via node:crypto.
 */
import { createPrivateKey, createPublicKey } from "node:crypto";

export class SshKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshKeyError";
  }
}

function sshString(value: Buffer | string): Buffer {
  const data = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, data]);
}

function sshMpint(unsignedBigEndian: Buffer): Buffer {
  let start = 0;
  while (start < unsignedBigEndian.length - 1 && unsignedBigEndian[start] === 0) start += 1;
  let bytes = unsignedBigEndian.subarray(start);
  if (bytes.length > 0 && (bytes[0]! & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return sshString(bytes);
}

class Reader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}
  uint32(): number {
    if (this.offset + 4 > this.buf.length) throw new SshKeyError("sshPrivateKey is truncated.");
    const value = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }
  bytes(): Buffer {
    const length = this.uint32();
    if (this.offset + length > this.buf.length) throw new SshKeyError("sshPrivateKey is truncated.");
    const value = this.buf.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
}

const OPENSSH_MAGIC = Buffer.from("openssh-key-v1\0", "latin1");

function pemBody(pem: string, label: string): Buffer {
  const match = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`).exec(pem);
  if (!match) throw new SshKeyError("sshPrivateKey is not a complete PEM block.");
  return Buffer.from(match[1]!.replace(/\s+/g, ""), "base64");
}

function fromOpenSshFormat(pem: string): string {
  const raw = pemBody(pem, "OPENSSH PRIVATE KEY");
  if (raw.length < OPENSSH_MAGIC.length || !raw.subarray(0, OPENSSH_MAGIC.length).equals(OPENSSH_MAGIC)) {
    throw new SshKeyError("sshPrivateKey is not a valid OpenSSH private key.");
  }
  const reader = new Reader(raw.subarray(OPENSSH_MAGIC.length));
  const cipher = reader.bytes().toString("latin1");
  reader.bytes(); // kdf name
  reader.bytes(); // kdf options
  const keyCount = reader.uint32();
  if (keyCount !== 1) throw new SshKeyError("sshPrivateKey must hold exactly one key.");
  const publicBlob = reader.bytes();
  if (cipher !== "none") {
    throw new SshKeyError(
      "sshPrivateKey is protected by a passphrase. The engine connects non-interactively, so use a key without one (ssh-keygen -t ed25519 -N '').",
    );
  }
  const type = new Reader(publicBlob).bytes().toString("latin1");
  return `${type} ${publicBlob.toString("base64")}`;
}

const EC_CURVES: Record<string, string> = { "P-256": "nistp256", "P-384": "nistp384", "P-521": "nistp521" };

function fromPem(pem: string): string {
  let jwk: Record<string, unknown>;
  try {
    jwk = createPublicKey(createPrivateKey({ key: pem, format: "pem" })).export({ format: "jwk" }) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/passphrase|encrypted/i.test(message)) {
      throw new SshKeyError("sshPrivateKey is protected by a passphrase. Use a key without one.");
    }
    throw new SshKeyError(`sshPrivateKey could not be read: ${message}`);
  }
  const b64u = (value: unknown) => Buffer.from(String(value), "base64url");
  if (jwk.kty === "RSA") {
    const blob = Buffer.concat([sshString("ssh-rsa"), sshMpint(b64u(jwk.e)), sshMpint(b64u(jwk.n))]);
    return `ssh-rsa ${blob.toString("base64")}`;
  }
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") {
    const blob = Buffer.concat([sshString("ssh-ed25519"), sshString(b64u(jwk.x))]);
    return `ssh-ed25519 ${blob.toString("base64")}`;
  }
  if (jwk.kty === "EC" && typeof jwk.crv === "string" && EC_CURVES[jwk.crv]) {
    const curve = EC_CURVES[jwk.crv]!;
    const type = `ecdsa-sha2-${curve}`;
    const point = Buffer.concat([Buffer.from([4]), b64u(jwk.x), b64u(jwk.y)]);
    const blob = Buffer.concat([sshString(type), sshString(curve), sshString(point)]);
    return `${type} ${blob.toString("base64")}`;
  }
  throw new SshKeyError(`sshPrivateKey uses an unsupported key type (${String(jwk.kty)}). Use ed25519, ECDSA or RSA.`);
}

/** Returns `"<type> <base64>"`, the first two fields of an authorized_keys line. */
export function derivePublicKey(privateKey: string): string {
  const pem = privateKey.trim();
  if (pem.includes("-----BEGIN OPENSSH PRIVATE KEY-----")) return fromOpenSshFormat(pem);
  return fromPem(pem);
}
