// Regenerates engine/package-lock.json and proves the installer's `npm ci` accepts it.
//   /path/to/node-v24/bin/node scripts/engine-lock.mjs
// Run it with the Node.js the installer pins (Node 24 and its npm), after changing the version in engine/package.json.
//
// Why more than one pass: Paperclip's packages bundle esbuild (and through it fsevents). npm's first lockfile for a new
// tree leaves out the optional platform packages of those bundled copies, and `npm ci` then refuses it as out of sync.
// A second pass over the existing lockfile adds them. This repeats until the lockfile stops changing, then checks it the
// way the installer will use it.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const dir = new URL("../engine/", import.meta.url).pathname;
const npmCli = join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
const npm = (args) => execFileSync(process.execPath, [npmCli, ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const flags = ["--ignore-scripts", "--no-audit", "--no-fund"];
const lockfile = `${dir}package-lock.json`;

console.log(`engine-lock: node ${process.versions.node}, npm ${npm(["--version"]).trim()}`);
if (process.argv.includes("--fresh") && existsSync(lockfile)) rmSync(lockfile);
let before = existsSync(lockfile) ? readFileSync(lockfile, "utf8") : "";
for (let pass = 1; ; pass++) {
  npm(["install", "--package-lock-only", ...flags]);
  const after = readFileSync(lockfile, "utf8");
  if (after === before) break;
  if (pass === 4) throw new Error("the lockfile is still changing after 4 passes");
  before = after;
}
try { npm(["ci", "--dry-run", "--omit=dev", ...flags]); }
catch (e) { console.error(`${e.stdout ?? ""}${e.stderr ?? ""}`); throw new Error("npm ci refuses engine/package-lock.json"); }
const lock = JSON.parse(readFileSync(lockfile, "utf8"));
const bad = Object.entries(lock.packages).filter(([k, p]) => k && !p.inBundle && !p.link && !(p.integrity?.startsWith("sha512-") && p.resolved?.startsWith("https://registry.npmjs.org/")));
if (bad.length) throw new Error(`entries without a registry URL and sha512 integrity: ${bad.map(([k]) => k).join(", ")}`);
console.log(`engine-lock: ${Object.keys(lock.packages).length - 1} entries, all from registry.npmjs.org with sha512 integrity; npm ci accepts it`);
