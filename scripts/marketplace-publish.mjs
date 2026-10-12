// Turns marketplace/catalog.json into a signed index: marketplace/dist/index.json and index.json.sig.
//   MARKETPLACE_SIGNING_KEY="$(cat private.pem)" node scripts/marketplace-publish.mjs [--sequence N] [--days 60]
// The sequence defaults to the current time in seconds, so every publication is higher than the last. The index
// expires after --days (default 60), so a catalog that stops being republished stops being accepted.
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SCHEMA, signIndex, trustedKey, verifyIndex } from "../packages/marketplace/src/index.ts";

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const pem = process.env.MARKETPLACE_SIGNING_KEY;
if (!pem) { console.error("Set MARKETPLACE_SIGNING_KEY to the catalog's private key (PEM)."); process.exit(1); }
const publicKeyPem = createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "pem" }).toString();

const { entries } = JSON.parse(readFileSync(new URL("../marketplace/catalog.json", import.meta.url), "utf8"));
const now = new Date();
const index = { schema: SCHEMA, sequence: Number(arg("sequence", Math.floor(now.getTime() / 1000))), generatedAt: now.toISOString(), expires: new Date(now.getTime() + Number(arg("days", 60)) * 86_400_000).toISOString(), entries };
const bytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`);
const sig = signIndex(bytes, pem, publicKeyPem);

// Check it the way a device will before writing anything.
verifyIndex(bytes, sig, { keys: [trustedKey(publicKeyPem)] });

const out = new URL("../marketplace/dist/", import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("index.json", out), bytes);
writeFileSync(new URL("index.json.sig", out), sig);
console.log(`Published ${entries.length} entries, sequence ${index.sequence}, expires ${index.expires}.`);
