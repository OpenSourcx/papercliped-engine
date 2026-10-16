// Signs release/epaperclip.tar.gz: writes release/epaperclip.manifest.json (version, SHA-256, size, file name) and
// release/epaperclip.manifest.sig (detached Ed25519 signature over the manifest). Run after scripts/package-release.mjs.
//   RELEASE_SIGNING_KEY="$(cat key.pem)" node scripts/sign-release.mjs [--dir release]
// The private key comes only from the RELEASE_SIGNING_KEY environment variable (a CI secret). It is never printed.
// The version is read from the tarball's own VERSION file, so a manifest can't describe a different build than the one it signs.
// The result is verified again against deploy/release-signing.pub before the script says it is done; a missing or wrong key fails.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { MANIFEST, SIGNATURE, TARBALL, buildManifest, normalizeVersion, privateKeyFrom, signManifest, verifyManifest } from "./release-lib.mjs";

const root = new URL("../", import.meta.url).pathname;
const args = process.argv.slice(2);
const di = args.indexOf("--dir");
const dir = (di >= 0 ? args[di + 1] : `${root}release`).replace(/\/?$/, "/");
const pi = args.indexOf("--public");
const pubFile = pi >= 0 ? args[pi + 1] : `${root}deploy/release-signing.pub`;
const fail = (m) => { console.error(`sign-release: ${m}`); process.exit(1); };

const secret = process.env.RELEASE_SIGNING_KEY;
if (!secret || !secret.trim()) fail("RELEASE_SIGNING_KEY is not set, so the release was NOT signed and must not be published. Generate the key once with scripts/release-keygen.mjs and store it as that GitHub secret (docs/RELEASING.md).");
let priv;
try { priv = privateKeyFrom(secret); } catch { fail("RELEASE_SIGNING_KEY is not a PEM private key (the secret's value is not shown)."); }
let pub;
try { pub = readFileSync(pubFile, "utf8"); } catch { fail(`${pubFile} is missing. Run scripts/release-keygen.mjs and commit the public key it writes.`); }

let tarball;
try { tarball = readFileSync(`${dir}${TARBALL}`); } catch { fail(`${dir}${TARBALL} is missing; run scripts/package-release.mjs first.`); }
let inside;
try { inside = normalizeVersion(execFileSync("tar", ["-xzOf", `${dir}${TARBALL}`, "epaperclip/VERSION"], { encoding: "utf8" })); } catch { fail(`${TARBALL} has no epaperclip/VERSION; it is not a release.`); }
const expected = process.env.EPC_RELEASE_VERSION ? normalizeVersion(process.env.EPC_RELEASE_VERSION) : inside;
if (expected !== inside) fail(`the tarball is version ${inside}, but ${expected} was expected.`);

const manifest = buildManifest({ version: inside, tarball });
const signature = signManifest(manifest, priv);
if (!verifyManifest(manifest, signature, pub)) fail("the signature does not verify against deploy/release-signing.pub: RELEASE_SIGNING_KEY is not the private half of the pinned public key. Nothing was written.");
writeFileSync(`${dir}${MANIFEST}`, manifest);
writeFileSync(`${dir}${SIGNATURE}`, signature);
console.log(`sign-release: ${inside} signed -> ${MANIFEST}, ${SIGNATURE} (verified against the pinned key)`);
