// End-to-end proof against the REAL engine: the pinned Paperclip, the real host service and the built console, with the
// fake Proxmox from test/fakes-e2e.ts, driven through a browser. See docs/E2E.md for what it covers and what it can't.
//
//   pnpm --filter @papercliped-engine/console exec vite build
//   node --experimental-strip-types services/epaperclip/scripts/e2e-real-engine.mts
//
// Needs root (the engine's embedded Postgres refuses to run as root, so the engine is started as `nobody` with setpriv),
// a Node >= 24.11 and the installed engine (EPC_E2E_ENGINE_APP, default /opt/epc-eng/app with node_modules/paperclipai),
// and Playwright with a Chromium (EPC_PLAYWRIGHT, EPC_CHROMIUM; never run `playwright install`).
//   EPC_E2E_SHOTS=/tmp/epc-e2e-shots   where screenshots go (not committed)
//   EPC_E2E_ONLY=orgs,pin              run only stages whose names contain one of these words
//   EPC_E2E_HOLD=/path/file.json      after the stages, keep everything running and write the host's address there (for poking at it)
//   EPC_E2E_KEEP=1                     leave the engine data directory behind
import { spawn, type ChildProcess } from "node:child_process";
import { chownSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/app.ts";
import { startPinRuntime } from "../src/features/pin-automations.ts";
import { SessionStore } from "../src/sessions.ts";
import { StateStore } from "../src/state.ts";
import { fakeSsh } from "../test/fakes.ts";
import { fakeE2ePve, scriptedProvider } from "../test/fakes-e2e.ts";
import { runStages } from "./e2e-stages.mts";

const here = import.meta.dirname;
const dist = resolve(here, "../../../apps/console/dist");
const shots = process.env.EPC_E2E_SHOTS ?? "/tmp/epc-e2e-shots";
const enginePrefix = process.env.EPC_E2E_ENGINE_APP ?? "/opt/epc-eng/app";
const engineNode = process.env.EPC_E2E_ENGINE_NODE ?? "/opt/epc-eng/node-v24.21.0-linux-x64/bin/node";
const nobody = 65534;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
mkdirSync(shots, { recursive: true });
if (!existsSync(join(dist, "index.html"))) throw new Error(`The console isn't built: run \`pnpm --filter @papercliped-engine/console exec vite build\` (looked in ${dist})`);
if (!existsSync(join(enginePrefix, "node_modules/@paperclipai/server/dist/index.js"))) throw new Error(`No engine in ${enginePrefix} (EPC_E2E_ENGINE_APP)`);
if (process.getuid?.() !== 0) throw new Error("Run as root: the engine's embedded Postgres refuses to run as root, so it is started as nobody.");

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const freePort = async () => {
  const s = createServer();
  const url = await listen(s);
  s.close();
  return Number(new URL(url).port);
};

// ---- The real engine, as the installer runs it: loopback only, authenticated, private, as an unprivileged user.
const home = mkdtempSync(join(tmpdir(), "epc-e2e-engine-"));
chownSync(home, nobody, nobody);
const enginePort = await freePort();
const engineUrl = `http://127.0.0.1:${enginePort}`;
const hex = () => [...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
const engine: ChildProcess = spawn("setpriv", [`--reuid=${nobody}`, `--regid=${nobody}`, "--clear-groups", "env", "-i", "PATH=/usr/bin:/bin", `HOME=${home}`, `PAPERCLIP_HOME=${home}`,
  `BETTER_AUTH_SECRET=${hex()}`, `PAPERCLIP_AGENT_JWT_SECRET=${hex()}`, "PAPERCLIP_DEPLOYMENT_MODE=authenticated", "PAPERCLIP_DEPLOYMENT_EXPOSURE=private", "HOST=127.0.0.1", `PORT=${enginePort}`,
  `PAPERCLIP_PUBLIC_URL=${engineUrl}`, "PAPERCLIP_ALLOWED_HOSTNAMES=127.0.0.1,localhost", `PAPERCLIP_API_URL=${engineUrl}`, "PAPERCLIP_MIGRATION_AUTO_APPLY=true", "SERVE_UI=false",
  "PAPERCLIP_AUTH_RATE_LIMIT_ENABLED=false", "PAPERCLIP_TELEMETRY_DISABLED=1", engineNode, join(enginePrefix, "node_modules/@paperclipai/server/dist/index.js")],
  { cwd: enginePrefix, stdio: ["ignore", "pipe", "pipe"], detached: true });
const engineLog: string[] = [];
for (const s of [engine.stdout!, engine.stderr!]) s.on("data", (c: Buffer) => { engineLog.push(c.toString()); if (engineLog.length > 4000) engineLog.shift(); });
let engineGone = false;
engine.on("exit", () => { engineGone = true; });
const stopEngine = async () => {
  if (engineGone) return;
  try { process.kill(-engine.pid!, "SIGTERM"); } catch { /* already gone */ }
  for (let i = 0; i < 60 && !engineGone; i++) await sleep(250);
  try { process.kill(-engine.pid!, "SIGKILL"); } catch { /* gone */ }
};
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void stopEngine().finally(() => process.exit(130)));
process.on("exit", () => { try { process.kill(-engine.pid!, "SIGKILL"); } catch { /* gone */ } });
for (let i = 0; ; i++) {
  if (engineGone) throw new Error("The engine exited while starting:\n" + engineLog.join("").slice(-3000));
  const ok = await fetch(engineUrl + "/api/health", { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  if (ok) break;
  if (i > 120) throw new Error("The engine didn't answer in 6 minutes:\n" + engineLog.join("").slice(-3000));
  await sleep(3000);
}
const engineVersion = ((await (await fetch(engineUrl + "/api/health")).json()) as { version?: string }).version;
console.log(`engine up at ${engineUrl}${engineVersion ? ` (${engineVersion})` : ""}`);

// ---- The real host service, with fakes only for Proxmox, ssh and the model provider.
const pve = fakeE2ePve();
const provider = scriptedProvider();
const ssh = fakeSsh();
const state = new StateStore(mkdtempSync(join(tmpdir(), "epc-e2e-state-")));
/** The host's clock: real time plus an offset the run moves to expire sessions. */
const clock = { skew: 0 };
const hostNow = () => Date.now() + clock.skew;
/** Pin's automation clock, moved by hand so a schedule fires when the run says. */
const pinClock = { t: Date.now() };
const sessions = new SessionStore(hostNow);
const staticFiles = dist;
const fetchOut = (url: string, init: RequestInit) => provider.fetch(url, init);
const pveOpts = { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport };
const app = createApp({
  pve: pveOpts,
  sessions,
  staticDir: staticFiles,
  secureCookies: false,
  state,
  now: hostNow,
  fetch: fetchOut,
  engine: { url: engineUrl, installDir: enginePrefix },
  containers: { ssh: ssh.runner, paceMs: 0 },
  maxUploadBytes: 5 * 1024 ** 2,
});
const pin = startPinRuntime(state, { pve: pveOpts, now: () => pinClock.t, sleep: async () => {}, fetch: fetchOut }, { run: false });
const server = createServer(app);
server.on("upgrade", app.upgrade);
const base = await listen(server);
console.log(`host service at ${base}`);
await app.engine!.start();
// As main.ts does once the engine answers: keep agents off the host (docs/ENGINE.md).
const enforced = await app.containers.enforce();
if (!enforced.ok) throw new Error(`The managed-sandbox-only policy couldn't be set: ${enforced.error}`);

// ---- The browser
const { chromium } = createRequire(process.env.EPC_PLAYWRIGHT ?? "/opt/node-tools/")("playwright");
const browser = await chromium.launch({ executablePath: process.env.EPC_CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });

let code = 1;
try {
  const only = (process.env.EPC_E2E_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const results = await runStages({ base, engineUrl, app, pve, provider, ssh, state, clock, pinClock, pin, sessions, browser, shots, only, engineLog: () => engineLog.join("") });
  if (process.env.EPC_E2E_HOLD) {
    writeFileSync(process.env.EPC_E2E_HOLD, JSON.stringify({ base, engineUrl }));
    console.log(`holding: host ${base}, engine ${engineUrl} (kill this process to stop)`);
    await new Promise(() => {});
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  code = failed.length ? 1 : 0;
} catch (e) {
  console.error("e2e aborted:", e);
} finally {
  await browser.close().catch(() => {});
  server.closeAllConnections();
  server.close();
  pin.runner.stop();
  app.engine?.stop();
  await stopEngine();
  if (process.env.EPC_E2E_KEEP !== "1") rmSync(home, { recursive: true, force: true });
  else console.log(`engine data kept in ${home}`);
}
process.exit(code);
