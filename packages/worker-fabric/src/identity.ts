import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";

/** Ed25519 identities and the pairing code. Raw 32-byte public keys travel as base64url. */

const ED_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const X_SPKI = Buffer.from("302a300506032b656e032100", "hex");

export const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
export const unb64u = (s: string): Buffer => Buffer.from(s, "base64url");

export function edPublicFromRaw(raw: string): KeyObject {
  const b = unb64u(raw);
  if (b.length !== 32) throw new Error("bad public key");
  return createPublicKey({ key: Buffer.concat([ED_SPKI, b]), format: "der", type: "spki" });
}
export function xPublicFromRaw(raw: string): KeyObject {
  const b = unb64u(raw);
  if (b.length !== 32) throw new Error("bad public key");
  return createPublicKey({ key: Buffer.concat([X_SPKI, b]), format: "der", type: "spki" });
}
export const rawPublic = (k: KeyObject): string => b64u((k.export({ type: "spki", format: "der" }) as Buffer).subarray(-32));

export interface Identity {
  /** PKCS#8 PEM. Secret: the file holding it is mode 0600. */
  privatePem: string;
  /** Raw Ed25519 public key, base64url. */
  publicKey: string;
}

export function generateIdentity(): Identity {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey: rawPublic(publicKey) };
}

export const privateKeyOf = (id: Identity): KeyObject => createPrivateKey(id.privatePem);

export const signWith = (id: Identity, data: Uint8Array): string => b64u(sign(null, data, privateKeyOf(id)));

export function verifyRaw(publicKey: string, data: Uint8Array, sig: string): boolean {
  try {
    return verify(null, data, edPublicFromRaw(publicKey), unb64u(sig));
  } catch {
    return false;
  }
}

/** A short, stable fingerprint of a public key for people to compare: 32 hex characters, grouped. */
export function fingerprint(publicKey: string): string {
  return createHash("sha256").update(unb64u(publicKey)).digest("hex").slice(0, 32);
}

/** The short string both screens show for a pending request: easy to read aloud, derived from the key. */
export function verificationString(publicKey: string): string {
  const h = createHash("sha256").update("epw1-verify").update(unb64u(publicKey)).digest();
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[h[i]! % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export interface PairingPayload {
  /** Candidate host endpoints in preference order. */
  urls: { provider: string; url: string }[];
  /** The host's Ed25519 public key (raw, base64url). */
  hostKey: string;
  /** Pairing id (public) and secret (single use). */
  id: string;
  secret: string;
}

export const PAIRING_PREFIX = "epw1.";

export function encodePairing(p: PairingPayload): string {
  return PAIRING_PREFIX + Buffer.from(JSON.stringify({ u: p.urls, k: p.hostKey, i: p.id, s: p.secret })).toString("base64url");
}

export function decodePairing(code: string): PairingPayload {
  const t = code.trim();
  if (!t.startsWith(PAIRING_PREFIX) || t.length > 4096) throw new Error("That is not an ePaperclip pairing code.");
  let v: { u?: unknown; k?: unknown; i?: unknown; s?: unknown };
  try {
    v = JSON.parse(Buffer.from(t.slice(PAIRING_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new Error("That pairing code is damaged.");
  }
  const urls = Array.isArray(v.u) ? v.u.filter((x): x is { provider: string; url: string } => !!x && typeof (x as { url?: unknown }).url === "string" && typeof (x as { provider?: unknown }).provider === "string") : [];
  if (!urls.length || typeof v.k !== "string" || typeof v.i !== "string" || typeof v.s !== "string") throw new Error("That pairing code is incomplete.");
  edPublicFromRaw(v.k);
  return { urls, hostKey: v.k, id: v.i, secret: v.s };
}

export const newPairingSecret = (): string => randomBytes(20).toString("base64url");
export const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");
