// Signs the worker release: release/epaperclip-worker-<version>.tar.gz (from scripts/package-worker.sh) gets
// release/epaperclip-worker.manifest.json (version, SHA-256, size, file name) and release/epaperclip-worker.manifest.sig
// (detached Ed25519 signature over the manifest), with the same key and the same checks as scripts/sign-release.mjs.
//   RELEASE_SIGNING_KEY="$(cat key.pem)" node scripts/sign-worker-release.mjs [--dir release]
// The private key comes only from the RELEASE_SIGNING_KEY environment variable (a CI secret). It is never printed.
// The version is read from the tarball's own VERSION file and must match the version in its file name, so a manifest can't
// describe a different build than the one it signs. The result is verified against deploy/release-signing.pub before this
// says it is done; a missing or wrong key fails.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { WORKER_MANIFEST, WORKER_SIGNATURE, WORKER_TARBALL_RE, buildManifest, normalizeVersion, privateKeyFrom, signManifest, verifyManifest } from "./release-lib.mjs";

const root = new URL("../", import.meta.url).pathname;
const args = process.argv.slice(2);
const di = args.indexOf("--dir");
const dir = (di >= 0 ? args[di + 1] : `${root}release`).replace(/\/?$/, "/");
const pi = args.indexOf("--public");
const pubFile = pi >= 0 ? args[pi + 1] : `${root}deploy/release-signing.pub`;
const fail = (m) => { console.error(`sign-worker-release: ${m}`); process.exit(1); };

const secret = process.env.RELEASE_SIGNING_KEY;
if (!secret || !secret.trim()) fail("RELEASE_SIGNING_KEY is not set, so the worker release was NOT signed and must not be published. Generate the key once with scripts/release-keygen.mjs (docs/RELEASING.md).");
let priv;
try { priv = privateKeyFrom(secret); } catch { fail("RELEASE_SIGNING_KEY is not a PEM private key (the secret's value is not shown)."); }
let pub;
try { pub = readFileSync(pubFile, "utf8"); } catch { fail(`${pubFile} is missing. Run scripts/release-keygen.mjs and commit the public key it writes.`); }

let names;
try { names = readdirSync(dir).filter((f) => WORKER_TARBALL_RE.test(f)); } catch { fail(`${dir} doesn't exist; run scripts/package-worker.sh first.`); }
if (names.length !== 1) fail(`expected exactly one epaperclip-worker-<version>.tar.gz in ${dir}, found ${names.length}; run scripts/package-worker.sh on a clean release folder.`);
const name = names[0];
const fromName = WORKER_TARBALL_RE.exec(name)[1];
const tarball = readFileSync(`${dir}${name}`);
let inside;
try { inside = normalizeVersion(execFileSync("tar", ["-xzOf", `${dir}${name}`, `epaperclip-worker-${fromName}/VERSION`], { encoding: "utf8" })); } catch { fail(`${name} has no epaperclip-worker-${fromName}/VERSION, so its version can't be confirmed.`); }
if (inside !== fromName) fail(`${name} says version ${fromName} but the build inside is ${inside}.`);

const manifest = buildManifest({ version: inside, tarball, name });
const signature = signManifest(manifest, priv);
if (!verifyManifest(manifest, signature, pub)) fail("the signature does not verify against deploy/release-signing.pub: RELEASE_SIGNING_KEY is not the private half of the pinned public key, so nothing was written.");
writeFileSync(`${dir}${WORKER_MANIFEST}`, manifest);
writeFileSync(`${dir}${WORKER_SIGNATURE}`, signature);
console.log(`sign-worker-release: ${inside} signed -> ${WORKER_MANIFEST}, ${WORKER_SIGNATURE} (verified against the pinned key)`);
