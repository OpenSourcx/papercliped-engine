import { createHash, randomBytes } from "node:crypto";

/**
 * Device-side primitives for the identity-link protocol proposed in docs/ACCESS-IDENTITY-LINK-CONTRACT.md (section 5.2 and
 * 5.3). Only what the contract states exactly and what does not depend on Connect's routes or open questions: the
 * PKCE-style verifier and S256 challenge (RFC 7636), the canonical signed-message text, and the session binding. There are
 * no routes, no state and no network here; nothing uses this yet. If the contract changes, change this file with it.
 */

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** A fresh verifier: 32 random bytes, base64url (43 characters), and its S256 challenge (RFC 7636). */
export function newVerifier(random: (n: number) => Uint8Array = randomBytes): { verifier: string; challenge: string } {
  const verifier = b64u(random(32));
  return { verifier, challenge: challengeOf(verifier) };
}

/** base64url(SHA-256(ascii(verifier))). */
export const challengeOf = (verifier: string): string => b64u(createHash("sha256").update(verifier, "ascii").digest());

const ACTIONS = ["start", "poll", "confirm", "revoke", "reconcile", "oidc-register", "oidc-redirects", "oidc-rotate", "oidc-remove", "hint"] as const;
export type IdentityAction = (typeof ACTIONS)[number];

/**
 * The text a device signs: `papercliped-connect:identity:<action>:v1\n` then one line per field, in the given order,
 * `<name>=<base64url(utf8(value))>\n`. Every field must be present (an absent value is the empty string, never skipped), and
 * names are lowercase letters and camelCase only, so no value or name can change where a line ends.
 */
export function canonicalIdentityMessage(action: IdentityAction, fields: readonly (readonly [string, string | number])[]): string {
  if (!ACTIONS.includes(action)) throw new Error("unknown identity action");
  let out = `papercliped-connect:identity:${action}:v1\n`;
  for (const [name, value] of fields) {
    if (!/^[a-z][A-Za-z0-9]{0,40}$/.test(name)) throw new Error("bad field name");
    out += `${name}=${b64u(Buffer.from(String(value), "utf8"))}\n`;
  }
  return out;
}

/** base64url(SHA-256("papercliped-connect:identity-session:v1:" + linkId + ":" + localSessionId)): binds a confirm to the session that started the link. */
export const sessionBinding = (linkId: string, localSessionId: string): string =>
  b64u(createHash("sha256").update(`papercliped-connect:identity-session:v1:${linkId}:${localSessionId}`, "utf8").digest());
