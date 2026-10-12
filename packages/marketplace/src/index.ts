import { CONNECTOR_KINDS, SCHEMA, type Entry, type Index, type Source } from "./types.ts";
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

/**
 * The marketplace index: a JSON list of the connectors, adapters and skills the Store offers, published as a file
 * (for example in a public GitHub repository) next to a detached Ed25519 signature. The host service fetches both,
 * checks the signature against keys pinned in this code, and only then lets the Store see the list. Where the file is
 * hosted doesn't matter for trust: a copy that isn't signed by a pinned key is refused.
 *
 * Also checked: the index hasn't expired (so a frozen old copy can't be replayed forever), and its sequence number
 * never goes down (so an older, still-valid copy can't roll the catalog back).
 */

/** Where the first-party catalog is published. Overridable by the device's administrator. */
export * from "./types.ts";
export const DEFAULT_INDEX_URL = "https://raw.githubusercontent.com/OpenSourcx/papercliped-marketplace/main/index.json";

export type FailCode = "malformed" | "unknown_key" | "bad_signature" | "expired" | "rollback" | "too_large";
export class MarketplaceError extends Error {
  readonly code: FailCode;
  constructor(code: FailCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface TrustedKey {
  /** First 16 hex characters of the SHA-256 of the key's SPKI DER. */
  id: string;
  publicKeyPem: string;
}

/** Keys the catalog is trusted to be signed by. The first-party key is added here when it is generated; a key can be retired by publishing a release that drops it. */
export const TRUSTED_KEYS: TrustedKey[] = [];

const keyIdOf = (publicKeyPem: string) => createHash("sha256").update(createPublicKey(publicKeyPem).export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);

export function trustedKey(publicKeyPem: string): TrustedKey {
  return { id: keyIdOf(publicKeyPem), publicKeyPem };
}

/** Makes a signing key pair. Keep the private half secret (a CI secret); publish the public half. */
export function generateSigningKey(): { privateKeyPem: string; publicKeyPem: string; keyId: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyPem, keyId: keyIdOf(publicKeyPem) };
}

/** The signature file's contents for an index file's exact bytes: `<key id> <base64 signature>`. */
export function signIndex(bytes: Uint8Array, privateKeyPem: string, publicKeyPem: string): string {
  return `${keyIdOf(publicKeyPem)} ${sign(null, bytes, privateKeyPem).toString("base64")}\n`;
}

const MAX_INDEX_BYTES = 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9_-]{1,47}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.-]{1,32})?$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9-]{0,50}\/)?[a-z0-9][a-z0-9._-]{0,100}$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const PERMISSION = /^[a-z][a-z0-9._:-]{1,39}$/;
const text = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f<>]/.test(v);
const when = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));

function bad(why: string): never {
  throw new MarketplaceError("malformed", `The catalog isn't valid: ${why}.`);
}

