#!/usr/bin/env node
// epaperclip install | status | rollback | uninstall [--purge]
// Verifies the signed release this package carries (payload/epaperclip.tar.gz, its manifest and Ed25519 signature, against
// the public key pinned beside them), unpacks it to a private temporary folder and runs the installer inside (the same one
// as the release download and the Debian package). It must run as root on a Proxmox VE host. Nothing is unpacked or run
// unless the signature, the manifest's SHA-256 and its version all check out. Node.js is only needed to start this command: the
// installer brings its own pinned, checksum-verified Node.js for the services.
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const payload = new URL("../payload/", import.meta.url).pathname;
const usage = `usage: epaperclip <command>

  install              install ePaperclip, or upgrade it to this package's version
  status               version, whether both services run and answer, where the data is
  rollback             go back to the previous version
  uninstall [--purge]  remove it (keeps data and settings; --purge removes those too)

Run as root in the Proxmox host's shell, for example: sudo npx epaperclip install
Guide: https://github.com/OpenSourcx/papercliped-engine/blob/main/docs/INSTALL.md`;

const fail = (msg, code = 1) => { console.error(`epaperclip: ${msg}`); process.exit(code); };
const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { console.log(usage); process.exit(cmd ? 0 : 2); }
if (cmd === "--version" || cmd === "-v" || cmd === "version") {
  try { console.log(JSON.parse(readFileSync(join(payload, "epaperclip.manifest.json"), "utf8")).version); } catch { console.log("unknown"); }
  process.exit(0);
}

const flags = { install: [], status: ["--status"], rollback: ["--rollback"], uninstall: ["--uninstall"] }[cmd];
if (!flags) fail(`unknown command '${cmd}'\n\n${usage}`, 2);
let args = [...flags, ...rest];
if (cmd === "uninstall" && rest.includes("--purge")) args = ["--purge", ...rest.filter((a) => a !== "--purge")];

const onPath = (name) => (process.env.PATH ?? "").split(delimiter).concat("/usr/bin", "/usr/sbin").some((d) => {
  try { accessSync(join(d, name), constants.X_OK); return true; } catch { return false; }
});
if (process.platform !== "linux") fail("ePaperclip installs on a Proxmox VE host (Linux); this is " + process.platform);
if (typeof process.getuid === "function" && process.getuid() !== 0) fail(`run as root, for example: sudo npx epaperclip ${[cmd, ...rest].join(" ")}`);
if (!onPath("pveversion")) fail("this isn't a Proxmox VE host (pveversion wasn't found). Run it in the Proxmox host's own shell.");

// Fail closed: the signature over the manifest, then the manifest's SHA-256 and file name against the tarball.
const read = (f) => { try { return readFileSync(join(payload, f)); } catch { return null; } };
const [tarball, manifest, signature, key] = ["epaperclip.tar.gz", "epaperclip.manifest.json", "epaperclip.manifest.sig", "release-signing.pub"].map(read);
if (!key) fail("this package carries no release-signing key, so nothing can be verified and nothing was installed. The maintainer must run scripts/release-keygen.mjs and publish a package built with deploy/release-signing.pub");
if (!tarball || !manifest || !signature) fail("this package is incomplete or unsigned (the release, its manifest or its signature is missing), so nothing was installed; reinstall the package");
let signed = false;
try { signed = verify(null, manifest, createPublicKey(key), Buffer.from(signature.toString("utf8").replace(/\s+/g, ""), "base64")); } catch { /* not valid */ }
if (!signed) fail("the release's signature is not valid for the pinned key, so nothing was installed (the package was not signed by the project, or was altered)");
let m;
try { m = JSON.parse(manifest.toString("utf8")); } catch { fail("the signed manifest can't be read, so nothing was installed"); }
if (m.name !== "epaperclip.tar.gz" || !/^[0-9a-f]{64}$/.test(m.sha256 ?? "") || !/^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(-[0-9A-Za-z.]{1,40})?$/.test(m.version ?? "")) fail("the signed manifest is not for this release file, so nothing was installed");
if (createHash("sha256").update(tarball).digest("hex") !== m.sha256 || (typeof m.size === "number" && m.size !== tarball.length)) fail("the release in this package doesn't match its signed checksum, so nothing was installed");

const work = mkdtempSync(join(tmpdir(), "epaperclip-npm-"));
const cleanup = () => rmSync(work, { recursive: true, force: true });
const x = spawnSync("tar", ["-xzf", join(payload, "epaperclip.tar.gz"), "--no-same-owner", "-C", work], { stdio: "inherit" });
if (x.error || x.status !== 0) { cleanup(); fail("couldn't unpack the release"); }
const installer = join(work, "epaperclip", "deploy", "install.sh");
try { accessSync(installer, constants.R_OK); } catch { cleanup(); fail("the release is incomplete (deploy/install.sh is missing)"); }
const r = spawnSync("bash", [installer, ...args], { stdio: "inherit" });
cleanup();
if (r.error) fail(`couldn't run the installer: ${r.error.message}`);
process.exit(r.status ?? 1);
