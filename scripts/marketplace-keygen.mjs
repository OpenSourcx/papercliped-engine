// Makes the signing key pair for a marketplace catalog.
//   node scripts/marketplace-keygen.mjs
// Store the PRIVATE key as a secret in the catalog's CI (MARKETPLACE_SIGNING_KEY). Never commit it.
// Pin the PUBLIC key in packages/marketplace/src/index.ts (TRUSTED_KEYS) so devices trust the catalog it signs.
import { generateSigningKey } from "../packages/marketplace/src/index.ts";

const k = generateSigningKey();
console.log(`Key id: ${k.keyId}\n\nPUBLIC key (pin this in TRUSTED_KEYS):\n${k.publicKeyPem}\nPRIVATE key (a CI secret, never commit):\n${k.privateKeyPem}`);
