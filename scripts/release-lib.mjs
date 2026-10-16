// Shared by scripts/release-keygen.mjs, sign-release.mjs, package-release.mjs and the tests: the manifest, the Ed25519
// signature over it, and the get.sh that carries the pinned key. Plain node:crypto, no dependencies.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";

export const TARBALL = "epaperclip.tar.gz";
export const MANIFEST = "epaperclip.manifest.json";
export const SIGNATURE = "epaperclip.manifest.sig";
export const VERSION_RE = /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(-[0-9A-Za-z.]{1,40})?$/;

export const normalizeVersion = (v) => String(v).trim().replace(/^v/, "");
export const isPrerelease = (v) => normalizeVersion(v).includes("-");

/** The signed manifest. Fixed field order and layout, because deploy/verify-release.sh reads it line by line. */
export function buildManifest({ version, tarball }) {
  const v = normalizeVersion(version);
  if (!VERSION_RE.test(v)) throw new Error(`"${version}" is not a release version (expected 1.2.3 or 1.2.3-rc1)`);
  return `${JSON.stringify({ format: 1, name: TARBALL, version: v, sha256: createHash("sha256").update(tarball).digest("hex"), size: tarball.length }, null, 2)}\n`;
}

/** Accepts the PEM exactly as stored in a CI secret (also with its newlines written as backslash-n). */
export function privateKeyFrom(text) {
  const pem = String(text).trim().replace(/\\n/g, "\n");
  return createPrivateKey(pem);
}

export const signManifest = (manifestText, privateKey) => sign(null, Buffer.from(manifestText), privateKey).toString("base64") + "\n";

export function verifyManifest(manifestText, signatureText, publicPem) {
  try { return verify(null, Buffer.from(manifestText), createPublicKey(publicPem), Buffer.from(signatureText.trim(), "base64")); } catch { return false; }
}

export function generateReleaseKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicPem: publicKey.export({ type: "spki", format: "pem" }), privatePem: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

/** Short fingerprint for humans to compare: the first 16 hex digits of the SHA-256 of the public key (DER). */
export const fingerprint = (publicPem) => createHash("sha256").update(createPublicKey(publicPem).export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);

/**
 * The get.sh a release ships: the template with the verification library and the pinned public key written in, so the one
 * file piped to bash is self-contained. With no key the template's own refusal stays in place (it fails closed).
 */
export function buildGetSh(root, publicPem) {
  let s = readFileSync(`${root}deploy/get.sh`, "utf8");
  const lib = readFileSync(`${root}deploy/verify-release.sh`, "utf8");
  if (!s.includes("# @@EPC_VERIFY_LIB@@\n") || !s.includes("# @@EPC_PINNED_KEY@@\n")) throw new Error("deploy/get.sh has lost its template markers");
  s = s.replace("# @@EPC_VERIFY_LIB@@\n", () => lib);
  if (publicPem) {
    if (!/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n?$/.test(publicPem)) throw new Error("the public key is not a PEM public key");
    s = s.replace("# @@EPC_PINNED_KEY@@\n", () => `EPC_PINNED_KEY='${publicPem.trim()}'\n`);
  }
  return s;
}
