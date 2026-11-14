#!/usr/bin/env node
// epaperclip install | status | rollback | uninstall [--purge]
// Verifies the signed release this package carries (payload/epaperclip.tar.gz, its manifest and Ed25519 signature, against
// the public key pinned beside them), unpacks it to a private temporary folder and runs the installer inside (the same one
// as the release download and the Debian package). It must run as root on a Proxmox VE host. Nothing is unpacked or run
// unless the signature, the manifest's SHA-256 and its version all check out. Node.js is only needed to start this command: the
// installer brings its own pinned, checksum-verified Node.js for the services.
//
// `epaperclip --worker` does the same for a worker machine (Linux): it verifies the signed worker release this package
// carries, installs it with its own installer, and leads into `epaperclip-worker connect` to pair.
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const payload = new URL("../payload/", import.meta.url).pathname;
const read = (f) => { try { return readFileSync(join(payload, f)); } catch { return null; } };
const usage = `usage: epaperclip <command>

  setup                guided first run: checks the host, makes the sandbox network, installs, and says what to do next
  install              install ePaperclip, or upgrade it to this package's version
  status               version, whether both services run and answer, where the data is
  rollback             go back to the previous version
  uninstall [--purge]  remove it (keeps data and settings; --purge removes those too)
  --worker [code]      set this Linux machine up as a worker: verify the signed worker release, install it, and pair
                       (options: --user --fetch-node --check --name N --ollama-url U --max-context N --slots N --workspaces DIR;
                       "--worker install" installs or upgrades only; "--worker connect [code]" pairs, installing first if needed)
  worker ...           run the installed worker CLI (status, config, diagnose, ...)

Run as root in the Proxmox host's shell, for example: sudo npx epaperclip install
Guide: https://github.com/OpenSourcx/papercliped-engine/blob/main/docs/INSTALL.md`;

const fail = (msg, code = 1) => { console.error(`epaperclip: ${msg}`); process.exit(code); };
const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { console.log(usage); process.exit(cmd ? 0 : 2); }
if (cmd === "--version" || cmd === "-v" || cmd === "version") {
  try { console.log(JSON.parse(readFileSync(join(payload, "epaperclip.manifest.json"), "utf8")).version); } catch { console.log("unknown"); }
  process.exit(0);
}

// Verification shared by the host release and the worker release. Fail closed: the signature over the manifest against the
// pinned key, then the manifest's file name, SHA-256 and size against the file the package carries. Returns the verified
// bytes (what is unpacked is exactly what was checked, never a second read of the file).
function verifyPayload(what, manifestFile, sigFile, expected) {
  const [manifest, signature, key] = [manifestFile, sigFile, "release-signing.pub"].map(read);
  if (!key) fail("this package carries no release-signing key, so nothing can be verified and nothing was installed. The maintainer must run scripts/release-keygen.mjs and publish a package built with deploy/release-signing.pub");
  const incomplete = () => fail(`this package is incomplete or unsigned (the ${what}, its manifest or its signature is missing), so nothing was installed; reinstall the package`);
  if (!manifest || !signature) incomplete();
  let signed = false;
  try { signed = verify(null, manifest, createPublicKey(key), Buffer.from(signature.toString("utf8").replace(/\s+/g, ""), "base64")); } catch { /* not valid */ }
  if (!signed) fail(`the ${what}'s signature is not valid for the pinned key, so nothing was installed (the package was not signed by the project, or was altered)`);
  let m;
  try { m = JSON.parse(manifest.toString("utf8")); } catch { fail("the signed manifest can't be read, so nothing was installed"); }
  const nameOk = typeof expected === "string" ? m.name === expected : typeof m.name === "string" && expected.exec(m.name)?.[1] === m.version;
  if (!nameOk || !/^[0-9a-f]{64}$/.test(m.sha256 ?? "") || !/^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(-[0-9A-Za-z.]{1,40})?$/.test(m.version ?? "")) fail(`the signed manifest is not for this ${what} file, so nothing was installed`);
  const tarball = read(m.name);
  if (!tarball) incomplete();
  if (createHash("sha256").update(tarball).digest("hex") !== m.sha256 || (typeof m.size === "number" && m.size !== tarball.length)) fail(`the ${what} in this package doesn't match its signed checksum, so nothing was installed`);
  return { tarball, m };
}

