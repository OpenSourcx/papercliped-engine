// Makes the release signing key pair. Run it ONCE, on the maintainer's own machine (never in CI, never in a shared shell log).
//   node scripts/release-keygen.mjs                 writes the public key to deploy/release-signing.pub and prints the
//                                                   private key ONCE on stdout; store it as the GitHub secret RELEASE_SIGNING_KEY
//   node scripts/release-keygen.mjs --set-secret    same, but pipes the private key straight to `gh secret set
//                                                   RELEASE_SIGNING_KEY` and never shows it (add --repo owner/name if needed)
//   node scripts/release-keygen.mjs --force         replace an existing deploy/release-signing.pub (that is a key ROTATION:
//                                                   read docs/RELEASING.md first, a new key must ship in a release signed by the old one)
//   node scripts/release-keygen.mjs --public-out <file>   write the public key somewhere else (tests)
//
// The public key is a PEM (SubjectPublicKeyInfo, "BEGIN PUBLIC KEY") so openssl reads it directly. It is committed, pinned
// in the repo and shipped inside every release. The private key is never written to disk by this script.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fingerprint, generateReleaseKey } from "./release-lib.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const fail = (m) => { console.error(`release-keygen: ${m}`); process.exit(1); };
const root = new URL("../", import.meta.url).pathname;
const pubPath = value("--public-out") ?? `${root}deploy/release-signing.pub`;

if (flag("--help") || flag("-h")) { console.log("usage: node scripts/release-keygen.mjs [--set-secret [--repo owner/name]] [--force] [--public-out file]"); process.exit(0); }
if (process.env.CI) fail("this must run on the maintainer's own machine, not in CI (a key made in CI would sit in the build log's reach).");
if (existsSync(pubPath) && !flag("--force")) fail(`${pubPath} already exists. Replacing it is a key rotation; read docs/RELEASING.md ("Rotating the key"), then pass --force.`);

const { publicPem, privatePem } = generateReleaseKey();
if (flag("--set-secret")) {
  const gh = spawnSync("gh", ["secret", "set", "RELEASE_SIGNING_KEY", ...(value("--repo") ? ["--repo", value("--repo")] : [])], { input: privatePem, stdio: ["pipe", "inherit", "inherit"] });
  if (gh.error || gh.status !== 0) fail(`gh secret set failed${gh.error ? ` (${gh.error.message})` : ""}. Nothing was written; run it again (the new private key was discarded).`);
}
mkdirSync(dirname(pubPath), { recursive: true });
writeFileSync(pubPath, publicPem);
console.error(`release-keygen: public key written to ${pubPath} (fingerprint ${fingerprint(publicPem)}). Commit it.`);
if (flag("--set-secret")) {
  console.error("release-keygen: the private key went straight to the GitHub secret RELEASE_SIGNING_KEY and was not shown or saved.");
} else {
  console.error("release-keygen: the PRIVATE key follows on stdout, once. Store it as the GitHub secret RELEASE_SIGNING_KEY now (Settings > Secrets and variables > Actions),\n  then clear your terminal. It is not saved anywhere. Prefer --set-secret next time so it is never displayed.\n");
  process.stdout.write(privatePem);
}
