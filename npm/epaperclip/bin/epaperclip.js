#!/usr/bin/env node
// epaperclip install | status | rollback | uninstall [--purge]
// Runs the installer this package carries (payload/epaperclip/deploy/install.sh, the same one as the release download
// and the Debian package). It must run as root on a Proxmox VE host. Node.js is only needed to start this command: the
// installer brings its own pinned, checksum-verified Node.js for the services.
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

const payload = new URL("../payload/epaperclip/", import.meta.url).pathname;
const installer = join(payload, "deploy", "install.sh");
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
  try { console.log(readFileSync(join(payload, "VERSION"), "utf8").trim()); } catch { console.log("unknown"); }
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
try { accessSync(installer, constants.R_OK); } catch { fail(`this package is incomplete (${installer} is missing); reinstall it`); }

const r = spawnSync("bash", [installer, ...args], { stdio: "inherit" });
if (r.error) fail(`couldn't run the installer: ${r.error.message}`);
process.exit(r.status ?? 1);
