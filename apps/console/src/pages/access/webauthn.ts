/**
 * Security keys (WebAuthn) in the browser, the way Proxmox's own pages do it: the challenge and credential ids travel as
 * base64url text, the browser wants bytes, and the answer goes back as base64url text inside JSON.
 */

export const b64uToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export const bytesToB64u = (b: ArrayBuffer | Uint8Array): string => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let bin = "";
  for (const x of u) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const webauthnAvailable = () => typeof window !== "undefined" && "PublicKeyCredential" in window && !!navigator.credentials;

interface PolicyLike { id: string | null; origin: string | null; allowSubdomains: boolean }

/**
 * Whether a key registered from this address would work with Proxmox's WebAuthn setting. A key is bound to the
 * relying-party id (a domain) and the origin; they have to match the address the person is using now.
 */
export function webauthnUsableHere(policy: PolicyLike | null, location: { origin: string; hostname: string }): { ok: boolean; why: string } {
  if (!policy || !policy.id || !policy.origin) return { ok: false, why: "Proxmox has no WebAuthn address set yet. An administrator sets it in Sign-in policy." };
  const sameOrigin = policy.origin.replace(/\/$/, "") === location.origin;
  let subdomain = false;
  try {
    const host = new URL(policy.origin).hostname;
    subdomain = policy.allowSubdomains && (location.hostname === host || location.hostname.endsWith(`.${host}`));
  } catch {
    subdomain = false;
  }
  if (!sameOrigin && !subdomain) return { ok: false, why: `Proxmox's WebAuthn address is ${policy.origin}, but this page is ${location.origin}. Keys registered here would not work. An administrator can set the WebAuthn address to ${location.origin} in Sign-in policy.` };
  const idOk = location.hostname === policy.id || location.hostname.endsWith(`.${policy.id}`);
  if (!idOk) return { ok: false, why: `Proxmox's relying-party id is ${policy.id}, which this page's address (${location.hostname}) doesn't belong to.` };
  return { ok: true, why: "" };
}

/** Asks the browser to make a key from Proxmox's registration options; returns the JSON Proxmox wants as `value`. */
export async function registerKey(optionsJson: string): Promise<{ challenge: string; value: string }> {
  const creds = JSON.parse(optionsJson) as { publicKey: Record<string, any> };
  const pk = creds.publicKey;
  const challenge: string = pk.challenge;
  pk.challenge = b64uToBytes(challenge);
  pk.user.id = b64uToBytes(pk.user.id);
  pk.excludeCredentials = (pk.excludeCredentials ?? []).map((c: { id: string; type: string }) => ({ id: b64uToBytes(c.id), type: c.type }));
  const r = (await navigator.credentials.create(creds as unknown as CredentialCreationOptions)) as PublicKeyCredential | null;
  if (!r) throw new Error("No security key was added");
  const resp = r.response as AuthenticatorAttestationResponse;
  return { challenge, value: JSON.stringify({ id: r.id, type: r.type, rawId: bytesToB64u(r.rawId), response: { attestationObject: bytesToB64u(resp.attestationObject), clientDataJSON: bytesToB64u(resp.clientDataJSON) } }) };
}

/** Answers Proxmox's sign-in challenge with a key; returns the JSON to send back. */
export async function answerChallenge(options: Record<string, any>): Promise<string> {
  const pk = options.publicKey as Record<string, any>;
  const copy = { publicKey: { ...pk, challenge: b64uToBytes(pk.challenge), allowCredentials: (pk.allowCredentials ?? []).map((c: { id: string; type: string }) => ({ ...c, id: b64uToBytes(c.id) })) } };
  const r = (await navigator.credentials.get(copy as unknown as CredentialRequestOptions)) as PublicKeyCredential | null;
  if (!r) throw new Error("No security key answered");
  const resp = r.response as AuthenticatorAssertionResponse;
  return JSON.stringify({ id: r.id, type: r.type, rawId: bytesToB64u(r.rawId), response: { authenticatorData: bytesToB64u(resp.authenticatorData), clientDataJSON: bytesToB64u(resp.clientDataJSON), signature: bytesToB64u(resp.signature) } });
}
