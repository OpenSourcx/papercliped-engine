import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import type { StateStore } from "./state.ts";

/**
 * Device-owned signing key for managed Papercliped Connect enrollment.
 *
 * NEVER send the private key to Papercliped Connect or expose it through
 * ePaperclip's browser API. It lives only in the host's encrypted StateStore
 * vault. This utility deliberately defines no HTTP or auth routes yet.
 */
const VAULT_KEY = "papercliped.connect.deviceKey";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{3,128}$/;

export interface ConnectDeviceIdentity {
  publicKeyJwk: { kty: string; crv?: string; x?: string; y?: string };
  deviceKeyThumbprint: string;
}

/** Must only be instantiated by the local-admin-authorized host service. */
export class PaperclipedDeviceIdentity {
  private readonly state: StateStore;
  constructor(state: StateStore) { this.state = state; }

  private privateKey() {
    const stored = this.state.getSecret(VAULT_KEY);
    if (stored) {
      // Fail closed if storage is corrupted. Silently replacing a key would
      // unexpectedly orphan the existing registered device.
      const key = createPrivateKey(stored);
      if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
        throw new Error("stored Connect key is not P-256");
      }
      return key;
    }
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const privatePem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    this.state.setSecret(VAULT_KEY, privatePem);
    return keys.privateKey;
  }

  publicIdentity(): ConnectDeviceIdentity {
    const key = this.privateKey();
    const pub = createPublicKey(key);
    const publicKeyJwk = pub.export({ format: "jwk" }) as ConnectDeviceIdentity["publicKeyJwk"];
    const spki = pub.export({ format: "der", type: "spki" });
    return {
      publicKeyJwk,
      deviceKeyThumbprint: createHash("sha256").update(spki).digest("base64url"),
    };
  }

  /** Initial proof of possession for an unclaimed device pairing challenge. */
  signChallenge(token: string): string {
    if (!TOKEN.test(token)) throw new Error("Invalid pairing challenge");
    const msg = Buffer.from("papercliped-connect:pairing:v1:" + token);
    return sign("sha256", msg, { key: this.privateKey(), dsaEncoding: "ieee-p1363" }).toString("base64url");
  }

  /** Second signature names the EXACT hosted account chosen by a human.
   * This must only be invoked AFTER trusted local administrator consent.
   */
  signAccountConfirmation(pairingId: string, accountId: string, token: string): string {
    if (!UUID.test(pairingId) || !ACCOUNT_ID.test(accountId) || !TOKEN.test(token)) {
      throw new Error("Invalid account confirmation");
    }
    const msg = Buffer.from("papercliped-connect:completion:v1:" + pairingId + ":" + accountId + ":" + token);
    return sign("sha256", msg, { key: this.privateKey(), dsaEncoding: "ieee-p1363" }).toString("base64url");
  }
}

/** Share only a handle, never a raw pairing challenge in the browser URL. */
export function pairingApprovalUrl(pairingId: string): string {
  if (!UUID.test(pairingId)) throw new Error("Invalid pairing id");
  return "https://console.papercliped.co/devices/pair?pairing_id=" + pairingId.toLowerCase();
}