// Writes the verified bytes to a private folder and unpacks them there.
function unpackVerified(tarball, name) {
  const work = mkdtempSync(join(tmpdir(), "epaperclip-npm-"));
  const cleanup = () => rmSync(work, { recursive: true, force: true });
  writeFileSync(join(work, name), tarball, { mode: 0o600 });
  const x = spawnSync("tar", ["-xzf", join(work, name), "--no-same-owner", "-C", work], { stdio: "inherit" });
  if (x.error || x.status !== 0) { cleanup(); fail("couldn't unpack the release"); }
  return { work, cleanup };
}

const WORKER_FILE = /^epaperclip-worker-([0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(?:-[0-9A-Za-z.]{1,40})?)\.tar\.gz$/;
const WORKER_VALUE_FLAGS = new Set(["--name", "--ollama-url", "--max-context", "--slots", "--workspaces"]);
const WORKER_BOOL_FLAGS = new Set(["--user", "--fetch-node", "--check"]);

// epaperclip --worker: set this machine up as a worker. It never reimages or repartitions anything: it installs one
// unprivileged service account and the worker package, which only connects out to your own ePaperclip host.
function workerCommand(rest) {
  const sub = rest[0];
  const setup = !sub || sub.startsWith("-") || sub === "install" || /^epw1\./.test(sub);
  if (!setup && sub !== "connect") {
    const r = spawnSync("epaperclip-worker", rest, { stdio: "inherit" });
    if (r.error) fail("the worker isn't installed on this machine. Set it up with: sudo epaperclip --worker");
    process.exit(r.status ?? 1);
  }
  if (process.platform === "darwin") fail("this command sets up workers on Linux. On a Mac, use the signed worker release's install-macos.sh (docs/WORKER-FABRIC-GUIDE.md); macOS isn't covered here until its install is qualified", 2);
  if (process.platform !== "linux") fail(`workers install on Linux; this is ${process.platform}`, 2);

  // What to hand the installer, and what to hand `connect`.
  const installerArgs = [];
  let code = null;
  let connectArgs = [];
  let userMode = false;
  let checkOnly = false;
  if (sub === "connect") {
    userMode = rest.includes("--user");
    if (userMode) installerArgs.push("--user");
    if (rest.includes("--fetch-node")) installerArgs.push("--fetch-node");
    connectArgs = rest.slice(1).filter((a) => a !== "--user" && a !== "--fetch-node");
  } else {
    const a = sub === "install" ? rest.slice(1) : rest;
    for (let i = 0; i < a.length; i++) {
      const t = a[i];
      if (WORKER_VALUE_FLAGS.has(t)) { if (a[i + 1] === undefined || a[i + 1].startsWith("--")) fail(`${t} needs a value`, 2); installerArgs.push(t, a[++i]); }
      else if (WORKER_BOOL_FLAGS.has(t)) { installerArgs.push(t); if (t === "--user") userMode = true; if (t === "--check") checkOnly = true; }
      else if (t.startsWith("-")) fail(`unknown option ${t}\n\n${usage}`, 2);
      else if (code === null && sub !== "install") code = t;
      else fail(`unexpected argument ${t}\n\n${usage}`, 2);
    }
  }
  if (!userMode && typeof process.getuid === "function" && process.getuid() !== 0 && process.env.EPW_TEST !== "1") {
    fail(`run as root to install the worker service (sudo epaperclip --worker ${rest.join(" ")}), or add --user to install it for your own account only`);
  }

  // Is it already here? Pairing doesn't reinstall; "install" and --check always run the installer.
  const binDir = process.env.EPW_BIN_DIR || (userMode ? join(process.env.HOME ?? "", ".local", "bin") : "/usr/local/bin");
  const cli = join(binDir, "epaperclip-worker");
  const prefix = process.env.EPW_PREFIX || (userMode ? join(process.env.HOME ?? "", ".local", "epaperclip-worker") : "/opt/epaperclip-worker");
  const bundle = join(prefix, "epaperclip-worker.mjs");
  // Installed means the installer's command and bundle are both there. (The command isn't run to find out: it switches to the
  // service account, which can fail for reasons that have nothing to do with whether the worker is installed.)
  const isInstalled = (() => { try { accessSync(cli, constants.X_OK); accessSync(bundle, constants.R_OK); return true; } catch { return false; } })();
  const ver = isInstalled ? spawnSync(process.execPath, [bundle, "version"], { encoding: "utf8" }) : null;
  const installed = isInstalled ? (ver && ver.status === 0 && String(ver.stdout).trim()) || "an earlier install" : null;
  const mustInstall = sub === "install" || checkOnly || installed === null;

  if (mustInstall) {
    const { tarball, m } = verifyPayload("worker release", "epaperclip-worker.manifest.json", "epaperclip-worker.manifest.sig", WORKER_FILE);
    const { work, cleanup } = unpackVerified(tarball, m.name);
    const installer = join(work, m.name.replace(/\.tar\.gz$/, ""), "install.sh");
    try { accessSync(installer, constants.R_OK); } catch { cleanup(); fail("the worker release is incomplete (install.sh is missing)"); }
    console.error(`epaperclip: worker release ${m.version} verified (signature and checksum)`);
    const r = spawnSync("bash", [installer, ...installerArgs], { stdio: "inherit" });
    cleanup();
    if (r.error) fail(`couldn't run the worker installer: ${r.error.message}`);
    if (r.status !== 0 || checkOnly || sub === "install") process.exit(r.status ?? 1);
  } else {
    console.error(`epaperclip: the worker is already installed (${/^[0-9]/.test(installed) ? `version ${installed}` : installed}); pairing it. To upgrade it, run: epaperclip --worker install`);
  }

  if (sub === "connect" || code !== null) {
    const p = spawnSync(cli, ["connect", ...(sub === "connect" ? connectArgs : [code])], { stdio: "inherit" });
    if (p.error) fail(`couldn't start the worker to pair it: ${p.error.message}`);
    process.exit(p.status ?? 1);
  }
  console.log(`\nInstalled. Next, pair it with your ePaperclip host: in the console open Workers, choose Add worker, copy the code, then run:\n  ${userMode ? "" : "sudo "}epaperclip --worker connect <code>`);
  process.exit(0);
}

if (cmd === "worker" || cmd === "--worker") workerCommand(rest);

const flags = { setup: [], install: [], status: ["--status"], rollback: ["--rollback"], uninstall: ["--uninstall"] }[cmd];
if (!flags) fail(`unknown command '${cmd}'\n\n${usage}`, 2);
let args = [...flags, ...rest];
if (cmd === "uninstall" && rest.includes("--purge")) args = ["--purge", ...rest.filter((a) => a !== "--purge")];

const onPath = (name) => (process.env.PATH ?? "").split(delimiter).concat("/usr/bin", "/usr/sbin").some((d) => {
  try { accessSync(join(d, name), constants.X_OK); return true; } catch { return false; }
});
if (process.platform !== "linux") fail("ePaperclip installs on a Proxmox VE host (Linux); this is " + process.platform);
if (typeof process.getuid === "function" && process.getuid() !== 0) fail(`run as root, for example: sudo npx epaperclip ${[cmd, ...rest].join(" ")}`);
if (!onPath("pveversion")) fail("this isn't a Proxmox VE host (pveversion wasn't found). Run it in the Proxmox host's own shell.");

const { tarball, m } = verifyPayload("release", "epaperclip.manifest.json", "epaperclip.manifest.sig", "epaperclip.tar.gz");
const { work, cleanup } = unpackVerified(tarball, m.name);
const installer = join(work, "epaperclip", "deploy", "install.sh");
try { accessSync(installer, constants.R_OK); } catch { cleanup(); fail("the release is incomplete (deploy/install.sh is missing)"); }
// The installer records which channel installed the host (apt, npm or the release download) and refuses to install over a
// host apt has registered, so it needs to know this is the npm one.
const r = spawnSync("bash", [installer, ...args], { stdio: "inherit", env: { ...process.env, EPC_CHANNEL: "npm" } });
cleanup();
if (r.error) fail(`couldn't run the installer: ${r.error.message}`);
if (cmd === "setup" && r.status === 0) {
  // Installed: the guided steps (sandbox network, health check, what to do next) live in the installed command.
  const s2 = spawnSync("epaperclip", ["setup"], { stdio: "inherit" });
  process.exit(s2.status ?? 1);
}
process.exit(r.status ?? 1);
