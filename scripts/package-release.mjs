// Packs the built service and console, with the installer and the engine's lockfile, into release/epaperclip.tar.gz
// (+ .sha256) and copies get.sh. The Debian and npm packages are built from that same tarball.
//   pnpm build && node scripts/package-release.mjs [version]
// The version defaults to the latest git tag or short commit. Users never build anything: get.sh downloads this.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const root = new URL("../", import.meta.url).pathname;
const bundle = `${root}services/epaperclip/dist/epaperclip.mjs`;
const consoleDir = `${root}apps/console/dist`;
const deployFiles = ["install.sh", "epaperclip.service", "epaperclip-engine.service", "epaperclip.default", "engine-links.mjs", "epaperclip-update.sh", "epaperclip-update.service", "epaperclip-update.path"];
const engineFiles = ["package.json", "package-lock.json"];
// The Proxmox sandbox provider (agent containers): its built code, template scripts and lockfile. Its production packages
// are installed at install time with the private Node.js, like the engine's (about 44 MB, so they are not in the download).
const pluginDir = `${root}plugins/proxmox-sandbox/`;
const pluginFiles = ["dist", "template", "package.json", "package-lock.json", "README.md"];
for (const p of [bundle, `${consoleDir}/index.html`]) if (!existsSync(p)) { console.error(`package-release: ${p} is missing; run pnpm build first`); process.exit(1); }
for (const p of [`${pluginDir}dist/manifest.js`, `${pluginDir}dist/worker.js`]) if (!existsSync(p)) { console.error(`package-release: ${p} is missing; build the provider first: npm --prefix plugins/proxmox-sandbox ci && npm --prefix plugins/proxmox-sandbox run build`); process.exit(1); }
for (const p of [...deployFiles.map((f) => `${root}deploy/${f}`), ...engineFiles.map((f) => `${root}engine/${f}`), ...pluginFiles.map((f) => `${pluginDir}${f}`)]) {
  if (!existsSync(p)) { console.error(`package-release: ${p} is missing`); process.exit(1); }
}

const version = process.argv[2] ?? (() => { try { return execFileSync("git", ["describe", "--tags", "--always"], { cwd: root, encoding: "utf8" }).trim(); } catch { return "dev"; } })();
const out = `${root}release/`;
const dir = `${out}epaperclip/`;
rmSync(out, { recursive: true, force: true });
mkdirSync(`${dir}deploy`, { recursive: true });
mkdirSync(`${dir}engine`, { recursive: true });
mkdirSync(`${dir}plugins/proxmox-sandbox`, { recursive: true });
cpSync(bundle, `${dir}epaperclip.mjs`);
cpSync(consoleDir, `${dir}console`, { recursive: true });
for (const f of deployFiles) cpSync(`${root}deploy/${f}`, `${dir}deploy/${f}`);
for (const f of engineFiles) cpSync(`${root}engine/${f}`, `${dir}engine/${f}`);
for (const f of pluginFiles) cpSync(`${pluginDir}${f}`, `${dir}plugins/proxmox-sandbox/${f}`, { recursive: true });
cpSync(`${root}LICENSE`, `${dir}LICENSE`);
writeFileSync(`${dir}VERSION`, `${version}\n`);

execFileSync("tar", ["-czf", `${out}epaperclip.tar.gz`, "--owner=0", "--group=0", "-C", out, "epaperclip"]);
const sum = createHash("sha256").update(readFileSync(`${out}epaperclip.tar.gz`)).digest("hex");
writeFileSync(`${out}epaperclip.tar.gz.sha256`, `${sum}  epaperclip.tar.gz\n`);
cpSync(`${root}deploy/get.sh`, `${out}get.sh`);
rmSync(dir, { recursive: true });
console.log(`package-release: ${version} -> release/epaperclip.tar.gz (${sum.slice(0, 12)}…)`);