function parseEntry(raw: unknown, i: number): Entry {
  if (typeof raw !== "object" || raw === null) bad(`entry ${i} isn't an object`);
  const e = raw as Record<string, unknown>;
  const at = `entry ${i}`;
  if (typeof e.id !== "string" || !ID.test(e.id)) bad(`${at} has a bad id`);
  if (e.kind !== "connector" && e.kind !== "adapter" && e.kind !== "skill") bad(`${at} has a bad kind`);
  if (!text(e.name, 60) || !text(e.vendor, 80) || !text(e.summary, 300)) bad(`${at} has a bad name, vendor or summary`);
  if (typeof e.version !== "string" || !VERSION.test(e.version)) bad(`${at} has a bad version`);
  if (e.minEngine !== undefined && (typeof e.minEngine !== "string" || !VERSION.test(e.minEngine))) bad(`${at} has a bad minEngine`);
  if (e.connectorKind !== undefined && !(CONNECTOR_KINDS as readonly unknown[]).includes(e.connectorKind)) bad(`${at} has a bad connectorKind`);
  if (e.kind === "connector" && e.connectorKind === undefined) bad(`${at} is a connector without a connectorKind`);
  const s = e.source as Record<string, unknown> | null;
  let source: Source;
  if (s?.type === "builtin") source = { type: "builtin" };
  else if (s?.type === "npm" && typeof s.name === "string" && NPM_NAME.test(s.name) && typeof s.version === "string" && VERSION.test(s.version) && typeof s.integrity === "string" && INTEGRITY.test(s.integrity)) source = { type: "npm", name: s.name, version: s.version, integrity: s.integrity };
  else return bad(`${at} has a bad source (npm packages need an exact version and a sha512 integrity hash)`);
  if (!Array.isArray(e.permissions) || e.permissions.length > 12 || !e.permissions.every((p) => typeof p === "string" && PERMISSION.test(p))) bad(`${at} has bad permissions`);
  let icon: Entry["icon"];
  if (e.icon !== undefined) {
    const ic = e.icon as Record<string, unknown>;
    if (typeof ic?.file !== "string" || !/^icons\/[a-z0-9_-]{1,48}\.svg$/.test(ic.file) || typeof ic.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(ic.sha256)) bad(`${at} has a bad icon`);
    icon = { file: ic.file as string, sha256: ic.sha256 as string };
  }
  return { id: e.id, kind: e.kind, name: e.name as string, vendor: e.vendor as string, summary: e.summary as string, version: e.version, ...(e.minEngine ? { minEngine: e.minEngine as string } : {}), ...(e.connectorKind ? { connectorKind: e.connectorKind as Entry["connectorKind"] } : {}), source, permissions: e.permissions as string[], ...(icon ? { icon } : {}) };
}

export interface VerifyOptions {
  keys: TrustedKey[];
  now?: number;
  /** The highest sequence this device has already accepted. */
  lastSequence?: number;
}

/** Checks a downloaded index and its signature, and returns the parsed list, or throws a MarketplaceError saying why not. */
export function verifyIndex(bytes: Uint8Array, signatureText: string, o: VerifyOptions): Index {
  if (bytes.length > MAX_INDEX_BYTES) throw new MarketplaceError("too_large", "The catalog is larger than expected.");
  const m = signatureText.trim().match(/^([0-9a-f]{16}) ([A-Za-z0-9+/]+=*)$/);
  if (!m) throw new MarketplaceError("malformed", "The catalog's signature file isn't valid.");
  const key = o.keys.find((k) => k.id === m[1]);
  if (!key) throw new MarketplaceError("unknown_key", "The catalog is signed with a key this device doesn't trust.");
  if (!verify(null, bytes, key.publicKeyPem, Buffer.from(m[2], "base64"))) throw new MarketplaceError("bad_signature", "The catalog's signature doesn't match, so it was not used.");

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return bad("it isn't JSON");
  }
  const r = raw as Record<string, unknown>;
  if (typeof r !== "object" || r === null || r.schema !== SCHEMA) bad("it uses a format this version doesn't know");
  if (!Number.isInteger(r.sequence) || (r.sequence as number) < 0 || !when(r.generatedAt) || !when(r.expires) || !Array.isArray(r.entries) || r.entries.length > 500) bad("its header is wrong");
  const now = o.now ?? Date.now();
  if (Date.parse(r.expires as string) <= now) throw new MarketplaceError("expired", "The catalog has expired; it needs to be republished.");
  if (o.lastSequence !== undefined && (r.sequence as number) < o.lastSequence) throw new MarketplaceError("rollback", "The catalog is older than one already seen, so it was not used.");
  const entries = (r.entries as unknown[]).map(parseEntry);
  if (new Set(entries.map((e) => e.id)).size !== entries.length) bad("two entries share an id");
  return { schema: SCHEMA, sequence: r.sequence as number, generatedAt: r.generatedAt as string, expires: r.expires as string, entries };
}
